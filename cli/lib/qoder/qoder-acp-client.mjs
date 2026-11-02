import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { qoderRuntimeEnv, resolveQoderAcpCommand } from './qoder-executable.mjs';
import { readProcessIdentity } from './process-identity.mjs';

const CLIENT_INFO = Object.freeze({ name: 'codex-squad', version: '1.0.0' });
const DEFAULT_GRACE_MS = 1_500;
const DEFAULT_FORCE_MS = 2_000;

/** One persistent ACP process per session: environment and pending requests never cross identities. */
export class QoderAcpClient {
  constructor({ command = 'qodercli', cwd, env, args = [], onSpawn = null } = {}) {
    this.options = { command, cwd, env, args };
    this.onSpawn = onSpawn;
    this.pending = new Map();
    this.nextId = 0;
    this.notifications = new Set();
    this.requests = new Set();
    this.closes = new Set();
    this.child = null;
    this.starting = null;
    this.capabilities = {};
    this.closing = null;
  }

  onNotify(callback) { this.notifications.add(callback); }
  onServerRequest(callback) { this.requests.add(callback); }
  onClose(callback) { this.closes.add(callback); }

  async ensureStarted() {
    if (this.starting) return this.starting;
    this.starting = this.start().catch(async (error) => {
      this.starting = null;
      await this.close();
      throw error;
    });
    return this.starting;
  }

  async start() {
    const { command, cwd, env, args } = this.options;
    const runtimeEnv = qoderRuntimeEnv(env);
    const executable = resolveQoderAcpCommand(command, { env: runtimeEnv });
    const child = spawn(executable, ['--acp', ...args], {
      cwd,
      env: runtimeEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
      shell: false,
    });
    this.child = child;
    let registration;
    if (child.pid) {
      const kill = child.kill.bind(child);
      child.kill = (signal = 'SIGTERM') => {
        try { process.kill(-child.pid, signal); return true; }
        catch { return kill(signal); }
      };
      registration = this.reportSpawn(child, executable);
    }
    // stderr is process diagnostics only; it is drained, never parsed as protocol or assistant content.
    child.stderr.resume();
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      if (this.child !== child || !line.trim()) return;
      try { this.receive(JSON.parse(line)); }
      catch { this.fail(new Error('Qoder ACP returned invalid JSON-RPC output'), child); }
    });
    child.on('error', (error) => this.fail(error, child));
    child.on('exit', (code, signal) => this.fail(new Error(`Qoder ACP connection closed (${signal || code})`), child));
    child.stdin.on('error', (error) => this.fail(error, child));
    await registration;
    const result = await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { ...CLIENT_INFO },
    });
    if (result?.protocolVersion !== 1) throw new Error('Qoder ACP protocol version 1 is required');
    this.capabilities = result.agentCapabilities || {};
    return result;
  }

  /** Persist the spawn before protocol work; registration failure closes the child. */
  async reportSpawn(child, executable) {
    if (typeof this.onSpawn !== 'function' || !child.pid) return;
    const base = { pid: child.pid, pgid: child.pid, executable, state: 'spawned' };
    await this.onSpawn({ ...base });
    const identity = await readProcessIdentity(child.pid);
    if(identity)await this.onSpawn({ ...base, identity, state: identity.supported ? 'identified' : 'identity-unavailable' });
  }

  request(method, params, timeoutMs = 30_000, { onSent = null } = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Qoder ACP ${method} timed out`));
      }, timeoutMs) : null;
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ jsonrpc: '2.0', id, method, params }, (error) => {
          const waiter = this.pending.get(id);
          if (error) {
            if (!waiter) return;
            this.pending.delete(id);
            clearTimeout(waiter.timer);
            waiter.reject(error);
            return;
          }
          // A timed-out, failed or already answered request must not report a later write as a receipt.
          if (!waiter) return;
          try { onSent?.(); } catch {}
        });
      }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  notify(method, params) { this.write({ jsonrpc: '2.0', method, params }); }
  respondToServerRequest(id, result) { this.write({ jsonrpc: '2.0', id, result }); return true; }
  write(message, callback) {
    if (!this.child || this.child.stdin.destroyed) throw new Error('Qoder ACP is not connected');
    const line = `${JSON.stringify(message)}\n`;
    if (callback) this.child.stdin.write(line, callback);
    else this.child.stdin.write(line);
  }

  receive(message) {
    if (message.method && message.id != null) {
      if (message.method !== 'session/request_permission') {
        this.write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Client capability is not supported' } });
      } else for (const callback of this.requests) callback(message);
      return;
    }
    if (message.method) { for (const callback of this.notifications) callback(message); return; }
    const waiter = this.pending.get(message.id);
    if (!waiter) return;
    this.pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) waiter.reject(Object.assign(new Error(message.error.message || 'Qoder ACP request failed'), {
      rpcCode: message.error.code,
      isRpcError: true,
      rpcData: message.error.data,
    }));
    else waiter.resolve(message.result);
  }

  fail(error, child = this.child) {
    if (!child || this.child !== child) return;
    this.child = null;
    this.starting = null;
    this.closing ||= this.terminate(child, {});
    for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
    this.pending.clear();
    this.emitClosed(error);
  }

  emitClosed(error) {
    const callbacks = [...this.closes];
    this.closes.clear();
    for (const callback of callbacks) callback(error);
  }

  /**
   * Unified idempotent shutdown: cancel pending requests, then SIGTERM the ACP
   * process group, escalate to a bounded SIGKILL and confirm the process is gone.
   */
  close({ force = false, graceMs = DEFAULT_GRACE_MS, forceMs = DEFAULT_FORCE_MS } = {}) {
    if (!this.closing) this.closing = this.shutdown({ force, graceMs, forceMs });
    return this.closing;
  }

  async shutdown({ force, graceMs, forceMs }) {
    const child = this.child;
    const error = new Error('Qoder ACP client closed');
    this.child = null;
    this.starting = null;
    for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
    this.pending.clear();
    this.emitClosed(error);
    if (!child) return { pid: null, exited: true, forced: false, signal: null, code: null };
    return this.terminate(child, { force, graceMs, forceMs });
  }

  async terminate(child, { force = false, graceMs = DEFAULT_GRACE_MS, forceMs = DEFAULT_FORCE_MS } = {}) {
    const alive = () => {
      if(process.platform==='win32')return child.exitCode===null&&child.signalCode===null;
      try{process.kill(-child.pid,0);return true}catch(error){return error.code!=='ESRCH'}
    };
    const waitExit = async (ms) => {
      const deadline=performance.now()+Math.max(0,Number(ms)||0);
      while(alive()){
        if(performance.now()>=deadline)return false;
        await new Promise(resolve=>setTimeout(resolve,20));
      }
      return true;
    };
    if(child.exitCode!==null||child.signalCode!==null){
      const exited=!alive();
      return {pid:child.pid||null,exited,forced:false,signal:child.signalCode||null,code:child.exitCode??null,...(!exited?{error:'group_exit_unconfirmed'}:{})};
    }
    try { child.kill('SIGTERM'); } catch {}
    let exited = force ? await waitExit(0) : await waitExit(graceMs);
    let forced = false;
    if (!exited) {
      // Once the leader is reaped we cannot safely signal a persisted group by
      // number alone. Keep cleanup unconfirmed instead of risking PID reuse.
      if(child.exitCode!==null||child.signalCode!==null)return {pid:child.pid||null,exited:false,forced:false,signal:child.signalCode||null,code:child.exitCode??null,error:'group_exit_unconfirmed'};
      forced = true;
      try { child.kill('SIGKILL'); } catch {}
      exited = await waitExit(forceMs);
    }
    // A deferred kill timer must never outlive a confirmed exit.
    if (exited) { try { child.kill = () => true; } catch {} }
    return { pid: child.pid || null, exited, forced, signal: child.signalCode || null, code: child.exitCode ?? null };
  }
}

import assert from 'node:assert/strict';
import test from 'node:test';
import {spawn} from 'node:child_process';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {QoderAcpClient} from '../cli/lib/qoder/qoder-acp-client.mjs';
import {reclaimOrphanedAcp} from '../cli/lib/orphan-recovery.mjs';
import {createWorkerSignalHandler} from '../cli/lib/worker.mjs';
import {readProcessIdentity,sameProcessIdentity} from '../cli/lib/qoder/process-identity.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures');
const FAKE_ACP = join(FIXTURES, 'fake-acp.mjs');
const ORPHAN_WORKER = join(FIXTURES, 'orphan-worker.mjs');
const SWEEP_SERVICE = join(FIXTURES, 'sweep-service.mjs');

function alive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function waitFor(predicate, {timeoutMs = 8_000, intervalMs = 50, label = 'condition'} = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  for (;;) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

async function createAcpCommand(t) {
  const root = await mkdtemp(join(tmpdir(), 'squad-acp-fixture-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const wrapper = join(root, 'qodercli');
  await writeFile(
    wrapper,
    `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(FAKE_ACP)} "$@"\n`,
    {mode: 0o755},
  );
  return wrapper;
}

async function workerHome(t) {
  const home = await mkdtemp(join(tmpdir(), 'squad-orphan-home-'));
  t.after(() => rm(home, {recursive: true, force: true}));
  return home;
}

async function spawnWorker(t, home, env = {}) {
  const command = await createAcpCommand(t);
  const nonce = randomUUID();
  const child = spawn(process.execPath, [ORPHAN_WORKER, '--home', home, '--nonce', nonce, '--acp', command], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {...process.env, ...env,FAKE_ACP_PID_FILE:join(home,'acp-'+nonce+'.pid')},
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const readyPath = join(home, 'ready', `${nonce}.json`);
  let ready;
  try {
    ready = await waitFor(async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`worker exited before readiness (code ${child.exitCode}, signal ${child.signalCode}): ${stderr}`);
      }
      try {
        return JSON.parse(await readFile(readyPath, 'utf8'));
      } catch {
        return null;
      }
    // Startup includes OS identity discovery and can be delayed on a swapping
    // developer machine. Cleanup deadlines remain independently bounded below.
    }, {timeoutMs:20_000,label: 'worker readiness'});
  } catch (error) {
    const receipt=await readFile(join(home,'workers',nonce+'.json'),'utf8').catch(()=>null);
    const events=await readFile(join(home,'acp-'+nonce+'.pid.events'),'utf8').catch(()=>null);
    throw new Error(`${error.message}; worker stderr: ${stderr}; receipt: ${receipt}; protocol: ${events}`);
  }
  const acpIdentity=await readProcessIdentity(ready.acpPid);
  t.after(async()=>{
    if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await waitExit(child).catch(()=>{})}
    const current=await readProcessIdentity(ready.acpPid);
    if(sameProcessIdentity(acpIdentity,current)){
      process.kill(-ready.acpPid,'SIGKILL');
      await waitFor(()=>!alive(ready.acpPid),{label:'fixture cleanup'});
    }
  });
  return {child, nonce, ...ready, stderr: () => stderr};
}

function waitExit(child, timeoutMs = 8_000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('worker exit timed out')), timeoutMs);
    timer.unref();
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

async function sweepThroughService(home) {
  const child = spawn(process.execPath, [SWEEP_SERVICE, home], {stdio: ['ignore', 'pipe', 'pipe']});
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve) => child.once('exit', resolve));
  if (code !== 0) throw new Error(`sweep service exited ${code}: ${stderr}`);
  return JSON.parse(stdout.trim().split('\n').at(-1));
}

async function readReceipt(home, nonce) {
  return JSON.parse(await readFile(join(home, 'workers', `${nonce}.json`), 'utf8'));
}

async function writeReceipt(home, nonce, value) {
  await mkdir(join(home, 'workers'), {recursive: true, mode: 0o700});
  await writeFile(join(home, 'workers', `${nonce}.json`), `${JSON.stringify(value)}\n`, {mode: 0o600});
}

async function spawnSleeper(t) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: 'ignore'});
  t.after(() => { if (alive(child.pid)) child.kill('SIGKILL'); });
  await waitFor(() => alive(child.pid), {label: 'sleeper'});
  return child;
}

test('a restarted shared service reclaims the ACP left by a suddenly killed worker', async (t) => {
  const home = await workerHome(t);
  const worker = await spawnWorker(t, home, {FAKE_ACP_IGNORE_TERM: '1'});
  assert.equal(alive(worker.workerPid), true);
  assert.equal(alive(worker.acpPid), true);

  worker.child.kill('SIGKILL');
  await waitExit(worker.child);
  await waitFor(() => !alive(worker.workerPid), {label: 'worker death'});
  assert.equal(alive(worker.acpPid), true, 'the detached ACP must survive its owner for this scenario');

  const report = await sweepThroughService(home);

  assert.equal(report.reclaimed.length, 1, JSON.stringify({report,recorded:(await readReceipt(home,worker.nonce)).acp.identity,current:await readProcessIdentity(worker.acpPid)}));
  assert.equal(report.reclaimed[0].nonce, worker.nonce);
  assert.equal(report.reclaimed[0].result, 'terminated');
  assert.equal(report.reclaimed[0].forced, true, 'the fixture ignores SIGTERM so the sweep must escalate');
  await waitFor(() => !alive(worker.acpPid), {timeoutMs: 3_000, label: 'ACP reclamation'});
  assert.equal(alive(worker.acpPid), false);

  const receipt = await readReceipt(home, worker.nonce);
  assert.equal(receipt.acp.exited, true);
  assert.equal(receipt.reclaim.result, 'terminated');
  assert.equal(receipt.reclaim.reason, 'worker_not_found');
});

test('a live worker keeps its ACP even when the heartbeat is stale', async (t) => {
  const home = await workerHome(t);
  const worker = await spawnWorker(t, home, {FAKE_ACP_IGNORE_TERM: '1'});
  const receipt = await readReceipt(home, worker.nonce);
  await writeFile(join(home, 'workers', `${worker.nonce}.json`), `${JSON.stringify({...receipt, updatedAt: 1})}\n`);

  const report = await reclaimOrphanedAcp({home});
  assert.equal(report.reclaimed.length, 0);
  assert.equal(report.skipped[0].reason, 'worker_alive');
  assert.equal(alive(worker.acpPid), true);

  worker.child.kill('SIGTERM');
  await waitExit(worker.child);
  assert.equal(alive(worker.acpPid), false, 'normal stop must close the ACP through the bounded close path');
});

test('only the dead worker is reclaimed while another worker keeps running', async (t) => {
  const home = await workerHome(t);
  const doomed = await spawnWorker(t, home, {FAKE_ACP_IGNORE_TERM: '1'});
  const healthy = await spawnWorker(t, home, {FAKE_ACP_IGNORE_TERM: '1'});

  doomed.child.kill('SIGKILL');
  await waitExit(doomed.child);
  const report = await reclaimOrphanedAcp({home, graceMs: 100, forceMs: 3_000});

  assert.deepEqual(report.reclaimed.map((entry) => entry.nonce), [doomed.nonce],JSON.stringify(report));
  assert.equal(alive(doomed.acpPid), false);
  assert.equal(alive(healthy.acpPid), true);
  assert.equal(alive(healthy.workerPid), true);
  const skipped = report.skipped.find((entry) => entry.nonce === healthy.nonce);
  assert.equal(skipped.reason, 'worker_alive');
});

test('PID reuse and missing start identity are skipped without signalling anything', async (t) => {
  const home = await workerHome(t);
  const sleeper = await spawnSleeper(t);
  const owner={pid:2147483000,pgid:2147483000,command:'/fixture/worker',startToken:'linux:fixture:1',supported:true};
  const reused = randomUUID();
  await writeReceipt(home, reused, {
    pid: owner.pid, nonce: reused, updatedAt: 1, exited: false,
    identity: owner,
    acp: {pid: sleeper.pid, pgid: sleeper.pid,ownerPid:owner.pid,ownerNonce:reused, identity:{...await readProcessIdentity(sleeper.pid),startToken:'linux:old-boot:1'}},
  });
  const missing = randomUUID();
  await writeReceipt(home, missing, {
    pid: owner.pid, nonce: missing, updatedAt: 1, exited: false,
    acp: {pid: sleeper.pid, pgid: sleeper.pid,ownerPid:owner.pid,ownerNonce:missing},
  });

  const report = await reclaimOrphanedAcp({home, graceMs: 100, forceMs: 500});
  assert.equal(report.reclaimed.length, 0);
  assert.equal(report.skipped.length,2);
  assert.equal(report.skipped.find(r=>r.nonce===reused).reason,'acp_identity_mismatch');
  assert.equal(report.skipped.find(r=>r.nonce===missing).reason,'worker_identity_missing');
  assert.equal(alive(sleeper.pid), true);
});

test('client close is idempotent and escalates SIGTERM to a bounded SIGKILL', async (t) => {
  const command = await createAcpCommand(t);
  const client = new QoderAcpClient({command, cwd: process.cwd(), env: {...process.env, FAKE_ACP_IGNORE_TERM: '1'}});
  await client.ensureStarted();
  const pid = client.child.pid;
  assert.equal(alive(pid), true);

  const first = client.close({graceMs: 100, forceMs: 3_000});
  const second = client.close();
  assert.equal(first, second, 'repeated close must share one shutdown');
  const result = await first;

  assert.equal(result.exited, true);
  assert.equal(result.forced, true);
  assert.equal(alive(pid), false);
  assert.deepEqual(await client.close(), result);
});

test('ACP registration failure closes the child before startup rejects',async t=>{
  const command=await createAcpCommand(t);let pid;
  const client=new QoderAcpClient({command,cwd:process.cwd(),env:{...process.env},onSpawn:details=>{pid=details.pid;throw Error('registry unavailable')}});
  t.after(()=>client.close());
  await assert.rejects(client.ensureStarted(),/registry unavailable/);
  assert.equal(alive(pid),false);
});

test('invalid protocol output awaits process cleanup instead of losing the child handle',async t=>{
  const command=await createAcpCommand(t);let pid;
  const client=new QoderAcpClient({command,cwd:process.cwd(),env:{...process.env,FAKE_ACP_INVALID_RPC:'1'},onSpawn:details=>{pid=details.pid}});
  t.after(()=>client.close());
  await assert.rejects(client.ensureStarted(),/invalid JSON/);
  assert.equal(alive(pid),false);
  assert.equal((await client.close()).exited,true);
});

test('repeated stop signals keep the worker lifecycle on the cleanup path', async (t) => {
  const home = await workerHome(t);
  const worker = await spawnWorker(t, home, {FAKE_ACP_IGNORE_TERM: '1'});

  worker.child.kill('SIGTERM');
  worker.child.kill('SIGINT');
  await waitExit(worker.child);

  assert.equal(alive(worker.workerPid), false);
  await waitFor(() => !alive(worker.acpPid), {timeoutMs: 3_000, label: 'ACP close after repeated signals'});
  assert.equal(alive(worker.acpPid), false);
  const receipt = await readReceipt(home, worker.nonce);
  assert.equal(receipt.exited, true);
  assert.equal(receipt.lastExit.reason, 'test_signal');
});

test('the worker signal handler never exits the process on a repeated signal', async () => {
  const controller = new AbortController();
  let forced = 0;
  const handler = createWorkerSignalHandler({
    controller,
    onForce: async () => { forced += 1; },
  });
  handler('SIGTERM');
  assert.equal(controller.signal.aborted, true);
  handler('SIGINT');
  handler('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(forced, 1);
});

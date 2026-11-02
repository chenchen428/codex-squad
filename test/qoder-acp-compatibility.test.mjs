import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { closeQoderAcpSessions, runQoderAcpCommand } from '../cli/lib/qoder/qoder-acp-runner.mjs';
import { QoderAcpClient } from '../cli/lib/qoder/qoder-acp-client.mjs';

const WORKSPACE = process.cwd();
const YOLO_DETAILS = 'unknown permission_mode: yolo';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function within(promise, label, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
    timer.unref();
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

function rpcError({ code = -32603, message = 'Internal error', data } = {}) {
  return Object.assign(new Error(message), { isRpcError: true, rpcCode: code, rpcData: data });
}

class FakeCompatClient {
  constructor({ modeOutcomes = {} } = {}) {
    this.options = { command: 'fake-qodercli', cwd: WORKSPACE, env: {}, args: [] };
    this.capabilities = {};
    this.modeOutcomes = modeOutcomes;
    this.calls = [];
    this.responses = [];
    this.notifyCallbacks = new Set();
    this.requestCallbacks = new Set();
    this.closeCallbacks = new Set();
    this.promptGate = deferred();
    this.promptParams = null;
  }

  async ensureStarted() { return {}; }

  async request(method, params, timeoutMs, { onSent = null } = {}) {
    this.calls.push({ method, params });
    if (method === 'session/new') return { sessionId: 'native-compat', models: { availableModels: [] } };
    if (method === 'session/set_mode') {
      const outcome = this.modeOutcomes[params.modeId];
      if (outcome) throw outcome();
      return {};
    }
    if (method === 'session/prompt') {
      onSent?.();
      this.promptParams = params;
      this.promptGate.resolve(params);
      return new Promise((resolve, reject) => {
        this.finishPromptTurn = resolve;
        this.rejectPromptTurn = reject;
      });
    }
    return {};
  }

  notify() {}
  respondToServerRequest(id, result) { this.responses.push({ id, result }); return true; }
  onNotify(callback) { this.notifyCallbacks.add(callback); }
  onServerRequest(callback) { this.requestCallbacks.add(callback); }
  onClose(callback) { this.closeCallbacks.add(callback); }

  emitPermission({ id = 'permission-compat', sessionId = 'native-compat', options = [
    { optionId: 'allow-once', kind: 'allow_once' },
    { optionId: 'reject-once', kind: 'reject_once' },
  ] } = {}) {
    for (const callback of [...this.requestCallbacks]) {
      callback({
        jsonrpc: '2.0',
        id,
        method: 'session/request_permission',
        params: { sessionId, toolCall: { toolCallId: `tool-${id}` }, options },
      });
    }
  }

  finishPrompt(result) { this.finishPromptTurn?.(result); }

  close() {
    for (const callback of [...this.closeCallbacks]) callback(new Error('Qoder ACP client closed'));
    this.rejectPromptTurn?.(new Error('Qoder ACP client closed'));
  }
}

function makeConfig(client, overrides = {}) {
  const controller = new AbortController();
  const events = [];
  return {
    controller,
    events,
    config: {
      sessionId: `qoder-compat-${randomUUID()}`,
      workspace: WORKSPACE,
      stdin: 'run compatibility task',
      taskDescription: 'run compatibility task',
      signal: controller.signal,
      onSessionEvent: (event) => events.push(event),
      qoderAcpClient: client,
      appServerApprovalPolicy: 'never',
      appServerSandbox: 'danger-full-access',
      ...overrides,
    },
  };
}

async function promptStartedOrFailure(client, running) {
  await Promise.race([client.promptGate.promise, running.then(() => undefined)]);
  if (!client.promptParams) {
    const result = await running;
    assert.fail(`session/prompt was not reached: ${result.error}`);
  }
  return client.promptParams;
}

function modeCalls(client) {
  return client.calls.filter((call) => call.method === 'session/set_mode').map((call) => call.params.modeId);
}

async function createFakeAcpProcess(t, source) {
  const root = await mkdtemp(join(tmpdir(), 'squad-qoder-compat-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const serverPath = join(root, 'server.mjs');
  const wrapperPath = join(root, 'qodercli');
  await writeFile(serverPath, source);
  await writeFile(wrapperPath, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(serverPath)} "$@"\n`, { mode: 0o755 });
  await chmod(wrapperPath, 0o755);
  return { root, wrapperPath, serverPath };
}

test('ACP client preserves structured RPC error data', async (t) => {
  const { root, wrapperPath } = await createFakeAcpProcess(t, `
import { createInterface } from 'node:readline';
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    return;
  }
  if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'native-client', models: { availableModels: [] } } });
    return;
  }
  if (message.method === 'session/set_mode') {
    send({ jsonrpc: '2.0', id: message.id, error: {
      code: -32603,
      message: 'Internal error',
      data: { details: '${YOLO_DETAILS}', retryable: false },
    } });
  }
});
`);
  const client = new QoderAcpClient({ command: wrapperPath, cwd: root, env: { HOME: root, PATH: '/usr/bin:/bin' } });
  t.after(() => client.close());
  await within(client.ensureStarted(), 'initialize');
  await within(client.request('session/new', { cwd: root, mcpServers: [] }), 'session/new');

  const error = await within(client.request('session/set_mode', { sessionId: 'native-client', modeId: 'bypassPermissions' }), 'set_mode rejection')
    .then(() => assert.fail('set_mode should be rejected'), (rejection) => rejection);
  assert.equal(error.isRpcError, true);
  assert.equal(error.rpcCode, -32603);
  assert.equal(error.message, 'Internal error');
  assert.deepEqual(error.rpcData, { details: YOLO_DETAILS, retryable: false });
});

test('prompt submission receipt fires only after a request is written', async () => {
  const client = new QoderAcpClient({ command: 'missing-qodercli', cwd: WORKSPACE, env: { PATH: '/usr/bin:/bin' } });
  let sent = 0;
  await assert.rejects(client.request('session/prompt', { sessionId: 'native-client', prompt: [] }, 0, { onSent: () => { sent += 1; } }), /not connected/);
  assert.equal(sent, 0);
});

test('prompt submission receipt waits for the real stdin write callback', async () => {
  const client = new QoderAcpClient({ command: 'fake-qodercli', cwd: WORKSPACE, env: {} });
  let finishWrite = null;
  const stdin = new Writable({ write(_chunk, _encoding, callback) { finishWrite = callback; } });
  stdin.on('error', () => {});
  client.child = { stdin, exitCode: null, signalCode: null, kill() {} };
  let sent = 0;
  const pending = client.request('session/prompt', { sessionId: 'native-client', prompt: [] }, 0, { onSent: () => { sent += 1; } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof finishWrite, 'function');
  assert.equal(sent, 0);
  finishWrite();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent, 1);
  client.receive({ jsonrpc: '2.0', id: 1, result: { stopReason: 'end_turn' } });
  assert.deepEqual(await pending, { stopReason: 'end_turn' });
  stdin.destroy();
});

test('an asynchronous stdin write failure rejects without a submission receipt', async () => {
  const client = new QoderAcpClient({ command: 'fake-qodercli', cwd: WORKSPACE, env: {} });
  const stdin = new Writable({
    write(_chunk, _encoding, callback) {
      setImmediate(() => callback(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })));
    },
  });
  stdin.on('error', () => {});
  client.child = { stdin, exitCode: null, signalCode: null, kill() {} };
  let sent = 0;
  await assert.rejects(
    client.request('session/prompt', { sessionId: 'native-client', prompt: [] }, 0, { onSent: () => { sent += 1; } }),
    (error) => error.code === 'EPIPE',
  );
  assert.equal(sent, 0);
  assert.equal(client.pending.size, 0);
});

test('keeps bypassPermissions and prompts directly when set_mode succeeds', async (t) => {
  t.after(() => closeQoderAcpSessions());
  const client = new FakeCompatClient();
  const { config, events } = makeConfig(client);
  const running = runQoderAcpCommand(config);
  await promptStartedOrFailure(client, running);
  client.finishPrompt({ stopReason: 'end_turn' });
  const result = await running;

  assert.equal(result.status, 'completed');
  assert.deepEqual(modeCalls(client), ['bypassPermissions']);
  assert.equal(client.calls.filter((call) => call.method === 'session/prompt').length, 1);
  assert.equal(events.at(-1).payload.success, true);
});

test('falls back to default exactly once for the exact yolo permission-mode error', async (t) => {
  t.after(() => closeQoderAcpSessions());
  const client = new FakeCompatClient({
    modeOutcomes: { bypassPermissions: () => rpcError({ data: { details: YOLO_DETAILS } }) },
  });
  const { config, events } = makeConfig(client);
  const running = runQoderAcpCommand(config);
  await promptStartedOrFailure(client, running);

  client.emitPermission({ id: 'permission-1' });
  client.emitPermission({ id: 'permission-2' });
  client.finishPrompt({ stopReason: 'end_turn' });
  const result = await running;

  assert.equal(result.status, 'completed');
  assert.deepEqual(modeCalls(client), ['bypassPermissions', 'default']);
  assert.equal(client.calls.at(-1).method, 'session/prompt');
  assert.deepEqual(client.responses, [
    { id: 'permission-1', result: { outcome: { outcome: 'selected', optionId: 'allow-once' } } },
    { id: 'permission-2', result: { outcome: { outcome: 'selected', optionId: 'allow-once' } } },
  ]);
  assert.equal(events.some((event) => event.kind === 'session.error'), false);
});

test('does not fall back for unrelated RPC codes, near-miss details or non-RPC errors', async (t) => {
  t.after(() => closeQoderAcpSessions());
  const cases = [
    { name: 'other code', error: () => rpcError({ code: -32602, data: { details: YOLO_DETAILS } }), expected: YOLO_DETAILS },
    { name: 'trailing space', error: () => rpcError({ data: { details: `${YOLO_DETAILS} ` } }), expected: `${YOLO_DETAILS} ` },
    { name: 'suffix', error: () => rpcError({ data: { details: `${YOLO_DETAILS}_v2` } }), expected: `${YOLO_DETAILS}_v2` },
    { name: 'missing details', error: () => rpcError({ data: { code: 'unknown' } }), expected: 'unknown' },
    { name: 'plain error', error: () => new Error('not an RPC error'), expected: 'not an RPC error' },
  ];
  for (const scenario of cases) {
    const client = new FakeCompatClient({ modeOutcomes: { bypassPermissions: scenario.error } });
    const { config, events } = makeConfig(client);
    const result = await runQoderAcpCommand(config);

    assert.equal(result.status, 'failed', scenario.name);
    assert.deepEqual(modeCalls(client), ['bypassPermissions'], scenario.name);
    assert.equal(client.calls.some((call) => call.method === 'session/prompt'), false, scenario.name);
    assert.match(result.error, /session\/set_mode/, scenario.name);
    assert.ok(result.error.includes(scenario.expected), `${scenario.name}: ${result.error}`);
    const errorEvent = events.find((event) => event.kind === 'session.error');
    assert.ok(errorEvent, scenario.name);
    assert.equal(errorEvent.payload.content, result.error);
  }
});

test('reports original and fallback errors without prompting when default also fails', async (t) => {
  t.after(() => closeQoderAcpSessions());
  const client = new FakeCompatClient({
    modeOutcomes: {
      bypassPermissions: () => rpcError({ data: { details: YOLO_DETAILS } }),
      default: () => rpcError({ code: -32602, data: { details: 'permission_mode default unavailable' } }),
    },
  });
  const { config, events } = makeConfig(client);
  const result = await runQoderAcpCommand(config);

  assert.equal(result.status, 'failed');
  assert.deepEqual(modeCalls(client), ['bypassPermissions', 'default']);
  assert.equal(client.calls.some((call) => call.method === 'session/prompt'), false);
  assert.match(result.error, /session\/set_mode/);
  assert.ok(result.error.includes(YOLO_DETAILS), result.error);
  assert.ok(result.error.includes('permission_mode default unavailable'), result.error);
  assert.equal(events.find((event) => event.kind === 'session.error').payload.content, result.error);
});

test('real ACP process retries default, then authorizes each tool request during prompt', async (t) => {
  const { root, wrapperPath } = await createFakeAcpProcess(t, `
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const logPath = process.env.COMPAT_LOG;
const log = (entry) => appendFileSync(logPath, JSON.stringify(entry) + '\\n');
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
let promptId = null;
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    return;
  }
  if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'native-compat', models: { availableModels: [] } } });
    return;
  }
  if (message.method === 'session/set_mode') {
    log({ mode: message.params.modeId });
    if (message.params.modeId === 'bypassPermissions') {
      send({ jsonrpc: '2.0', id: message.id, error: {
        code: -32603,
        message: 'Internal error',
        data: { details: '${YOLO_DETAILS}' },
      } });
    } else {
      send({ jsonrpc: '2.0', id: message.id, result: {} });
    }
    return;
  }
  if (message.method === 'session/prompt') {
    promptId = message.id;
    send({ jsonrpc: '2.0', id: 'permission-compat', method: 'session/request_permission', params: {
      sessionId: 'native-compat',
      toolCall: { toolCallId: 'tool-compat', title: 'shell' },
      options: [{ optionId: 'allow-once', kind: 'allow_once' }],
    } });
    return;
  }
  if (message.id === 'permission-compat') {
    log({ permission: message.result });
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'native-compat', update: {
      sessionUpdate: 'agent_message_chunk', messageId: 'compat', content: { type: 'text', text: 'AUTHORIZED' },
    } } });
    send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
  }
});
`);
  const logPath = join(root, 'compat.log');
  const { config } = makeConfig(null, {
    qoderAcpCommand: wrapperPath,
    agentEnv: { HOME: root, PATH: '/usr/bin:/bin', COMPAT_LOG: logPath },
  });
  const result = await within(runQoderAcpCommand(config), 'ACP compatibility run', 8_000);
  closeQoderAcpSessions();

  assert.equal(result.status, 'completed');
  assert.equal(result.text, 'AUTHORIZED');
  assert.equal(result.nativeSessionId, 'native-compat');
  const entries = (await readFile(logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(entries, [
    { mode: 'bypassPermissions' },
    { mode: 'default' },
    { permission: { outcome: { outcome: 'selected', optionId: 'allow-once' } } },
  ]);
});

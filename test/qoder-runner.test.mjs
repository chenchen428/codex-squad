import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  closeQoderAcpSessions,
  discoverQoderAcpModels,
  invalidateQoderAcpModels,
  qoderModelCatalogStatus,
  resolveQoderAcpModel,
  runQoderAcpCommand,
} from '../cli/lib/qoder/qoder-acp-runner.mjs';
import { QoderAcpClient } from '../cli/lib/qoder/qoder-acp-client.mjs';
import { qoderRuntimeEnv, resolveQoderAcpCommand } from '../cli/lib/qoder/qoder-executable.mjs';

const WORKSPACE = process.cwd();
const QODER_DIR = fileURLToPath(new URL('../cli/lib/qoder/', import.meta.url));

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

function modelState() {
  return {
    currentModelId: 'deepseek-flash',
    availableModels: [
      { modelId: 'deepseek-flash', name: 'DeepSeek-Flash', description: 'fast' },
      { modelId: 'other-model', name: 'Other Model' },
    ],
  };
}

class FakeAcpClient {
  constructor({ capabilities = {}, models = modelState(), newResult, resume, load } = {}) {
    this.options = { command: 'fake-qodercli', cwd: WORKSPACE, env: { FAKE: '1' }, args: ['--fake'] };
    this.capabilities = capabilities;
    this.models = models;
    this.newResult = newResult;
    this.resume = resume;
    this.load = load;
    this.calls = [];
    this.responses = [];
    this.notifications = [];
    this.closed = 0;
    this.started = 0;
    this.promptStarted = deferred();
    this.notifyCallbacks = new Set();
    this.requestCallbacks = new Set();
    this.closeCallbacks = new Set();
  }

  async ensureStarted() {
    this.started += 1;
    return {};
  }

  async request(method, params, timeoutMs, { onSent = null } = {}) {
    this.calls.push({ method, params, timeoutMs });
    if (method === 'session/new') {
      const result = typeof this.newResult === 'function'
        ? await this.newResult(params)
        : this.newResult !== undefined ? this.newResult : { sessionId: 'native-new', models: this.models };
      if (result?.sessionId) this.nativeSessionId = result.sessionId;
      return result;
    }
    if (method === 'session/resume' || method === 'session/load') {
      const handler = method === 'session/resume' ? this.resume : this.load;
      const result = typeof handler === 'function' ? await handler(params) : handler;
      this.nativeSessionId = params.sessionId;
      return result;
    }
    if (method === 'session/set_model' || method === 'session/set_mode' || method === 'session/close') return {};
    if (method === 'session/prompt') {
      onSent?.();
      const pending = new Promise((resolve, reject) => {
        this.resolvePrompt = resolve;
        this.rejectPrompt = reject;
      });
      this.promptStarted.resolve({ params, timeoutMs });
      return pending;
    }
    throw new Error(`unexpected ACP method: ${method}`);
  }

  notify(method, params) {
    this.notifications.push({ method, params });
    if (method === 'session/cancel') this.onCancel?.();
  }

  respondToServerRequest(id, result) {
    this.responses.push({ id, result });
    return true;
  }

  onNotify(callback) { this.notifyCallbacks.add(callback); }
  onServerRequest(callback) { this.requestCallbacks.add(callback); }
  onClose(callback) { this.closeCallbacks.add(callback); }

  emitUpdate(update, sessionId = this.nativeSessionId) {
    for (const callback of [...this.notifyCallbacks]) {
      callback({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } });
    }
  }

  emitPermission({ id = 'permission-1', sessionId = this.nativeSessionId, options = [
    { optionId: 'allow', kind: 'allow_once' },
    { optionId: 'deny', kind: 'reject_once' },
  ] } = {}) {
    for (const callback of [...this.requestCallbacks]) {
      callback({
        jsonrpc: '2.0',
        id,
        method: 'session/request_permission',
        params: { sessionId, toolCall: { toolCallId: 'tool-1', title: 'shell' }, options },
      });
    }
  }

  finishPrompt(result) { this.resolvePrompt?.(result); }

  close() {
    this.closed += 1;
    for (const callback of [...this.closeCallbacks]) callback(new Error('Qoder ACP client closed'));
    this.rejectPrompt?.(new Error('Qoder ACP client closed'));
  }
}

function makeConfig(fake, overrides = {}) {
  const controller = new AbortController();
  const events = [];
  const config = {
    sessionId: `qoder-test-${randomUUID()}`,
    workspace: WORKSPACE,
    stdin: '请实现任务',
    taskDescription: '实现任务',
    signal: controller.signal,
    onSessionEvent: (event) => events.push(event),
    qoderAcpClient: fake,
    qoderAcpModel: 'DeepSeek-Flash',
    appServerApprovalPolicy: 'never',
    appServerSandbox: 'danger-full-access',
    ...overrides,
  };
  return { config, controller, events };
}

test('executes session/new, model, bypass mode, segmented streaming, tool boundary and usage', async (t) => {
  t.after(() => closeQoderAcpSessions());
  const fake = new FakeAcpClient();
  const { config, events } = makeConfig(fake);
  const running = runQoderAcpCommand(config);
  await within(fake.promptStarted.promise, 'prompt start');

  fake.emitUpdate({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'SECRET-THOUGHT' } });
  fake.emitUpdate({ sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'Hello' } });
  fake.emitUpdate({ sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'Hello world' } });
  fake.emitUpdate({
    sessionUpdate: 'tool_call', toolCallId: 'tool-1', kind: 'execute', title: 'run ls', status: 'pending',
    rawInput: { command: 'ls' }, rawOutput: 'RAW-ONLY-OUTPUT',
  });
  fake.emitUpdate({
    sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', kind: 'execute', status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: 'tool output' } }], rawOutput: 'RAW-ONLY-OUTPUT',
  });
  fake.emitUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed' });
  fake.emitUpdate({ sessionUpdate: 'agent_message_chunk', messageId: 'm2', content: { type: 'text', text: 'Done' } });
  const usage = { inputTokens: 11, outputTokens: 7, totalTokens: 18 };
  fake.finishPrompt({ stopReason: 'end_turn', usage });

  const result = await running;
  assert.equal(result.status, 'completed');
  assert.equal(result.text, 'Hello world\nDone');
  assert.deepEqual(result.usage, usage);
  assert.equal(result.cliSessionId, 'native-new');
  assert.equal(result.error, undefined);

  assert.deepEqual(fake.calls.map((call) => call.method), ['session/new', 'session/set_model', 'session/set_mode', 'session/prompt']);
  assert.deepEqual(fake.calls[0].params, { cwd: WORKSPACE, mcpServers: [] });
  assert.deepEqual(fake.calls[1].params, { sessionId: 'native-new', modelId: 'deepseek-flash' });
  assert.deepEqual(fake.calls[2].params, { sessionId: 'native-new', modeId: 'bypassPermissions' });
  assert.deepEqual(fake.calls[3].params.prompt, [{ type: 'text', text: '请实现任务' }]);
  assert.equal(fake.calls[3].timeoutMs, 0);

  const submitted = events.filter((event) => event.kind === 'session.prompt_submitted');
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].payload.cliSessionId, 'native-new');
  assert.equal(submitted[0].payload.metadata.eventType, 'prompt/submitted');
  assert.equal(submitted[0].payload.metadata.threadId, 'native-new');
  assert.equal(Number.isFinite(Date.parse(submitted[0].payload.at)), true);
  assert.ok(events.indexOf(submitted[0]) < events.findIndex((event) => event.kind === 'session.assistant_message'));

  const assistant = events.filter((event) => event.kind === 'session.assistant_message');
  assert.deepEqual(assistant.map((event) => event.payload.content), ['Hello', 'Hello world', 'Hello world', 'Done', 'Done']);
  assert.deepEqual(assistant.map((event) => event.payload.metadata.streamState), ['streaming', 'streaming', 'completed', 'streaming', 'completed']);
  assert.equal(assistant[0].payload.persistedMessageId, assistant[1].payload.persistedMessageId);
  assert.equal(assistant[1].payload.persistedMessageId, assistant[2].payload.persistedMessageId);
  assert.notEqual(assistant[2].payload.persistedMessageId, assistant[3].payload.persistedMessageId);

  const toolUse = events.filter((event) => event.kind === 'session.tool_use');
  assert.equal(toolUse.length, 1);
  assert.equal(toolUse[0].payload.toolName, 'execute');
  assert.deepEqual(toolUse[0].payload.input, { command: 'ls' });
  const toolResults = events.filter((event) => event.kind === 'session.tool_result');
  assert.equal(toolResults.length, 1);
  assert.equal(toolResults[0].payload.content, 'tool output');
  assert.equal(toolResults[0].payload.metadata.toolCallId, 'tool-1');

  const reasoning = events.filter((event) => event.kind === 'session.reasoning');
  assert.equal(reasoning.length, 1);
  assert.equal('content' in reasoning[0].payload, false);
  const serialized = JSON.stringify(events);
  assert.equal(serialized.includes('SECRET-THOUGHT'), false);
  assert.equal(serialized.includes('RAW-ONLY-OUTPUT'), false);
  assert.equal(result.text.includes('tool output'), false);
  assert.equal(events.some((event) => event.kind.startsWith('authorization.')), false);

  const complete = events.at(-1);
  assert.equal(complete.kind, 'session.complete');
  assert.equal(complete.payload.success, true);
  assert.equal(complete.payload.aborted, false);
});

test('resumes or loads the original native session and ignores replayed history', async (t) => {
  t.after(() => closeQoderAcpSessions());
  for (const [method, capabilities] of [
    ['session/resume', { sessionCapabilities: { resume: true } }],
    ['session/load', { loadSession: true }],
  ]) {
    const fake = new FakeAcpClient({ capabilities });
    fake[method === 'session/resume' ? 'resume' : 'load'] = async (params) => {
      fake.emitUpdate({ sessionUpdate: 'agent_message_chunk', messageId: 'history', content: { type: 'text', text: 'OLD HISTORY' } }, params.sessionId);
      return { models: modelState() };
    };
    const { config, events } = makeConfig(fake, { sessionId: `qoder-test-${randomUUID()}`, cliSessionId: 'native-old' });
    const running = runQoderAcpCommand(config);
    await within(fake.promptStarted.promise, `${method} prompt start`);
    fake.emitUpdate({ sessionUpdate: 'agent_message_chunk', messageId: 'live', content: { type: 'text', text: 'LIVE' } });
    fake.finishPrompt({ stopReason: 'end_turn' });

    const result = await running;
    assert.equal(result.status, 'completed');
    assert.equal(result.cliSessionId, 'native-old');
    assert.equal('usage' in result, false);
    const methods = fake.calls.map((call) => call.method);
    assert.equal(methods.includes('session/new'), false);
    assert.equal(methods[0], method);
    assert.deepEqual(fake.calls[0].params, { sessionId: 'native-old', cwd: WORKSPACE, mcpServers: [] });
    assert.deepEqual(events.filter((event) => event.kind === 'session.assistant_message').map((event) => event.payload.content), ['LIVE', 'LIVE']);
    assert.equal(JSON.stringify(events).includes('OLD HISTORY'), false);
  }
});

test('fails a native resume/load error without creating a fallback session', async (t) => {
  t.after(() => closeQoderAcpSessions());
  const fake = new FakeAcpClient({ capabilities: { sessionCapabilities: { resume: true } } });
  fake.resume = async () => { throw new Error('resume exploded'); };
  const { config, events } = makeConfig(fake, { cliSessionId: 'native-old' });

  const result = await runQoderAcpCommand(config);
  assert.equal(result.status, 'failed');
  assert.match(result.error, /resume exploded/);
  assert.equal(fake.calls.filter((call) => call.method === 'session/resume').length, 1);
  assert.equal(fake.calls.some((call) => call.method === 'session/new'), false);
  assert.match(events.find((event) => event.kind === 'session.error').payload.content, /resume exploded/);
  const complete = events.at(-1);
  assert.equal(complete.kind, 'session.complete');
  assert.equal(complete.payload.success, false);
  assert.equal(complete.payload.aborted, false);
});

test('refuses to create a new session when ACP cannot load or identify a session', async (t) => {
  t.after(() => closeQoderAcpSessions());
  const unsupported = new FakeAcpClient();
  const unsupportedRun = makeConfig(unsupported, { cliSessionId: 'native-old' });
  const unsupportedResult = await runQoderAcpCommand(unsupportedRun.config);
  assert.equal(unsupportedResult.status, 'failed');
  assert.match(unsupportedResult.error, /does not support loading sessions/);
  assert.equal(unsupported.calls.some((call) => call.method === 'session/new'), false);

  const emptyIdentity = new FakeAcpClient({ newResult: { models: modelState() } });
  const emptyRun = makeConfig(emptyIdentity);
  const emptyResult = await runQoderAcpCommand(emptyRun.config);
  assert.equal(emptyResult.status, 'failed');
  assert.match(emptyResult.error, /returned no session ID/);
  assert.equal(emptyIdentity.calls.filter((call) => call.method === 'session/new').length, 1);
  assert.equal(emptyIdentity.calls.some((call) => call.method === 'session/resume' || call.method === 'session/load'), false);
});

test('answers permission requests automatically under never + danger-full-access', async (t) => {
  t.after(() => closeQoderAcpSessions());
  const fake = new FakeAcpClient();
  const { config, events } = makeConfig(fake);
  const running = runQoderAcpCommand(config);
  await within(fake.promptStarted.promise, 'prompt start');

  fake.emitPermission();
  fake.emitPermission({ id: 'permission-2', options: [{ optionId: 'always', kind: 'allow_always' }] });
  fake.emitPermission({ id: 'permission-3', options: [{ optionId: 'no', kind: 'reject_once' }] });
  fake.emitPermission({ id: 'permission-4', sessionId: 'other-session' });
  assert.deepEqual(fake.responses, [
    { id: 'permission-1', result: { outcome: { outcome: 'selected', optionId: 'allow' } } },
    { id: 'permission-2', result: { outcome: { outcome: 'selected', optionId: 'always' } } },
    { id: 'permission-3', result: { outcome: { outcome: 'cancelled' } } },
    { id: 'permission-4', result: { outcome: { outcome: 'cancelled' } } },
  ]);

  fake.finishPrompt({ stopReason: 'end_turn' });
  await running;
  fake.emitPermission({ id: 'permission-5' });
  assert.deepEqual(fake.responses.at(-1), { id: 'permission-5', result: { outcome: { outcome: 'cancelled' } } });
  assert.equal(events.some((event) => event.kind.startsWith('authorization.')), false);
});

test('refuses non-fixed approval or sandbox policies before starting ACP', async (t) => {
  t.after(() => closeQoderAcpSessions());
  for (const override of [
    { appServerApprovalPolicy: 'on-request' },
    { appServerSandbox: 'read-only' },
    { appServerSandbox: 'workspace-write' },
  ]) {
    const fake = new FakeAcpClient();
    const { config, events } = makeConfig(fake, override);
    const result = await runQoderAcpCommand(config);
    assert.equal(result.status, 'failed');
    assert.match(result.error, /requires approval policy never and danger-full-access/);
    assert.equal(fake.started, 0);
    assert.equal(fake.calls.length, 0);
    assert.equal(events.at(-1).payload.success, false);
  }
});

test('cancels an active prompt and returns interrupted status', async (t) => {
  t.after(() => closeQoderAcpSessions());
  const fake = new FakeAcpClient();
  fake.onCancel = () => fake.finishPrompt({ stopReason: 'cancelled' });
  const { config, controller, events } = makeConfig(fake);
  const running = runQoderAcpCommand(config);
  await within(fake.promptStarted.promise, 'prompt start');

  controller.abort();
  const result = await running;
  assert.equal(result.status, 'interrupted');
  assert.equal(result.cliSessionId, 'native-new');
  assert.equal(fake.notifications.some((notification) => notification.method === 'session/cancel'), true);
  assert.equal(fake.closed, 0);
  assert.equal(events.some((event) => event.kind === 'session.error'), false);
  const complete = events.at(-1);
  assert.equal(complete.kind, 'session.complete');
  assert.equal(complete.payload.success, false);
  assert.equal(complete.payload.aborted, true);
});

test('closes a hung ACP client five seconds after cancellation', async (t) => {
  t.after(() => closeQoderAcpSessions());
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => t.mock.timers.reset());
  const fake = new FakeAcpClient();
  const { config, controller } = makeConfig(fake);
  const running = runQoderAcpCommand(config);
  await fake.promptStarted.promise;

  controller.abort();
  assert.equal(fake.closed, 0);
  t.mock.timers.tick(5_000);
  const result = await running;
  assert.equal(result.status, 'interrupted');
  assert.equal(fake.closed, 1);
  assert.match(result.error, /client closed/);
});

test('discovers models through an injected restricted client without substituting a model', async (t) => {
  t.after(() => closeQoderAcpSessions());
  const fake = new FakeAcpClient({
    capabilities: { sessionCapabilities: { close: true }, promptCapabilities: { image: true } },
  });
  const models = await discoverQoderAcpModels({ workspace: WORKSPACE, client: fake });
  assert.deepEqual(fake.calls.map((call) => call.method), ['session/new', 'session/close']);
  assert.deepEqual(fake.calls[0].params, { cwd: WORKSPACE, mcpServers: [] });
  assert.deepEqual(models, [
    {
      id: 'deepseek-flash', label: 'DeepSeek-Flash', description: 'fast', isDefault: true,
      reasoningEfforts: [], defaultReasoningEffort: null, inputModalities: ['text', 'image'],
    },
    {
      id: 'other-model', label: 'Other Model', description: '', isDefault: false,
      reasoningEfforts: [], defaultReasoningEffort: null, inputModalities: ['text', 'image'],
    },
  ]);
  assert.equal(fake.closed, 1);

  assert.equal(resolveQoderAcpModel(models, 'DeepSeek-Flash'), 'deepseek-flash');
  assert.equal(resolveQoderAcpModel(models, 'other-model'), 'other-model');
  assert.throws(() => resolveQoderAcpModel(models, 'missing-model'), /unavailable or ambiguous/);
  assert.throws(() => resolveQoderAcpModel([
    { id: 'one', label: 'Same' },
    { id: 'two', label: 'Same' },
  ], 'same'), /unavailable or ambiguous/);

  const empty = new FakeAcpClient({ newResult: { sessionId: 'native-empty', models: { availableModels: [] } } });
  await assert.rejects(discoverQoderAcpModels({ workspace: WORKSPACE, client: empty }), /empty model catalog/);
  assert.equal(empty.closed, 1);
});

test('caches a successful model catalog per workspace and launch identity, and expires it', async (t) => {
  t.after(() => { invalidateQoderAcpModels(); closeQoderAcpSessions(); });
  invalidateQoderAcpModels();
  let clock = 1_000;
  const now = () => clock;
  const first = new FakeAcpClient();
  const models = await discoverQoderAcpModels({ workspace: WORKSPACE, client: first, cacheModels: true, now });
  assert.deepEqual(first.calls.map((call) => call.method), ['session/new']);
  assert.equal(first.closed, 1);
  assert.equal(models[0].id, 'deepseek-flash');
  assert.equal(qoderModelCatalogStatus().length, 1);

  const cached = new FakeAcpClient();
  const cachedModels = await discoverQoderAcpModels({ workspace: WORKSPACE, client: cached, cacheModels: true, now });
  assert.equal(cached.started, 0);
  assert.equal(cached.calls.length, 0);
  assert.equal(cached.closed, 0);
  assert.deepEqual(cachedModels, models);
  cachedModels[0].reasoningEfforts.push('mutated');
  assert.deepEqual(
    (await discoverQoderAcpModels({ workspace: WORKSPACE, client: new FakeAcpClient(), cacheModels: true, now }))[0].reasoningEfforts,
    [],
    'cached values must be cloned per caller',
  );

  const otherWorkspace = await mkdtemp(join(tmpdir(), 'squad-catalog-other-'));
  t.after(() => rm(otherWorkspace, { recursive: true, force: true }));
  const other = new FakeAcpClient();
  await discoverQoderAcpModels({ workspace: otherWorkspace, client: other, cacheModels: true, now });
  assert.deepEqual(other.calls.map((call) => call.method), ['session/new']);

  const differentLaunch = new FakeAcpClient();
  differentLaunch.options = { ...differentLaunch.options, env: { FAKE: '2' } };
  await discoverQoderAcpModels({ workspace: WORKSPACE, client: differentLaunch, cacheModels: true, now });
  assert.deepEqual(differentLaunch.calls.map((call) => call.method), ['session/new']);

  clock += 5 * 60 * 1000;
  const expired = new FakeAcpClient();
  await discoverQoderAcpModels({ workspace: WORKSPACE, client: expired, cacheModels: true, now });
  assert.deepEqual(expired.calls.map((call) => call.method), ['session/new']);
});

test('never caches failed or empty catalogs and supports explicit invalidation', async (t) => {
  t.after(() => { invalidateQoderAcpModels(); closeQoderAcpSessions(); });
  invalidateQoderAcpModels();
  const failing = new FakeAcpClient();
  failing.request = async (method) => {
    failing.calls.push({ method });
    throw new Error('model directory offline');
  };
  await assert.rejects(
    discoverQoderAcpModels({ workspace: WORKSPACE, client: failing, cacheModels: true }),
    /model directory offline/,
  );
  assert.equal(qoderModelCatalogStatus().length, 0);

  const empty = new FakeAcpClient({ newResult: { sessionId: 'native-empty', models: { availableModels: [] } } });
  await assert.rejects(
    discoverQoderAcpModels({ workspace: WORKSPACE, client: empty, cacheModels: true }),
    /empty model catalog/,
  );
  assert.equal(qoderModelCatalogStatus().length, 0);

  const healthy = new FakeAcpClient();
  await discoverQoderAcpModels({ workspace: WORKSPACE, client: healthy, cacheModels: true });
  assert.equal(qoderModelCatalogStatus().length, 1);
  assert.equal(invalidateQoderAcpModels({ workspace: WORKSPACE }), 0);
  const afterInvalidation = new FakeAcpClient();
  await discoverQoderAcpModels({ workspace: WORKSPACE, client: afterInvalidation, cacheModels: true });
  assert.deepEqual(afterInvalidation.calls.map((call) => call.method), ['session/new']);
  invalidateQoderAcpModels();
});

test('persists only catalog metadata so a later process can reuse a successful discovery', async (t) => {
  t.after(() => { invalidateQoderAcpModels(); closeQoderAcpSessions(); });
  invalidateQoderAcpModels();
  const root = await mkdtemp(join(tmpdir(), 'squad-catalog-file-'));
  const workspace = join(root, 'workspace');
  const otherWorkspace = join(root, 'other-workspace');
  const cacheDir = join(root, 'catalog');
  await Promise.all([mkdir(workspace), mkdir(otherWorkspace)]);
  t.after(() => rm(root, { recursive: true, force: true }));
  let clock = 1_000;
  const now = () => clock;
  const secret = 'qoder-token-do-not-persist';
  const client = (env = { FAKE: '1' }) => {
    const fake = new FakeAcpClient();
    fake.options = { command: 'fake-qodercli', cwd: workspace, env: { ...env, QODER_API_TOKEN: secret }, args: ['--fake'] };
    return fake;
  };
  const options = (overrides = {}) => ({
    workspace, cacheModels: true, modelCatalogDir: cacheDir, now, modelCatalogTtlMs: 60 * 60 * 1000, ...overrides,
  });

  const first = client();
  const models = await discoverQoderAcpModels({ ...options(), client: first });
  assert.deepEqual(first.calls.map((call) => call.method), ['session/new']);
  assert.equal(models[0].id, 'deepseek-flash');

  const [file] = await readdir(cacheDir);
  const raw = await readFile(join(cacheDir, file), 'utf8');
  const stored = JSON.parse(raw);
  assert.equal(stored.schemaVersion, 1);
  assert.equal(stored.workspace, await realpath(workspace));
  assert.match(stored.identityHash, /^[a-f0-9]{64}$/);
  assert.equal(stored.expiresAt - stored.cachedAt, 5 * 60 * 1000, 'TTL is clamped to five minutes');
  assert.deepEqual(stored.models, models);
  assert.equal(raw.includes(secret), false, 'credentials never reach the catalog file');
  assert.equal(raw.includes('QODER_API_TOKEN'), false);
  assert.equal(raw.includes('FAKE'), false, 'the launch environment is not persisted');

  // A separate CLI process has an empty in-memory cache; the persisted record alone must serve it.
  assert.equal(invalidateQoderAcpModels({ workspace }), 0);
  const reused = client();
  const reusedModels = await discoverQoderAcpModels({ ...options(), client: reused });
  assert.equal(reused.started, 0);
  assert.deepEqual(reused.calls, []);
  assert.deepEqual(reusedModels, models);
  assert.equal(resolveQoderAcpModel(reusedModels, 'DeepSeek-Flash'), 'deepseek-flash');

  assert.equal(invalidateQoderAcpModels({ workspace, cacheDir }), 0);
  assert.deepEqual(await readdir(cacheDir), []);
  const afterInvalidation = client();
  await discoverQoderAcpModels({ ...options(), client: afterInvalidation });
  assert.deepEqual(afterInvalidation.calls.map((call) => call.method), ['session/new']);

  const expiredFile = join(cacheDir, (await readdir(cacheDir))[0]);
  const expiredRecord = JSON.parse(await readFile(expiredFile, 'utf8'));
  clock = expiredRecord.expiresAt;
  const expired = client();
  await discoverQoderAcpModels({ ...options(), client: expired });
  assert.deepEqual(expired.calls.map((call) => call.method), ['session/new'], 'an expired record re-probes');

  const identity = client({ FAKE: '2' });
  await discoverQoderAcpModels({ ...options(), client: identity });
  assert.deepEqual(identity.calls.map((call) => call.method), ['session/new'], 'launch identity changes re-probe');

  const other = client();
  await discoverQoderAcpModels({ ...options({ workspace: otherWorkspace }), client: other });
  assert.deepEqual(other.calls.map((call) => call.method), ['session/new'], 'workspace changes re-probe');

  const corruptDir = join(root, 'corrupt-catalog');
  const corruptWorkspace = join(root, 'corrupt-workspace');
  await mkdir(corruptWorkspace);
  const seed = client();
  await discoverQoderAcpModels({ workspace: corruptWorkspace, cacheModels: true, modelCatalogDir: corruptDir, client: seed });
  const [corruptName] = await readdir(corruptDir);
  await writeFile(join(corruptDir, corruptName), '{not json');
  invalidateQoderAcpModels({ workspace: corruptWorkspace });
  const repaired = client();
  const repairedModels = await discoverQoderAcpModels({ workspace: corruptWorkspace, cacheModels: true, modelCatalogDir: corruptDir, client: repaired });
  assert.deepEqual(repaired.calls.map((call) => call.method), ['session/new'], 'a corrupt record re-probes');
  assert.equal(repairedModels[0].id, 'deepseek-flash');
  assert.equal(JSON.parse(await readFile(join(corruptDir, corruptName), 'utf8')).schemaVersion, 1);

  const failureDir = join(root, 'failure-catalog');
  const failing = client();
  failing.request = async () => { throw new Error('model directory offline'); };
  await assert.rejects(
    discoverQoderAcpModels({ workspace, cacheModels: true, modelCatalogDir: failureDir, client: failing }),
    /model directory offline/,
  );
  assert.deepEqual(await readdir(failureDir).catch(() => []), [], 'a failed discovery is never persisted');

  const emptyDir = join(root, 'empty-catalog');
  const empty = new FakeAcpClient({ newResult: { sessionId: 'native-empty', models: { availableModels: [] } } });
  await assert.rejects(
    discoverQoderAcpModels({ workspace, cacheModels: true, modelCatalogDir: emptyDir, client: empty }),
    /empty model catalog/,
  );
  assert.deepEqual(await readdir(emptyDir).catch(() => []), [], 'an empty catalog is never persisted');
});

test('separate node processes on the same fixture CLI reuse one upstream model discovery', async (t) => {
  t.after(() => { invalidateQoderAcpModels(); closeQoderAcpSessions(); });
  invalidateQoderAcpModels();
  const root = await mkdtemp(join(tmpdir(), 'squad-catalog-process-'));
  const workspace = join(root, 'workspace');
  const otherWorkspace = join(root, 'other-workspace');
  const bin = join(root, 'bin');
  const cacheDir = join(root, 'data', 'model-catalog');
  const log = join(root, 'discovery.log');
  const serverPath = join(root, 'peer.mjs');
  const wrapperPath = join(bin, 'qodercli');
  const runnerPath = fileURLToPath(new URL('../cli/lib/qoder/qoder-acp-runner.mjs', import.meta.url));
  await Promise.all([mkdir(workspace), mkdir(otherWorkspace), mkdir(bin)]);
  t.after(() => rm(root, { recursive: true, force: true }));

  const peerSource = `
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
const models = { currentModelId: 'flash', availableModels: [
  { modelId: 'flash', name: 'DeepSeek-Flash', description: 'fast' },
  { modelId: 'other', name: 'Other Model' },
] };
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: {
      protocolVersion: 1,
      agentCapabilities: { sessionCapabilities: { close: true } },
    } });
    return;
  }
  if (message.method === 'session/new') {
    appendFileSync(${JSON.stringify(log)}, 'session/new\\n');
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'native-' + process.pid, models } });
    return;
  }
  send({ jsonrpc: '2.0', id: message.id, result: {} });
});
`;
  await writeFile(serverPath, peerSource);
  await writeFile(wrapperPath, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(serverPath)} "$@"\n`, { mode: 0o755 });
  await chmod(wrapperPath, 0o755);

  const childPath = join(root, 'discover.mjs');
  await writeFile(childPath, `
import { discoverQoderAcpModels } from ${JSON.stringify(pathToFileURL(runnerPath).href)};
const input = JSON.parse(process.env.SQUAD_CATALOG_INPUT);
if (process.env.SQUAD_CLOCK_SKEW) {
  const skew = Number(process.env.SQUAD_CLOCK_SKEW);
  input.now = () => Date.now() + skew;
}
const models = await discoverQoderAcpModels(input);
process.stdout.write(JSON.stringify(models));
`);

  const run = (input, { skew = null } = {}) => new Promise((resolve, reject) => {
    execFile(process.execPath, [childPath], {
      cwd: workspace,
      timeout: 20_000,
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}/usr/bin${delimiter}/bin`,
        HOME: root,
        ...(skew === null ? {} : { SQUAD_CLOCK_SKEW: String(skew) }),
        SQUAD_CATALOG_INPUT: JSON.stringify({ workspace, qoderAcpCommand: wrapperPath, cacheModels: true, modelCatalogDir: cacheDir, modelCatalogTtlMs: 60 * 60 * 1000, ...input }),
      },
    }, (error, stdout, stderr) => error ? reject(Object.assign(error, { stderr })) : resolve(JSON.parse(stdout)));
  });
  const logLines = async () => (await readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);

  const agentEnv = (extra = {}) => ({ HOME: root, PATH: `${bin}${delimiter}/usr/bin${delimiter}/bin`, QODER_API_TOKEN: 'cross-process-secret', ...extra });

  const firstModels = await run({ agentEnv: agentEnv() });
  assert.equal(firstModels[0].id, 'flash');
  assert.deepEqual(await logLines(), ['session/new']);
  const files = await readdir(cacheDir);
  assert.equal(files.length, 1);
  for (const name of files) {
    const raw = await readFile(join(cacheDir, name), 'utf8');
    assert.equal(raw.includes('cross-process-secret'), false);
    assert.equal(raw.includes('QODER_API_TOKEN'), false);
  }

  const secondModels = await run({ agentEnv: agentEnv() });
  assert.deepEqual(secondModels, firstModels);
  assert.deepEqual(await logLines(), ['session/new'], 'the second process must not create another upstream discovery session');

  const changedIdentity = await run({ agentEnv: agentEnv({ QODER_PROFILE: 'second-account' }) });
  assert.ok(changedIdentity.length > 0);
  assert.equal((await logLines()).length, 2, 'a launch identity change re-probes');

  const otherWorkspaceModels = await run({ workspace: otherWorkspace, agentEnv: agentEnv() });
  assert.ok(otherWorkspaceModels.length > 0);
  assert.equal((await logLines()).length, 3, 'a workspace change re-probes');

  await run({ agentEnv: agentEnv() }, { skew: 6 * 60 * 1000 });
  assert.equal((await logLines()).length, 4, 'an expired persisted catalog re-probes');
});

test('requires a real workspace directory before model discovery', async () => {
  const fake = new FakeAcpClient();
  await assert.rejects(
    discoverQoderAcpModels({ workspace: join(tmpdir(), `missing-workspace-${randomUUID()}`), client: fake }),
    /not an existing directory/,
  );
  assert.equal(fake.started, 0);
  assert.equal(fake.calls.length, 0);
});

test('resolves qodercli only from existing PATH and user install directories', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'squad-qoder-bin-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const pathDir = join(root, 'path-bin');
  const localDir = join(home, '.local', 'bin');
  const qoderDir = join(home, '.qoder', 'bin');
  for (const dir of [pathDir, localDir, qoderDir]) await mkdir(dir, { recursive: true });
  const install = async (dir) => {
    const file = join(dir, 'qodercli');
    await writeFile(file, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await chmod(file, 0o755);
    return file;
  };

  const localBinary = await install(localDir);
  assert.equal(resolveQoderAcpCommand('qodercli', { env: { HOME: home, PATH: '/definitely/missing' } }), localBinary);
  assert.equal(resolveQoderAcpCommand(localBinary, { env: { HOME: home, PATH: '/definitely/missing' } }), localBinary);

  const qoderBinary = await install(qoderDir);
  await rm(localBinary);
  assert.equal(resolveQoderAcpCommand('qodercli', { env: { HOME: home, PATH: '/definitely/missing' } }), qoderBinary);

  const pathBinary = await install(pathDir);
  assert.equal(resolveQoderAcpCommand('qodercli', { env: { HOME: home, PATH: pathDir } }), pathBinary);
  assert.throws(
    () => resolveQoderAcpCommand('missing-qodercli', { env: { HOME: home, PATH: pathDir } }),
    /不会自动安装/,
  );

  const env = qoderRuntimeEnv({
    HOME: home, PATH: pathDir,
    HTTPS_PROXY: 'http://127.0.0.1:7890', ALL_PROXY: 'socks5://127.0.0.1:7890', http_proxy: 'http://proxy.example:8080',
  });
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:7890');
  assert.equal(env.ALL_PROXY, 'socks5://127.0.0.1:7890');
  assert.equal(env.http_proxy, 'http://proxy.example:8080');
  const pathEntries = env.PATH.split(delimiter);
  assert.equal(pathEntries[0], pathDir);
  assert.equal(pathEntries.includes(localDir), true);
  assert.equal(pathEntries.includes(qoderDir), true);
});

test('ACP client advertises codex-squad and routes ACP server requests', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'squad-qoder-acp-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const serverPath = join(root, 'server.mjs');
  const wrapperPath = join(root, 'qodercli');
  const serverSource = `
import { createInterface } from 'node:readline';
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: {
      protocolVersion: 1,
      agentCapabilities: { sessionCapabilities: { close: true }, loadSession: true },
      clientInfo: message.params.clientInfo,
    } });
    return;
  }
  if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: {
      sessionId: 'native-process',
      models: { currentModelId: 'process-model', availableModels: [{ modelId: 'process-model', name: 'Process Model' }] },
    } });
    send({ jsonrpc: '2.0', id: 'permission-process', method: 'session/request_permission', params: {
      sessionId: 'native-process',
      toolCall: { toolCallId: 'tool-process', title: 'write' },
      options: [{ optionId: 'allow', kind: 'allow_once' }],
    } });
    send({ jsonrpc: '2.0', id: 'unsupported-process', method: 'session/other_request', params: {} });
    return;
  }
  if (message.id === 'permission-process') {
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'native-process', update: {
      sessionUpdate: 'agent_message_chunk', messageId: 'permission', content: { type: 'text', text: 'PERMISSION-ALLOWED' },
    } } });
    return;
  }
  if (message.id === 'unsupported-process') {
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'native-process', update: {
      sessionUpdate: 'agent_message_chunk', messageId: 'unsupported', content: { type: 'text', text: 'UNSUPPORTED-REJECTED' },
    } } });
  }
});
`;
  await writeFile(serverPath, serverSource);
  await writeFile(wrapperPath, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(serverPath)} "$@"\n`, { mode: 0o755 });
  await chmod(wrapperPath, 0o755);

  const client = new QoderAcpClient({ command: wrapperPath, cwd: root, env: { HOME: root, PATH: '/usr/bin:/bin' } });
  t.after(() => client.close());
  const notifications = [];
  const permission = deferred();
  const allowed = deferred();
  const unsupported = deferred();
  client.onNotify((message) => {
    if (message.method !== 'session/update') return;
    const text = message.params?.update?.content?.text;
    notifications.push(text);
    if (text === 'PERMISSION-ALLOWED') allowed.resolve();
    if (text === 'UNSUPPORTED-REJECTED') unsupported.resolve();
  });
  client.onServerRequest((message) => permission.resolve(message));

  const initialized = await within(client.ensureStarted(), 'ACP initialize');
  assert.equal(initialized.clientInfo.name, 'codex-squad');
  assert.equal(initialized.clientInfo.version, '1.0.0');
  const session = await within(client.request('session/new', { cwd: root, mcpServers: [] }), 'session/new');
  assert.equal(session.sessionId, 'native-process');

  const request = await within(permission.promise, 'permission request');
  assert.equal(request.id, 'permission-process');
  assert.equal(request.params.sessionId, 'native-process');
  client.respondToServerRequest(request.id, { outcome: { outcome: 'selected', optionId: 'allow' } });
  await within(allowed.promise, 'permission response');
  await within(unsupported.promise, 'unsupported request rejection');
  assert.deepEqual(notifications.sort(), ['PERMISSION-ALLOWED', 'UNSUPPORTED-REJECTED']);

  const child = client.child;
  const exited = child ? new Promise((resolve) => child.once('exit', resolve)) : Promise.resolve();
  client.close();
  await within(exited, 'ACP process exit', 3_000);
});

test('qoder executor modules import only Node built-ins and sibling files', async () => {
  const files = (await readdir(QODER_DIR)).filter((file) => file.endsWith('.mjs')).sort();
  assert.deepEqual(files, [
    'process-identity.mjs',
    'qoder-acp-client.mjs',
    'qoder-acp-runner.mjs',
    'qoder-assistant-segments.mjs',
    'qoder-executable.mjs',
  ]);
  for (const file of files) {
    const source = await readFile(join(QODER_DIR, file), 'utf8');
    for (const match of source.matchAll(/import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g)) {
      const specifier = match[1];
      assert.ok(specifier.startsWith('node:') || specifier.startsWith('./'), `${file} imports ${specifier}`);
      if (specifier.startsWith('./')) assert.equal(existsSync(join(QODER_DIR, specifier)), true, `${file} -> ${specifier}`);
    }
  }
});

test('source manifest marks a historical local snapshot and records SHA-256 digests', async () => {
  const manifest = JSON.parse(await readFile(join(QODER_DIR, 'source.json'), 'utf8'));
  assert.match(manifest.source, /historical private local snapshot/);
  assert.match(manifest.source, /not a public upstream/);
  assert.deepEqual(Object.keys(manifest.files).sort(), [
    'local-agent-command.mjs',
    'qoder-acp-client.mjs',
    'qoder-acp-runner.mjs',
    'qoder-assistant-segments.mjs',
    'qoder-runtime-env.mjs',
  ]);
  for (const digest of Object.values(manifest.files)) assert.match(digest, /^[a-f0-9]{64}$/);
});

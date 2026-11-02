import {createHash, randomUUID} from 'node:crypto';
import {mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import { QoderAcpClient } from './qoder-acp-client.mjs';
import { createQoderAssistantSegments } from './qoder-assistant-segments.mjs';

const SRC = 'codex-squad-qoder-acp';
const PERMISSION_MODE = 'bypassPermissions';
const FALLBACK_PERMISSION_MODE = 'default';
const YOLO_MODE_DETAILS = 'unknown permission_mode: yolo';
const DEFAULT_MODEL_CATALOG_TTL_MS = 5 * 60 * 1000;
const CATALOG_FILE_SCHEMA = 1;
const sessions = new Map();
const modelCatalogCache = new Map();

function catalogKey(cwd, identity) {
  return `${cwd}\n${identity}`;
}
function sha256(value){return createHash('sha256').update(String(value)).digest('hex');}
function cloneModels(models){
  return models.map((model)=>({...model,reasoningEfforts:[...(model.reasoningEfforts||[])],inputModalities:[...(model.inputModalities||[])]}));
}
function validCatalogModel(model){
  return model!==null&&typeof model==='object'&&!Array.isArray(model)
    &&typeof model.id==='string'&&Boolean(model.id)
    &&typeof model.label==='string'&&typeof model.description==='string'
    &&typeof model.isDefault==='boolean'
    &&Array.isArray(model.reasoningEfforts)&&model.reasoningEfforts.every((item)=>typeof item==='string')
    &&(model.defaultReasoningEffort===null||typeof model.defaultReasoningEffort==='string')
    &&Array.isArray(model.inputModalities)&&model.inputModalities.every((item)=>typeof item==='string');
}
function catalogFile(cacheDir,keyDigest){return join(cacheDir,`${keyDigest}.json`);}
function readPersistentCatalog({cacheDir,keyDigest,cwd,identityHash,now}){
  const file=catalogFile(cacheDir,keyDigest);
  let raw;
  try{raw=readFileSync(file,'utf8');}catch{return null;}
  try{
    const value=JSON.parse(raw);
    const valid=value!==null&&typeof value==='object'
      &&value.schemaVersion===CATALOG_FILE_SCHEMA
      &&value.workspace===cwd
      &&value.identityHash===identityHash
      &&Number.isFinite(value.cachedAt)&&Number.isFinite(value.expiresAt)
      &&Array.isArray(value.models)&&value.models.length>0&&value.models.every(validCatalogModel);
    if(!valid||!(value.expiresAt>now)){
      try{rmSync(file,{force:true});}catch{}
      return null;
    }
    return {models:cloneModels(value.models),cachedAt:value.cachedAt,expiresAt:value.expiresAt};
  }catch{
    try{rmSync(file,{force:true});}catch{}
    return null;
  }
}
/** Persists only the catalog and its identity digest, never the launch environment. */
function writePersistentCatalog({cacheDir,keyDigest,cwd,identityHash,models,cachedAt,expiresAt}){
  try{
    mkdirSync(cacheDir,{recursive:true,mode:0o700});
    const target=catalogFile(cacheDir,keyDigest);
    const temp=`${target}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temp,`${JSON.stringify({
      schemaVersion:CATALOG_FILE_SCHEMA,workspace:cwd,identityHash,cachedAt,expiresAt,models,
    },null,2)}\n`,{mode:0o600});
    renameSync(temp,target);
  }catch{
    // A cache write failure must never turn a valid discovery into a failed dispatch.
  }
}
function removePersistentCatalogs(cacheDir,workspace){
  if(!cacheDir)return;
  if(workspace===undefined){
    try{rmSync(cacheDir,{recursive:true,force:true});}catch{}
    return;
  }
  const wanted=resolve(workspace);
  let real=null;
  try{real=realpathSync(wanted);}catch{}
  let files=[];
  try{files=readdirSync(cacheDir);}catch{return;}
  for(const name of files){
    if(!name.endsWith('.json'))continue;
    const file=join(cacheDir,name);
    try{
      const value=JSON.parse(readFileSync(file,'utf8'));
      if(value?.workspace===wanted||(real&&value?.workspace===real))rmSync(file,{force:true});
    }catch{}
  }
}

function realWorkspace(value) {
  const target = resolve(value || process.cwd());
  let found;
  try { found = statSync(target); } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`Qoder workspace is not an existing directory: ${target}`);
    throw error;
  }
  if (!found.isDirectory()) throw new Error(`Qoder workspace is not an existing directory: ${target}`);
  return realpathSync(target);
}

/**
 * Drops cached catalogs after an explicit installation/config/model change.
 * A failed or empty discovery is never written to this cache. When cacheDir
 * is supplied, the same invalidation also removes the persisted records.
 */
export function invalidateQoderAcpModels({ workspace, cacheDir } = {}) {
  removePersistentCatalogs(cacheDir, workspace);
  if (workspace === undefined) {
    modelCatalogCache.clear();
    return modelCatalogCache.size;
  }
  const prefix = `${resolve(workspace)}\n`;
  let realPrefix = null;
  try { realPrefix = `${realpathSync(resolve(workspace))}\n`; } catch {}
  for (const key of [...modelCatalogCache.keys()]) {
    if (key.startsWith(prefix) || (realPrefix && key.startsWith(realPrefix))) modelCatalogCache.delete(key);
  }
  return modelCatalogCache.size;
}

export function qoderModelCatalogStatus() {
  return [...modelCatalogCache.entries()].map(([key, value]) => ({
    workspace: key.split('\n')[0], cachedAt: value.cachedAt, expiresAt: value.expiresAt, models: value.models.length,
  }));
}

function rpcDetails(error) {
  const data = error?.rpcData;
  return data && typeof data === 'object' && typeof data.details === 'string' ? data.details : null;
}

function isYoloModeRejection(error) {
  return error?.rpcCode === -32603 && rpcDetails(error) === YOLO_MODE_DETAILS;
}

function describeAcpError(error) {
  const message = String(error?.message || error);
  const fields = [];
  if (error?.isRpcError && error.rpcCode !== undefined) fields.push(`code ${error.rpcCode}`);
  const details = rpcDetails(error);
  if (details !== null) fields.push(`details ${details}`);
  else if (error?.rpcData !== undefined) {
    try { fields.push(`data ${JSON.stringify(error.rpcData)}`); } catch {}
  }
  return fields.length ? `${message} (${fields.join(', ')})` : message;
}

function stageFailure(stage, error) {
  return new Error(`Qoder ACP ${stage} failed: ${describeAcpError(error)}`, { cause: error });
}

async function applyPermissionMode(session, modeId) {
  return session.client.request('session/set_mode', { sessionId: session.nativeId, modeId });
}

async function setPermissionMode(session) {
  try {
    await applyPermissionMode(session, PERMISSION_MODE);
  } catch (error) {
    if (!isYoloModeRejection(error)) throw stageFailure('session/set_mode', error);
    try {
      await applyPermissionMode(session, FALLBACK_PERMISSION_MODE);
    } catch (fallbackError) {
      throw new Error(
        `Qoder ACP session/set_mode failed: ${describeAcpError(error)}; fallback permission mode ${FALLBACK_PERMISSION_MODE} failed: ${describeAcpError(fallbackError)}`,
        { cause: fallbackError },
      );
    }
  }
}

function acpArgs(config) {
  if (Array.isArray(config.qoderAcpArgs)) return [...config.qoderAcpArgs];
  if (Array.isArray(config.args)) return [...config.args];
  return [];
}

function createClient(config, cwd) {
  return new QoderAcpClient({
    command: config.qoderAcpCommand || 'qodercli',
    cwd,
    env: { ...(config.agentEnv || {}) },
    args: acpArgs(config),
  });
}

function launchIdentity(client) {
  const options = client?.options || {};
  return JSON.stringify([
    options.command || '',
    options.args || [],
    Object.entries(options.env || {}).sort(([left], [right]) => left.localeCompare(right)),
  ]);
}

function assertFixedExecutionPolicy(config) {
  if (config.appServerApprovalPolicy !== 'never' || config.appServerSandbox !== 'danger-full-access') {
    throw new Error('Qoder ACP fixed execution requires approval policy never and danger-full-access');
  }
}

export async function runQoderAcpCommand(config) {
  const sessionId = config.sessionId || `qoder-${randomUUID()}`;
  let session = sessions.get(sessionId);
  if (session?.running) throw new Error('Qoder session already has an active command');
  const workspace = resolve(config.workspace || process.cwd());
  if (session && session.workspace !== workspace) throw new Error('Qoder session cannot change workspace');
  const client = config.qoderAcpClient || session?.client || createClient(config, workspace);
  if (session && session.launchIdentity !== launchIdentity(client)) throw new Error('Qoder session cannot change its executable or environment');
  if (session?.nativeId && config.cliSessionId && session.nativeId !== config.cliSessionId) throw new Error('Qoder native session identity changed');
  if (!session) {
    session = createSession(sessionId, workspace, client, config);
    sessions.set(sessionId, session);
  }
  session.onSessionEvent = config.onSessionEvent;
  session.running = true;
  session.stopped = false;
  session.error = null;
  session.text = '';
  session.finalMessage = null;
  session.usage = null;
  const onAbort = () => stopSession(session);
  config.signal?.addEventListener('abort', onAbort, { once: true });
  if (config.signal?.aborted) onAbort();
  session.emit('session.started', {
    content: 'Qoder ACP command started',
    command: `${client.options?.command || 'qodercli'} --acp`,
    agentType: 'qoder',
    agentAlias: config.agentAlias,
    taskDescription: config.taskDescription,
  });
  let status = 'completed';
  try {
    if (session.stopped) throw new Error('Qoder command cancelled before startup');
    assertFixedExecutionPolicy(config);
    await session.client.ensureStarted();
    if (!session.ready) {
      const nativeId = session.nativeId || config.cliSessionId;
      if (nativeId) {
        const canResume = Boolean(session.client.capabilities.sessionCapabilities?.resume);
        if (!canResume && !session.client.capabilities.loadSession) throw new Error('Qoder ACP does not support loading sessions');
        const result = await session.client.request(canResume ? 'session/resume' : 'session/load', { sessionId: nativeId, cwd: workspace, mcpServers: [] });
        session.models = normalizeQoderAcpModels(result?.models);
        session.nativeId = nativeId;
      } else {
        const result = await session.client.request('session/new', { cwd: workspace, mcpServers: [] });
        if (!result?.sessionId) throw new Error('Qoder ACP session/new returned no session ID');
        session.nativeId = result.sessionId;
        session.models = normalizeQoderAcpModels(result.models);
      }
      session.ready = true;
    }
    if (config.qoderAcpModel) {
      await session.client.request('session/set_model', { sessionId: session.nativeId, modelId: resolveQoderAcpModel(session.models, config.qoderAcpModel) });
    }
    await setPermissionMode(session);
    if (session.stopped) status = 'interrupted';
    else {
      session.emit('session.running', { status: 'running' });
      status = await prompt(session, config.stdin || config.taskDescription || '');
    }
  } catch (error) {
    status = session.stopped ? 'interrupted' : 'failed';
    session.error = String(error?.message || error);
    session.emit('session.error', { content: session.error, level: 'error' });
  } finally {
    config.signal?.removeEventListener('abort', onAbort);
    clearTimeout(session.cancelTimer);
    session.cancelTimer = null;
    session.running = false;
    session.prompting = false;
  }
  session.emit('session.complete', {
    content: `Turn ${status}`,
    success: status === 'completed',
    idle: status === 'completed',
    aborted: status === 'interrupted',
    metadata: { eventType: 'turn/completed', status, threadId: session.nativeId, turnId: session.turnId },
  });
  return {
    sessionId,
    status,
    uploaded: session.uploaded,
    text: session.text,
    finalText: session.finalMessage?.text || null,
    cliSessionId: session.nativeId,
    nativeSessionId: session.nativeId,
    turnId: session.turnId,
    ...(session.usage ? { usage: session.usage } : {}),
    ...(session.error ? { error: session.error } : {}),
  };
}

async function prompt(session, content) {
  const text = String(content || '');
  if (!text) return 'completed';
  if (session.stopped) return 'interrupted';
  session.turnId = randomUUID();
  session.assistantSegments = createQoderAssistantSegments();
  session.tools = new Map();
  session.thoughtSignaled = false;
  session.prompting = true;
  try {
    const result = await session.client.request('session/prompt', {
      sessionId: session.nativeId,
      prompt: [{ type: 'text', text }],
    }, 0, {
      onSent: () => session.emit('session.prompt_submitted', {
        at: new Date().toISOString(),
        metadata: { eventType: 'prompt/submitted', turnId: session.turnId, threadId: session.nativeId },
      }),
    });
    if (result?.usage && typeof result.usage === 'object') session.usage = result.usage;
    const finalSegment = session.assistantSegments.complete();
    if (finalSegment) emitMessage(session, finalSegment, 'completed');
    session.text = session.assistantSegments.text();
    if (result?.stopReason === 'cancelled' || session.stopped) return 'interrupted';
    if (result?.stopReason !== 'end_turn') throw new Error(`Qoder ACP stopped without completing: ${result?.stopReason || 'unknown'}`);
    return 'completed';
  } finally {
    session.prompting = false;
  }
}

function createSession(sessionId, workspace, client, config) {
  const session = {
    sessionId,
    workspace,
    client,
    launchIdentity: launchIdentity(client),
    nativeId: null,
    models: [],
    ready: false,
    running: false,
    prompting: false,
    stopped: false,
    turnId: null,
    assistantSegments: null,
    finalMessage: null,
    tools: new Map(),
    thoughtSignaled: false,
    cancelTimer: null,
    uploaded: 0,
    onSessionEvent: config.onSessionEvent,
    emit(kind, payload = {}) {
      this.uploaded++;
      const event = {
        sessionId,
        kind,
        payload: { source: SRC, ...payload, ...(this.nativeId ? { cliSessionId: this.nativeId } : {}) },
      };
      try { Promise.resolve(this.onSessionEvent?.(event)).catch(() => {}); } catch {}
    },
  };
  client.onClose(() => { session.ready = false; });
  client.onNotify((message) => {
    // session/load and session/resume replay history; only this live prompt may publish new deltas.
    if (!session.prompting || message.method !== 'session/update' || message.params?.sessionId !== session.nativeId) return;
    updateSession(session, message.params.update || {});
  });
  client.onServerRequest((message) => {
    respondToPermission(session, message);
  });
  return session;
}

function respondToPermission(session, message) {
  const respond = (result) => {
    try { session.client.respondToServerRequest(message.id, result); } catch {}
  };
  if (!session.prompting || session.stopped || message.params?.sessionId !== session.nativeId) {
    respond({ outcome: { outcome: 'cancelled' } });
    return;
  }
  const options = Array.isArray(message.params?.options) ? message.params.options : [];
  const option = options.find((candidate) => candidate.kind === 'allow_once')
    || options.find((candidate) => candidate.kind === 'allow_always')
    || options.find((candidate) => String(candidate.kind || '').startsWith('allow'));
  respond(option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : { outcome: { outcome: 'cancelled' } });
}

function updateSession(session, update) {
  const eventType = update.sessionUpdate;
  const metadata = { eventType, turnId: session.turnId, threadId: session.nativeId };
  if (eventType === 'agent_message_chunk' && update.content?.type === 'text') {
    const messageId = String(update.messageId || 'assistant');
    const chunk = update.content.text;
    if (!session.finalMessage || session.finalMessage.id !== messageId) session.finalMessage = { id: messageId, text: chunk };
    else session.finalMessage.text = chunk.startsWith(session.finalMessage.text) ? chunk : `${session.finalMessage.text}${chunk}`;
    const segment = session.assistantSegments.append(update.messageId, update.content.text);
    if (segment) emitMessage(session, segment, 'streaming');
  } else if (eventType === 'agent_thought_chunk' && update.content?.type === 'text') {
    // Hidden thought text never leaves the executor; the consumer maps this signal to generic progress.
    if (!session.thoughtSignaled) {
      session.thoughtSignaled = true;
      session.emit('session.reasoning', { metadata: { ...metadata, itemId: `agent-thought:${session.turnId}` } });
    }
  } else if (eventType === 'tool_call' || eventType === 'tool_call_update') {
    const previous = session.tools.get(update.toolCallId);
    if (eventType === 'tool_call' || !previous) {
      const segment = session.assistantSegments.boundary();
      if (segment) emitMessage(session, segment, 'completed');
    }
    const tool = { ...previous, ...update };
    session.tools.set(update.toolCallId, tool);
    const completed = ['completed', 'failed'].includes(tool.status);
    if (previous?.status === tool.status && eventType === 'tool_call_update' && !update.content) return;
    session.emit(completed ? 'session.tool_result' : 'session.tool_use', {
      content: completed ? toolContent(tool.content) : '',
      ...(completed ? {} : { input: tool.rawInput, title: tool.title || '' }),
      toolName: tool.kind || 'tool',
      level: tool.status === 'failed' ? 'error' : 'info',
      metadata: { ...metadata, itemId: tool.toolCallId, toolCallId: tool.toolCallId },
    });
  } else if (eventType === 'plan') {
    const plan = (update.entries || []).map((entry) => ({ step: entry.content, status: entry.status }));
    session.emit('session.status', {
      content: plan.map((entry) => `- ${entry.step} [${entry.status}]`).join('\n'),
      metadata: { ...metadata, eventType: 'turn/plan/updated', plan },
    });
  }
}

function toolContent(content) {
  return (Array.isArray(content) ? content : [])
    .map((item) => item.type === 'content' ? item.content?.text || '' : item.type === 'diff' ? `${item.path}\n${item.newText || ''}` : '')
    .filter(Boolean)
    .join('\n');
}

function emitMessage(session, segment, streamState) {
  session.emit('session.assistant_message', {
    content: segment.content,
    persistedMessageId: `qoder-acp:${session.nativeId}:${session.turnId}:${segment.itemId}`,
    metadata: {
      eventType: 'agent_message_chunk',
      itemId: segment.itemId,
      sourceMessageId: segment.sourceMessageId,
      threadId: session.nativeId,
      turnId: session.turnId,
      streamState,
    },
  });
}

function stopSession(session) {
  if (!session?.running) return false;
  session.stopped = true;
  if (session.prompting) {
    try { session.client.notify('session/cancel', { sessionId: session.nativeId }); } catch {}
  }
  // A broken ACP peer must not keep the executor alive after cancellation.
  if (!session.cancelTimer) session.cancelTimer = setTimeout(() => {void Promise.resolve(session.client.close()).catch(()=>{});}, 5_000);
  return true;
}

function normalizeQoderAcpModels(state) {
  return (Array.isArray(state?.availableModels) ? state.availableModels : []).map((model) => ({
    id: model.modelId,
    label: model.name || model.modelId,
    description: model.description || '',
    isDefault: model.modelId === state.currentModelId,
    reasoningEfforts: [],
    defaultReasoningEffort: null,
  }));
}

export function resolveQoderAcpModel(models, selected) {
  const list = Array.isArray(models) ? models : [];
  const exact = list.find((model) => model.id === selected);
  if (exact) return exact.id;
  const value = String(selected ?? '').toLowerCase();
  const matches = list.filter((model) => String(model.id).toLowerCase() === value || String(model.label).toLowerCase() === value);
  if (matches.length === 1) return matches[0].id;
  throw new Error(`Qoder model is unavailable or ambiguous: ${selected}`);
}

export async function discoverQoderAcpModels(config = {}) {
  const cwd = realWorkspace(config.workspace);
  const provided = config.qoderAcpClient || config.client || null;
  const useCache = config.cacheModels === true;
  const now = typeof config.now === 'function' ? config.now : Date.now;
  const cacheDir = useCache && config.modelCatalogDir ? resolve(config.modelCatalogDir) : null;
  const identity = launchIdentity(provided || { options: { command: config.qoderAcpCommand || 'qodercli', args: acpArgs(config), env: config.agentEnv || {} } });
  const key = useCache ? catalogKey(cwd, identity) : null;
  const keyDigest = key ? sha256(key) : null;
  const identityHash = key ? sha256(identity) : null;
  if (key) {
    const hit = modelCatalogCache.get(key);
    if (hit && hit.expiresAt > now()) return cloneModels(hit.models);
    if (hit) modelCatalogCache.delete(key);
    if (cacheDir) {
      const persisted = readPersistentCatalog({cacheDir,keyDigest,cwd,identityHash,now:now()});
      if (persisted) {
        modelCatalogCache.set(key, persisted);
        return cloneModels(persisted.models);
      }
    }
  }
  const client = provided || createClient(config, cwd);
  try {
    await client.ensureStarted();
    const session = await client.request('session/new', { cwd, mcpServers: [] });
    if (!session?.sessionId) throw new Error('Qoder ACP session/new returned no session ID');
    const models = normalizeQoderAcpModels(session.models).map((model) => ({
      ...model,
      inputModalities: client.capabilities.promptCapabilities?.image === true ? ['text', 'image'] : ['text'],
    }));
    if (client.capabilities.sessionCapabilities?.close) await client.request('session/close', { sessionId: session.sessionId });
    if (!models.length) throw new Error('Qoder ACP returned an empty model catalog');
    if (key) {
      const requested = Number.isFinite(Number(config.modelCatalogTtlMs)) && Number(config.modelCatalogTtlMs) >= 0
        ? Number(config.modelCatalogTtlMs) : DEFAULT_MODEL_CATALOG_TTL_MS;
      const ttl = Math.min(requested, DEFAULT_MODEL_CATALOG_TTL_MS);
      const cachedAt = now();
      const entry = {models, cachedAt, expiresAt: cachedAt + ttl};
      modelCatalogCache.set(key, entry);
      if (cacheDir && ttl > 0) {
        writePersistentCatalog({cacheDir,keyDigest,cwd,identityHash,models,cachedAt,expiresAt:entry.expiresAt});
      }
    }
    return models;
  } finally {
    await client.close();
  }
}

export async function closeQoderAcpSessions({force = false, graceMs, forceMs} = {}) {
  const pending = [];
  for (const session of sessions.values()) {
    clearTimeout(session.cancelTimer);
    session.cancelTimer = null;
    pending.push(
      Promise.resolve(session.client.close({force, graceMs, forceMs}))
        .then((result) => ({sessionId: session.sessionId, ...result}))
        .catch((error) => ({
          sessionId: session.sessionId, pid: null, exited: false, forced: false,
          error: String(error?.message || error),
        })),
    );
  }
  sessions.clear();
  return Promise.all(pending);
}

/** Repeated stop escalation: skip the TERM grace window but still confirm the exit. */
export function forceCloseQoderAcpSessions() {
  return closeQoderAcpSessions({force: true, graceMs: 0, forceMs: 2_000});
}

import { createHash } from 'node:crypto';
import { normalizeNativeConversationEvent } from './native-events.mjs';

const MAX_MESSAGE_CHARS = 64_000;
const MESSAGE_CHUNK_CHARS = 9_000;
const MAX_TOOL_DETAIL_CHARS = 800;
const MAX_TOOL_RESULT_CHARS = 4_000;

export function createConversationEventNormalizer(context) {
  validateContext(context);
  const state = {
    runId: context.runId,
    sequence: Math.max(0, Number(context.initialSequence || 0)),
    runRevision: Math.max(0, Number(context.initialRunRevision || 0)),
    runStarted: context.initialRunStarted === true,
    terminal: false,
    assistantCounter: 0,
    userCounter: 0,
    toolCounter: 0,
    authorizationCounter: 0,
    capabilityCounter: 0,
    authorizations: new Map(),
    assistants: new Map(),
    activeAssistantId: null,
    tools: new Map(),
    progress: new Map(),
    usageRevision: 0,
    seenSourceEvents: new Set(),
  };

  return {
    push(value) {
      const native = normalizeNativeConversationEvent(value);
      if (!native || state.terminal) return [];
      if (native.sourceEventId && state.seenSourceEvents.has(native.sourceEventId)) return [];
      if (native.sourceEventId) state.seenSourceEvents.add(native.sourceEventId);
      const events = [];
      const push = (type, operation, entityId, entityRevision, payload = {}) => {
        state.sequence += 1;
        events.push({
          schemaVersion: 'agent-bridge.conversation/v1',
          eventId: eventId(context.runId, native.sourceEventId, events.length, state.sequence),
          runId: context.runId,
          sessionId: context.sessionId,
          taskRef: context.taskRef,
          ...(context.assignmentGeneration ? { assignmentGeneration: context.assignmentGeneration } : {}),
          sequence: state.sequence,
          entityId,
          entityRevision,
          type,
          operation,
          occurredAt: validTime(native.occurredAt) || now(context),
          origin: { ...context.origin },
          visibility: context.visibility,
          payload: type.startsWith('TOOL_') ? sanitizeToolPayload(payload, context.visibility) : sanitizePayload(payload, context.visibility),
        });
      };
      const ensureRunStarted = () => {
        if (state.runStarted) return;
        state.runStarted = true;
        state.runRevision += 1;
        push('RUN_STARTED', 'START', context.runId, state.runRevision, { status: 'RUNNING' });
      };

      ensureRunStarted();
      switch (native.type) {
        case 'run_initialized':
          break;
        case 'user_message':
          emitUser(native, state, push);
          break;
        case 'assistant_message':
          emitAssistant(native, state, push, context.visibility);
          break;
        case 'progress':
          emitProgress(native, state, push);
          break;
        case 'tool_started':
          emitToolStart(native, state, push);
          break;
        case 'tool_completed':
          emitToolCompleted(native, state, push, context.onDiagnostic);
          break;
        case 'authorization_required':
          emitAuthorization(native, state, push);
          break;
        case 'authorization_resolved':
          emitAuthorizationResolved(native, state, push);
          break;
        case 'usage':
          state.usageRevision += 1;
          push('USAGE_REPORTED', 'REPLACE', `usage:${context.runId}`, state.usageRevision, {
            inputTokens: nonNegative(native.inputTokens),
            outputTokens: nonNegative(native.outputTokens),
            cachedInputTokens: nonNegative(native.cachedInputTokens),
            totalTokens: nonNegative(native.totalTokens),
          });
          break;
        case 'capability_invoked':
          state.capabilityCounter += 1;
          push('CAPABILITY_INVOKED', 'FINALIZE',
            stableEntity(state.runId, 'capability', native.capabilityId, `${native.category}:${state.capabilityCounter}`),
            1, { category: native.category, capabilityId: native.capabilityId,
              status: native.succeeded ? 'SUCCEEDED' : 'FAILED', succeeded: native.succeeded });
          break;
        case 'run_completed':
          if (native.finalMessage && (state.activeAssistantId || !hasAssistantContent(state))) {
            emitAssistant({ type: 'assistant_message', messageId: state.activeAssistantId || undefined, content: native.finalMessage, update: 'REPLACE' }, state, push, context.visibility);
          }
          completeAssistants(state, push);
          state.runRevision += 1;
          push('RUN_COMPLETED', 'FINALIZE', context.runId, state.runRevision, { status: 'SUCCEEDED' });
          state.terminal = true;
          break;
        case 'run_failed':
          completeAssistants(state, push);
          state.runRevision += 1;
          push('RUN_FAILED', 'FINALIZE', context.runId, state.runRevision, {
            status: 'FAILED', errorCode: safeCode(native.errorCode || 'PROVIDER_RESULT_FAILED'), summary: safeSummary(native.summary),
          });
          state.terminal = true;
          break;
        case 'run_canceled':
          completeAssistants(state, push);
          state.runRevision += 1;
          push('RUN_CANCELED', 'FINALIZE', context.runId, state.runRevision, { status: 'CANCELED', summary: safeSummary(native.summary) });
          state.terminal = true;
          break;
        default:
          break;
      }
      return events;
    },
    sequence() { return state.sequence; },
    terminal() { return state.terminal; },
  };
}

function emitUser(native, state, push) {
  state.userCounter += 1;
  const id = stableEntity(state.runId, 'message', native.messageId, `${state.userCounter}:user`);
  const content = deduplicateInitialTaskText(native.content);
  push('MESSAGE_STARTED', 'START', id, 1, { role: 'user' });
  push('MESSAGE_SNAPSHOT', 'REPLACE', id, 2, { role: 'user', content });
  push('MESSAGE_COMPLETED', 'FINALIZE', id, 3, { role: 'user' });
}

function emitAssistant(native, state, push, visibility) {
  if (native.messageId && state.activeAssistantId && native.messageId !== state.activeAssistantId) {
    completeAssistant(state.activeAssistantId, state, push);
  }
  const key = native.messageId || state.activeAssistantId || `assistant-${++state.assistantCounter}`;
  let assistant = state.assistants.get(key);
  if (!assistant) {
    assistant = {
      id: stableEntity(state.runId, 'message', native.messageId, `assistant:${state.assistantCounter || 1}`),
      revision: 1,
      rawContent: '',
      content: '',
      complete: false,
    };
    state.assistants.set(key, assistant);
    state.activeAssistantId = key;
    push('MESSAGE_STARTED', 'START', assistant.id, assistant.revision, { role: 'assistant' });
  }
  if (assistant.complete) return;
  const rawIncoming = boundedText(native.content);
  const nextRaw = native.update === 'APPEND'
    ? boundedText(`${assistant.rawContent}${rawIncoming}`)
    : rawIncoming;
  const next = visibleMessageText(nextRaw, visibility);
  if (next !== assistant.content) {
    const prefixGrowth = assistant.content.length > 0 && next.startsWith(assistant.content);
    // APPEND is safe only when the fully sanitized projection still extends the visible prefix.
    // A credential can become recognizable only after a later delta; then the new sanitized text
    // must replace the previously visible fragment instead of slicing it by the old raw length.
    const append = prefixGrowth;
    const payloadText = append ? next.slice(assistant.content.length) : next;
    const chunks = chunkText(payloadText);
    chunks.forEach((chunk, index) => {
      assistant.revision += 1;
      push(index === 0 && !append ? 'MESSAGE_SNAPSHOT' : 'MESSAGE_DELTA', index === 0 && !append ? 'REPLACE' : 'APPEND', assistant.id, assistant.revision, { role: 'assistant', content: chunk });
    });
    assistant.content = next;
  }
  assistant.rawContent = nextRaw;
  if (native.completed) completeAssistant(key, state, push);
}

function completeAssistants(state, push) {
  for (const key of state.assistants.keys()) completeAssistant(key, state, push);
  state.activeAssistantId = null;
}

function completeAssistant(key, state, push) {
  const assistant = state.assistants.get(key);
  if (!assistant || assistant.complete) return;
  assistant.complete = true;
  assistant.revision += 1;
  push('MESSAGE_COMPLETED', 'FINALIZE', assistant.id, assistant.revision, { role: 'assistant' });
  if (state.activeAssistantId === key) state.activeAssistantId = null;
}

function hasAssistantContent(state) {
  return [...state.assistants.values()].some((assistant) => assistant.content);
}

function emitProgress(native, state, push) {
  const summary = safeSummary(native.summary);
  if (!summary || internalLifecycle(summary)) return;
  const id = stableEntity(state.runId, 'progress', native.progressId, 'current');
  const revision = (state.progress.get(id) || 0) + 1;
  state.progress.set(id, revision);
  push('PROGRESS_UPDATED', 'REPLACE', id, revision, { summary, ...(native.percent == null ? {} : { progressPercent: percent(native.percent) }) });
}

function emitToolStart(native, state, push) {
  const toolName = safeTool(native.toolName);
  const content = toolBehaviorContent(native, toolName);
  const id = stableEntity(state.runId, 'tool', native.toolCallId, String(++state.toolCounter));
  const existing = state.tools.get(id);
  if (existing && !existing.complete) {
    existing.revision += 1;
    existing.collaboration = native.collaboration || existing.collaboration;
    push('TOOL_UPDATED', 'REPLACE', id, existing.revision, toolPayload(id, toolName, 'RUNNING', content, existing.collaboration));
    return;
  }
  const tool = { id, name: toolName, revision: 1, complete: false, collaboration: native.collaboration };
  state.tools.set(id, tool);
  push('TOOL_STARTED', 'START', id, tool.revision, toolPayload(id, toolName, 'RUNNING', content, tool.collaboration));
}

function emitToolCompleted(native, state, push, onDiagnostic) {
  const toolName = safeTool(native.toolName);
  const explicitId = native.toolCallId ? stableEntity(state.runId, 'tool', native.toolCallId, '') : '';
  let tool = explicitId ? state.tools.get(explicitId) : null;
  if (!tool) {
    const candidates = [...state.tools.values()].filter((item) => !item.complete && item.name === toolName);
    if (!explicitId && candidates.length === 1) tool = candidates[0];
  }
  if (!tool) {
    const id = explicitId || stableEntity(state.runId, 'tool', null, `orphan:${++state.toolCounter}`);
    tool = { id, name: toolName, revision: 1, complete: false, collaboration: native.collaboration };
    state.tools.set(id, tool);
    push('TOOL_STARTED', 'START', id, tool.revision, toolPayload(id, toolName, 'RUNNING'));
    onDiagnostic?.({ code: 'TOOL_START_MISSING', toolCallId: native.toolCallId, toolName });
  }
  if (tool.complete) return;
  tool.collaboration = native.collaboration || tool.collaboration;
  tool.complete = true;
  tool.revision += 1;
  const result = boundedToolText(native.content, MAX_TOOL_RESULT_CHARS);
  push('TOOL_COMPLETED', 'FINALIZE', tool.id, tool.revision, {
    ...toolPayload(tool.id, toolName === 'tool' ? tool.name : toolName, native.ok === false ? 'FAILED' : 'SUCCEEDED', '', tool.collaboration),
    ...(result ? { result } : {}),
  });
}

function emitAuthorization(native, state, push) {
  state.authorizationCounter += 1;
  const id = stableEntity(state.runId, 'authorization', native.requestId, String(state.authorizationCounter));
  const authorization = state.authorizations.get(id) || { id, revision: 0, resolved: false };
  if (authorization.resolved) return;
  authorization.revision += 1;
  state.authorizations.set(id, authorization);
  push('AUTHORIZATION_REQUIRED', authorization.revision === 1 ? 'START' : 'REPLACE', id, authorization.revision, { toolName: safeTool(native.toolName), summary: safeSummary(native.summary) || '等待授权', status: 'RUNNING' });
}

function emitAuthorizationResolved(native, state, push) {
  const id = stableEntity(state.runId, 'authorization', native.requestId, 'current');
  const authorization = state.authorizations.get(id) || { id, revision: 1, resolved: false };
  if (authorization.resolved) return;
  authorization.resolved = true;
  authorization.revision += 1;
  state.authorizations.set(id, authorization);
  push('AUTHORIZATION_RESOLVED', 'FINALIZE', id, authorization.revision, {
    summary: safeSummary(native.summary) || '授权请求已处理',
    decision: native.decision === 'APPROVE' ? 'APPROVE' : 'REJECT',
    status: 'RUNNING',
  });
}

function toolPayload(id, name, status, content = '', collaboration = null) {
  return { toolCallId: id, toolName: name, status, ...(content ? { content } : {}), ...(collaboration ? { collaboration } : {}) };
}

function toolBehaviorContent(native, toolName) {
  const input = native?.input;
  // Only command tools may surface a command-shaped input; for every other tool the field is opaque
  // and rendering it (raw or serialized) would misrepresent a private expression as a command.
  const structured = isCommandTool(toolName) ? commandText(native, input) : toolInputDetail(input);
  return boundedToolText(structured || native?.title || native?.content, MAX_TOOL_DETAIL_CHARS);
}

function commandText(native, input) {
  return firstString([
    typeof native?.command === 'string' ? native.command : '',
    typeof input === 'string' ? input : '',
    typeof input?.command === 'string' ? input.command : '',
    typeof input?.cmd === 'string' ? input.cmd : '',
    typeof native?.content === 'string' ? native.content : '',
  ]);
}

/** Tool inputs arrive structured from Codex app-server and as pre-rendered text from Qoder ACP. */
function toolInputDetail(input) {
  if (typeof input === 'string') return input.replace(/\0/g, '').trim();
  if (!input || typeof input !== 'object') return '';
  return firstString([
    firstString([input.file_path, input.path, input.filePath, input.notebook_path, input.target_file]),
    firstString([input.pattern, input.query, input.search, input.glob]),
    firstString([input.url, input.uri]),
    firstString([input.description, input.explanation, input.prompt]),
  ]);
}

function firstString(values) {
  for (const value of values || []) {
    const text = typeof value === 'string' ? value.replace(/\0/g, '').trim() : '';
    if (text) return text;
  }
  return '';
}

function boundedToolText(value, maximum = MAX_TOOL_DETAIL_CHARS) {
  return String(value || '').replace(/\0/g, '').trim().slice(0, maximum);
}

function isCommandTool(name) {
  return /^(?:bash|shell|terminal|sh|zsh|powershell|pwsh|cmd|command|commandexecution|command_execution|exec_command|execute|run|run_command|run_terminal_cmd)$/i.test(String(name || '').trim());
}

function sanitizeToolPayload(payload, visibility = 'PERSONAL_PRIVATE') {
  const result = { ...payload };
  for (const key of ['content', 'result']) {
    if (typeof result[key] !== 'string') continue;
    result[key] = visibility === 'SHARED_SAFE' ? sharedSafeText(result[key]).slice(0, MAX_TOOL_RESULT_CHARS) : result[key].replace(/\0/g, '');
  }
  delete result.summary;
  // Tool output bodies are local-only detail; shared and summary streams never carry them.
  if (visibility !== 'PERSONAL_PRIVATE') delete result.result;
  if (visibility === 'SUMMARY_ONLY') delete result.content;
  if (result.collaboration) result.collaboration = sanitizeCollaboration(result.collaboration, visibility);
  return Object.fromEntries(Object.entries(result).filter(([, value]) => value !== undefined && value !== null && value !== ''));
}

function sanitizeCollaboration(value, visibility) {
  const agents = (Array.isArray(value?.agents) ? value.agents : []).slice(0, 16).map((agent) => ({
    id: boundedIdentityPart(agent?.id || 'agent', 128),
    ...(agent?.name ? { name: String(agent.name).slice(0, 80) } : {}),
    ...(visibility === 'PERSONAL_PRIVATE' && agent?.target ? { target: boundedToolText(agent.target, 500) } : {}),
    status: String(agent?.status || 'running').slice(0, 32),
    ...(agent?.reason ? { reason: boundedToolText(agent.reason, 300) } : {}),
  }));
  return {
    ...(value?.parentId ? { parentId: boundedIdentityPart(value.parentId, 128) } : {}),
    status: String(value?.status || '').slice(0, 32),
    agents,
  };
}

function sanitizePayload(payload, visibility) {
  const result = { ...payload };
  if (visibility === 'SUMMARY_ONLY') delete result.content;
  if (visibility === 'SHARED_SAFE') {
    if (result.content) result.content = sharedSafeText(result.content);
    if (result.summary) result.summary = sharedSafeText(result.summary);
  }
  return Object.fromEntries(Object.entries(result).filter(([, value]) => value !== undefined && value !== null && value !== ''));
}

function sharedSafeText(value) {
  const mask = '[secret]';
  return String(value || '')
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gi, mask)
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*/gi, mask)
    .replace(/(\b(?:set-cookie|cookie)["']?\s*:\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^"'\r\n]+)/gi, `$1${mask}`)
    .replace(/(\bauthorization["']?\s*:\s*)(?:"(?:basic|bearer)\s+[^"\r\n]*"|'(?:basic|bearer)\s+[^'\r\n]*'|(?:basic|bearer)\s+[^\s"'`,;]+)/gi, `$1${mask}`)
    .replace(/\bbearer\s+[^\s"'`,;]+/gi, mask)
    .replace(/(\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|RUN[_-]?TICKET)[A-Z0-9_]*["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s"'`,;}]+)/gi, `$1${mask}`)
    .replace(/((?:^|\s)--?(?:token|secret|password|passwd|api[-_]?key|access[-_]?key)(?:\s+|=))(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s"'`,;}]+)/gi, `$1${mask}`)
    .replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g, mask)
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/gi, mask)
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, mask)
    .replace(/(?:\bbearer\s+|\brun[_ -]?ticket\s*[=:]\s*|\baccess[_ -]?token\s*[=:]\s*|\bclient[_ -]?secret\s*[=:]\s*|--?(?:token|password|secret|api[-_]?key)\s+)[^\s"'`]+/gi, '[secret]')
    .replace(/\b(?:access[_ -]?token|client[_ -]?secret|token|secret|password|api[-_]?key)["']?\s*[:=]\s*["']?[^\s"'`,}]+/gi, '[secret]')
    .replace(/\b(?:sk|ak|token|secret|password)[-_=:][A-Za-z0-9._-]{8,}\b/gi, '[secret]')
    .slice(0, MAX_MESSAGE_CHARS);
}

function stableEntity(runId, kind, explicit, fallback) {
  const scope = boundedIdentityPart(runId, 96);
  const prefix = `${scope}:${kind}:`;
  return `${prefix}${boundedIdentityPart(explicit || fallback || 'unknown', 256 - prefix.length)}`;
}
function boundedIdentityPart(value, maximum) { const raw = String(value || 'unknown'); const safe = raw.replace(/[^A-Za-z0-9._:-]/g, '_'); if (safe.length <= maximum) return safe; const hash = createHash('sha256').update(raw).digest('hex').slice(0, 16); return `${safe.slice(0, Math.max(1, maximum - hash.length - 1))}-${hash}`; }
function eventId(runId, sourceId, outputIndex, sequence) {
  if (!sourceId) return `${runId}:${sequence}`;
  const digest = createHash('sha256').update(`${runId}\0${sourceId}\0${outputIndex}`).digest('hex').slice(0, 24);
  return `${runId}:${digest}`;
}
function validateContext(context) {
  if (!context?.runId || !context?.sessionId || !context?.taskRef?.taskId || !context?.origin?.providerId) throw new TypeError('Conversation normalizer requires stable run, session, task, and provider context');
  if (!['PERSONAL_PRIVATE', 'SHARED_SAFE', 'SUMMARY_ONLY'].includes(context.visibility)) throw new TypeError(`Unsupported conversation visibility: ${context?.visibility}`);
}
function now(context) { return typeof context.now === 'function' ? context.now() : new Date().toISOString(); }
function validTime(value) { const time = Date.parse(String(value || '')); return Number.isFinite(time) ? new Date(time).toISOString() : ''; }
function chunkText(value) { const text = String(value || ''); const chunks = []; for (let index = 0; index < text.length; index += MESSAGE_CHUNK_CHARS) chunks.push(text.slice(index, index + MESSAGE_CHUNK_CHARS)); return chunks; }
function boundedText(value) { return String(value || '').replace(/\0/g, '').slice(0, MAX_MESSAGE_CHARS); }
function visibleMessageText(value, visibility) { return visibility === 'SHARED_SAFE' ? sharedSafeText(value) : boundedText(value); }
function deduplicateInitialTaskText(value) { const text = boundedText(value).trim(); const parts = text.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean); return parts.length === 2 && parts[0] === parts[1] ? parts[0] : text; }
function safeSummary(value) { return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 500); }
function safeTool(value) { return String(value || 'tool').replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 80) || 'tool'; }
function safeCode(value) { return String(value || 'PROVIDER_RESULT_FAILED').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 96); }
function nonNegative(value) { const result = Number(value); return Number.isFinite(result) && result > 0 ? Math.floor(result) : 0; }
function percent(value) { const result = Number(value); return Number.isFinite(result) ? Math.max(0, Math.min(100, Math.round(result))) : 0; }
function internalLifecycle(value) { return /^(?:已进入|已退出)计划模式[。.]?$|^(?:entered|exited|left) plan mode[.!]?$/i.test(value); }

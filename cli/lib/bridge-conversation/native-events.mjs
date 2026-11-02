import { createHash } from 'node:crypto';

export const NATIVE_EVENT_TYPES = new Set([
  'run_initialized',
  'user_message',
  'assistant_message',
  'progress',
  'tool_started',
  'tool_completed',
  'authorization_required',
  'authorization_resolved',
  'capability_invoked',
  'usage',
  'run_completed',
  'run_failed',
  'run_canceled',
]);

export function sourceEventId(prefix, value) {
  const digest = createHash('sha256').update(stableJson(value)).digest('hex').slice(0, 20);
  return `${prefix}:${digest}`;
}

export function normalizeNativeConversationEvent(value) {
  if (!value || typeof value !== 'object') return null;
  if (NATIVE_EVENT_TYPES.has(value.type)) return sanitizeNativeEvent(value);

  const base = {
    ...(value.sourceEventId ? { sourceEventId: String(value.sourceEventId) } : {}),
    ...(value.providerTurnId ? { providerTurnId: String(value.providerTurnId) } : {}),
    ...(value.occurredAt ? { occurredAt: String(value.occurredAt) } : {}),
  };
  if (value.kind === 'system_init' || value.type === 'SYSTEM_INIT') {
    return sanitizeNativeEvent({ ...base, type: 'run_initialized', providerSessionId: value.sessionId, modelId: value.model });
  }
  if (value.kind === 'task_start' || value.type === 'USER_MESSAGE' || (value.kind === 'message' && value.subkind === 'user')) {
    return sanitizeNativeEvent({ ...base, type: 'user_message', messageId: value.messageId, content: value.text || value.summary || value.title || '' });
  }
  if (value.kind === 'message' && value.subkind === 'reasoning') {
    return sanitizeNativeEvent({ ...base, type: 'progress', progressId: value.messageId, summary: value.text || value.summary || '' });
  }
  if (value.kind === 'message' || value.type === 'ASSISTANT_MESSAGE') {
    return sanitizeNativeEvent({
      ...base,
      type: 'assistant_message',
      messageId: value.messageId,
      content: value.text || value.content || value.summary || '',
      update: value.update === 'APPEND' ? 'APPEND' : 'REPLACE',
      streamState: value.streamState,
      completed: value.completed,
    });
  }
  if (value.kind === 'tool_use' || value.type === 'TOOL_STARTED') {
    return sanitizeNativeEvent({
      ...base,
      type: 'tool_started',
      toolCallId: value.toolCallId || value.toolUseId,
      toolName: value.name || value.toolName,
      ...(value.input === undefined ? {} : { input: value.input }),
      ...(value.command === undefined ? {} : { command: value.command }),
      ...(value.content === undefined ? {} : { content: value.content }),
      ...(value.title === undefined ? {} : { title: value.title }),
      ...(value.collaboration === undefined ? {} : { collaboration: value.collaboration }),
    });
  }
  if (value.kind === 'tool_result' || value.type === 'TOOL_COMPLETED') {
    return sanitizeNativeEvent({
      ...base,
      type: 'tool_completed',
      toolCallId: value.toolCallId || value.toolUseId,
      toolName: value.name || value.toolName,
      ok: value.ok !== false,
      ...(value.content === undefined ? {} : { content: value.content }),
      ...(value.collaboration === undefined ? {} : { collaboration: value.collaboration }),
    });
  }
  if (value.kind === 'authorization' || value.type === 'AUTHORIZATION_REQUIRED') {
    return sanitizeNativeEvent({
      ...base,
      type: 'authorization_required',
      requestId: value.requestId,
      toolName: value.toolName,
      summary: value.text || value.summary || value.title || '等待授权',
    });
  }
  if (value.kind === 'authorization_resolved' || value.type === 'AUTHORIZATION_RESOLVED') {
    return sanitizeNativeEvent({
      ...base,
      type: 'authorization_resolved',
      requestId: value.requestId,
      summary: value.text || value.summary || '授权请求已处理',
      decision: value.decision === 'APPROVE' || value.allow === true ? 'APPROVE' : 'REJECT',
    });
  }
  if (value.kind === 'usage' || value.type === 'USAGE') {
    return sanitizeNativeEvent({
      ...base,
      type: 'usage',
      inputTokens: value.inputTokens,
      outputTokens: value.outputTokens,
      cachedInputTokens: value.cachedInputTokens,
      totalTokens: value.totalTokens,
    });
  }
  if (value.kind === 'capability_invoked' || value.type === 'CAPABILITY_INVOKED') {
    return sanitizeNativeEvent({
      ...base,
      type: 'capability_invoked',
      category: value.category,
      capabilityId: value.capabilityId,
      succeeded: value.succeeded !== false,
    });
  }
  if (value.kind === 'result') {
    return sanitizeNativeEvent(value.ok === false
      ? { ...base, type: 'run_failed', errorCode: value.errorCode, summary: value.text || value.error || 'Agent 执行失败' }
      : { ...base, type: 'run_completed', finalMessage: value.text || value.content || '' });
  }
  if (value.kind === 'task_failed') {
    return sanitizeNativeEvent({ ...base, type: 'run_failed', errorCode: value.errorCode, summary: value.error || value.text || 'Agent 执行失败' });
  }
  if (value.kind === 'task_cancelled') {
    return sanitizeNativeEvent({ ...base, type: 'run_canceled', summary: value.text || value.reason || '任务已取消' });
  }
  if (value.type === 'PROGRESS') {
    return sanitizeNativeEvent({ ...base, type: 'progress', progressId: value.progressId, summary: value.summary, percent: value.progressPercent });
  }
  return null;
}

const MAX_TOOL_RESULT_CHARS = 8_000;

function sanitizeNativeEvent(value) {
  const result = { ...value, type: String(value.type) };
  for (const key of ['sourceEventId', 'providerTurnId', 'occurredAt', 'providerSessionId', 'modelId', 'messageId', 'progressId', 'toolCallId', 'requestId', 'toolName', 'errorCode', 'title']) {
    if (result[key] == null || result[key] === '') delete result[key];
    else result[key] = String(result[key]);
  }
  if (result.content != null) result.content = String(result.content);
  if (result.summary != null) result.summary = String(result.summary);
  if (result.finalMessage != null) result.finalMessage = String(result.finalMessage);
  if (result.decision != null) result.decision = result.decision === 'APPROVE' ? 'APPROVE' : 'REJECT';
  if (result.update && result.update !== 'APPEND') result.update = 'REPLACE';
  if (result.type === 'assistant_message') {
    if (!result.update) result.update = 'REPLACE';
    const streamState = String(result.streamState || '').toLowerCase();
    if (streamState === 'streaming' || streamState === 'completed') result.streamState = streamState;
    else delete result.streamState;
    result.completed = result.completed === true || streamState === 'completed';
    if (!result.completed) delete result.completed;
  }
  if (result.type === 'tool_completed') result.ok = result.ok !== false;
  if (result.type === 'capability_invoked') {
    result.category = ['skill', 'mcp', 'cli', 'other'].includes(result.category) ? result.category : 'other';
    result.capabilityId = String(result.capabilityId || '').replace(/[^A-Za-z0-9._:@/-]/g, '').slice(0, 200);
    result.succeeded = result.succeeded !== false;
    if (!result.capabilityId) return null;
  }
  if (result.type === 'tool_started') {
    for (const key of ['summary', 'detail', 'result', 'output']) delete result[key];
  }
  if (result.type === 'tool_completed') {
    for (const key of ['summary', 'detail', 'input', 'command', 'result', 'output']) delete result[key];
    // Tool output stays visible in the conversation log, but only in a bounded window.
    if (result.content != null) result.content = String(result.content).replace(/\0/g, '').slice(0, MAX_TOOL_RESULT_CHARS);
  }
  return result;
}

function stableJson(value) {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

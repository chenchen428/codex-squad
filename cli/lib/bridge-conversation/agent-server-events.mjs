import { createHash } from 'node:crypto';

export function appServerExecutionEvent(frame, options = {}) {
  if (!frame?.kind) return null;
  const payload = frame.payload || {};
  const content = String(payload.content || '');
  if (frame.kind === 'session.assistant_message') {
    return { kind: 'message', subkind: 'text', text: content, ...appServerMessageLifecycle(payload, content) };
  }
  if (frame.kind === 'session.user_message') {
    if (payload.source === 'agent-bridge-appserver') return null;
    // Taskboard comments are echoed back as user messages; personal conversations keep them so a
    // reopened task still shows what the user asked for, shared streams render them from the server.
    const commentEcho = payload.source === 'agent-bridge-ui'
      || payload.metadata?.eventType === 'taskboard.comment.dequeued';
    if (commentEcho && options.includeUserEcho !== true) return null;
    const messageId = payload.metadata?.messageId || (payload.metadata?.commentId ? `comment:${payload.metadata.commentId}` : '');
    return { kind: 'message', subkind: 'user', text: payload.metadata?.displayedUserContent || content,
        ...(messageId ? { messageId, sourceEventId: `${messageId}:user` } : {}) };
  }
  if (frame.kind === 'session.reasoning' || frame.kind === 'session.status') {
    if (payload.metadata?.eventType === 'thread/settings/updated') return null;
    const itemId = String(payload.metadata?.itemId || payload.metadata?.eventType || frame.kind);
    return {
      kind: 'message', subkind: 'reasoning', text: frame.kind === 'session.reasoning' ? 'Agent 正在分析任务' : content,
      ...(payload.metadata?.turnId ? { providerTurnId: payload.metadata.turnId } : {}),
      sourceEventId: `${itemId}:progress:${digest(content).slice(0, 20)}`,
    };
  }
  if (frame.kind === 'session.tool_use') {
    const identity = toolCallIdentity(payload);
    const input = payload.input !== undefined && payload.input !== null ? payload.input : content;
    const title = typeof payload.title === 'string' ? payload.title : '';
    return {
      kind: 'tool_use', name: payload.toolName || 'tool', input,
      ...(title ? { title } : {}),
      ...identity,
      ...(payload.metadata?.turnId ? { providerTurnId: payload.metadata.turnId } : {}),
      ...(payload.metadata?.collab ? { collaboration: payload.metadata.collab } : {}),
      ...(identity.toolCallId ? { sourceEventId: `${identity.toolCallId}:started` } : {}),
    };
  }
  if (frame.kind === 'session.tool_result') {
    const identity = toolCallIdentity(payload);
    return {
      kind: 'tool_result', name: payload.toolName || 'tool', content, ok: payload.level !== 'error',
      ...identity,
      ...(payload.metadata?.turnId ? { providerTurnId: payload.metadata.turnId } : {}),
      ...(payload.metadata?.collab ? { collaboration: payload.metadata.collab } : {}),
      ...(identity.toolCallId ? { sourceEventId: `${identity.toolCallId}:completed` } : {}),
    };
  }
  if (frame.kind === 'authorization.request') {
    return {
      kind: 'authorization',
      requestId: payload.requestId || payload.metadata?.approvalRequestId,
      title: '等待授权',
      text: content,
      toolName: payload.toolName || null,
    };
  }
  if (frame.kind === 'authorization.decision') {
    return {
      kind: 'authorization_resolved',
      requestId: payload.requestId || payload.metadata?.approvalRequestId,
      text: content || '授权请求已处理',
      decision: payload.allow === false || payload.metadata?.decision === 'decline' ? 'REJECT' : 'APPROVE',
    };
  }
  if (frame.kind === 'session.error') return { kind: 'message', subkind: 'reasoning', text: 'Agent 遇到临时错误，正在确认执行终态' };
  if (frame.kind === 'session.complete' && payload.success !== false) return { kind: 'result', ok: true };
  return null;
}


export function appServerMessageLifecycle(payload, content) {
  const metadata = payload?.metadata && typeof payload.metadata === 'object' ? payload.metadata : {};
  const messageId = String(payload?.persistedMessageId || appServerMessageId(metadata) || '').trim();
  const streamState = ['streaming', 'completed'].includes(String(metadata.streamState || '').toLowerCase())
    ? String(metadata.streamState).toLowerCase()
    : '';
  if (!messageId && !streamState) return {};
  return {
    ...(messageId ? { messageId } : {}),
    ...(metadata.turnId ? { providerTurnId: String(metadata.turnId) } : {}),
    update: 'REPLACE',
    ...(streamState ? { streamState } : {}),
    ...(streamState === 'completed' ? { completed: true } : {}),
    ...(messageId ? { sourceEventId: `${messageId}:${streamState || 'snapshot'}:${digest(content).slice(0, 20)}` } : {}),
  };
}

function appServerMessageId(metadata) {
  const itemId = String(metadata?.itemId || '').trim();
  if (!itemId) return '';
  const threadId = String(metadata?.threadId || 'thread').trim();
  const turnId = String(metadata?.turnId || 'turn').trim();
  return `appserver-agent-message:${threadId}:${turnId}:${itemId}`;
}


export function toolCallIdentity(value) {
  const toolCallId = String(
    value?.toolCallId
    || value?.toolUseId
    || value?.metadata?.itemId
    || value?.metadata?.callId
    || value?.metadata?.toolCallId
    || '',
  ).trim().slice(0, 256);
  return toolCallId ? { toolCallId } : {};
}

function digest(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

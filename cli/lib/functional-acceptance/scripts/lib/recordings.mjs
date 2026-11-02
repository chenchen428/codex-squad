import { truncate } from './text.mjs';

export class RecordingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RecordingError';
    this.code = code;
  }
}

const REC_JS_PREFIX = /^\uFEFF?\s*window\.__CP_EXPORT__\s*=\s*/;
const REC_JS_PUSH = /^\uFEFF?\s*\(\s*window\.__CP_EXPORT__\s*\?\?=\s*\[\s*\]\s*\)\s*\.\s*push\s*\(([\s\S]*)\)\s*;?\s*$/;

/**
 * ChromePilot 的 .rec.js 接受官方 push 包装及旧式赋值包装。
 * 这里做严格字符串截取 + JSON.parse，绝不执行 JavaScript（不使用 eval/vm/Function）。
 */
export function parseRecJs(text, label) {
  const push = text.match(REC_JS_PUSH);
  const match = text.match(REC_JS_PREFIX);
  if (!push && !match) {
    throw new RecordingError('E_RECJS_WRAPPER', `${label}: .rec.js 必须使用官方 __CP_EXPORT__ JSON 包装`);
  }
  let body = push ? push[1].trim() : text.slice(match[0].length).trim();
  if (body.endsWith(';')) body = body.slice(0, -1).trim();
  if (!body || !/^[{["]/.test(body)) {
    throw new RecordingError('E_RECJS_JSON', `${label}: 包装内不是 JSON 对象`);
  }
  if (/^\s*(function|\(|async|class|new)\b/.test(body)) {
    throw new RecordingError('E_RECJS_NOT_JSON', `${label}: 包装内包含 JavaScript 表达式，拒绝解析`);
  }
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    throw new RecordingError('E_RECJS_JSON', `${label}: 包装内 JSON 解析失败（${error.message}）`);
  }
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      throw new RecordingError('E_RECJS_JSON', `${label}: 字符串内容不是 JSON`);
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RecordingError('E_RECJS_SHAPE', `${label}: 导出内容必须是对象`);
  }
  if (!Array.isArray(parsed.events)) {
    throw new RecordingError('E_RECJS_EVENTS', `${label}: 导出内容缺少 events 数组`);
  }
  return { payload: parsed, source: 'rec.js' };
}

function coerceEvents(payload) {
  if (Array.isArray(payload)) return { events: payload, extras: null };
  if (payload && typeof payload === 'object') {
    if (Array.isArray(payload.events)) return { events: payload.events, extras: payload };
  }
  return null;
}

function summarizeEntry(entry) {
  if (entry === null || entry === undefined) return null;
  if (typeof entry === 'string' || typeof entry === 'number') return truncate(entry, 200);
  if (typeof entry === 'object') {
    const summary = {};
    for (const key of ['url', 'title', 'name', 'method', 'status', 'level', 'type', 'message', 'text']) {
      if (entry[key] !== undefined && (typeof entry[key] === 'string' || typeof entry[key] === 'number')) {
        summary[key] = truncate(entry[key], 200);
      }
    }
    return Object.keys(summary).length ? summary : '（复合对象）';
  }
  return null;
}

function summarizeList(list, limit = 8) {
  if (!Array.isArray(list)) return null;
  const items = list.slice(0, limit).map(summarizeEntry).filter((item) => item !== null);
  return { total: list.length, items };
}

function pickFields(object, keys) {
  if (!object || typeof object !== 'object') return null;
  const out = {};
  for (const key of keys) {
    const value = object[key];
    if (value === undefined) continue;
    if (typeof value === 'string') out[key] = truncate(value, 300);
    else if (typeof value === 'number' || typeof value === 'boolean') out[key] = value;
    else if (value && typeof value === 'object') out[key] = truncate(JSON.stringify(value), 300);
  }
  return Object.keys(out).length ? out : null;
}

export function summarizeChromePilot(payload) {
  return {
    session: pickFields(payload.session, ['id', 'name', 'title', 'domain', 'start_url', 'start_ts', 'end_ts', 'event_count', 'status', 'source', 'degraded', 'startedAt', 'endedAt', 'startTime', 'browser', 'viewport', 'url', 'userAgent', 'env']),
    pages: summarizeList(payload.pages),
    net: summarizeList(payload.net, 5),
    console: summarizeList(payload.console, 5),
    counts: {
      pages: Array.isArray(payload.pages) ? payload.pages.length : 0,
      net: Array.isArray(payload.net) ? payload.net.length : 0,
      console: Array.isArray(payload.console) ? payload.console.length : 0,
    },
  };
}

/**
 * 统一解析 rrweb / ChromePilot 录制，返回事件数组和统计信息。
 */
export function parseRecordingText(text, { declaredPath, format, label }) {
  let payload;
  let source = 'json';
  let wrapped = null;
  const looksRecJs = /\.rec\.js$/i.test(declaredPath) || REC_JS_PREFIX.test(text) || REC_JS_PUSH.test(text);
  if (looksRecJs) {
    const parsed = parseRecJs(text, label);
    payload = parsed.payload;
    source = parsed.source;
    wrapped = parsed.payload;
  } else {
    try {
      payload = JSON.parse(text);
    } catch (error) {
      throw new RecordingError('E_RECORDING_JSON', `${label}: JSON 解析失败（${error.message}）`);
    }
  }

  const coerced = coerceEvents(payload);
  if (!coerced) {
    throw new RecordingError('E_RECORDING_SHAPE', `${label}: 录制必须是事件数组，或带 events 数组的对象`);
  }
  const events = coerced.events;
  if (events.length < 2) {
    throw new RecordingError('E_RECORDING_TOO_SHORT', `${label}: 至少需要 2 个事件，实际 ${events.length} 个`);
  }
  let hasFullSnapshot = false;
  let meta = null;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (!event || typeof event !== 'object') {
      throw new RecordingError('E_RECORDING_EVENT', `${label}: 第 ${index + 1} 个事件不是对象`);
    }
    if (typeof event.timestamp !== 'number' || !Number.isFinite(event.timestamp)) {
      throw new RecordingError('E_RECORDING_TIMESTAMP', `${label}: 第 ${index + 1} 个事件缺少有效 timestamp`);
    }
    if (typeof event.type !== 'number') {
      throw new RecordingError('E_RECORDING_EVENT_TYPE', `${label}: 第 ${index + 1} 个事件缺少 type`);
    }
    if (event.type === 2) hasFullSnapshot = true;
    if (event.type === 4 && !meta && event.data && typeof event.data === 'object') meta = event.data;
    if (index > 0 && event.timestamp < events[index - 1].timestamp) {
      throw new RecordingError('E_RECORDING_ORDER', `${label}: 事件时间戳必须非递减（第 ${index + 1} 个事件回退）`);
    }
  }
  if (!hasFullSnapshot) {
    throw new RecordingError('E_RECORDING_NO_SNAPSHOT', `${label}: 缺少 full snapshot（type: 2），无法回放`);
  }

  const startTime = events[0].timestamp;
  const endTime = events[events.length - 1].timestamp;
  let viewport = null;
  if (meta && Number.isFinite(meta.width) && Number.isFinite(meta.height) && meta.width > 0 && meta.height > 0) {
    viewport = { width: Math.round(meta.width), height: Math.round(meta.height) };
  }

  const extraMeta = {};
  if (source === 'rec.js' || format === 'chromepilot') {
    const sourcePayload = wrapped || coerced.extras || {};
    extraMeta.chromePilot = summarizeChromePilot(sourcePayload);
  }
  if (meta && typeof meta.href === 'string') {
    extraMeta.recordedUrl = truncate(meta.href, 300);
  }

  return {
    events,
    startTime,
    endTime,
    durationMs: endTime - startTime,
    viewport,
    eventCount: events.length,
    sourceFormat: source === 'rec.js' ? 'chromepilot' : format,
    sourceMeta: extraMeta,
    wrappedInRecJs: source === 'rec.js',
  };
}

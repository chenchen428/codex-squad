// 核验章与版本提示的纯视图模型：只做事实收口，不产生任何示例数据。
// 公开本机构建没有发布通道，只展示安装版本并给出手动获取入口。
export const UPDATE_ENTRY_URL = 'https://github.com/chenchen428/codex-squad/releases';
const UPDATE_ENTRY_HOST = 'github.com';
const UPDATE_ENTRY_PATH = '/chenchen428/codex-squad/releases';

const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const TIME_ZONE = 'Asia/Shanghai';
const DATE_TIME = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** 保留原文换行，只去掉不可见控制字符。 */
export function safeText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\r\n?/g, '\n').replace(CONTROL_CHARS, '');
}

function presentText(value) {
  const text = safeText(value);
  return text.trim() ? text : null;
}

function oneLine(value) {
  return safeText(value).replace(/\s+/g, ' ').trim();
}

function isoOrNull(value) {
  if (typeof value !== 'string' && !(value instanceof Date)) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function partsOf(value) {
  const iso = isoOrNull(value);
  if (!iso) return null;
  const parts = {};
  for (const part of DATE_TIME.formatToParts(new Date(iso))) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  return parts;
}

export function formatDateTime(value) {
  const parts = partsOf(value);
  return parts ? `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}` : null;
}

export function formatClock(value) {
  const parts = partsOf(value);
  return parts ? `${parts.hour}:${parts.minute}:${parts.second}` : null;
}

function decimal(value) {
  return String(Math.round(value * 100) / 100);
}

export function formatTokenCount(value) {
  const tokens = finite(value);
  if (tokens === null) return null;
  if (tokens >= 1000000) return `${decimal(tokens / 1000000)}m`;
  if (tokens >= 1000) return `${decimal(tokens / 1000)}k`;
  return String(tokens);
}

function normalizeError(value) {
  if (!isRecord(value)) return null;
  const code = presentText(value.code);
  const message = oneLine(value.message).slice(0, 300) || null;
  if (!code && !message) return null;
  return {
    code: code || 'SQUAD_RUNTIME_INFO_UNAVAILABLE',
    message,
    text: message || code || '接口暂不可用',
  };
}

function versionLabel(value) {
  const text = presentText(value);
  if (!text) return null;
  return `v${text.replace(/^v/i, '')}`;
}

function safeEntryUrl(value) {
  if (typeof value !== 'string' || !value) return UPDATE_ENTRY_URL;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return UPDATE_ENTRY_URL;
    if (url.hostname !== UPDATE_ENTRY_HOST || url.pathname !== UPDATE_ENTRY_PATH) return UPDATE_ENTRY_URL;
    return url.toString();
  } catch {
    return UPDATE_ENTRY_URL;
  }
}

/**
 * @param {object|null|undefined} updates /api/runtime-info.updates
 */
export function versionView(updates) {
  const loading = {
    state: 'loading',
    localVersion: null,
    localLabel: '未识别',
    statusText: '正在读取本机版本…',
    stale: false,
    error: null,
    errorNotice: null,
    localVersionError: null,
    localErrorNotice: null,
    entryUrl: UPDATE_ENTRY_URL,
    entryLabel: '打开发布页',
    autoUpdate: false,
    note: '公开本机构建不包含自动更新；需要新版本时请手动获取。',
  };
  if (!updates || !isRecord(updates)) return loading;

  const localVersion = presentText(updates.localVersion);
  const localLabel = versionLabel(localVersion) || '未识别';
  const localVersionError = normalizeError(updates.localVersionError);
  const error = normalizeError(updates.error);
  const stale = updates.stale === true;
  const statusText = localVersionError
    ? '本机安装版本无法识别。'
    : error
      ? '暂时无法读取本机版本。'
      : '本机安装版本。';

  return {
    state: 'ready',
    localVersion,
    localLabel,
    statusText,
    stale,
    error,
    errorNotice: error ? (stale ? `读取失败，展示上次成功记录：${error.text}` : `读取失败：${error.text}`) : null,
    localVersionError,
    localErrorNotice: localVersionError ? `本机版本无法识别：${localVersionError.text}` : null,
    entryUrl: safeEntryUrl(updates.entry?.url),
    entryLabel: '打开发布页',
    autoUpdate: false,
    note: '公开本机构建不包含自动更新；需要新版本时请手动获取并替换本机插件。',
  };
}

export function versionEntry(updates) {
  const view = versionView(updates);
  const versionLabelText = versionLabel(view.localVersion);
  return {
    label: versionLabelText || '版本未确认',
    hint: '· 查看版本',
    tone: 'quiet',
    title: view.localVersionError ? '本机版本无法识别' : '查看本机版本与手动更新说明',
    ariaLabel: versionLabelText
      ? `当前版本 ${versionLabelText}，查看版本信息`
      : `当前版本未识别，${view.statusText}`,
    statusText: view.statusText,
  };
}

function attemptIndexOf(attempt, position) {
  const value = Number(attempt?.index);
  return Number.isSafeInteger(value) && value > 0 ? value : position + 1;
}

function normalizeState(value) {
  return value === 'stopping' || value === 'stopped' || value === 'unconfirmed' ? value : null;
}

function stopView(task, attemptStatus, latest) {
  const stop = isRecord(task?.stop) ? task.stop : null;
  const explicit = normalizeState(stop?.state) || normalizeState(stop?.terminal);
  const status = String((latest ? task?.status : attemptStatus) || attemptStatus || task?.status || '').toLowerCase();
  let state = explicit;
  if (!state && status === 'stopped') state = 'stopped';
  else if (!state && stop && /running|queued|pending|in_progress|starting|preparing/.test(status)) state = 'stopping';
  else if (!state && stop && latest) state = 'unconfirmed';
  if (!state) return null;
  const labels = {stopping: '停止中', stopped: '已停止', unconfirmed: '无法确认停止'};
  return {
    state,
    label: labels[state],
    reason: presentText(stop?.reason),
    requestedAt: stop?.requestedAt ?? null,
    requestedLabel: formatDateTime(stop?.requestedAt),
    note: state === 'stopped'
      ? '已停止，保留当前修改与最后结果。'
      : state === 'stopping'
        ? '停止请求已发出，正文与修改继续保留。'
        : '未收到停止回执，正文与修改仍保留。',
  };
}

function entryFor(task, source, options) {
  const acceptance = isRecord(source?.acceptance) ? source.acceptance : null;
  const verification = isRecord(source?.verification) ? source.verification : null;
  if (!acceptance && !verification && !options.verifying) return null;

  const status = acceptance ? 'accepted' : 'verifying';
  const attemptIndex = options.index;
  const acceptedAt = acceptance ? isoOrNull(acceptance.at) : null;
  const verifiedAt = verification ? isoOrNull(verification.at) : null;
  const note = acceptance ? presentText(acceptance.note) : null;
  const changed = acceptance?.changedSinceVerification === true;
  const stop = stopView(task, source?.status, options.latest);
  const acceptedLabel = formatDateTime(acceptedAt);
  const verifiedLabel = formatDateTime(verifiedAt);
  const title = status === 'accepted' ? 'Codex 已核验' : 'Codex 核验中';

  const subtitle = status === 'accepted'
    ? acceptedLabel ? `核验时间：${acceptedLabel}` : '核验时间未上报'
    : verifiedLabel ? `提交核验时间：${verifiedLabel}` : '提交核验时间未上报';

  return {
    key: options.key,
    attemptIndex,
    badge: title,
    status,
    accepted: status === 'accepted',
    title,
    entryLabel: '查看结论',
    sheet: {
      title: '核验结论',
      subtitle,
      badge: title,
      warning: null,
      note: {
        label: '核验结果说明',
        text: note,
        present: Boolean(note),
        emptyText: '验收记录未提供说明（未上报）。',
      },
      changed,
      stop,
    },
  };
}

function retirementView(retirement) {
  if (!isRecord(retirement)) return null;
  const outcome = retirement.outcome === 'cancelled' ? 'cancelled' : 'superseded';
  return {
    outcome,
    title: outcome === 'cancelled' ? '任务处置 · 已取消' : '任务处置 · 已被替代',
    reason: presentText(retirement.reason) || '原因未上报',
    replacedBy: presentText(retirement.replacedBy),
    atLabel: formatDateTime(retirement.at),
  };
}

export function verificationModel(task) {
  const attempts = Array.isArray(task?.attempts) ? task.attempts : [];
  const ordered = attempts
    .map((attempt, position) => ({attempt, position, index: attemptIndexOf(attempt, position)}))
    .sort((left, right) => left.index - right.index || left.position - right.position);
  const entries = [];
  ordered.forEach((item, position) => {
    const entry = entryFor(task, item.attempt, {
      index: item.index,
      key: presentText(item.attempt?.id) || `attempt-${item.index}`,
      latest: position === ordered.length - 1,
    });
    if (entry) entries.push(entry);
  });
  if (!entries.length && (task?.acceptance || task?.verification)) {
    const fallback = entryFor(task, {
      acceptance: task.acceptance,
      verification: task.verification,
      status: task.status,
    }, {index: null, key: 'current', latest: true});
    if (fallback) entries.push(fallback);
  }

  const latestAttempt = ordered.length ? ordered[ordered.length - 1] : null;
  const latestEntry = entries.length ? entries[entries.length - 1] : null;
  // 只把“最新一次尝试”的核验事实作为右上角状态；旧的已通过结论不能覆盖正在核验的新一轮。
  let latest = latestEntry && (!latestAttempt || latestEntry.attemptIndex === latestAttempt.index) ? latestEntry : null;
  if (!latest && String(latestAttempt?.status || task?.status || '').toLowerCase() === 'verifying') {
    latest = entryFor(task, latestAttempt?.attempt ?? {status: task?.status}, {
      index: latestAttempt?.index ?? null,
      key: 'verifying',
      latest: true,
      verifying: true,
    });
  }

  return {
    latest,
    entries,
    count: entries.length,
    stampCount: entries.filter(entry => entry.accepted).length,
    hasRecords: Boolean(latest),
    entryLabel: '查看结论',
    retirement: retirementView(task?.retirement),
    stop: stopView(task, latestAttempt?.attempt?.status, true),
  };
}

// 版本入口与版本弹层：只读 /api/runtime-info，展示本机安装版本并给出手动获取入口；
// 公开本机构建不发起任何联网检查，也不提交安装请求。
import {versionEntry, versionView} from './runtime-info-model.mjs';

export type RuntimeUpdates = {
  localVersion?: string | null;
  localVersionError?: {code?: string; message?: string} | null;
  entry?: {url?: string; mode?: string} | null;
  autoUpdate?: boolean;
  stale?: boolean;
  error?: {code?: string; message?: string} | null;
};

export type RuntimeInfo = {
  schemaVersion?: number;
  updates?: RuntimeUpdates | null;
  activeTasks?: number | null;
};

type RuntimeRequest = (url: string, init?: RequestInit) => Promise<Response>;
type RuntimeError = {code?: string; message?: string};

export type RuntimeReaderOptions = {
  request?: RuntimeRequest;
  onUpdate?: (info: RuntimeInfo) => void;
  onError?: (error: RuntimeError) => void;
  timeoutMs?: number;
};

export type RuntimeReader = {
  read(): Promise<RuntimeInfo | null>;
  start(): Promise<RuntimeInfo | null>;
  readIfStale(maxAgeMs?: number): Promise<RuntimeInfo | null>;
  current(): RuntimeInfo | null;
  close(): void;
};

const DEFAULT_TIMEOUT_MS = 8000;

function failureInfo(message: string): RuntimeInfo {
  return {
    schemaVersion: 1,
    updates: {
      localVersion: null,
      localVersionError: null,
      entry: null,
      autoUpdate: false,
      stale: false,
      error: {code: 'SQUAD_RUNTIME_INFO_UNAVAILABLE', message: message.slice(0, 300)},
    },
    activeTasks: null,
  };
}

export function createRuntimeInfoReader(options: RuntimeReaderOptions = {}): RuntimeReader {
  const request: RuntimeRequest = options.request || ((url, init) => fetch(url, init));
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(200, Number(options.timeoutMs)) : DEFAULT_TIMEOUT_MS;
  let current: RuntimeInfo | null = null;
  let inFlight: Promise<RuntimeInfo | null> | null = null;
  let controller: AbortController | null = null;
  let lastReadAt = 0;
  let closed = false;

  function emit(next: RuntimeInfo): void {
    if (closed) return;
    current = next;
    options.onUpdate?.(next);
  }
  function report(error: unknown): void {
    if (closed) return;
    const message = error instanceof Error ? error.message : String(error || 'runtime-info unavailable');
    const detail = {code: 'SQUAD_RUNTIME_INFO_UNAVAILABLE', message};
    options.onError?.(detail);
    if (!current) {
      emit(failureInfo(message));
      return;
    }
    // 读取失败时保留上次成功值，只标记记录过期。
    emit({
      ...current,
      updates: current.updates ? {...current.updates, stale: true, error: detail} : current.updates,
    });
  }
  function load(): Promise<RuntimeInfo | null> {
    if (closed) return Promise.resolve(current);
    if (inFlight) return inFlight;
    controller = new AbortController();
    const abort = controller;
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    inFlight = (async () => {
      try {
        const response = await request('./api/runtime-info', {
          method: 'GET',
          cache: 'no-store',
          headers: {accept: 'application/json'},
          signal: abort.signal,
        });
        if (!response.ok) throw new Error(`runtime-info HTTP ${response.status}`);
        const next = await response.json() as RuntimeInfo;
        if (!next || typeof next !== 'object' || next.schemaVersion !== 1) throw new Error('runtime-info 回执无法识别');
        lastReadAt = Date.now();
        emit(next);
        return next;
      } catch (error) {
        report(error);
        return current;
      } finally {
        clearTimeout(timer);
        if (controller === abort) controller = null;
        inFlight = null;
      }
    })();
    return inFlight;
  }

  return {
    read() {
      return load();
    },
    start() {
      return load();
    },
    readIfStale(maxAgeMs = 60000) {
      const age = Date.now() - lastReadAt;
      if (lastReadAt && age < Math.max(0, maxAgeMs)) return Promise.resolve(current);
      return load();
    },
    current() {
      return current;
    },
    close() {
      closed = true;
      controller?.abort();
      controller = null;
    },
  };
}

/* ---------- 共享弹层：>=768px 居中 560px，窄窗口底部展开，绝不使用侧边抽屉 ---------- */

const ICONS: Record<string, string> = {
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  verified: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l2.1 1.7 2.7-.2.9 2.5 2.3 1.5-.8 2.6.8 2.6-2.3 1.5-.9 2.5-2.7-.2L12 21l-2.1-1.7-2.7.2-.9-2.5L4 15.5l.8-2.6L4 10.3l2.3-1.5.9-2.5 2.7.2z"/><path d="m8.6 12.2 2.2 2.2 4.3-4.6"/></svg>',
  published: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12a8 8 0 0 1 13.7-5.6L20 8"/><path d="M20 4v4h-4"/><path d="M20 12a8 8 0 0 1-13.7 5.6L4 16"/><path d="M4 20v-4h4"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5v5h5"/><path d="M4.6 10a7.5 7.5 0 1 1 .3 5"/></svg>',
  alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5 21 19H3z"/><path d="M12 9v4.5"/><circle cx="12" cy="16.4" r=".6" fill="currentColor" stroke="none"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 11v5"/><circle cx="12" cy="8" r=".6" fill="currentColor" stroke="none"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg>',
};

function iconNode(name: string, className: string): HTMLElement {
  const span = document.createElement('span');
  span.className = className;
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = ICONS[name] || ICONS.info;
  return span;
}

export type DialogVariant = 'seal' | 'update';

export type DialogOptions = {
  variant: DialogVariant;
  title: string;
  subtitle?: string;
  badge?: string | null;
  icon?: 'verified' | 'published';
  body: Node;
  footer?: Node | null;
  onClose?: () => void;
};

export type DialogHandle = {
  element: HTMLElement;
  body: HTMLElement;
  badge: HTMLElement;
  subtitle: HTMLElement;
  close(): void;
  setBody(node: Node): void;
  setBadge(text: string): void;
  setSubtitle(text: string): void;
  setFooter(node: Node): void;
};

const dialogRegistry = new Set<DialogHandle>();
let scrollLocks = 0;
let previousBodyOverflow: string | null = null;

function lockBodyScroll(): void {
  if (scrollLocks === 0) {
    previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
  scrollLocks += 1;
}

function unlockBodyScroll(): void {
  if (scrollLocks === 0) return;
  scrollLocks -= 1;
  if (scrollLocks === 0) {
    document.body.style.overflow = previousBodyOverflow || '';
    previousBodyOverflow = null;
  }
}

export function closeAllDialogs(): void {
  for (const dialog of Array.from(dialogRegistry)) dialog.close();
}

export function openDialog(options: DialogOptions): DialogHandle {
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const titleId = `squad-v9-dialog-title-${Math.random().toString(36).slice(2, 9)}`;

  const element = document.createElement('div');
  element.className = `squad-v9-dialog squad-v9-dialog--${options.variant}`;
  element.setAttribute('role', 'dialog');
  element.setAttribute('aria-modal', 'true');
  element.setAttribute('aria-labelledby', titleId);

  const backdrop = document.createElement('div');
  backdrop.className = 'squad-v9-dialog-backdrop';
  backdrop.dataset.dialogBackdrop = '';

  const panel = document.createElement('div');
  panel.className = 'squad-v9-dialog-panel';

  const grab = document.createElement('div');
  grab.className = 'squad-v9-sheet-grab';
  grab.setAttribute('aria-hidden', 'true');

  const head = document.createElement('div');
  head.className = 'squad-v9-dialog-head';
  const identity = document.createElement('div');
  identity.className = 'squad-v9-dialog-identity';
  const iconBox = document.createElement('div');
  iconBox.className = 'squad-v9-dialog-icon';
  iconBox.append(iconNode(options.icon || 'verified', 'squad-v9-icon'));
  const titles = document.createElement('div');
  titles.className = 'squad-v9-dialog-titles';
  const titleRow = document.createElement('div');
  titleRow.className = 'squad-v9-dialog-title-row';
  const title = document.createElement('h2');
  title.className = 'squad-v9-dialog-title';
  title.id = titleId;
  title.textContent = options.title;
  const badge = document.createElement('span');
  badge.className = 'squad-v9-dialog-badge';
  badge.textContent = options.badge || '';
  badge.hidden = !options.badge;
  titleRow.append(title, badge);
  const subtitle = document.createElement('p');
  subtitle.className = 'squad-v9-dialog-subtitle';
  subtitle.textContent = options.subtitle || '';
  subtitle.hidden = !options.subtitle;
  titles.append(titleRow, subtitle);
  identity.append(iconBox, titles);

  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'squad-v9-dialog-close';
  closeButton.setAttribute('aria-label', '关闭 (Esc)');
  closeButton.title = '关闭 (Esc)';
  closeButton.append(
    Object.assign(document.createElement('span'), {className: 'squad-v9-dialog-esc', textContent: 'Esc'}),
    iconNode('close', 'squad-v9-icon squad-v9-icon--close'),
  );
  head.append(identity, closeButton);

  const body = document.createElement('div');
  body.className = 'squad-v9-dialog-body';
  body.append(options.body);

  const footer = document.createElement('div');
  footer.className = 'squad-v9-dialog-foot';
  if (options.footer) footer.append(options.footer);
  else {
    const done = document.createElement('button');
    done.type = 'button';
    done.className = 'squad-v9-dialog-secondary';
    done.textContent = '关闭 (Esc)';
    done.addEventListener('click', () => dialog.close());
    footer.append(done);
  }

  panel.append(grab, head, body, footer);
  element.append(backdrop, panel);
  document.body.append(element);
  lockBodyScroll();

  const focusables = (): HTMLElement[] => Array.from(element.querySelectorAll<HTMLElement>(
    'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])',
  )).filter(node => !node.hidden && node.offsetParent !== null);

  let closed = false;
  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      dialog.close();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = focusables();
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  const dialog: DialogHandle = {
    element,
    body,
    badge,
    subtitle,
    close() {
      if (closed) return;
      closed = true;
      element.removeEventListener('keydown', onKeydown);
      element.remove();
      dialogRegistry.delete(dialog);
      unlockBodyScroll();
      const restore=previousFocus?.isConnected?previousFocus:previousFocus?.id?document.getElementById(previousFocus.id):null;
      restore?.focus({preventScroll:true});
      options.onClose?.();
    },
    setBody(node) {
      body.replaceChildren(node);
    },
    setBadge(text) {
      badge.textContent = text;
      badge.hidden = !text;
    },
    setSubtitle(text) {
      subtitle.textContent = text;
      subtitle.hidden = !text;
    },
    setFooter(node) {
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const activeInsideFooter = Boolean(active && footer.contains(active));
      footer.replaceChildren(node);
      if (!activeInsideFooter) return;
      const target = footer.querySelector<HTMLElement>('[data-dialog-close]:not([disabled])')
        || footer.querySelector<HTMLElement>('button:not([disabled]),a[href]');
      target?.focus({preventScroll: true});
    },
  };
  closeButton.addEventListener('click', () => dialog.close());
  backdrop.addEventListener('click', () => dialog.close());
  element.addEventListener('keydown', onKeydown);
  dialogRegistry.add(dialog);
  closeButton.focus({preventScroll: true});
  return dialog;
}

/* ---------- 版本弹层：只展示本机版本与手动获取入口 ---------- */

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

/* ---------- 全局版本入口 ---------- */

export type VersionEntryHandle = {
  element: HTMLButtonElement;
  update(updates?: RuntimeUpdates | null): void;
};

export function updateVersionEntry(button: HTMLButtonElement, updates?: RuntimeUpdates | null): void {
  const view = versionEntry(updates ?? null);
  button.dataset.tone = view.tone;
  button.title = view.title;
  button.setAttribute('aria-label', view.ariaLabel);
  const label = button.querySelector<HTMLElement>('[data-version-label]');
  if (label) label.textContent = view.label;
  const badge = button.querySelector<HTMLElement>('[data-version-badge]');
  if (badge) {
    badge.textContent = '';
    badge.hidden = true;
  }
  const hint = button.querySelector<HTMLElement>('[data-version-hint]');
  if (hint) hint.textContent = view.hint;
}

export function renderVersionEntry({onOpen}: {onOpen: () => void}): VersionEntryHandle {
  const button = node('button', 'squad-v9-version');
  button.id='squad-version-entry';
  button.type = 'button';
  button.setAttribute('aria-haspopup', 'dialog');
  const dot = node('span', 'squad-v9-version-dot');
  dot.setAttribute('aria-hidden', 'true');
  const label = node('span', 'squad-v9-version-label');
  label.dataset.versionLabel = '';
  const badge = node('span', 'squad-v9-version-badge');
  badge.dataset.versionBadge = '';
  const hint = node('span', 'squad-v9-version-hint');
  hint.dataset.versionHint = '';
  button.append(dot, label, badge, hint);
  button.addEventListener('click', () => onOpen());
  updateVersionEntry(button, null);
  return {element: button, update: updates => updateVersionEntry(button, updates)};
}
/* ---------- 版本弹层：只展示本机版本与手动获取入口 ---------- */

export type VersionSheetHandle = DialogHandle & {
  update(runtime: RuntimeInfo | null): void;
};

type VersionSheetOptions = {
  onClose?: () => void;
};

function versionBody(runtime: RuntimeInfo | null): HTMLElement {
  const view = versionView(runtime?.updates ?? null);
  const root = node('div', 'squad-v9-update');
  root.dataset.versionState = view.state;

  const versions = node('div', 'squad-v9-update-versions');
  const current = node('span', 'squad-v9-update-version');
  current.append(node('span', 'squad-v9-update-version-label', '当前版本：'), node('strong', '', view.localLabel));
  versions.append(current, node('span', 'squad-v9-update-status is-quiet', view.statusText));
  root.append(versions);

  if (view.localErrorNotice) root.append(node('p', 'squad-v9-update-notice', view.localErrorNotice));
  if (view.errorNotice) root.append(node('p', 'squad-v9-update-notice', view.errorNotice));

  root.append(node('div', 'squad-v9-update-section-label', '[ 手动更新 · MANUAL UPDATE ]'));
  const notes = node('div', 'squad-v9-update-notes');
  notes.append(node('p', 'squad-v9-update-note-text', view.note));
  notes.append(node(
    'p',
    'squad-v9-update-empty',
    '本插件没有自动更新通道，也不会自动安装新版本；请在发布页确认版本后手动替换本机插件。',
  ));
  root.append(notes);
  return root;
}

function versionFooter(runtime: RuntimeInfo | null, actions: {close: () => void}): HTMLElement {
  const view = versionView(runtime?.updates ?? null);
  const footer = node('div', 'squad-v9-dialog-foot-row');
  const close = node('button', 'squad-v9-dialog-secondary', '关闭 (Esc)');
  close.type = 'button';
  close.dataset.dialogClose = '';
  close.addEventListener('click', actions.close);
  const entry = node('a', 'squad-v9-dialog-primary');
  entry.href = view.entryUrl;
  entry.target = '_blank';
  entry.rel = 'noopener noreferrer';
  entry.append(node('span', '', view.entryLabel), node('span', 'squad-v9-dialog-primary-arrow', '↗'));
  footer.append(close, entry);
  return footer;
}

export function openVersionSheet(runtime: RuntimeInfo | null, options: VersionSheetOptions = {}): VersionSheetHandle {
  let current = runtime;
  let dialog: VersionSheetHandle | null = null;
  const render = (): void => {
    if (!dialog) return;
    dialog.setBody(versionBody(current));
    dialog.setFooter(versionFooter(current, {close: () => dialog?.close()}));
    dialog.setSubtitle('本机安装 · 手动更新');
  };

  dialog = Object.assign(openDialog({
    variant: 'update',
    title: '版本信息',
    subtitle: '本机安装 · 手动更新',
    badge: '本机构建',
    icon: 'published',
    body: versionBody(runtime),
    footer: versionFooter(runtime, {close: () => dialog?.close()}),
    onClose: options.onClose,
  }), {
    update(next: RuntimeInfo | null) {
      current = next;
      render();
    },
  });
  return dialog;
}

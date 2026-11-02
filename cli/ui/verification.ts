// 右上角核验状态与“最新核验结论”弹层：只有真实 acceptance 才显示已核验，verification 仅表示核验中。
import {verificationModel} from './runtime-info-model.mjs';
import {openDialog, type DialogHandle} from './runtime-info';
import type {Task} from './types';

type StopModel = {
  state: 'stopping' | 'stopped' | 'unconfirmed';
  label: string;
  reason: string | null;
  requestedAt?: string | null;
  requestedLabel?: string | null;
  note: string;
};

type SheetModel = {
  title: string;
  subtitle: string;
  badge: string;
  warning: string | null;
  note: {label: string; text: string | null; present: boolean; emptyText: string};
  changed: boolean;
  stop: StopModel | null;
};

export type VerificationEntryModel = {
  key: string;
  attemptIndex: number | null;
  badge: string;
  status: 'accepted' | 'verifying';
  accepted: boolean;
  title: string;
  entryLabel: string;
  sheet: SheetModel;
};

type VerificationViewModel = {
  latest: VerificationEntryModel | null;
};

const ICONS: Record<string, string> = {
  arrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7"/><path d="M8 7h9v9"/></svg>',
  note: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h5M9 12h6M9 16h4"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v5c0 4.4-2.9 7.6-7 10-4.1-2.4-7-5.6-7-10V6z"/><path d="m9 12 2 2 4-4.5"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"/><rect x="9" y="9" width="6" height="6" rx="1"/></svg>',
};

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function iconNode(name: string, className: string): HTMLElement {
  const span = document.createElement('span');
  span.className = className;
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = ICONS[name] || ICONS.note;
  return span;
}

export function openVerificationSheet(entry: VerificationEntryModel): DialogHandle {
  return openDialog({
    variant: 'seal',
    title: entry.sheet.title,
    subtitle: entry.sheet.subtitle,
    badge: entry.sheet.badge,
    icon: entry.status === 'accepted' ? 'verified' : 'published',
    body: evidenceBody(entry),
  });
}

// 任务标题行右上角只保留一个可点状态；没有核验事实时不动原执行状态。
export function renderVerificationStamp(section: HTMLElement, task: Task): void {
  const container = section.querySelector('h1')?.parentElement;
  if (!container) return;
  const latest = (verificationModel(task) as VerificationViewModel).latest;
  if (!latest) return;

  const previous = container.querySelector<HTMLElement>('[data-verify-stamp]');
  const stamp = node('button', `squad-v9-verify-stamp is-${latest.status}`);
  stamp.type = 'button';
  stamp.id = `squad-verification-${encodeURIComponent(task.id)}`;
  stamp.dataset.verifyStamp = '';
  stamp.dataset.status = latest.status;
  stamp.setAttribute('aria-haspopup', 'dialog');
  stamp.setAttribute('aria-label', `${latest.entryLabel}：${latest.title}`);
  stamp.title = '查看最新核验结论';

  stamp.append(
    node('span', 'squad-v9-verify-stamp-dot'),
    node('span', 'squad-v9-verify-stamp-label', latest.title),
    iconNode('arrow', 'squad-v9-verify-stamp-arrow'),
  );
  stamp.addEventListener('click', () => openVerificationSheet(latest));

  if (previous) {
    previous.replaceWith(stamp);
    return;
  }
  const badge = container.lastElementChild as HTMLElement | null;
  if (badge) badge.replaceWith(stamp);
  else container.append(stamp);
}

function stopSection(stop: StopModel): HTMLElement {
  const block = node('div', `squad-v9-evidence-stop is-${stop.state}`);
  const head = node('div', 'squad-v9-evidence-stop-head');
  head.append(iconNode('stop', 'squad-v9-icon'), node('strong', '', stop.label));
  block.append(head, node('p', 'squad-v9-evidence-stop-note', stop.note));
  const details: string[] = [];
  if (stop.reason) details.push(`原因：${stop.reason}`);
  if (stop.requestedLabel) details.push(`请求时间：${stop.requestedLabel}`);
  if (details.length) block.append(node('p', 'squad-v9-evidence-empty', details.join(' ')));
  return block;
}

function evidenceBody(entry: VerificationEntryModel): HTMLElement {
  const sheet = entry.sheet;
  const root = node('div', 'squad-v9-evidence');

  if (entry.status !== 'accepted') {
    const section = node('section', 'squad-v9-evidence-section');
    section.append(node('h3', 'squad-v9-evidence-label', 'Codex 核验中'));
    const body = node('div', 'squad-v9-evidence-body');
    body.append(node('p', 'squad-v9-evidence-verifying', '正在核验，完成后可在这里查看结论。'));
    section.append(body);
    root.append(section);
    if (sheet.stop) root.append(stopSection(sheet.stop));
    return root;
  }

  const section = node('section', 'squad-v9-evidence-section');
  section.append(node('h3', 'squad-v9-evidence-label', sheet.note.label));
  const body = node('div', 'squad-v9-evidence-body');
  const wrap = node('div', 'squad-v9-evidence-note-wrap');
  wrap.append(sheet.note.present && sheet.note.text
    ? node('p', 'squad-v9-evidence-note', sheet.note.text)
    : node('p', 'squad-v9-evidence-empty', sheet.note.emptyText));
  body.append(wrap);
  section.append(body);
  root.append(section);

  if (sheet.stop) root.append(stopSection(sheet.stop));
  return root;
}

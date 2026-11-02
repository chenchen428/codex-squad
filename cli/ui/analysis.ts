// 周期分析报告页面：按 R50 Stitch 整稿组织章节与稳定表格，只填装冻结统计与同轮分析输出。
// 内容为共享壳之内的分析主体，动态文本一律 textContent。
import type { aggregateAnalytics } from '../lib/analytics.mjs';
import {PREVIEW_ROWS, RANGE_OPTIONS, cliView, observationStages, reportModel} from './analysis-report.mjs';
import {nextSort, sortRows} from './table-model.mjs';
import {openDialog, type DialogHandle} from './runtime-info';

type SortDirection = 'asc' | 'desc';
type TableSort = {key: string; direction: SortDirection};
type SortColumn<T> = {key: string; type: 'number' | 'text'; value: (row: T) => unknown};

export type AnalysisSuggestion = {
  title: string;
  observation?: string;
  action?: string;
  verification?: string;
  evidenceRefs?: string[];
};

export type AnalysisSessionDescription = {
  threadId: string;
  title?: string;
  description?: string;
  representativeTaskIds?: string[];
  codexUrl?: string;
  taskLinks?: Array<{taskId?: string; url?: string}>;
};

export type AnalysisRunSummary = {
  runId?: string;
  status?: 'running' | 'succeeded' | 'failed' | 'interrupted' | string;
  trigger?: 'manual' | 'schedule' | string;
  requestId?: string;
  days?: 7 | 30 | null;
  window?: {days?: 7 | 30 | null; from?: string | null; to?: string | null};
  startedAt?: string;
  endedAt?: string;
  phase?: 'collecting' | 'analyzing' | 'publishing' | 'completed' | string;
  realCodexThreadId?: string;
  codexUrl?: string;
  reportAvailable?: boolean;
  error?: string;
};

export type AnalysisBlock = {
  available: boolean;
  /** 已保存统计是否可用于展示数字；AI 未完成或失败时仍可为 true。 */
  statsAvailable?: boolean;
  reason?: string;
  runId?: string;
  trigger?: string;
  summary?: string;
  categories?: Partial<Record<'skills_tools' | 'time' | 'tokens', AnalysisSuggestion[]>>;
  sessionDescriptions?: AnalysisSessionDescription[];
  codexThreadId?: string;
  codexUrl?: string;
  generatedAt?: string;
  window?: {days?: 7 | 30 | null; from?: string | null; to?: string | null};
  statsObservedAt?: string;
  statFingerprint?: string;
  evidenceDigest?: string;
  latestRun?: AnalysisRunSummary | null;
};

export type AnalysisData = ReturnType<typeof aggregateAnalytics> & {
  coverage: {sources?: {expected: number; loaded: number; unavailable: unknown[]}};
  /** 后端 /api/analytics 返回的已保存报告块；缺省表示尚无报告。 */
  analysis?: AnalysisBlock | null;
};

export type AnalysisState = {
  days: 7 | 30 | null;
  capability: 'skills' | 'tools';
  rank: 'tokens' | 'tasks';
  /** 主 Codex 可选注入的真实发起状态；缺省时以 data.analysis.latestRun 推断。 */
  running?: boolean;
};

export type AnalysisActions = {
  currentThreadId: string;
  onDays(days: 7 | 30 | null): void;
  onCapability(capability: 'skills' | 'tools'): void;
  onRank(rank: 'tokens' | 'tasks'): void;
  onTask(taskId: string): void;
  onRefresh(): void;
  onBoard(): void;
};

type BadgeTone = 'ok' | 'running' | 'fail' | 'quiet';

type ModelStatus = {
  phase: string;
  available: boolean;
  statsAvailable: boolean;
  running: boolean;
  runId: string | null;
  shortRunId: string | null;
  badge: {text: string; tone: BadgeTone};
  note: string;
  statusLabel: string;
  observedAt: string | null;
  generatedAt: string | null;
  error: string | null;
};

type ModelSessionRow = {
  index: number;
  numberLabel: string;
  threadId: string;
  title: string;
  taskCount: number;
  attempts: number;
  tokens: number | null;
  sortValues: {tasks: number; attempts: number; tokens: number | null};
  tokenLabel: string;
  hasScope: boolean;
  scopeHref: string | null;
  scopeLabel: string;
  codexHref: string | null;
  codexLabel: string;
  hasCodex: boolean;
  isPrimary: boolean;
  isCurrent: boolean;
};

type ModelTokenParts = {value: string; unit: string};

type ModelUsageTotals = {
  total: ModelTokenParts;
  input: ModelTokenParts;
  cached: ModelTokenParts;
  rawInput: ModelTokenParts;
  output: ModelTokenParts;
  cacheShare: string | null;
  shares: {cached: number | null; rawInput: number | null; output: number | null};
};

type ModelCodexUsage = {
  available: boolean;
  empty: boolean;
  emptyTitle: string | null;
  emptyText: string | null;
  note: string | null;
  observedLabel: string;
  coverageLabel: string;
  coverageSummary: string;
  leaders: Array<{
    key?: string;
    threadId: string;
    title: string;
    kindLabel: string;
    models: string[];
    total: number | null;
    turnCount: number;
    numberLabel: string;
    tokenLabel: string;
    percent: string;
    width: number;
  }>;
  groups: Array<{key: string; label: string; value: number; tokenLabel: string; percent: string}>;
  models: Array<{name: string; total: number; tokenLabel: string; percent: string; width: number}>;
  modelsCount: number;
  modelsOmitted: number;
  allSessions: Array<{
    key: string;
    threadId: string;
    title: string;
    kind: string;
    squadThreadId: string | null;
    kindLabel: string;
    models: string[];
    total: number | null;
    turnCount: number;
    tokenLabel: string;
    percent: string;
    scopeHref: string | null;
    codexHref: string | null;
  }>;
  sessionsCount: number;
  totals: ModelUsageTotals | null;
};

type ModelQoderUsage = {
  present: boolean;
  available: boolean;
  empty: boolean;
  emptyTitle: string | null;
  emptyText: string | null;
  note: string | null;
  observedLabel: string;
  coverageLabel: string;
  coverageSummary: string;
  totals: ModelUsageTotals | null;
  models: Array<{name: string; source: string; sourceLabel: string; attempts: number; total: number | null; tokenLabel: string; percent: string}>;
  modelsCount: number;
  modelsOmitted: number;
  sessions: Array<{
    threadId: string;
    title: string;
    kindLabel: string;
    models: string[];
    total: number | null;
    tokenLabel: string;
    percent: string;
    reportedAttempts: number;
    attempts: number;
    scopeHref: string | null;
    codexHref: string | null;
  }>;
  sessionsCount: number;
};

type ModelUsageComparison = {
  available: boolean;
  empty: boolean;
  emptyText: string;
  observedLabel: string;
  coverageLabel: string;
  coverageSummary: string;
  summary: string;
  rows: Array<{key: string; title: string; codexLabel: string; qoderLabel: string; codexTotal: number | null; qoderTotal: number | null; scopeHref: string | null; codexHref: string | null; kindLabel: string}>;
  codexOnly: Array<{title: string; kindLabel: string; codexLabel: string; qoderLabel: string; codexTotal: number | null; qoderTotal: number | null}>;
  note: string;
};

type ModelUsage = {
  modes: Array<{value: string; label: string}>;
  codex: ModelCodexUsage;
  qoder: ModelQoderUsage;
  compare: ModelUsageComparison;
};

type ModelEfficiency = {
  available: boolean;
  empty: boolean;
  headline: string;
  focusTitle: string;
  focusIntro: string;
  focusEmpty: boolean;
  focusEmptyText: string;
  emptyText: string | null;
  focus: Array<{
    title: string;
    rounds: number | null;
    roundsLabel: string;
    attempts: number;
    failedAttempts: number;
    failureLabel: string;
    tokenLabel: string;
    durationLabel: string;
    scopeHref: string | null;
    hasScope: boolean;
    linkLabel: string;
  }>;
  focusTotal: number;
  focusNote: string;
};

type ModelObservation = {
  number: string;
  categoryKey: string;
  categoryLabel: string;
  title: string;
  observation: string;
  action: string;
  verification: string;
  refs: Array<{label: string; href: string | null}>;
  evidenceNames: string[];
  hasDetails: boolean;
};

type ModelObservations = {
  available: boolean;
  hasSummary: boolean;
  intro: string;
  items: ModelObservation[];
  total: number;
  empty: boolean;
  emptyText: string;
};

type ModelCliRate = {
  succeeded: number;
  failed: number;
  unknown: number;
  known: number;
  rate: string | null;
  display: string;
  confirmedLabel: string;
};

type ModelCliRow = {
  key: string;
  name: string;
  command: string;
  title: string;
  calls: number;
  execution: ModelCliRate;
  business: ModelCliRate;
  failures: number;
  failureCategories: Array<{category: string; label: string; count: number}>;
  hasFailures: boolean;
  sessions: Array<{key: string; label: string; taskHref: string | null; codexHref: string | null}>;
  sessionsOmitted: number;
  hasSessions: boolean;
};

type ModelCli = {
  available: boolean;
  empty: boolean;
  emptyText: string | null;
  note: string | null;
  unclassifiedCalls: number | null;
  totalCalls: number;
  rowCount: number;
  filteredCount: number;
  shownCount: number;
  hiddenCount: number;
  omitted: number;
  unknownCalls: number;
  coverageLabel: string;
  filter: string;
  query: string;
  sort: TableSort | null;
  noMatches: boolean;
  expanded: boolean;
  filters: Array<{value: string; label: string}>;
  canExpand: boolean;
  toggleLabel: string | null;
  rows: ModelCliRow[];
};

type ModelBenefitMetric = {
  key: string;
  label: string;
  value: string;
  percent: string | null;
  tone: string;
  missing: boolean;
};

type ModelBenefitDelivery = {
  title: string;
  statusLabel: string;
  rangeLabel: string;
  actualLabel: string;
  actualCodexLabel: string;
  actualQoderLabel: string;
  qoderUsed: boolean;
  baselineLabel: string;
  baselineTokenLabel: string;
  baselineTimeLabel: string | null;
  netTokenLabel: string;
  netTimeLabel: string;
  tokenSavingLabel: string;
  timeSavingLabel: string;
  sortValues: {
    baselineTokens: number | null;
    codexTokens: number | null;
    qoderTokens: number | null;
    savedTokens: number | null;
    savedSeconds: number | null;
  };
  estimated: boolean;
  sources: Array<{label: string; href: string | null}>;
  sourcesNote: string;
  exclusions: string[];
  processing: Array<{label:string;value:string}>;
  included: boolean;
  links: Array<{label: string; href: string}>;
  hasLinks: boolean;
};

type ModelBenefits = {
  visible: boolean;
  present: boolean;
  available: boolean;
  empty: boolean;
  emptyTitle: string;
  emptyText: string;
  state: 'positive' | 'negative' | 'missing' | 'partial';
  title: string;
  metrics: ModelBenefitMetric[];
  summaryLine: string;
  negativeNote: string | null;
  coverageLabel: string;
  observation: string;
  observationLinks: Array<{label: string; href: string | null}>;
  details: {
    title: string;
    present: boolean;
    emptyText: string | null;
    summaryLabel: string;
    tableEmptyText: string;
    previewLimit: number;
    canExpand: boolean;
    expandLabel: string;
    collapseLabel: string;
    rangeLabel: string;
    generatedLabel: string;
    coverageLabel: string;
    countLabel: string;
    tableNote: string;
    groups: Array<{
      title: string;
      rows: Array<{key: string; label: string; value: string; percent?: string | null; tone?: string}>;
    }>;
    deliveries: ModelBenefitDelivery[];
    deliveryTotal: number;
    deliveriesOmitted: number;
    includedCount: number;
    excludedCount: number;
    exclusionSummary: Array<{label: string; count: number; countLabel: string}>;
    speeds: {
      rows: Array<{label: string; valueLabel: string; samplesLabel: string; basisLabel: string; rough: boolean; reported: boolean}>;
      empty: boolean;
      partial: boolean;
      note: string;
      emptyNote: string;
    };
    signedNote: string | null;
    note: string;
  };
};

type Model = {
  schemaVersion: number;
  windowDays: 7 | 30 | null;
  meta: {
    round: string; window: string; windowRange: string;
    windowFrom: string | null; windowTo: string | null;
    observedRaw: string | null; generatedRaw: string | null;
    badge: {text: string; tone: BadgeTone};
    observedAt: string; generatedAt: string;
  };
  highlight: {text: string; showLink: boolean; linkLabel: string};
  kpis: Array<{key: string; label: string; badge: {text: string; tone: string}; value: string; unit: string; footer: Array<{text: string; tone?: string}>}>;
  trend: {
    available: boolean;
    rows: Array<{date: string; label: string; missing: boolean; attempts: number | null; tokenReported: boolean; tokenLabel: string; unreportedAttempts: number | null; unreportedLabel: string}>;
    empty: boolean;
    title: string;
    scopeNote: string;
    note: string;
    emptyText: string;
    metaLabel: string;
    windowRange: string;
  };
  efficiency: ModelEfficiency;
  sessions: {rows: ModelSessionRow[]; rank: 'tokens' | 'tasks'; omitted: number; total: number; previewRows: number; canExpand: boolean; available: boolean; headline: string; subtitle: string; footer: string; emptyText: string};
  skills: {rows: Array<{name: string; reads: number}>; total: number; empty: boolean; available: boolean};
  usage: ModelUsage;
  benefits: ModelBenefits;
  cli: ModelCli;
  observations: ModelObservations;
  footer: {title: string};
  state: ModelStatus;
};

type RenderContext = {data: AnalysisData; state: AnalysisState; actions: AnalysisActions};

const contexts = new WeakMap<HTMLElement, RenderContext>();
const boundRoots = new WeakSet<HTMLElement>();
/** 轮询会整体重绘；展开的 CLI 失败明细按稳定行键保留。 */
const cliExpanded = new WeakMap<HTMLElement, Set<string>>();
/** CLI 筛选只在本地保留，统计口径不变。 */
const cliFilter = new WeakMap<HTMLElement, string>();
const renderedModels = new WeakMap<HTMLElement, Model>();
/** Codex/Qoder/对比只在本地切换，不重新读取统计。 */
const usageMode = new WeakMap<HTMLElement, 'codex' | 'qoder' | 'compare'>();
/** 所有可展开表默认只展示前 3 行；展开状态按稳定表键跨重绘保留。 */
const previewExpanded = new WeakMap<HTMLElement, Set<string>>();
/** 用量明细 details 的开合与行预览分开保存，重绘后保持用户当前展开的明细。 */
const usageDetailsOpen = new WeakMap<HTMLElement, Set<string>>();
/** 每张分析页同时最多一个工作依据弹框。 */
const benefitDialogs = new WeakMap<HTMLElement, {index: number; handle: DialogHandle}>();
/** 列排序按表独立记忆；轮询重绘不重置，也不影响其它表。 */
const tableSort = new WeakMap<HTMLElement, Map<string, TableSort>>();
/** CLI 查询只在本地保留，与分类筛选取交集。 */
const cliQuery = new WeakMap<HTMLElement, string>();
/** 中文输入法组合期间延迟整页重绘，避免轮询替换输入框打断候选。 */
const composingRoots = new WeakSet<HTMLElement>();
const pendingRenders = new WeakMap<HTMLElement, {data: AnalysisData; state: AnalysisState; actions: AnalysisActions}>();

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function slot(root: ParentNode, name: string): HTMLElement {
  const element = root.querySelector<HTMLElement>(`[data-slot="${name}"]`);
  if (!element) throw new Error(`分析页模板缺少 data-slot="${name}"`);
  return element;
}

function slotOf<T extends HTMLElement>(root: ParentNode, name: string): T {
  return slot(root, name) as T;
}

function setText(root: ParentNode, name: string, value: string): HTMLElement {
  const element = slot(root, name);
  element.textContent = value;
  return element;
}

function anchorItem(href: string, title: string, className: string, parts: string[]): HTMLAnchorElement {
  const link = el('a', className);
  link.href = href;
  if (title) link.title = title;
  for (const part of parts) link.append(el('span', '', part));
  return link;
}

function svgIcon(d: string, className: string): SVGSVGElement {
  const namespace = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(namespace, 'svg');
  const attrs: Record<string, string> = {
    class: className,
    viewBox: '0 0 16 16',
    width: '16',
    height: '16',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.5',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    focusable: 'false',
  };
  for (const [name, value] of Object.entries(attrs)) svg.setAttribute(name, value);
  const path = document.createElementNS(namespace, 'path');
  path.setAttribute('d', d);
  svg.append(path);
  return svg;
}

/** 未上报与未记录保持未知，不按 0 补齐。 */
function isUnreportedText(value: string): boolean {
  return !value || /未上报|未记录|未确认|暂无法|无记录/.test(value);
}

function valueCell(text: string, className = 'num-col align-right'): HTMLTableCellElement {
  const td = el('td', className);
  if (isUnreportedText(text)) td.append(el('span', 'status-pill uncomputed', text));
  else td.append(el('span', 'num-mono', text));
  return td;
}

function cellActions(cell: HTMLElement, className = 'cell-actions'): HTMLElement {
  const actions = el('div', className);
  cell.append(actions);
  return actions;
}

function titleCell(text: string, meta?: string): HTMLTableCellElement {
  const td = el('td', 'cell-title');
  const line = el('div', 'session-title');
  const title = el('span', 'cell-title-truncate', text);
  title.title = text;
  line.append(title);
  td.append(line);
  if (meta) td.append(el('span', 'cell-muted', meta));
  return td;
}

const TABLE_LAYOUT = {
  benefits: {widths: ['220px', '110px', '110px', '110px', '100px', '95px', '72px'], minWidth: 850},
  sessions: {widths: ['auto', '64px', '64px', '100px', '156px'], minWidth: 560},
  daily: {widths: ['auto', '90px', '100px', '120px'], minWidth: 480},
  cli: {widths: ['auto', '70px', '90px', '90px', '72px'], minWidth: 520},
  'usage-codex': {widths: ['auto', '84px', '84px', '64px', '156px'], minWidth: 560},
  'usage-qoder': {widths: ['auto', '84px', '84px', '64px', '156px'], minWidth: 560},
  'usage-compare': {widths: ['auto', '104px', '104px', '156px'], minWidth: 560},
  'usage-compare-only': {widths: ['auto', '110px', '110px'], minWidth: 560},
} as const;

function previewKeys(root: HTMLElement): Set<string> {
  let keys = previewExpanded.get(root);
  if (!keys) {
    keys = new Set<string>();
    previewExpanded.set(root, keys);
  }
  return keys;
}

function previewExpandedFor(root: HTMLElement, key: string): boolean {
  return previewExpanded.get(root)?.has(key) === true;
}

function setPreviewExpanded(root: HTMLElement, key: string, expanded: boolean): void {
  const keys = previewKeys(root);
  if (expanded) keys.add(key);
  else keys.delete(key);
}

function previewRows<T>(rows: T[], expanded: boolean): T[] {
  return expanded ? rows : rows.slice(0, PREVIEW_ROWS);
}

/** 表容器只在显式展开后限高滚动；收起态保留自然高度和页面滚动。 */
function markPreview(wrap: HTMLElement, key: string, expanded: boolean): void {
  wrap.classList.add('table-scroll-container');
  wrap.classList.toggle('expanded', expanded);
  wrap.dataset.previewTable = key;
  wrap.dataset.expanded = String(expanded);
}

function resetPreviewScroll(root: HTMLElement, key: string): void {
  const wrap = root.querySelector<HTMLElement>(`[data-preview-table="${CSS.escape(key)}"]`);
  if (wrap) wrap.scrollTop = 0;
}

function focusPreviewToggle(root: HTMLElement, key: string): void {
  root.querySelector<HTMLButtonElement>(`[data-action="preview"][data-preview-key="${CSS.escape(key)}"]`)
    ?.focus({preventScroll: true});
}

function tableFooter(
  host: HTMLElement,
  key: string,
  expanded: boolean,
  total: number,
  noun: string,
  labels?: {expand?: string; collapse?: string},
): void {
  host.replaceChildren();
  host.hidden = total <= PREVIEW_ROWS;
  if (total <= PREVIEW_ROWS) return;
  host.append(el('span', 'table-footer-count', `显示 ${expanded ? total : PREVIEW_ROWS} / ${total} ${noun}`));
  const button = el('button', 'table-footer-btn',
    expanded ? labels?.collapse || `收起至前 ${PREVIEW_ROWS} ${noun}` : labels?.expand || `展开全部 ${total} ${noun}`);
  button.type = 'button';
  button.dataset.action = 'preview';
  button.dataset.previewKey = key;
  button.setAttribute('aria-expanded', String(expanded));
  host.append(button);
}

function sortFor(root: HTMLElement, table: string): TableSort | null {
  return tableSort.get(root)?.get(table) ?? null;
}

/** cliView 由 JS 推断出 `sort?: null`，这里按页面模型契约收窄一次。 */
const cliViewModel = cliView as unknown as (
  data: AnalysisData,
  options: {filter: string; query: string; sort: TableSort | null; expanded: boolean},
) => ModelCli;

function setSortFor(root: HTMLElement, table: string, sort: TableSort): void {
  let map = tableSort.get(root);
  if (!map) {
    map = new Map<string, TableSort>();
    tableSort.set(root, map);
  }
  map.set(table, sort);
}

function sortRowsFor<T>(rows: T[], sort: TableSort | null, columns: SortColumn<T>[]): T[] {
  if (!sort) return rows.slice();
  return sortRows(rows, sort, columns) as T[];
}

const SORT_GLYPH_PATHS = {
  asc: 'M4 6.5 8 2.5l4 4',
  desc: 'M4 9.5 8 13.5l4-4',
} as const;

/** 排序图标沿用来源稿：16×16、2 描边、上下两枚三角；当前方向加亮，另一侧压暗。 */
function sortGlyph(state: 'neutral' | 'asc' | 'desc'): SVGSVGElement {
  const namespace = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(namespace, 'svg');
  const attrs: Record<string, string> = {
    class: 'sort-indicator',
    viewBox: '0 0 16 16',
    width: '16',
    height: '16',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    focusable: 'false',
  };
  for (const [name, value] of Object.entries(attrs)) svg.setAttribute(name, value);
  for (const direction of ['asc', 'desc'] as const) {
    const path = document.createElementNS(namespace, 'path');
    path.setAttribute('d', SORT_GLYPH_PATHS[direction]);
    path.setAttribute('class', `sort-path${state === direction ? ' is-active' : ''}`);
    svg.append(path);
  }
  svg.dataset.direction = state;
  return svg;
}

function sortHint(label: string, sort: TableSort | null, key: string, type: 'number' | 'text'): string {
  const next = nextSort(sort, key, type).direction === 'desc' ? '降序' : '升序';
  if (!sort || sort.key !== key) return `按${label}${next}排序`;
  const current = sort.direction === 'desc' ? '降序' : '升序';
  return `当前按${label}${current}，点击改为${next}`;
}

function headerClass(type: 'number' | 'text', className: string): string {
  return [type === 'number' ? 'num-col align-right' : '', className].filter(Boolean).join(' ');
}

/**
 * 表头整格是一个 button，方向与 aria-sort 同步；焦点环向内收，避免横向滚动容器裁切。
 */
function sortableHeader(
  root: HTMLElement,
  table: string,
  label: string,
  key: string,
  type: 'number' | 'text',
  className = '',
): HTMLTableCellElement {
  const current = sortFor(root, table);
  const active = current?.key === key;
  const th = el('th', headerClass(type, className));
  th.scope = 'col';
  th.setAttribute('aria-sort', active ? (current.direction === 'desc' ? 'descending' : 'ascending') : 'none');
  const button = el('button', `table-header-btn${type === 'number' ? ' align-right' : ''}${active ? ' is-active' : ''}`);
  button.type = 'button';
  button.dataset.action = 'sort';
  button.dataset.table = table;
  button.dataset.key = key;
  button.dataset.type = type;
  button.title = sortHint(label, current, key, type);
  button.append(el('span', 'header-label', label));
  button.append(sortGlyph(active && current ? current.direction : 'neutral'));
  th.append(button);
  return th;
}

function plainHeader(label: string, className = ''): HTMLTableCellElement {
  const th = el('th', [className, className.includes('num-col') ? 'align-right' : ''].filter(Boolean).join(' '));
  th.scope = 'col';
  th.textContent = label;
  return th;
}

function focusSortButton(root: HTMLElement, table: string, key: string): void {
  root.querySelector<HTMLButtonElement>(
    `[data-action="sort"][data-table="${CSS.escape(table)}"][data-key="${CSS.escape(key)}"]`,
  )?.focus({preventScroll: true});
}

function tableWrapper(root: HTMLElement, table: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-table-key="${CSS.escape(table)}"]`)
    ?.closest<HTMLElement>('.table-scroll-container') ?? null;
}

/** 排序后只重绘所属表，保留横向滚动位置，并把焦点还到同一列的同名按钮。 */
function refreshSort(root: HTMLElement, table: string, key: string): void {
  const scrollLeft = tableWrapper(root, table)?.scrollLeft ?? 0;
  if (table === 'benefits') refreshBenefits(root);
  else if (table === 'sessions') refreshSessions(root);
  else if (table === 'daily') refreshTrend(root);
  else if (table === 'cli') refreshCli(root);
  else if (table.startsWith('usage-')) refreshUsage(root);
  const wrap = tableWrapper(root, table);
  if (wrap) wrap.scrollLeft = scrollLeft;
  focusSortButton(root, table, key);
}

const LOCAL_DATE = new Intl.DateTimeFormat('zh-CN', {month: 'numeric', day: 'numeric'});
const LOCAL_STAMP = new Intl.DateTimeFormat('zh-CN', {
  month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

type LocalMoment = {date: Date; hasTime: boolean};

function localMoment(value: string | null | undefined): LocalMoment | null {
  const text = String(value || '').trim();
  if (!text) return null;
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (day) return {date: new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])), hasTime: false};
  const stamp = Date.parse(text);
  return Number.isFinite(stamp) ? {date: new Date(stamp), hasTime: true} : null;
}

function intlPart(parts: Intl.DateTimeFormatPart[], type: string): string {
  return parts.find(part => part.type === type)?.value || '';
}

function localDateText(value: string | null | undefined): string | null {
  const moment = localMoment(value);
  if (!moment) return null;
  const parts = LOCAL_DATE.formatToParts(moment.date);
  return `${intlPart(parts, 'month')}月${intlPart(parts, 'day')}日`;
}

function localStampText(value: string | null | undefined): string | null {
  const moment = localMoment(value);
  if (!moment) return null;
  if (!moment.hasTime) return localDateText(value);
  const parts = LOCAL_STAMP.formatToParts(moment.date);
  return `${intlPart(parts, 'month')}月${intlPart(parts, 'day')}日 ${intlPart(parts, 'hour')}:${intlPart(parts, 'minute')}`;
}

function localRangeText(from: string | null, to: string | null): string | null {
  const start = localMoment(from);
  const end = localMoment(to);
  const startText = start ? localDateText(from) : null;
  const endText = end ? localDateText(to) : null;
  if (startText && endText) {
    if (startText === endText) return startText;
    if (start && end && start.date.getFullYear() === end.date.getFullYear()
      && start.date.getMonth() === end.date.getMonth()) {
      return `${startText} — ${intlPart(LOCAL_DATE.formatToParts(end.date), 'day')}日`;
    }
    return `${startText} — ${endText}`;
  }
  if (endText) return `至 ${endText}`;
  if (startText) return `自 ${startText}`;
  return null;
}

const SUMMARY_PREFIX = '周期审计综述：';

/** R50 刊页静态骨架：沿用 Stitch 整稿的章节、表格框架与折叠结构；不含任何示例数据。 */
const REPORT_TEMPLATE = `
<main class="report-shell" data-analysis-report data-analysis-page="global">
<!-- 期次标题与区间切换：共享壳已提供品牌、原生会话名、导航与版本入口 -->
<header class="edition-bar" data-slot="meta-section">
<h1 class="edition-title" data-slot="report-title">小队的投入与回报<span class="sub" data-slot="window"></span></h1>
<div class="control-cluster">
<div class="pill-filters" data-slot="ranges" role="group" aria-label="选择统计区间"></div>
<span class="timestamp-cue" data-slot="updated"></span>
<span class="edition-badge" data-slot="badge" hidden></span>
</div>
</header>
<div class="sheet-body">
<!-- 01 小队收益 -->
<section class="report-chapter" id="sec-benefits" data-slot="benefits" aria-labelledby="benefits-heading">
<div class="chapter-heading-bar">
<div class="chapter-title-group">
<span class="chapter-num">§ 01</span>
<h2 class="chapter-title" id="benefits-heading">小队收益</h2>
<span class="chapter-caption" data-slot="benefits-coverage"></span>
</div>
<span class="chapter-aside-meta" data-slot="benefits-title"></span>
</div>
<div class="benefit-editorial-container">
<div class="benefit-hero-grid" data-slot="benefits-metrics"></div>
<div class="editorial-observation-bar" data-slot="benefits-observation" hidden>
<span class="observation-marker" aria-hidden="true">¶</span>
<span data-slot="benefits-observation-text"></span>
<span class="observation-links" data-slot="benefits-links"></span>
</div>
<div class="table-responsive-wrapper" data-slot="benefits-basis" hidden>
<div class="table-scroll-container" data-slot="benefits-table-wrap">
<table class="editorial-data-table" data-table-key="benefits">
<thead data-slot="benefits-head"></thead>
<tbody data-slot="benefits-rows"></tbody>
</table>
</div>
<div class="table-footer-band" data-slot="benefits-preview"></div>
</div>
</div>
</section>
<!-- 02 Token 消耗去向 -->
<section class="report-chapter" id="sec-consumption" data-slot="codex-usage" aria-labelledby="consumption-heading">
<div class="chapter-heading-bar">
<div class="chapter-title-group">
<span class="chapter-num">§ 02</span>
<h2 class="chapter-title" id="consumption-heading">Token 消耗去向</h2>
<span class="chapter-caption" data-slot="usage-scope"></span>
</div>
<div class="segmented-control" data-slot="usage-tabs" role="group" aria-label="切换用量视图"></div>
</div>
<div class="token-composite-card" data-slot="usage-totals">
<div class="token-hero-line">
<div class="token-hero-left" data-slot="usage-hero"></div>
<span class="token-hero-coverage" data-slot="usage-hero-note"></span>
</div>
<div class="token-flow-strip" data-slot="usage-flow"></div>
<div class="token-aux-info-band token-meta-row">
<span class="token-aux-item" data-slot="usage-model-summary"></span>
<span class="token-aux-item is-quiet" data-slot="usage-coverage"></span>
</div>
</div>
<div class="chapter-heading-bar usage-subheading">
<div class="chapter-title-group"><h3 class="chapter-title">小队任务与用量</h3></div>
</div>
<div class="squad-facts-band" data-slot="kpis"></div>
<details class="token-meta-fold">
<summary class="token-meta-summary"><span>执行明细</span><span class="token-meta-cue">展开</span></summary>
<div class="token-meta-body" data-slot="kpi-detail-body"></div>
</details>
<div class="usage-panel" data-slot="usage-body" role="tabpanel"></div>
<div class="chapter-heading-bar usage-subheading">
<div class="chapter-title-group">
<h3 class="chapter-title">会话消耗排行</h3>
<span class="chapter-caption" data-slot="sessions-subtitle"></span>
</div>
<div class="segmented-control" data-slot="session-rank" role="group" aria-label="会话排行依据">
<button class="seg-btn" type="button" data-action="rank" data-rank="tokens">按已报 Token</button>
<button class="seg-btn" type="button" data-action="rank" data-rank="tasks">按任务数</button>
</div>
</div>
<div class="table-responsive-wrapper">
<div class="table-scroll-container" data-slot="sessions-table-wrap">
<table class="editorial-data-table" data-table-key="sessions">
<thead data-slot="sessions-head"></thead>
<tbody data-slot="sessions"></tbody>
</table>
</div>
<div class="table-footer-band" data-slot="sessions-preview"></div>
</div>
<p class="stat-subtext" data-slot="sessions-footer"></p>
<details class="token-meta-fold daily-details" data-slot="daily" data-daily>
<summary class="token-meta-summary"><span data-slot="daily-title"></span><span class="token-meta-cue" data-slot="trend-max"></span></summary>
<div class="daily-body">
<p class="stat-subtext" data-slot="daily-scope"></p>
<p class="stat-subtext" data-slot="trend-range"></p>
<div class="table-responsive-wrapper">
<div class="table-scroll-container" data-slot="daily-table-wrap">
<table class="editorial-data-table" data-table-key="daily">
<thead data-slot="daily-head"></thead>
<tbody data-slot="trend"></tbody>
</table>
</div>
<div class="table-footer-band" data-slot="trend-preview"></div>
</div>
<p class="stat-subtext" data-slot="trend-note"></p>
</div>
</details>
</section>
<!-- 03 技能与 CLI 表现 -->
<section class="report-chapter" id="sec-cli" aria-labelledby="skills-heading">
<div class="chapter-heading-bar">
<div class="chapter-title-group">
<span class="chapter-num">§ 03</span>
<h2 class="chapter-title" id="skills-heading">技能与 CLI 表现</h2>
<span class="chapter-caption" data-slot="skills-summary"></span>
</div>
<span class="chapter-aside-meta" data-slot="cli-caption"></span>
</div>
<div class="skills-panel">
<div class="chapter-heading-bar usage-subheading">
<div class="chapter-title-group"><h3 class="chapter-title">技能文件读取</h3><span class="chapter-caption" data-slot="skills-total"></span></div>
</div>
<div class="skills-list" data-slot="skills"></div>
<div class="table-footer-band" data-slot="skills-preview"></div>
</div>
<div class="cli-block" data-slot="cli"></div>
</section>
<!-- 04 本期最值得处理的问题 -->
<section class="report-chapter" id="directives" data-slot="advisory" aria-labelledby="directives-heading">
<div class="chapter-heading-bar">
<div class="chapter-title-group">
<span class="chapter-num">§ 04</span>
<h2 class="chapter-title" id="directives-heading">本期最值得处理的问题</h2>
<span class="chapter-caption" data-slot="observation-count"></span>
</div>
<span class="chapter-aside-meta" data-slot="highlight-cue"></span>
</div>
<div class="recommendations-wrapper">
<p class="rec-summary-paragraph" data-slot="highlight-text"></p>
<a class="btn-cell-action rec-summary-link" data-slot="highlight-link" data-scroll="directives" hidden></a>
<p class="stat-subtext" data-slot="observation-intro"></p>
<div class="rec-list" data-slot="observations"></div>
</div>
</section>
</div>
<footer class="sheet-footer">
<span data-slot="footer-title"></span>
</footer>
</main>`;

const HIGHLIGHT_CUE = '执行事实';

function highlightText(model: Model): string {
  const source = model.highlight.text;
  return source.startsWith(SUMMARY_PREFIX) ? source.slice(SUMMARY_PREFIX.length) : source;
}

function renderHighlight(root: ParentNode, model: Model): void {
  setText(root, 'highlight-text', highlightText(model));
  setText(root, 'highlight-cue', model.windowDays === 7 || model.windowDays === 30
    ? `基于 ${model.windowDays} 天${HIGHLIGHT_CUE}`
    : `基于全部已保存${HIGHLIGHT_CUE}`);
  const link = slotOf<HTMLAnchorElement>(root, 'highlight-link');
  link.textContent = model.highlight.showLink ? model.highlight.linkLabel : '';
  link.hidden = !model.highlight.showLink;
}

function renderReportHead(root: HTMLElement, model: Model): void {
  const range = localRangeText(model.meta.windowFrom, model.meta.windowTo);
  setText(root, 'window', range ? range : model.state.statsAvailable ? '统计区间已保存' : '区间未上报');

  const generated = localStampText(model.meta.generatedRaw);
  const observed = localStampText(model.meta.observedRaw);
  const updated = slot(root, 'updated');
  if (generated) updated.textContent = `${generated} 更新`;
  else if (observed) updated.textContent = `${observed} 数据截止`;
  else updated.textContent = '更新时间未上报';
  const details: string[] = [];
  if (generated) details.push(`报告生成：${generated}`);
  if (observed) details.push(`数据截止：${observed}`);
  updated.title = details.length ? details.join(' · ') : '报告生成时间与数据截止时间均未上报';

  const badge = slot(root, 'badge');
  const showBadge = model.state.phase !== 'succeeded';
  badge.hidden = !showBadge;
  badge.textContent = showBadge ? model.state.badge.text : '';
  badge.dataset.tone = model.state.badge.tone;
}

function renderRanges(root: ParentNode, state: AnalysisState): void {
  const container = slot(root, 'ranges');
  container.replaceChildren();
  for (const option of RANGE_OPTIONS as Array<{days: number | null; label: string}>) {
    const days = option.days === 7 || option.days === 30 ? option.days as 7 | 30 : null;
    const active = state.days === days;
    const button = el('button', `pill-btn${active ? ' active' : ''}`, option.label);
    button.type = 'button';
    button.dataset.action = 'range';
    button.dataset.days = days === null ? 'all' : String(days);
    button.setAttribute('aria-pressed', String(active));
    button.title = active ? '当前统计区间' : '切换到该区间并读取已保存统计';
    container.append(button);
  }
}

function renderKpis(root: ParentNode, model: Model): void {
  const band = slot(root, 'kpis');
  const details = slot(root, 'kpi-detail-body');
  band.replaceChildren();
  details.replaceChildren();
  for (const kpi of model.kpis) {
    const card = el('div', 'squad-fact-card');
    card.dataset.tone = kpi.badge.tone;
    card.append(el('span', 'squad-fact-title', kpi.label));
    const value = el('div', 'squad-fact-val');
    value.append(el('span', '', kpi.value), el('span', 'squad-fact-unit', kpi.unit));
    card.append(value, el('span', 'squad-fact-note', kpi.badge.text));
    band.append(card);
    const row = el('div', 'kpi-detail-row');
    row.append(el('strong', '', kpi.label));
    const facts = el('span', 'kpi-detail-facts');
    kpi.footer.forEach((item, index) => {
      if (index) facts.append(document.createTextNode(' · '));
      facts.append(el('span', item.tone === 'danger' ? 'is-danger' : '', item.text));
    });
    row.append(facts);
    details.append(row);
  }
}

type DailyPoint = {date: string; label: string; missing: boolean; attempts: number | null; tokenReported: boolean; tokenLabel: string; unreportedAttempts: number | null; unreportedLabel: string};

/** 按日排序只读真实快照原值：缺失或未报用量保持 null，不解析展示文本，也不按 0 补齐。 */
function dailyTotals(data: AnalysisData): Map<string, number | null> {
  const totals = new Map<string, number | null>();
  const points = Array.isArray(data.trend) ? data.trend : [];
  for (const point of points) {
    const date = typeof point?.date === 'string' ? point.date : '';
    if (!date) continue;
    const tokens = point?.tokens;
    const total = typeof tokens?.totalTokens === 'number' && Number.isFinite(tokens.totalTokens) ? tokens.totalTokens : null;
    const input = typeof tokens?.inputTokens === 'number' && Number.isFinite(tokens.inputTokens) ? tokens.inputTokens : null;
    const output = typeof tokens?.outputTokens === 'number' && Number.isFinite(tokens.outputTokens) ? tokens.outputTokens : null;
    const reported = total !== null || input !== null || output !== null;
    totals.set(date, reported ? total ?? (input ?? 0) + (output ?? 0) : null);
  }
  return totals;
}

function renderTrend(root: HTMLElement, model: Model): void {
  setText(root, 'daily-title', model.trend.title);
  setText(root, 'daily-scope', model.trend.scopeNote);
  setText(root, 'trend-range', model.trend.windowRange);
  setText(root, 'trend-note', model.trend.note);
  setText(root, 'trend-max', model.trend.metaLabel);

  const head = slot(root, 'daily-head');
  head.replaceChildren();
  const headRow = el('tr');
  headRow.append(sortableHeader(root, 'daily', '日期', 'date', 'text'));
  headRow.append(sortableHeader(root, 'daily', '尝试次数', 'attempts', 'number'));
  headRow.append(sortableHeader(root, 'daily', '未报用量', 'unreported', 'number'));
  headRow.append(sortableHeader(root, 'daily', '已报 Token', 'tokens', 'number'));
  head.append(headRow);

  const expanded = previewExpandedFor(root, 'daily');
  markPreview(slot(root, 'daily-table-wrap'), 'daily', expanded);
  const preview = slot(root, 'trend-preview');
  preview.replaceChildren();
  const body = slot(root, 'trend');
  body.replaceChildren();
  if (!model.trend.rows.length) {
    const row = el('tr');
    const cell = el('td', 'editorial-empty', model.trend.emptyText);
    cell.colSpan = 4;
    row.append(cell);
    body.append(row);
    tableFooter(preview, 'daily', expanded, 0, '天');
    return;
  }
  const context = contexts.get(root);
  const totals = context ? dailyTotals(context.data) : new Map<string, number | null>();
  const rows: DailyPoint[] = model.trend.rows;
  const sorted = sortRowsFor(rows, sortFor(root, 'daily'), [
    {key: 'date', type: 'text', value: row => row.date},
    {key: 'attempts', type: 'number', value: row => row.attempts},
    {key: 'tokens', type: 'number', value: row => totals.get(row.date) ?? null},
    {key: 'unreported', type: 'number', value: row => row.unreportedAttempts},
  ]);
  for (const item of previewRows(sorted, expanded)) {
    const row = el('tr', item.tokenReported ? '' : 'is-unreported');
    row.dataset.date = item.date;
    row.append(titleCell(item.label));
    row.append(item.attempts === null
      ? valueCell(item.missing ? '无记录' : '未上报')
      : valueCell(String(item.attempts)));
    row.append(valueCell(item.unreportedLabel));
    row.append(valueCell(item.tokenLabel));
    body.append(row);
  }
  tableFooter(preview, 'daily', expanded, rows.length, '天');
}

function renderSessions(root: HTMLElement, model: Model): void {
  setText(root, 'sessions-subtitle', model.sessions.subtitle);
  const omitted = model.sessions.omitted > 0 ? ` · 其余 ${model.sessions.omitted} 组已省略` : '';
  setText(root, 'sessions-footer', `${model.sessions.footer}${omitted}`);

  const head = slot(root, 'sessions-head');
  head.replaceChildren();
  const headRow = el('tr');
  headRow.append(sortableHeader(root, 'sessions', '会话', 'title', 'text'));
  headRow.append(sortableHeader(root, 'sessions', '任务', 'tasks', 'number'));
  headRow.append(sortableHeader(root, 'sessions', '尝试', 'attempts', 'number'));
  headRow.append(sortableHeader(root, 'sessions', '已报 Token', 'tokens', 'number'));
  headRow.append(plainHeader('操作', 'table-action-col'));
  head.append(headRow);

  const expanded = previewExpandedFor(root, 'sessions');
  markPreview(slot(root, 'sessions-table-wrap'), 'sessions', expanded);
  const preview = slot(root, 'sessions-preview');
  preview.replaceChildren();

  const body = slot(root, 'sessions');
  body.replaceChildren();
  if (!model.sessions.rows.length) {
    const row = el('tr');
    const cell = el('td', 'editorial-empty', model.sessions.emptyText);
    cell.colSpan = 5;
    row.append(cell);
    body.append(row);
  }
  const sorted = sortRowsFor(model.sessions.rows, sortFor(root, 'sessions'), [
    {key: 'title', type: 'text', value: session => session.title},
    {key: 'tasks', type: 'number', value: session => session.sortValues.tasks},
    {key: 'attempts', type: 'number', value: session => session.sortValues.attempts},
    {key: 'tokens', type: 'number', value: session => session.sortValues.tokens},
  ]);
  for (const session of previewRows(sorted, expanded)) {
    const row = el('tr', session.isPrimary ? 'is-primary' : '');
    const content = el('td', 'session-work');
    const line = el('div', 'session-title');
    line.append(el('span', `row-index${session.isPrimary || session.index <= 4 ? ' is-hot' : ''}`, session.numberLabel));
    const name = el('span', 'cell-title-truncate', session.title);
    name.title = session.title;
    line.append(name);
    if (session.isCurrent) line.append(el('span', 'status-pill is-quiet', '当前'));
    if (session.isPrimary) line.append(el('span', 'status-pill', '报告主序'));
    content.append(line);
    row.append(content);
    row.append(valueCell(String(session.taskCount), 'num-col align-right'));
    row.append(valueCell(String(session.attempts), 'num-col align-right'));
    row.append(valueCell(session.tokenLabel, `num-col align-right${session.isPrimary ? ' num-hot' : ''}`));
    const links = el('td', 'table-action-col');
    usageLinks(links, session.title, session.scopeHref, session.codexHref);
    row.append(links);
    body.append(row);
  }
  tableFooter(preview, 'sessions', expanded, model.sessions.rows.length, '个会话');

  const rank = slot(root, 'session-rank');
  for (const button of Array.from(rank.querySelectorAll<HTMLButtonElement>('button'))) {
    const sort = sortFor(root, 'sessions');
    const active = sort ? sort.key === button.dataset.rank && sort.direction === 'desc' : button.dataset.rank === model.sessions.rank;
    button.className = `seg-btn${active ? ' is-active' : ''}`;
    button.setAttribute('aria-pressed', String(active));
  }
}

type UsageViewMode = 'codex' | 'qoder' | 'compare';
type UsageFact = 'total' | 'input' | 'cached' | 'output';
type UsageFlowFact = Exclude<UsageFact, 'total'>;

const USAGE_FLOW: Array<{kind: UsageFlowFact; index: string; label: string; sub: string}> = [
  {kind: 'input', index: '01', label: '输入', sub: '总输入量'},
  {kind: 'cached', index: '02', label: '其中缓存', sub: '已含在输入中'},
  {kind: 'output', index: '03', label: '输出', sub: '模型输出'},
];

const USAGE_HERO_NOTES: Record<UsageViewMode, string> = {
  codex: 'Codex 本机记录 · 不与 Qoder 合并',
  qoder: 'Qoder 执行记录 · 不与 Codex 合并',
  compare: '两方独立核算 · 不累加总额',
};

const USAGE_SCOPE_LABELS: Record<UsageViewMode, string> = {
  codex: 'Codex 本机记录',
  qoder: 'Qoder 执行记录',
  compare: 'Codex / Qoder 对比',
};

/** 只读 ModelUsageTotals：缺失指标区分未上报与缓存未记录，不按 0 补位。 */
function usageFact(kind: UsageFact, totals: ModelUsageTotals | null): {text: string; missing: boolean} {
  if (!totals) return {text: '未上报', missing: true};
  const value = kind === 'total' ? totals.total
    : kind === 'input' ? totals.input
    : kind === 'cached' ? totals.cached
    : totals.output;
  if (value.value === '未上报') return {text: kind === 'cached' ? '未记录' : '未上报', missing: true};
  return {text: `${value.value}${value.unit}`, missing: false};
}

/** 对比态把两方实际总量并排放在同一 hero 行；单主体沿用来源稿 hero 数值与副标题。 */
function fillUsageHero(
  hero: HTMLElement,
  mode: UsageViewMode,
  codexTotals: ModelUsageTotals | null,
  qoderTotals: ModelUsageTotals | null,
): void {
  hero.replaceChildren();
  hero.classList.toggle('is-compare', mode === 'compare');
  if (mode === 'compare') {
    for (const [provider, tone, totals] of [
      ['Codex', 'is-codex', codexTotals],
      ['Qoder', 'is-qoder', qoderTotals],
    ] as const) {
      const row = el('div', 'comparison-row');
      const line = el('div', 'comp-line');
      line.append(el('span', `comp-prov-tag ${tone}`, provider));
      const total = usageFact('total', totals);
      // 缺失侧只改颜色不改字号，保证切换模式时 hero 行高不变。
      line.append(el('span', `flow-val${total.missing ? ' is-missing' : ''}`, total.text));
      row.append(line);
      hero.append(row);
    }
    return;
  }
  const total = usageFact('total', mode === 'qoder' ? qoderTotals : codexTotals);
  hero.append(el('span', `token-hero-val${total.missing ? ' is-missing' : ''}`, total.text));
  hero.append(el('span', 'token-hero-subtitle', total.missing ? '本周期未上报' : '已记录总 Token'));
}

function usageFlowBadge(
  kind: UsageFlowFact,
  mode: UsageViewMode,
  codexTotals: ModelUsageTotals | null,
  qoderTotals: ModelUsageTotals | null,
): HTMLElement | null {
  if (mode === 'compare') {
    const label = kind === 'input' ? '独立输入' : kind === 'cached' ? '独立缓存' : '独立输出';
    return el('span', 'flow-badge', label);
  }
  // 输入占总量的原始分子未在 ModelUsageTotals 暴露，不用格式化字符串反推占比。
  if (kind === 'input') return null;
  const totals = mode === 'qoder' ? qoderTotals : codexTotals;
  let text = '未上报';
  if (totals) {
    if (kind === 'cached') text = totals.cacheShare ? `占输入 ${totals.cacheShare}` : '缓存未记录';
    else text = totals.shares.output === null ? '占比未上报' : `占总用量 ${totals.shares.output.toFixed(1)}%`;
  }
  return el('span', 'flow-badge', text);
}

function usageProviderLine(provider: 'Codex' | 'Qoder', kind: UsageFact, totals: ModelUsageTotals | null): HTMLElement {
  const row = el('div', 'comp-line');
  row.append(el('span', `comp-prov-tag ${provider === 'Codex' ? 'is-codex' : 'is-qoder'}`, provider));
  const value = usageFact(kind, totals);
  row.append(el('span', `flow-val${value.missing ? ' is-missing' : ''}`, value.text));
  return row;
}

function usageFlowCell(
  kind: UsageFlowFact,
  index: string,
  label: string,
  sub: string,
  mode: UsageViewMode,
  codexTotals: ModelUsageTotals | null,
  qoderTotals: ModelUsageTotals | null,
): HTMLElement {
  const cell = el('div', 'token-flow-cell');
  const head = el('span', 'flow-label');
  const name = el('span', 'flow-label-name');
  name.append(el('span', 'flow-label-index', `${index} · `));
  name.append(el('span', '', label));
  head.append(name);
  const badge = usageFlowBadge(kind, mode, codexTotals, qoderTotals);
  if (badge) head.append(badge);
  cell.append(head);
  const values = el('div', 'flow-val-slot');
  if (mode === 'compare') {
    values.append(usageProviderLine('Codex', kind, codexTotals), usageProviderLine('Qoder', kind, qoderTotals));
  } else {
    const value = usageFact(kind, mode === 'qoder' ? qoderTotals : codexTotals);
    values.append(el('span', `flow-val${value.missing ? ' is-missing' : ''}`, value.text));
  }
  cell.append(values);
  cell.append(el('span', 'flow-sub', sub));
  return cell;
}

function applyTableLayout(table: HTMLTableElement, key: string): void {
  const layout = TABLE_LAYOUT[key as keyof typeof TABLE_LAYOUT];
  if (!layout) throw new Error(`缺少表格列布局：${key}`);
  const sessionTable = ['sessions', 'usage-codex', 'usage-qoder', 'usage-compare'].includes(key);
  table.dataset.tableKey = key;
  table.classList.toggle('session-consumption-table', sessionTable);
  table.style.minWidth = sessionTable ? `var(--session-table-min-width, ${layout.minWidth}px)` : `${layout.minWidth}px`;
  table.querySelector('colgroup')?.remove();
  const cols = el('colgroup');
  for (const [index, width] of layout.widths.entries()) {
    const col = document.createElement('col');
    if (width !== 'auto') col.style.width = sessionTable
      ? `var(--session-col-${index}, ${width})`
      : width;
    cols.append(col);
  }
  table.prepend(cols);
}

function newTable(
  key: string,
  headers: HTMLTableCellElement[],
): {table: HTMLTableElement; body: HTMLTableSectionElement} {
  const table = el('table', 'editorial-data-table');
  applyTableLayout(table, key);
  const thead = el('thead');
  const headRow = el('tr');
  for (const header of headers) headRow.append(header);
  thead.append(headRow);
  table.append(thead);
  const body = el('tbody');
  table.append(body);
  return {table, body};
}

/** 三模式共用分布表壳：标题、显示计数、3 行预览与展开滚动由同一处生成。 */
function usageDistribution(
  root: HTMLElement,
  key: string,
  title: string,
  total: number,
  expanded: boolean,
  noun: string,
  headers: HTMLTableCellElement[],
): {section: HTMLElement; body: HTMLTableSectionElement} {
  const section = el('div', 'usage-distribution');
  const head = el('div', 'usage-distribution-head');
  head.append(el('h4', 'usage-distribution-title', title));
  const shown = Math.min(total, expanded ? total : PREVIEW_ROWS);
  head.append(el('span', 'usage-distribution-count', `当前显示 ${shown} / ${total} ${noun} · 点击表头排序`));
  section.append(head);

  const wrap = el('div', 'table-responsive-wrapper');
  const scroll = el('div', 'table-scroll-container');
  markPreview(scroll, key, expanded);
  const {table, body} = newTable(key, headers);
  table.classList.add('usage-distribution-table');
  scroll.append(table);
  wrap.append(scroll);
  const footer = el('div', 'table-footer-band');
  wrap.append(footer);
  tableFooter(footer, key, expanded, total, noun);
  section.append(wrap);
  return {section, body};
}

function usageLinks(cell: HTMLElement, title: string, scopeHref: string | null, codexHref: string | null): void {
  const actions = cellActions(cell, 'action-btn-group session-actions-desktop');
  if (scopeHref) actions.append(anchorItem(scopeHref, title, 'btn-cell-action', ['查看小队']));
  if (codexHref) actions.append(anchorItem(codexHref, title, 'btn-cell-action is-quiet', ['打开会话']));
  if (!actions.childElementCount) {
    actions.classList.remove('session-actions-desktop');
    actions.append(el('span', 'status-pill is-quiet', '无入口'));
    return;
  }
  const trigger = el('button', 'btn-cell-action session-actions-trigger', '操作');
  trigger.type = 'button';
  trigger.setAttribute('aria-label', `${title}：会话操作`);
  trigger.setAttribute('aria-haspopup', 'dialog');
  trigger.addEventListener('click', () => {
    const links = el('div', 'squad-session-actions');
    if (scopeHref) links.append(anchorItem(scopeHref, title, '', ['查看小队']));
    if (codexHref) links.append(anchorItem(codexHref, title, '', ['打开会话']));
    openDialog({variant: 'seal', title: '会话操作', subtitle: title, body: links});
  });
  cell.append(trigger);
}

function renderCodexPanel(root: HTMLElement, body: HTMLElement, usage: ModelCodexUsage): void {
  if (usage.empty || !usage.totals) {
    const empty = el('div', 'usage-empty');
    empty.append(el('strong', '', usage.emptyTitle || '暂无本机消耗记录'));
    empty.append(el('p', '', usage.emptyText || '尚未读取到本机 Codex 消耗记录。'));
    body.append(empty);
    if (usage.note) body.append(el('p', 'stat-subtext', usage.note));
    return;
  }

  const key = 'usage-codex';
  const expanded = previewExpandedFor(root, key);
  if (usage.allSessions.length) {
    const rows = sortRowsFor(usage.allSessions, sortFor(root, key), [
      {key: 'title', type: 'text', value: row => row.title},
      {key: 'model', type: 'text', value: row => row.models[0] || ''},
      {key: 'tokens', type: 'number', value: row => row.total},
      {key: 'share', type: 'number', value: row => row.total},
    ]);
    const pane = usageDistribution(root, key, '会话消耗分布（含小队）', rows.length, expanded, '个会话', [
      sortableHeader(root, key, '会话 / 任务主题', 'title', 'text'),
      sortableHeader(root, key, '模型', 'model', 'text'),
      sortableHeader(root, key, 'Token', 'tokens', 'number'),
      sortableHeader(root, key, '占比', 'share', 'number'),
      plainHeader('操作', 'table-action-col'),
    ]);
    body.append(pane.section);
    for (const session of previewRows(rows, expanded)) {
      const row = el('tr');
      row.append(titleCell(session.title, session.kindLabel));
      row.append(el('td', 'cell-model', session.models.length ? session.models.join(' / ') : '模型未标注'));
      row.append(valueCell(session.tokenLabel));
      row.append(valueCell(session.percent));
      const links = el('td', 'table-action-col');
      usageLinks(links, session.title, session.scopeHref, session.codexHref);
      row.append(links);
      pane.body.append(row);
    }
  } else {
    body.append(el('p', 'stat-subtext', '本窗口没有可展示的 Codex 会话记录。'));
  }
  if (usage.note) body.append(el('p', 'stat-subtext', usage.note));
}

function renderQoderPanel(root: HTMLElement, body: HTMLElement, qoder: ModelQoderUsage): void {
  if (qoder.empty || !qoder.totals) {
    const empty = el('div', 'usage-empty');
    empty.append(el('strong', '', qoder.emptyTitle || '尚未生成 Qoder 用量明细'));
    empty.append(el('p', '', qoder.emptyText || '这份统计快照没有 Qoder 执行用量。'));
    body.append(empty);
    if (qoder.note) body.append(el('p', 'stat-subtext', qoder.note));
    return;
  }

  const key = 'usage-qoder';
  const expanded = previewExpandedFor(root, key);
  if (qoder.sessions.length) {
    const rows = sortRowsFor(qoder.sessions, sortFor(root, key), [
      {key: 'title', type: 'text', value: row => row.title},
      {key: 'model', type: 'text', value: row => row.models[0] || ''},
      {key: 'tokens', type: 'number', value: row => row.total},
      {key: 'share', type: 'number', value: row => row.total},
    ]);
    const pane = usageDistribution(root, key, 'Qoder 会话消耗分布', rows.length, expanded, '个会话', [
      sortableHeader(root, key, '会话 / 任务主题', 'title', 'text'),
      sortableHeader(root, key, '模型', 'model', 'text'),
      sortableHeader(root, key, 'Token', 'tokens', 'number'),
      sortableHeader(root, key, '占比', 'share', 'number'),
      plainHeader('操作', 'table-action-col'),
    ]);
    body.append(pane.section);
    for (const session of previewRows(rows, expanded)) {
      const row = el('tr');
      const meta = session.attempts > 0
        ? `${session.kindLabel} · 已报 ${session.reportedAttempts}/${session.attempts} 次执行`
        : session.kindLabel;
      row.append(titleCell(session.title, meta));
      row.append(el('td', 'cell-model', session.models.length ? session.models.join(' / ') : '模型未标注'));
      row.append(valueCell(session.tokenLabel));
      row.append(valueCell(session.percent));
      const links = el('td', 'table-action-col');
      usageLinks(links, session.title, session.scopeHref, session.codexHref);
      row.append(links);
      pane.body.append(row);
    }
  } else {
    body.append(el('p', 'stat-subtext', '本窗口没有可展示的 Qoder 会话记录。'));
  }
  if (qoder.note) body.append(el('p', 'stat-subtext', qoder.note));
}

function usageFold(root: HTMLElement, key: string, summaryText: string): {details: HTMLDetailsElement; body: HTMLElement} {
  const details = el('details', 'token-meta-fold usage-subfold');
  details.dataset.usageDetails = key;
  details.open = usageDetailsOpen.get(root)?.has(key) === true;
  const summary = el('summary', 'token-meta-summary');
  summary.append(el('span', '', summaryText));
  summary.append(el('span', 'token-meta-cue', '明细'));
  details.append(summary);
  const body = el('div', 'token-meta-body');
  details.append(body);
  return {details, body};
}

function renderComparePanel(
  root: HTMLElement,
  body: HTMLElement,
  compare: ModelUsageComparison,
): void {
  if (compare.empty) {
    const empty = el('div', 'usage-empty');
    empty.append(el('strong', '', '暂无可对比记录'));
    empty.append(el('p', '', compare.emptyText));
    body.append(empty);
    return;
  }
  body.append(el('p', 'stat-subtext', compare.summary));

  const key = 'usage-compare';
  const expanded = previewExpandedFor(root, 'usage-compare');
  if (compare.rows.length) {
    const rows = sortRowsFor(compare.rows, sortFor(root, key), [
      {key: 'title', type: 'text', value: row => row.title},
      {key: 'codex', type: 'number', value: row => row.codexTotal},
      {key: 'qoder', type: 'number', value: row => row.qoderTotal},
    ]);
    const pane = usageDistribution(root, key, '小队用量对比', rows.length, expanded, '个会话', [
      sortableHeader(root, key, '小队 / 会话', 'title', 'text'),
      sortableHeader(root, key, 'Codex Token', 'codex', 'number'),
      sortableHeader(root, key, 'Qoder Token', 'qoder', 'number'),
      plainHeader('操作', 'table-action-col'),
    ]);
    body.append(pane.section);
    for (const row of previewRows(rows, expanded)) {
      const tr = el('tr');
      tr.append(titleCell(row.title, row.kindLabel));
      tr.append(valueCell(row.codexLabel));
      tr.append(valueCell(row.qoderLabel));
      const links = el('td', 'table-action-col');
      usageLinks(links, row.title, row.scopeHref, row.codexHref);
      tr.append(links);
      pane.body.append(tr);
    }
  }

  if (compare.codexOnly.length) {
    const onlyKey = 'usage-compare-only';
    const onlyExpanded = previewExpandedFor(root, onlyKey);
    const {details, body: foldBody} = usageFold(
      root, onlyKey, `分析报告与独立会话（${compare.codexOnly.length} 行）`,
    );
    const rows = sortRowsFor(compare.codexOnly, sortFor(root, onlyKey), [
      {key: 'title', type: 'text', value: row => row.title},
      {key: 'codex', type: 'number', value: row => row.codexTotal},
      {key: 'qoder', type: 'number', value: row => row.qoderTotal},
    ]);
    const wrap = el('div', 'table-responsive-wrapper');
    const scroll = el('div', 'table-scroll-container');
    markPreview(scroll, onlyKey, onlyExpanded);
      const {table, body: tbody} = newTable(onlyKey, [
      sortableHeader(root, onlyKey, '会话', 'title', 'text'),
      sortableHeader(root, onlyKey, 'Codex Token', 'codex', 'number'),
      sortableHeader(root, onlyKey, 'Qoder Token', 'qoder', 'number'),
    ]);
    for (const row of previewRows(rows, onlyExpanded)) {
      const tr = el('tr');
      tr.append(titleCell(row.title, row.kindLabel));
      tr.append(valueCell(row.codexLabel));
      tr.append(valueCell(row.qoderLabel));
      tbody.append(tr);
    }
    scroll.append(table);
    wrap.append(scroll);
    const footer = el('div', 'table-footer-band');
    wrap.append(footer);
    tableFooter(footer, onlyKey, onlyExpanded, compare.codexOnly.length, '行');
    foldBody.append(wrap);
    body.append(details);
  }
  if (compare.note) body.append(el('p', 'stat-subtext', compare.note));
}

function renderUsageTabs(root: ParentNode, model: Model, mode: string): void {
  const tabs = slot(root, 'usage-tabs');
  tabs.replaceChildren();
  for (const item of model.usage.modes) {
    const active = item.value === mode;
    const button = el('button', `seg-btn${active ? ' is-active' : ''}`, item.label);
    button.type = 'button';
    button.dataset.action = 'usage-mode';
    button.dataset.mode = item.value;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(active));
    tabs.append(button);
  }
}

function renderUsage(root: HTMLElement, model: Model, mode: string): void {
  const view = model.usage;
  const active: UsageViewMode = mode === 'qoder' || mode === 'compare' ? mode : 'codex';
  renderUsageTabs(root, model, active);

  const codexTotals = view.codex.totals;
  const qoderTotals = view.qoder.totals;
  slot(root, 'usage-totals').hidden = false;
  fillUsageHero(slot(root, 'usage-hero'), active, codexTotals, qoderTotals);
  slot(root, 'usage-hero-note').textContent = USAGE_HERO_NOTES[active];
  slot(root, 'usage-flow').replaceChildren(
    ...USAGE_FLOW.map(cell => usageFlowCell(cell.kind, cell.index, cell.label, cell.sub, active, codexTotals, qoderTotals)),
  );

  const scopeHead = active === 'qoder' ? view.qoder : active === 'compare' ? view.compare : view.codex;
  setText(root, 'usage-scope', USAGE_SCOPE_LABELS[active]);

  const models = active === 'qoder' ? view.qoder.models : view.codex.models;
  const modelsOmitted = active === 'qoder' ? view.qoder.modelsOmitted : view.codex.modelsOmitted;
  const summary = slot(root, 'usage-model-summary');
  if (active === 'compare') {
    summary.textContent = `Codex ${view.codex.models.length} 类模型 · Qoder ${view.qoder.models.length} 类模型`;
  } else if (models.length) {
    summary.textContent = `主要模型 ${models[0].name} · 占 ${models[0].percent}${modelsOmitted > 0 ? ` · 另有 ${modelsOmitted} 类` : ''}`;
  } else {
    summary.textContent = '模型去向未上报';
  }

  slot(root, 'usage-coverage').textContent = scopeHead.coverageSummary || scopeHead.coverageLabel || '覆盖未上报';

  const body = slot(root, 'usage-body');
  body.replaceChildren();
  body.dataset.mode = active;
  if (active === 'qoder') renderQoderPanel(root, body, view.qoder);
  else if (active === 'compare') renderComparePanel(root, body, view.compare);
  else renderCodexPanel(root, body, view.codex);
}

function refreshUsage(root: HTMLElement): void {
  const model = renderedModels.get(root);
  if (!model) return;
  renderUsage(root, model, usageMode.get(root) || 'codex');
}

function cliRateCell(rate: ModelCliRate): HTMLElement {
  const cell = el('td', 'num-col align-right');
  const known = rate.known > 0 && rate.rate !== null;
  const value = el('span', known ? 'num-mono cli-rate' : 'status-pill uncomputed cli-rate', rate.display);
  if (known) value.dataset.tone = Number.parseFloat(rate.rate as string) >= 95 ? 'ok' : 'warn';
  value.title = `${rate.confirmedLabel}${rate.unknown > 0 ? ` · ${rate.unknown} 次状态未确认` : ''}`;
  cell.append(value);
  return cell;
}

function cliMatchLabel(cli: ModelCli): string {
  if (!cli.available || cli.empty || cli.rowCount === 0) return '暂无可识别记录';
  if (cli.noMatches) return `无匹配指令 · 共 ${cli.rowCount} 条可筛选`;
  const suffix = cli.canExpand ? ` · 默认显示前 ${PREVIEW_ROWS} 条` : '';
  return `匹配 ${cli.filteredCount} / ${cli.rowCount} 条指令${suffix}`;
}

function syncCliControls(root: HTMLElement, cli: ModelCli): void {
  const stored = cliQuery.get(root) ?? '';
  const input = root.querySelector<HTMLInputElement>('[data-cli-query]');
  if (input && input.value !== stored) input.value = stored;
  if (cliFilter.get(root) !== cli.filter) cliFilter.set(root, cli.filter);
  const select = root.querySelector<HTMLSelectElement>('[data-cli-filter]');
  if (select && select.value !== cli.filter) select.value = cli.filter;
  const clear = root.querySelector<HTMLButtonElement>('[data-action="cli-clear"]');
  if (clear) clear.hidden = !stored && cli.filter === 'all';
}

function cliFailureRow(row: ModelCliRow, expanded: Set<string>): HTMLTableRowElement {
  const token = encodeURIComponent(row.key);
  const detailRow = el('tr', 'cli-failure-row');
  detailRow.dataset.cliDetail = token;
  detailRow.hidden = !expanded.has(token);
  const detailCell = el('td', 'cli-failure-detail');
  detailCell.colSpan = 5;
  const detailHead = el('div', 'cli-failure-head');
  detailHead.append(el('strong', '', '高频失败分析'));
  detailHead.append(el('span', 'cli-failure-count', `失败 ${row.failures} 次`));
  detailCell.append(detailHead);
  const chips = el('div', 'cli-chips');
  if (row.failureCategories.length) {
    for (const category of row.failureCategories) {
      chips.append(el('span', 'cli-chip', `${category.label} × ${category.count}`));
    }
  } else {
    chips.append(el('span', 'cli-chip is-quiet', '失败分类未上报'));
  }
  detailCell.append(chips);
  if (row.sessions.length) {
    const sessions = el('div', 'cli-sessions');
    for (const session of row.sessions) {
      const line = el('div', 'cli-session');
      line.append(el('span', 'cli-session-label', session.label));
      if (session.taskHref) line.append(anchorItem(session.taskHref, session.label, 'cli-link', ['查看小队']));
      if (session.codexHref) line.append(anchorItem(session.codexHref, session.label, 'cli-link', ['打开会话']));
      sessions.append(line);
    }
    if (row.sessionsOmitted > 0) sessions.append(el('span', 'cli-meta', `其余 ${row.sessionsOmitted} 个会话已省略`));
    detailCell.append(sessions);
  } else {
    detailCell.append(el('p', 'cli-meta', '关联小队或会话未上报。'));
  }
  detailRow.append(detailCell);
  return detailRow;
}

/** 仅替换结果区与计数，搜索框、分类选择和焦点保持在原节点上。 */
function renderCliResults(root: HTMLElement, cli: ModelCli): void {
  const host = root.querySelector<HTMLElement>('[data-cli-results]');
  if (!host) return;
  const count = root.querySelector<HTMLElement>('[data-cli-count]');
  if (count) count.textContent = cliMatchLabel(cli);
  syncCliControls(root, cli);
  host.replaceChildren();

  if (cli.noMatches) {
    const empty = el('div', 'cli-empty cli-no-matches');
    empty.append(el('strong', '', '没有匹配的 CLI 指令'));
    empty.append(el('p', '', '当前分类与搜索没有交集，可清除搜索或切换分类。'));
    host.append(empty);
    return;
  }

  const expanded = cliExpanded.get(root) || new Set<string>();
  const layout = TABLE_LAYOUT.cli;
  const wrap = el('div', 'table-responsive-wrapper');
  const scroll = el('div', 'table-scroll-container');
  markPreview(scroll, 'cli', cli.expanded);
  const {table, body} = newTable('cli', [
    sortableHeader(root, 'cli', 'CLI & Command', 'command', 'text'),
    sortableHeader(root, 'cli', '调用', 'calls', 'number'),
    sortableHeader(root, 'cli', '执行率', 'execution', 'number'),
    sortableHeader(root, 'cli', '业务率', 'business', 'number'),
    sortableHeader(root, 'cli', '失败', 'failures', 'number'),
  ]);
  table.classList.add('cli-table');

  for (const row of cli.rows) {
    const token = encodeURIComponent(row.key);
    const tr = el('tr', 'cli-row');
    const command = el('td', 'cell-title cli-name-cell');
    const commandText = el('div', 'cell-title-truncate cli-command', row.title);
    commandText.title = row.title;
    command.append(commandText);
    tr.append(command);
    tr.append(valueCell(String(row.calls)));
    tr.append(cliRateCell(row.execution));
    tr.append(cliRateCell(row.business));
    const failureCell = el('td', 'table-action-col');
    if (row.hasFailures) {
      const open = expanded.has(token);
      const actions = cellActions(failureCell);
      const button = el('button', 'btn-cell-action cli-failure-btn', String(row.failures));
      button.type = 'button';
      button.dataset.action = 'cli-failures';
      button.dataset.cliKey = token;
      button.setAttribute('aria-expanded', String(open));
      button.setAttribute('aria-label', `${row.title} 失败 ${row.failures} 次，${open ? '收起' : '展开'}失败分类与关联会话`);
      button.title = open ? '收起失败分类与关联会话' : '展开失败分类与关联会话';
      actions.append(button);
    } else {
      failureCell.append(el('span', 'num-mono', '0'));
    }
    tr.append(failureCell);
    body.append(tr);
    if (row.hasFailures) body.append(cliFailureRow(row, expanded));
  }

  scroll.append(table);
  wrap.append(scroll);
  const footer = el('div', 'table-footer-band');
  wrap.append(footer);
  tableFooter(footer, 'cli', cli.expanded, cli.filteredCount, '条指令');
  host.append(wrap);

  const meta = el('p', 'stat-subtext');
  const parts = [cli.coverageLabel];
  if (cli.unknownCalls > 0) parts.push(`${cli.unknownCalls} 次未确认，不计入分母`);
  if (cli.unclassifiedCalls) parts.push(`${cli.unclassifiedCalls} 次未归类`);
  meta.textContent = parts.join(' · ');
  host.append(meta);

  const details = el('details', 'token-meta-fold');
  const summary = el('summary', 'token-meta-summary');
  summary.append(el('span', '', '统计分母口径与指标判定说明'));
  summary.append(el('span', 'token-meta-cue', '明细'));
  details.append(summary);
  const detailBody = el('div', 'token-meta-body');
  if (cli.note) detailBody.append(el('p', 'stat-subtext', cli.note));
  detailBody.append(el('p', 'stat-subtext', '执行成功率按进程退出码统计；业务成功率要求明确的业务回执或落库证据；未知状态不计入成功率分母，确认覆盖率见上方汇总。'));
  details.append(detailBody);
  host.append(details);
}

function cliChapterLabel(cli: ModelCli, skills: Model['skills']): string {
  const skillCount = skills.available && skills.rows.length ? `${skills.rows.length} 种技能 · ` : '';
  return cli.available ? `${skillCount}${cli.rowCount} 条 CLI 指令` : `${skillCount}CLI 未统计`;
}

function renderCli(root: HTMLElement, model: Model): void {
  const cli = model.cli;
  const host = slot(root, 'cli');
  host.replaceChildren();
  setText(root, 'skills-summary', cliChapterLabel(cli, model.skills));
  setText(root, 'cli-caption', cli.available ? `总计 ${cli.totalCalls} 次调用` : 'CLI 未统计');

  const head = el('div', 'chapter-heading-bar usage-subheading');
  const titleGroup = el('div', 'chapter-title-group');
  titleGroup.append(el('h3', 'chapter-title', 'CLI 与工具表现'));
  if (cli.available) titleGroup.append(el('span', 'chapter-caption', `总计 ${cli.totalCalls} 次调用`));
  head.append(titleGroup);
  host.append(head);

  if (!cli.available || cli.empty || !cli.rowCount) {
    const empty = el('div', 'cli-empty');
    empty.append(el('strong', '', '暂无可展示的 CLI 记录'));
    empty.append(el('p', '', cli.emptyText || '尚无可识别 CLI 记录'));
    host.append(empty);
    if (cli.note) host.append(el('p', 'stat-subtext', cli.note));
    return;
  }

  const controls = el('div', 'cli-filter-toolbar');
  const searchLabel = el('label', 'cli-search-box');
  searchLabel.append(svgIcon('M7 12.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11ZM11 11l3 3', 'cli-search-icon'));
  const input = el('input', 'cli-search-input');
  input.type = 'search';
  input.dataset.cliQuery = '';
  input.value = cliQuery.get(root) ?? '';
  input.placeholder = '搜索 CLI 或子命令';
  input.setAttribute('aria-label', '搜索 CLI 或子命令');
  searchLabel.append(input);
  controls.append(searchLabel);

  const select = el('select', 'cli-select');
  select.dataset.cliFilter = '';
  select.setAttribute('aria-label', '按 CLI 名称筛选');
  for (const option of cli.filters) {
    const item = el('option', '', option.label);
    item.value = option.value;
    select.append(item);
  }
  select.value = cli.filter;
  controls.append(select);

  const clear = el('button', 'btn-cell-action cli-clear', '清除');
  clear.type = 'button';
  clear.dataset.action = 'cli-clear';
  clear.hidden = !(cliQuery.get(root) ?? '') && cli.filter === 'all';
  clear.setAttribute('aria-label', '清除搜索与分类筛选');
  controls.append(clear);

  const count = el('span', 'cli-match-count');
  count.dataset.cliCount = '';
  count.textContent = cliMatchLabel(cli);
  controls.append(count);
  host.append(controls);

  const results = el('div', 'cli-results');
  results.dataset.cliResults = '';
  host.append(results);
  renderCliResults(root, cli);
}

function syncCliFailures(root: HTMLElement): void {
  const expanded = cliExpanded.get(root);
  for (const button of Array.from(root.querySelectorAll<HTMLButtonElement>('[data-action="cli-failures"]'))) {
    const open = expanded?.has(button.dataset.cliKey || '') === true;
    button.setAttribute('aria-expanded', String(open));
    button.title = open ? '收起失败分类与关联会话' : '展开失败分类与关联会话';
  }
  for (const detail of Array.from(root.querySelectorAll<HTMLElement>('[data-cli-detail]'))) {
    detail.hidden = expanded?.has(detail.dataset.cliDetail || '') !== true;
  }
}

function renderSkills(root: HTMLElement, model: Model): void {
  setText(root, 'skills-total', !model.skills.available
    ? '未上报'
    : model.skills.rows.length > 0
      ? `${model.skills.rows.length} 种技能 · ${model.skills.total} 次累计读取`
      : '无记录');
  const list = slot(root, 'skills');
  const expanded = previewExpandedFor(root, 'skills');
  markPreview(list, 'skills', expanded);
  const preview = slot(root, 'skills-preview');
  preview.replaceChildren();
  list.replaceChildren();
  if (model.skills.empty) {
    list.append(el('p', 'stat-subtext', model.skills.available
      ? '本区间没有技能定义文件读取记录。'
      : '尚无统计快照，技能读取未上报。'));
    tableFooter(preview, 'skills', expanded, 0, '项技能');
    return;
  }
  for (const skill of previewRows(model.skills.rows, expanded)) {
    const line = el('div', 'skills-row');
    const name = el('span', 'skills-name cell-title-truncate', skill.name);
    name.title = skill.name;
    line.append(name);
    line.append(el('span', 'skills-reads num-mono', `${skill.reads} 次读取`));
    list.append(line);
  }
  tableFooter(preview, 'skills', expanded, model.skills.rows.length, '项技能');
}

function observationCard(item: ModelObservation, index: number): HTMLElement {
  const card = el('article', 'issue-card');
  const head = el('div', 'issue-card-header');
  const title = el('div', 'issue-card-title');
  title.title = item.title;
  title.append(el('span', 'rec-item-num', `${item.number}.`));
  title.append(el('strong', '', item.title));
  title.append(el('span', 'status-pill is-quiet', item.categoryLabel));
  head.append(title);
  const linked = item.refs.find(ref => Boolean(ref.href));
  if (linked?.href) {
    const actions = el('div', 'action-btn-group');
    const link = anchorItem(linked.href, `${item.title}：${linked.label}`, 'btn-cell-action', ['查看会话']);
    link.setAttribute('aria-label', `${item.title}：查看会话（${linked.label}）`);
    actions.append(link);
    head.append(actions);
  }
  card.append(head);

  const stages = el('div', 'issue-stage-grid');
  for (const stage of observationStages(item)) {
    const block = el('div', 'issue-stage-item');
    block.append(el('span', 'issue-stage-label', stage.label));
    const text = stage.key === 'evidence' && stage.text.length > 140 ? `${stage.text.slice(0, 140)}…` : stage.text;
    block.append(el('span', `issue-stage-desc${stage.missing ? ' is-missing' : ''}`, text));
    stages.append(block);
  }
  card.append(stages);

  if (item.refs.length || item.evidenceNames.length || item.observation.length > 140) {
    const evidenceId = `observation-evidence-${index + 1}`;
    const drawer = el('div', 'issue-evidence-drawer');
    const toggle = el('button', 'rec-item-evidence-toggle');
    toggle.type = 'button';
    toggle.dataset.action = 'evidence';
    toggle.dataset.target = evidenceId;
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-controls', evidenceId);
    toggle.append(el('span', '', '展开相关记录依据 ▾'));
    const content = el('div', 'rec-evidence-content');
    content.id = evidenceId;
    if (item.observation.length > 140) content.append(el('p', 'rec-evidence-line', item.observation));
    if (item.refs.length) {
      const refs = el('div', 'rec-item-links');
      refs.append(el('span', 'rec-evidence-label', '关联记录'));
      for (const ref of item.refs) {
        if (ref.href) refs.append(anchorItem(ref.href, ref.label, 'btn-cell-action', [ref.label]));
      }
      content.append(refs);
    }
    if (item.evidenceNames.length) {
      const names = el('div', 'rec-item-links');
      names.append(el('span', 'rec-evidence-label', '记录类型'));
      for (const name of item.evidenceNames) names.append(el('span', 'status-pill is-quiet', name));
      content.append(names);
    }
    drawer.append(toggle, content);
    card.append(drawer);
  }
  return card;
}

function renderObservations(root: ParentNode, model: Model): void {
  const observations = model.observations;
  setText(root, 'observation-count', observations.items.length ? `${observations.items.length} 项关键问题` : '暂无可处理问题');
  const intro = slot(root, 'observation-intro');
  // 首屏摘要与问题导语重复时只保留摘要，避免同一句话出现两次。
  const duplicate = observations.intro.trim() === highlightText(model).trim();
  intro.textContent = duplicate ? '' : observations.intro;
  intro.hidden = duplicate || !observations.intro;
  const container = slot(root, 'observations');
  container.replaceChildren();
  if (observations.empty) {
    container.append(el('p', 'stat-subtext', observations.emptyText));
  }
  observations.items.forEach((item, index) => container.append(observationCard(item, index)));
}

function benefitBasisRows(rows: Array<{label: string; value: string; percent?: string | null; tone?: string}>): HTMLElement {
  const list = el('div', 'squad-v9-benefit-rows');
  for (const row of rows) {
    const line = el('div', 'squad-v9-benefit-row');
    line.append(el('span', 'squad-v9-benefit-row-label', row.label));
    const value = el('span', 'squad-v9-benefit-row-value');
    if (row.tone) value.dataset.tone = row.tone;
    value.append(el('span', '', row.value));
    if (row.percent) {
      const share = row.percent.includes('%');
      value.append(el('span', share ? 'squad-v9-benefit-row-percent' : 'squad-v9-benefit-dialog-meta', share ? `约 ${row.percent}` : row.percent));
    }
    line.append(value);
    list.append(line);
  }
  return list;
}

function benefitsBasisSummary(details: ModelBenefits['details']): HTMLElement {
  const wrap = el('div', 'squad-v9-benefit-dialog-basis');
  if (details.signedNote) wrap.append(el('p', 'squad-v9-benefit-dialog-meta', details.signedNote));
  wrap.append(el('p', 'squad-v9-benefit-dialog-meta', [details.rangeLabel, details.generatedLabel, details.coverageLabel].filter(Boolean).join(' · ')));
  for (const group of details.groups) {
    wrap.append(el('h4', 'squad-v9-benefit-dialog-basis-title', group.title));
    wrap.append(benefitBasisRows(group.rows));
  }
  wrap.append(el('h4', 'squad-v9-benefit-dialog-basis-title', '实际模型速度'));
  if (details.speeds.empty) {
    wrap.append(el('p', 'squad-v9-benefit-dialog-meta', details.speeds.emptyNote));
  } else {
    wrap.append(benefitBasisRows(details.speeds.rows.map(row => ({
      label: row.label,
      value: row.valueLabel,
      percent: `${row.basisLabel} · ${row.samplesLabel}`,
    }))));
  }
  wrap.append(el('p', 'squad-v9-benefit-dialog-meta', details.speeds.note));
  if (details.exclusionSummary.length) {
    wrap.append(el('h4', 'squad-v9-benefit-dialog-basis-title', '排除原因汇总'));
    wrap.append(benefitBasisRows(details.exclusionSummary.map(row => ({
      label: row.label,
      value: row.countLabel,
    }))));
  }
  wrap.append(el('p', 'squad-v9-benefit-dialog-meta', details.note));
  return wrap;
}

function benefitBasisDetail(item: ModelBenefitDelivery): HTMLElement {
  const wrap = el('div', 'squad-v9-benefits-row-basis');
  if (item.sources.length) {
    const sources = el('div', 'squad-v9-benefit-delivery-sources');
    sources.append(el('span', 'squad-v9-benefit-delivery-label', '基线来源'));
    for (const source of item.sources) {
      if (source.href) sources.append(anchorItem(source.href, source.label, 'squad-v9-benefit-source-link', [source.label]));
      else sources.append(el('span', 'squad-v9-benefit-source', source.label));
    }
    wrap.append(sources);
  } else {
    wrap.append(el('p', 'squad-v9-benefit-note', item.sourcesNote));
  }
  if (item.processing.length) {
    const processing = el('div', 'squad-v9-benefit-rows');
    for (const part of item.processing) {
      const row = el('div', 'squad-v9-benefit-row');
      row.append(el('span', 'squad-v9-benefit-row-label', part.label));
      row.append(el('span', 'squad-v9-benefit-row-value', part.value));
      processing.append(row);
    }
    wrap.append(processing);
  }
  if (item.exclusions.length) {
    const exclusions = el('div', 'squad-v9-benefit-delivery-exclusions');
    for (const reason of item.exclusions) exclusions.append(el('span', 'squad-v9-benefit-exclusion', reason));
    wrap.append(exclusions);
  }
  if (item.hasLinks) {
    const links = el('div', 'squad-v9-benefit-delivery-links');
    for (const link of item.links) links.append(anchorItem(link.href, link.label, 'squad-v9-benefit-source-link', [link.label]));
    wrap.append(links);
  }
  return wrap;
}

function benefitDialogBody(item: ModelBenefitDelivery, details: ModelBenefits['details']): HTMLElement {
  const wrap = el('div', 'squad-v9-benefit-dialog');
  const work = el('div', 'squad-v9-benefit-dialog-work');
  const head = el('div', 'squad-v9-benefit-dialog-work-head');
  head.append(el('strong', 'squad-v9-benefit-dialog-work-title', item.title));
  head.append(el('span', `squad-v9-benefit-dialog-status${item.included ? '' : ' is-quiet'}`, item.statusLabel));
  work.append(head);
  work.append(el('p', 'squad-v9-benefit-dialog-range', item.rangeLabel));
  wrap.append(work);

  const grid = el('div', 'squad-v9-benefit-dialog-grid');
  const baseline = el('div', 'squad-v9-benefit-dialog-card');
  baseline.append(el('span', 'squad-v9-benefit-dialog-label', '纯 Codex 历史基准投入'));
  const baselineValue = el('strong', 'squad-v9-benefit-dialog-value', item.baselineTokenLabel);
  baselineValue.append(el('span', 'squad-v9-benefit-dialog-unit', ' Token'));
  baseline.append(baselineValue);
  baseline.append(el('span', 'squad-v9-benefit-dialog-meta', item.baselineTimeLabel || '基准耗时未上报'));
  grid.append(baseline);

  const actual = el('div', 'squad-v9-benefit-dialog-card');
  actual.append(el('span', 'squad-v9-benefit-dialog-label', '本次实际消耗（Codex / Qoder）'));
  const actualValue = el('strong', 'squad-v9-benefit-dialog-value is-rust');
  actualValue.append(el('span', '', item.actualCodexLabel));
  actualValue.append(el('span', 'squad-v9-benefit-dialog-sep', ' / '));
  actualValue.append(el('span', item.qoderUsed ? '' : 'is-quiet', item.actualQoderLabel));
  actual.append(actualValue);
  actual.append(el('span', 'squad-v9-benefit-dialog-meta', '按已保存的实际执行记录'));
  grid.append(actual);
  wrap.append(grid);

  const net = el('div', 'squad-v9-benefit-dialog-net');
  const token = el('div', 'squad-v9-benefit-dialog-net-cell');
  token.append(el('span', 'squad-v9-benefit-dialog-label', '测算净节省 Token'));
  const tokenValue = el('strong', 'squad-v9-benefit-dialog-net-value', item.netTokenLabel);
  tokenValue.dataset.tone = item.netTokenLabel.startsWith('+') ? 'ok' : item.netTokenLabel.startsWith('-') ? 'warn' : 'quiet';
  token.append(tokenValue);
  token.append(el('span', 'squad-v9-benefit-dialog-meta', item.tokenSavingLabel));
  net.append(token);
  const time = el('div', 'squad-v9-benefit-dialog-net-cell is-right');
  time.append(el('span', 'squad-v9-benefit-dialog-label', '测算节省处理时间'));
  const timeValue = el('strong', 'squad-v9-benefit-dialog-net-value', item.netTimeLabel);
  timeValue.dataset.tone = item.netTimeLabel.startsWith('+') ? 'ok' : item.netTimeLabel.startsWith('-') ? 'warn' : 'quiet';
  time.append(timeValue);
  time.append(el('span', 'squad-v9-benefit-dialog-meta', item.timeSavingLabel));
  net.append(time);
  wrap.append(net);
  wrap.append(el('p', 'squad-v9-benefit-dialog-note', '正值表示相对基线减少投入，负值表示多投入。'));

  const basis = el('div', 'squad-v9-benefit-dialog-basis');
  basis.append(el('h3', 'squad-v9-benefit-dialog-basis-title', '测算说明与基线依据来源'));
  basis.append(benefitBasisDetail(item));
  basis.append(el('p', 'squad-v9-benefit-dialog-meta', '处理时间按输出 Token 与同模型速度估算，不代表实际少等待了多久；负值代表相对基线多投入。'));
  wrap.append(basis);

  const aggregate = el('div', 'squad-v9-benefit-dialog-basis');
  aggregate.append(el('h3', 'squad-v9-benefit-dialog-basis-title', details.summaryLabel));
  aggregate.append(benefitsBasisSummary(details));
  wrap.append(aggregate);
  return wrap;
}

function benefitDialogFooter(handle: DialogHandle): HTMLElement {
  const footer = el('div', 'squad-v9-benefit-dialog-foot');
  footer.append(el('span', 'squad-v9-benefit-dialog-hint', '按 Esc 键或点击遮罩亦可返回'));
  const back = el('button', 'squad-v9-benefit-dialog-back', '返回计算依据表');
  back.type = 'button';
  back.dataset.dialogClose = '';
  back.addEventListener('click', () => handle.close());
  footer.append(back);
  return footer;
}

function openBenefitDialog(root: HTMLElement, index: number): void {
  const model = renderedModels.get(root);
  const details = model?.benefits.details;
  const delivery = model?.benefits.visible && details ? details.deliveries[index] : null;
  if (!delivery || !details) return;
  benefitDialogs.get(root)?.handle.close();
  let handle: DialogHandle | null = null;
  handle = openDialog({
    variant: 'seal',
    title: '这项工作的收益依据',
    subtitle: delivery.title,
    badge: '测算依据',
    icon: 'published',
    body: benefitDialogBody(delivery, details),
    footer: null,
    onClose: () => {
      const current = benefitDialogs.get(root);
      if (current && current.handle === handle) benefitDialogs.delete(root);
    },
  });
  handle.setFooter(benefitDialogFooter(handle));
  benefitDialogs.set(root, {index, handle});
}

function benefitRow(item: ModelBenefitDelivery, index: number): HTMLTableRowElement {
  const row = el('tr', item.included ? '' : 'is-excluded');
  const work = el('td', 'cell-title');
  const line = el('div', 'session-title');
  line.append(el('span', 'row-index', `${index + 1}.`));
  const title = el('span', 'cell-title-truncate', item.title);
  title.title = item.title;
  line.append(title);
  line.append(el('span', item.included ? 'status-pill' : 'status-pill is-quiet', item.statusLabel));
  work.append(line);
  row.append(work);
  row.append(valueCell(item.baselineTokenLabel));
  row.append(valueCell(item.actualCodexLabel));
  if (item.qoderUsed) {
    row.append(valueCell(item.actualQoderLabel));
  } else {
    const qoder = el('td', 'num-col align-right');
    qoder.append(el('span', 'status-pill is-quiet', item.actualQoderLabel));
    row.append(qoder);
  }
  const tokens = valueCell(item.netTokenLabel, 'num-col align-right benefit-net');
  tokens.dataset.tone = item.netTokenLabel.startsWith('+') ? 'ok' : item.netTokenLabel.startsWith('-') ? 'warn' : 'quiet';
  row.append(tokens);
  const time = valueCell(item.netTimeLabel, 'num-col align-right benefit-time');
  time.dataset.tone = item.netTimeLabel.startsWith('+') ? 'ok' : item.netTimeLabel.startsWith('-') ? 'warn' : 'quiet';
  row.append(time);
  const basis = el('td', 'table-action-col');
  const actions = cellActions(basis);
  const button = el('button', 'btn-cell-action', '依据');
  button.type = 'button';
  button.id = `squad-benefit-basis-${index}`;
  button.dataset.action = 'benefits-row';
  button.dataset.index = String(index);
  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-label', `${item.title} 的收益依据`);
  button.title = '打开这项工作的收益依据';
  actions.append(button);
  row.append(basis);
  row.dataset.index = String(index);
  return row;
}

function benefitMetricBlock(metric: ModelBenefitMetric): HTMLElement {
  const card = el('div', 'benefit-stat-item');
  card.dataset.tone = metric.tone;
  card.dataset.metric = metric.key;
  const tone = metric.tone === 'warn' ? 'rust' : metric.tone === 'ok' ? 'forest' : 'neutral';
  const labelRow = el('div', 'stat-label-row');
  labelRow.append(el('span', 'stat-label', metric.label));
  card.append(labelRow);
  const valueRow = el('div', 'stat-val-row');
  valueRow.append(el('span', `stat-huge-number ${tone}`, metric.value));
  if (metric.percent) valueRow.append(el('span', `stat-diff-badge ${tone}`, `约 ${metric.percent}`));
  card.append(valueRow);
  if (metric.missing) card.append(el('span', 'stat-subtext', '暂缺测算数据'));
  return card;
}

function refreshBenefits(root: HTMLElement): void {
  const model = renderedModels.get(root);
  if (model) renderBenefits(root, model);
}

function renderBenefits(root: HTMLElement, model: Model): void {
  const benefits = model.benefits;
  const details = benefits.details;
  const section = slot(root, 'benefits');
  section.hidden = !benefits.visible;
  if (!benefits.visible) {
    benefitDialogs.get(root)?.handle.close();
    return;
  }
  section.dataset.benefitState = benefits.state;

  const activeDialog = benefitDialogs.get(root);
  if (activeDialog) {
    const delivery = details.present ? details.deliveries[activeDialog.index] : null;
    if (!delivery) activeDialog.handle.close();
    else {
      activeDialog.handle.setSubtitle(delivery.title);
      activeDialog.handle.setBody(benefitDialogBody(delivery, details));
    }
  }

  setText(root, 'benefits-title', benefits.summaryLine);
  setText(root, 'benefits-coverage', benefits.coverageLabel);
  slot(root, 'benefits-coverage').hidden = !benefits.present;

  const grid = slot(root, 'benefits-metrics');
  grid.replaceChildren();
  for (const metric of benefits.metrics) grid.append(benefitMetricBlock(metric));

  const observation = slot(root, 'benefits-observation');
  const observationText = [benefits.observation, benefits.negativeNote].filter(Boolean).join(' ');
  setText(root, 'benefits-observation-text', observationText);
  const links = slot(root, 'benefits-links');
  links.replaceChildren();
  for (const link of benefits.observationLinks) {
    if (link.href) links.append(anchorItem(link.href, link.label, 'btn-cell-action', [link.label]));
  }
  links.hidden = !links.childElementCount;
  observation.hidden = !observationText && !links.childElementCount;

  const basis = slot(root, 'benefits-basis');
  basis.hidden = !details.present;
  const preview = slot(root, 'benefits-preview');
  const head = slot(root, 'benefits-head');
  const body = slot(root, 'benefits-rows');
  if (!details.present) {
    head.replaceChildren();
    body.replaceChildren();
    preview.replaceChildren();
    preview.hidden = true;
    return;
  }

  const expanded = previewExpandedFor(root, 'benefits');
  markPreview(slot(root, 'benefits-table-wrap'), 'benefits', expanded);
  preview.replaceChildren();
  preview.hidden = false;

  head.replaceChildren();
  const headRow = el('tr');
  headRow.append(sortableHeader(root, 'benefits', '工作 / 任务', 'title', 'text'));
  headRow.append(sortableHeader(root, 'benefits', '全 Codex 基线', 'baselineTokens', 'number'));
  headRow.append(sortableHeader(root, 'benefits', '实际 Codex', 'codexTokens', 'number'));
  headRow.append(sortableHeader(root, 'benefits', '实际 Qoder', 'qoderTokens', 'number'));
  headRow.append(sortableHeader(root, 'benefits', '净节省/多用', 'savedTokens', 'number'));
  headRow.append(sortableHeader(root, 'benefits', '省时/多投', 'savedSeconds', 'number'));
  headRow.append(plainHeader('依据', 'table-action-col'));
  head.append(headRow);

  body.replaceChildren();
  if (!details.deliveries.length) {
    const row = el('tr');
    const cell = el('td', 'editorial-empty', details.tableEmptyText);
    cell.colSpan = 7;
    row.append(cell);
    body.append(row);
  } else {
    const rows = details.deliveries.map((item, index) => ({item, index}));
    const sorted = sortRowsFor(rows, sortFor(root, 'benefits'), [
      {key: 'title', type: 'text', value: row => row.item.title},
      {key: 'baselineTokens', type: 'number', value: row => row.item.sortValues.baselineTokens},
      {key: 'codexTokens', type: 'number', value: row => row.item.sortValues.codexTokens},
      {key: 'qoderTokens', type: 'number', value: row => row.item.sortValues.qoderTokens},
      {key: 'savedTokens', type: 'number', value: row => row.item.sortValues.savedTokens},
      {key: 'savedSeconds', type: 'number', value: row => row.item.sortValues.savedSeconds},
    ]);
    for (const row of previewRows(sorted, expanded)) body.append(benefitRow(row.item, row.index));
  }
  tableFooter(preview, 'benefits', expanded, details.deliveries.length, '项', {
    expand: details.expandLabel,
    collapse: details.collapseLabel,
  });
}

function renderFooter(root: ParentNode, model: Model): void {
  setText(root, 'footer-title', model.footer.title);
}

function fill(root: HTMLElement, model: Model, state: AnalysisState): void {
  const context = contexts.get(root);
  const current = context
    ? {
        ...model,
        cli: cliViewModel(context.data, {
          filter: cliFilter.get(root) || 'all',
          query: cliQuery.get(root) || '',
          sort: sortFor(root, 'cli'),
          expanded: previewExpandedFor(root, 'cli'),
        }),
      }
    : model;
  renderedModels.set(root, current);
  renderReportHead(root, current);

  renderRanges(root, state);
  renderUsage(root, current, usageMode.get(root) || 'codex');
  renderBenefits(root, current);
  renderHighlight(root, current);
  renderKpis(root, current);
  renderTrend(root, current);
  renderSessions(root, current);
  renderSkills(root, current);
  renderCli(root, current);
  renderObservations(root, current);
  renderFooter(root, current);
}

function refreshCli(root: HTMLElement): void {
  const context = contexts.get(root);
  const model = renderedModels.get(root);
  if (!context || !model) return;
  const cli = cliViewModel(context.data, {
    filter: cliFilter.get(root) || 'all',
    query: cliQuery.get(root) || '',
    sort: sortFor(root, 'cli'),
    expanded: previewExpandedFor(root, 'cli'),
  });
  const next = {...model, cli};
  renderedModels.set(root, next);
  if (root.querySelector('[data-cli-results]')) {
    setText(root, 'skills-summary', cliChapterLabel(cli, model.skills));
    renderCliResults(root, cli);
  } else {
    renderCli(root, next);
  }
}

function refreshTrend(root: HTMLElement): void {
  const model = renderedModels.get(root);
  if (model) renderTrend(root, model);
}

function refreshSessions(root: HTMLElement): void {
  const model = renderedModels.get(root);
  if (model) renderSessions(root, model);
}

function refreshPreview(root: HTMLElement, key: string): void {
  if (key === 'cli') refreshCli(root);
  else if (key === 'benefits') refreshBenefits(root);
  else if (key === 'daily') refreshTrend(root);
  else if (key === 'sessions') refreshSessions(root);
  else if (key === 'skills') { const model = renderedModels.get(root); if (model) renderSkills(root, model); }
  else if (key.startsWith('usage-')) refreshUsage(root);
}

function bindInteractions(root: HTMLElement): void {
  root.addEventListener('input', event => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || !target.matches('[data-cli-query]')) return;
    if (!contexts.get(root)) return;
    cliQuery.set(root, target.value);
    if (composingRoots.has(root)) return;
    setPreviewExpanded(root, 'cli', false);
    resetPreviewScroll(root, 'cli');
    refreshCli(root);
  });
  root.addEventListener('compositionstart', event => {
    const target = event.target;
    if (target instanceof HTMLInputElement && target.matches('[data-cli-query]')) composingRoots.add(root);
  });
  root.addEventListener('compositionend', event => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || !target.matches('[data-cli-query]')) return;
    composingRoots.delete(root);
    cliQuery.set(root, target.value);
    setPreviewExpanded(root, 'cli', false);
    refreshCli(root);
    const pending = pendingRenders.get(root);
    if (pending) {
      pendingRenders.delete(root);
      renderAnalysis(root, pending.data, pending.state, pending.actions);
    }
  });
  root.addEventListener('change', event => {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement) || !target.matches('[data-cli-filter]')) return;
    if (!contexts.get(root)) return;
    cliFilter.set(root, target.value);
    setPreviewExpanded(root, 'cli', false);
    resetPreviewScroll(root, 'cli');
    refreshCli(root);
  });
  root.addEventListener('click', event => {
    const source = event.target instanceof Element ? event.target : null;
    const target = source?.closest<HTMLElement>('[data-action],[data-scroll]') ?? null;
    if (!target) return;
    const context = contexts.get(root);
    if (!context) return;
    const scrollTarget = target.dataset.scroll;
    if (scrollTarget) {
      event.preventDefault();
      root.querySelector(`#${CSS.escape(scrollTarget)}`)?.scrollIntoView({behavior: 'smooth', block: 'start'});
      return;
    }
    const action = target.dataset.action;
    if (action === 'sort') {
      event.preventDefault();
      const table = target.dataset.table || '';
      const key = target.dataset.key || '';
      if (!table || !key) return;
      const type = target.dataset.type === 'number' ? 'number' : 'text';
      setSortFor(root, table, nextSort(sortFor(root, table), key, type));
      refreshSort(root, table, key);
      return;
    }
    if (action === 'cli-clear') {
      event.preventDefault();
      cliQuery.set(root, '');
      cliFilter.set(root, 'all');
      setPreviewExpanded(root, 'cli', false);
      resetPreviewScroll(root, 'cli');
      refreshCli(root);
      root.querySelector<HTMLInputElement>('[data-cli-query]')?.focus({preventScroll: true});
      return;
    }
    if (action === 'usage-mode') {
      event.preventDefault();
      const mode = target.dataset.mode;
      usageMode.set(root, mode === 'qoder' || mode === 'compare' ? mode : 'codex');
      refreshUsage(root);
      return;
    }
    if (action === 'preview') {
      event.preventDefault();
      const key = target.dataset.previewKey || '';
      if (!key) return;
      const expanded = !previewExpandedFor(root, key);
      setPreviewExpanded(root, key, expanded);
      if (!expanded) resetPreviewScroll(root, key);
      refreshPreview(root, key);
      focusPreviewToggle(root, key);
      return;
    }
    if (action === 'benefits-row') {
      event.preventDefault();
      const index = Number(target.dataset.index);
      if (!Number.isInteger(index)) return;
      // 部分浏览器点击按钮不会聚焦，先显式聚焦，关闭弹框时才能回到原行。
      target.focus({preventScroll: true});
      openBenefitDialog(root, index);
      return;
    }
    if (action === 'evidence') {
      event.preventDefault();
      const targetId = target.dataset.target || '';
      const content = targetId ? root.querySelector<HTMLElement>(`#${CSS.escape(targetId)}`) : null;
      if (!content) return;
      const open = !content.classList.contains('is-open');
      content.classList.toggle('is-open', open);
      target.setAttribute('aria-expanded', String(open));
      const label = target.querySelector('span');
      if (label) label.textContent = open ? '收起相关记录依据 ▴' : '展开相关记录依据 ▾';
      return;
    }
    if (action === 'range') {
      event.preventDefault();
      const raw = target.dataset.days;
      context.actions.onDays(raw === 'all' || raw === undefined ? null : Number(raw) as 7 | 30);
      return;
    }
    if (action === 'rank') {
      event.preventDefault();
      const rank = target.dataset.rank === 'tasks' ? 'tasks' : 'tokens';
      setSortFor(root, 'sessions', {key: rank, direction: 'desc'});
      context.actions.onRank(rank);
      return;
    }
    if (action === 'cli-failures') {
      event.preventDefault();
      const key = target.dataset.cliKey || '';
      if (!key) return;
      const expanded = cliExpanded.get(root) || new Set<string>();
      if (expanded.has(key)) expanded.delete(key);
      else expanded.add(key);
      cliExpanded.set(root, expanded);
      syncCliFailures(root);
    }
  });
  root.addEventListener('toggle', event => {
    const target = event.target;
    if (!(target instanceof HTMLDetailsElement)) return;
    if (target.matches('[data-daily]')) {
      if (target.open) return;
      setPreviewExpanded(root, 'daily', false);
      resetPreviewScroll(root, 'daily');
      refreshTrend(root);
      return;
    }
    if (!target.matches('[data-usage-details]')) return;
    const key = target.dataset.usageDetails || '';
    if (!key) return;
    const openDetails = usageDetailsOpen.get(root) || new Set<string>();
    if (target.open) openDetails.add(key);
    else openDetails.delete(key);
    usageDetailsOpen.set(root, openDetails);
    if (target.open) return;
    setPreviewExpanded(root, key, false);
    resetPreviewScroll(root, key);
    refreshUsage(root);
  }, true);
}

export function renderAnalysis(root: HTMLElement, data: AnalysisData, state: AnalysisState, actions: AnalysisActions): void {
  contexts.set(root, {data, state, actions});
  if (!boundRoots.has(root)) {
    bindInteractions(root);
    boundRoots.add(root);
  }
  if (composingRoots.has(root)) {
    pendingRenders.set(root, {data, state, actions});
    return;
  }
  const active = document.activeElement;
  const searchInput = root.querySelector<HTMLInputElement>('[data-cli-query]');
  const selection = searchInput && active === searchInput
    ? {start: searchInput.selectionStart ?? 0, end: searchInput.selectionEnd ?? 0}
    : null;
  const sortButton = active instanceof HTMLElement && active.matches('[data-action="sort"]')
    ? {table: active.dataset.table || '', key: active.dataset.key || ''}
    : null;

  root.innerHTML = REPORT_TEMPLATE;
  for (const table of Array.from(root.querySelectorAll<HTMLTableElement>('table[data-table-key]'))) {
    applyTableLayout(table, table.dataset.tableKey || '');
  }
  fill(root, reportModel(data, state, actions) as unknown as Model, state);

  if (selection) {
    const next = root.querySelector<HTMLInputElement>('[data-cli-query]');
    if (next) {
      next.value = cliQuery.get(root) ?? '';
      next.focus({preventScroll: true});
      next.setSelectionRange(selection.start, selection.end);
    }
  } else if (sortButton) {
    focusSortButton(root, sortButton.table, sortButton.key);
  }
}

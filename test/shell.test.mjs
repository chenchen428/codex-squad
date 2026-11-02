// 共享壳导航口径：分析 Tab 只承载分析入口，不冒用看板或全局周期的 Token 数字。
import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';

// Use the declared build tool so the test also runs on the supported Node 22
// versions that do not load TypeScript files without an extra runtime flag.
const bundled = await build({
  entryPoints: [fileURLToPath(new URL('../cli/ui/shell.ts', import.meta.url))],
  bundle: true, format: 'esm', platform: 'node', write: false,
});
const {renderShell} = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString('base64')}`);

// 页面路由层决定壳里的任务数量；与壳一起按声明的构建工具加载，避免依赖 DOM。
const appBundled = await build({
  entryPoints: [fileURLToPath(new URL('../cli/ui/app.tsx', import.meta.url))],
  bundle: true, format: 'esm', platform: 'node', write: false,
});
const {resolveBoardTaskCount} = await import(`data:text/javascript;base64,${Buffer.from(appBundled.outputFiles[0].contents).toString('base64')}`);

class FakeClassList {
  constructor(element) {
    this.element = element;
    this.names = new Set();
  }
  add(name) {
    this.names.add(name);
  }
  remove(name) {
    this.names.delete(name);
  }
  contains(name) {
    return this.names.has(name);
  }
  toggle(name, force) {
    const on = force === undefined ? !this.names.has(name) : Boolean(force);
    if (on) this.names.add(name);
    else this.names.delete(name);
    return on;
  }
}

class FakeElement {
  constructor(tag, document) {
    this.tagName = tag.toUpperCase();
    this.localName = tag;
    this.ownerDocument = document;
    this.children = [];
    this.parentNode = null;
    this.text = '';
    this.hidden = false;
    this.attributes = new Map();
    this.listeners = new Map();
    this.classList = new FakeClassList(this);
  }
  set className(value) {
    this.classList.names = new Set(String(value).split(/\s+/).filter(Boolean));
  }
  get className() {
    return [...this.classList.names].join(' ');
  }
  get textContent() {
    return this.text + this.children.map(child => child.textContent).join('');
  }
  set textContent(value) {
    this.children.forEach(child => {
      child.parentNode = null;
    });
    this.children = [];
    this.text = String(value);
  }
  set innerHTML(value) {
    this.text = String(value);
  }
  append(...nodes) {
    for (const child of nodes) {
      child.parentNode = this;
      this.children.push(child);
    }
  }
  replaceChildren(...nodes) {
    this.children.forEach(child => {
      child.parentNode = null;
    });
    this.children = [];
    this.append(...nodes);
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }
  removeAttribute(name) {
    this.attributes.delete(name);
  }
  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter(child => child !== this);
    this.parentNode = null;
  }
  addEventListener(type, listener, options = {}) {
    const entry = {listener};
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(entry);
    const signal = options?.signal;
    if (!signal) return;
    const drop = () => {
      this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item !== entry));
    };
    if (signal.aborted) drop();
    else signal.addEventListener('abort', drop);
  }
  dispatch(type) {
    for (const {listener} of [...(this.listeners.get(type) || [])]) listener({type, target: this});
  }
}

function fakeDocument() {
  const doc = {createElement: tag => new FakeElement(tag, doc)};
  return doc;
}

function descendants(node, found = []) {
  for (const child of node.children) {
    found.push(child);
    descendants(child, found);
  }
  return found;
}

function byClass(node, name) {
  return descendants(node).find(child => child.classList.contains(name)) || null;
}

function navTabs(shellElement) {
  const nav = byClass(shellElement, 'squad-main-nav');
  assert.ok(nav, '共享壳缺少主导航');
  const tabs = nav.children[0];
  const [overview, analysis] = tabs.children;
  assert.ok(overview && analysis, '主导航应只有看板与分析两个入口');
  return {overview, analysis};
}

function options(overrides = {}) {
  return {
    page: 'overview',
    title: '当前会话',
    days: 7,
    taskCount: 3,
    connected: true,
    observedAt: '2026-10-28T02:00:00.000Z',
    onPage: () => {},
    onDays: () => {},
    onRefresh: () => {},
    onRetry: () => {},
    ...overrides,
  };
}

test('分析入口在任意页面状态都只显示分析文字，任务数量随壳更新且跳转有效', () => {
  const document = fakeDocument();
  const host = new FakeElement('div', document);
  const opened = [];
  const shell = renderShell(host, options({onPage: page => opened.push(page)}));
  const shellElement = host.children[0];

  let {overview, analysis} = navTabs(shellElement);
  assert.equal(analysis.textContent, '分析');
  assert.equal(analysis.children.length, 1, '分析入口不应创建数量或 Token 节点');
  assert.equal(byClass(analysis, 'squad-tab-count'), null);
  const overviewCount = byClass(overview, 'squad-tab-count');
  assert.ok(overviewCount, '看板入口保留任务数量');
  assert.equal(overviewCount.textContent, '3');

  shell.update({page: 'analysis', taskCount: 5});
  ({overview, analysis} = navTabs(shellElement));
  assert.equal(analysis.textContent, '分析');
  assert.equal(byClass(analysis, 'squad-tab-count'), null, '进入分析后不得出现隐藏的 Token 徽标');
  assert.equal(analysis.getAttribute('aria-current'), 'page');
  assert.equal(overview.getAttribute('aria-current'), null);
  assert.equal(byClass(overview, 'squad-tab-count').textContent, '5', '任务数量继续随壳更新');
  assert.doesNotMatch(analysis.textContent, /tok|B\b|M\b|Token/i, '分析入口不得冒用其他口径的数字');

  shell.update({page: 'session', taskCount: null});
  ({overview, analysis} = navTabs(shellElement));
  assert.equal(analysis.textContent, '分析');
  assert.equal(byClass(analysis, 'squad-tab-count'), null);
  assert.equal(byClass(overview, 'squad-tab-count').textContent, '—');
  assert.equal(analysis.getAttribute('aria-current'), null);
  assert.equal(overview.getAttribute('aria-current'), 'page');

  analysis.dispatch('click');
  overview.dispatch('click');
  assert.deepEqual(opened, ['analysis', 'overview']);

  shell.update({page: 'analysis'});
  analysis = navTabs(shellElement).analysis;
  analysis.dispatch('click');
  assert.deepEqual(opened, ['analysis', 'overview', 'analysis']);

  shell.dispose();
  assert.equal(host.children.length, 0, '销毁后共享壳从宿主移除');
});

function countTask(id, status) {
  return {id, title: id, memberId: 'implementer', status, attempts: []};
}

test('看板任务数跨页同源：单任务快照不覆写全量计数，未知加载不伪造 1 或 0', () => {
  const board = {
    schemaVersion: 1, connected: true, observedAt: '2026-10-28T02:00:00.000Z',
    tasks: [
      ...['a', 'b', 'c', 'd', 'e', 'f'].map(id => countTask(id, 'in_review')),
      countTask('history', 'stopped'),
    ],
  };
  let count = resolveBoardTaskCount(null, board);
  assert.equal(count, 6, '全量看板先按看板可见口径统计');

  // 详情页只保留当前任务，但携带服务端声明的全量看板计数。
  const session = {...board, tasks: [countTask('a', 'in_review')], task: countTask('a', 'in_review'), boardTaskCount: 6};
  count = resolveBoardTaskCount(count, session);
  assert.equal(count, 6);
  // 切到分析页时数据仍是上一条详情快照，不得把 1 当成看板数。
  count = resolveBoardTaskCount(count, session);
  assert.equal(count, 6);
  count = resolveBoardTaskCount(count, board);
  assert.equal(count, 6, '回到看板仍沿用同一个计数事实');

  // 深链直达详情且服务端尚未声明看板计数：保持未知态，不显示 1 或 0。
  assert.equal(resolveBoardTaskCount(null, {...session, boardTaskCount: null}), null);
  // 服务端声明优先于旧的本地值；声明缺失时不能把已有计数清零。
  assert.equal(resolveBoardTaskCount(6, {...session, boardTaskCount: 5}), 5);
  assert.equal(resolveBoardTaskCount(6, {...session, boardTaskCount: null}), 6);
});

test('加载反馈复用恒定 meta 栏并公开 pending、完成、失败与重试状态', () => {
  const document = fakeDocument();
  const host = new FakeElement('div', document);
  let retries = 0;
  const shell = renderShell(host, options({onRetry: () => retries++}));
  const shellElement = host.children[0];
  const live = byClass(shellElement, 'squad-live-status');
  const progress = byClass(shellElement, 'squad-progress-bar');
  const refresh = byClass(shellElement, 'squad-btn-refresh');
  const syncDetail = byClass(shellElement, 'squad-sync-detail');
  const errorBanner = byClass(shellElement, 'squad-error-banner');
  assert.ok(live, '加载反馈应有可访问的状态播报');
  assert.equal(live.getAttribute('role'), 'status');
  assert.equal(live.getAttribute('aria-live'), 'polite');

  // 完成态：无 pending 时进度归零，播报返回真实同步口径。
  assert.equal(live.textContent, '实时同步');
  assert.equal(progress.classList.contains('active'), false);
  assert.equal(refresh.classList.contains('spinning'), false);
  assert.equal(errorBanner.hidden, true);

  // pending：进度 rail 与刷新图标承担可见反馈，详细文案只进入隐藏播报与 title。
  shell.setPending('正在刷新…');
  assert.equal(progress.classList.contains('active'), true);
  assert.equal(refresh.classList.contains('spinning'), true);
  assert.equal(live.textContent, '正在刷新…');
  assert.equal(byClass(shellElement, 'squad-sync-indicator').title, '正在刷新…');
  assert.equal(syncDetail.textContent, '正在同步');
  assert.equal(errorBanner.hidden, true);

  // 完成：pending 结束后恢复同步口径，不残留加载文案。
  shell.setPending(null);
  assert.equal(live.textContent, '实时同步');
  assert.equal(progress.classList.contains('active'), false);
  assert.equal(refresh.classList.contains('spinning'), false);
  assert.equal(byClass(shellElement, 'squad-sync-indicator').title, '');

  // 失败：错误横幅保留 role=alert 与重试入口，避免与隐藏播报重复播报。
  shell.setPending('页面资源加载失败，请重试。', true);
  assert.equal(errorBanner.hidden, false);
  assert.equal(errorBanner.getAttribute('role'), 'alert');
  assert.equal(byClass(shellElement, 'squad-error-label').textContent, '页面资源加载失败，请重试。');
  assert.equal(live.textContent, '');
  assert.equal(progress.classList.contains('active'), false);
  assert.equal(refresh.classList.contains('spinning'), false);
  const retry = byClass(shellElement, 'squad-btn-retry');
  assert.ok(retry && retry.parentNode === errorBanner, '重试入口保留在错误横幅内');
  retry.dispatch('click');
  assert.equal(retries, 1, '重试回调触达页面刷新入口');

  // 重试后重新进入 pending，再回到完成态。
  shell.setPending('正在重新加载…');
  assert.equal(errorBanner.hidden, true);
  assert.equal(progress.classList.contains('active'), true);
  assert.equal(live.textContent, '正在重新加载…');
  shell.setPending(null);
  assert.equal(errorBanner.hidden, true);
  assert.equal(live.textContent, '实时同步');

  // 分析页复用同一套状态：只有同步口径文案不同。
  shell.update({page: 'analysis'});
  assert.equal(live.textContent, '周期报告');
  shell.setPending('正在读取分析记录…');
  assert.equal(live.textContent, '正在读取分析记录…');

  shell.dispose();
});

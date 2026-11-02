// 版本入口与版本弹层的纯视图模型测试：只断言本机版本、手动获取入口和错误态。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  UPDATE_ENTRY_URL,
  formatClock, formatDateTime, formatTokenCount,
  safeText, versionEntry, versionView,
} from '../cli/ui/runtime-info-model.mjs';

function updates(overrides = {}) {
  return {
    localVersion: '0.12.0',
    entry: {url: UPDATE_ENTRY_URL, mode: 'manual'},
    autoUpdate: false,
    stale: false,
    ...overrides,
  };
}

test('safeText keeps paragraph breaks and strips only control characters', () => {
  assert.equal(safeText('第一行\r\n第二行\t末尾\u0007'), '第一行\n第二行\t末尾');
});

test('no runtime info yet shows a loading version sheet', () => {
  const view = versionView(null);
  assert.equal(view.state, 'loading');
  assert.equal(view.localVersion, null);
  assert.equal(view.localLabel, '未识别');
  assert.match(view.statusText, /正在读取本机版本/);
  assert.equal(view.entryUrl, UPDATE_ENTRY_URL);
  assert.equal(view.entryLabel, '打开发布页');
  assert.equal(view.autoUpdate, false);
  assert.match(view.note, /不包含自动更新/);
});

test('a readable local version is shown without any remote comparison', () => {
  const view = versionView(updates());
  assert.equal(view.state, 'ready');
  assert.equal(view.localVersion, '0.12.0');
  assert.equal(view.localLabel, 'v0.12.0');
  assert.match(view.statusText, /本机安装版本/);
  assert.equal(view.entryUrl, UPDATE_ENTRY_URL);
  assert.equal(view.entryLabel, '打开发布页');
  assert.equal(view.autoUpdate, false);
  assert.equal(view.error, null);
  assert.equal(view.errorNotice, null);
  assert.equal(view.localVersionError, null);
  assert.match(view.note, /手动获取并替换本机插件/);
  for (const key of ['latestVersion', 'latestLabel', 'status', 'updateAvailable', 'badge', 'notes', 'action', 'protection', 'checkedLabel']) {
    assert.equal(key in view, false, key);
  }
});

test('an unrecognized local version is reported without inventing one', () => {
  const view = versionView(updates({
    localVersion: null,
    localVersionError: {code: 'SQUAD_UPDATE_LOCAL_VERSION_INVALID', message: '本机插件版本无法识别。'},
  }));
  assert.equal(view.localLabel, '未识别');
  assert.match(view.statusText, /本机安装版本无法识别/);
  assert.equal(view.localVersionError.code, 'SQUAD_UPDATE_LOCAL_VERSION_INVALID');
  assert.match(view.localErrorNotice, /本机版本无法识别：本机插件版本无法识别。/);
  assert.equal(view.entryUrl, UPDATE_ENTRY_URL);
});

test('a stale read keeps the last successful version and says so', () => {
  const view = versionView(updates({
    stale: true,
    error: {code: 'SQUAD_RUNTIME_INFO_UNAVAILABLE', message: '接口暂不可用'},
  }));
  assert.equal(view.stale, true);
  assert.match(view.statusText, /暂时无法读取本机版本/);
  assert.match(view.errorNotice, /读取失败，展示上次成功记录：接口暂不可用/);
  assert.equal(view.localLabel, 'v0.12.0');
});

test('the manual entry links only to the public GitHub Releases page', () => {
  const untrusted = versionView(updates({entry: {url: 'https://evil.example/update', mode: 'manual'}}));
  assert.equal(untrusted.entryUrl, UPDATE_ENTRY_URL);
  const insecure = versionView(updates({entry: {url: 'http://insecure.example/releases', mode: 'manual'}}));
  assert.equal(insecure.entryUrl, UPDATE_ENTRY_URL);
  const subPath = versionView(updates({entry: {url: 'https://github.com/other/repo/releases', mode: 'manual'}}));
  assert.equal(subPath.entryUrl, UPDATE_ENTRY_URL);
  const accepted = versionView(updates({entry: {url: UPDATE_ENTRY_URL, mode: 'manual'}}));
  assert.equal(accepted.entryUrl, UPDATE_ENTRY_URL);
});

test('the version entry stays quiet and names the manual update path', () => {
  const loading = versionEntry(null);
  assert.equal(loading.label, '版本未确认');
  assert.equal(loading.hint, '· 查看版本');
  assert.equal(loading.tone, 'quiet');

  const current = versionEntry(updates());
  assert.equal(current.label, 'v0.12.0');
  assert.equal(current.hint, '· 查看版本');
  assert.equal(current.tone, 'quiet');
  assert.match(current.title, /查看本机版本与手动更新说明/);
  assert.match(current.ariaLabel, /当前版本 v0\.12\.0/);

  const unknown = versionEntry(updates({
    localVersion: null,
    localVersionError: {code: 'SQUAD_UPDATE_LOCAL_VERSION_INVALID', message: '本机插件版本无法识别。'},
  }));
  assert.equal(unknown.label, '版本未确认');
  assert.equal(unknown.title, '本机版本无法识别');
});

test('the view never promises automatic update or install', () => {
  const serialized = JSON.stringify({
    idle: versionView(updates()),
    loading: versionView(null),
    error: versionView(updates({stale: true, error: {code: 'E', message: '失败'}})),
  });
  assert.doesNotMatch(serialized, /自动更新到|自动安装|安装请求|更新到 v|正在更新/);
  assert.match(serialized, /不包含自动更新/);
});

test('editing timestamps stay in the documented Shanghai display', () => {
  assert.equal(formatDateTime('2026-10-27T04:05:06.000Z'), '2026-10-27 12:05:06');
  assert.equal(formatClock('2026-10-27T04:05:06.000Z'), '12:05:06');
});

test('token formatting stays local to the consumption reader', () => {
  assert.equal(formatTokenCount(950), '950');
  assert.equal(formatTokenCount(1500000), '1.5m');
  assert.equal(formatTokenCount(null), null);
});

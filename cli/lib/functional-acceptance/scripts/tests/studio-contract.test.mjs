import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { validateStructure } from '../lib/contract.mjs';
import { resolveViewer, renderIndexHtml, createNonce, BuildError } from '../lib/render.mjs';
import { createStudioModel, LEGACY_VERIFICATION_NOTICE } from '../../assets/lib/studio-data.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const CLI = path.join(ROOT, 'scripts', 'acceptance.mjs');
const REAL_DATA = process.env.ACCEPTANCE_TEST_DATA || '';

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ita-studio-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function errorCodes(data) {
  return validateStructure(data).errors.map((item) => item.code);
}

function dataStep(id, extra = {}) {
  return Object.assign(
    {
      id,
      type: 'data',
      title: '数据 ' + id,
      action: '读取数据',
      expected: '数据一致',
      actual: '未执行',
      status: 'not_run',
    },
    extra
  );
}

function pageStep(id, extra = {}) {
  return Object.assign(
    {
      id,
      type: 'page',
      page: '提现户页面',
      title: '页面 ' + id,
      action: '打开页面',
      expected: '展示页面',
      actual: '未执行',
      status: 'not_run',
    },
    extra
  );
}

function makeData(overrides = {}) {
  return Object.assign(
    {
      schemaVersion: 1,
      report: { id: 'studio-contract', title: 'studio 合同测试', environment: '本地测试', example: true },
      groups: [{ id: 'g1', title: '分组一' }],
      evidence: [],
      cases: [{
        id: 'C1',
        groupId: 'g1',
        title: '用例一',
        objective: '验证合同',
        status: 'not_run',
        steps: [dataStep('s1')],
        checks: [],
      }],
    },
    overrides
  );
}

function withStep(stepExtra) {
  return makeDataWithEvidence(stepExtra);
}

function verification(overrides = {}) {
  return Object.assign(
    {
      question: '提现户是否写入成功？',
      method: '查询提现户表并按商家过滤',
      focus: [{ label: '提现户状态', reason: '决定能否提现', actual: '已生效', evidenceIds: ['ev1'] }],
      statement: {
        kind: 'sql',
        text: 'select status from withdraw_account where seller_id = ?',
        origin: 'executed',
        explanation: '原文取自本次只读查询',
        parameters: [{ name: 'sellerId', value: 'S-1', reason: '限定当前商家' }],
      },
      comparison: [
        { label: '状态', expected: '生效', actual: '生效', status: 'passed', evidenceIds: ['ev1'] },
      ],
      conclusion: '证据显示提现户状态为生效',
      limitations: ['仅覆盖当前商家'],
    },
    overrides
  );
}

function reproduction(overrides = {}) {
  return Object.assign(
    {
      kind: 'db',
      label: '只读库查询',
      url: 'https://dms.example.test/query',
      urlStatus: 'verified',
      reason: '已在本轮只读控制台核验',
      params: 'select * from withdraw_account where seller_id = :sellerId',
      instructions: '打开控制台 → 粘贴模板 → 只读执行',
      constraints: ['只读，不写库'],
      sourceIds: ['ev1'],
    },
    overrides
  );
}

function makeDataWithEvidence(stepExtra) {
  return makeData({
    evidence: [{
      id: 'ev1',
      title: '提现户查询结果',
      type: 'json',
      category: 'data',
      value: { status: 'ACTIVE' },
      kind: '补拍前截图说明',
    }],
    cases: [{
      id: 'C1',
      groupId: 'g1',
      title: '用例一',
      objective: '验证合同',
      status: 'not_run',
      steps: [dataStep('s1', stepExtra)],
      checks: [],
    }],
  });
}

function writeData(t, data, name = 'acceptance.json') {
  const dir = tmpDir(t);
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return { dir, file };
}

function build(t, data, name = 'pkg', extraArgs = []) {
  const { file } = writeData(t, data);
  const out = path.join(tmpDir(t), name);
  const result = runCli(['build', file, '--out', out, '--json', ...extraArgs]);
  let payload = null;
  const htmlPath = path.join(out, 'index.html');
  if (fs.existsSync(htmlPath)) {
    const html = fs.readFileSync(htmlPath, 'utf8');
    const matched = html.match(/<script type="application\/json" id="acceptance-data" nonce="[0-9a-f]+">([\s\S]*?)<\/script>/);
    payload = matched ? JSON.parse(matched[1]) : null;
  }
  return { result, out, payload };
}

function readPayloadFromHtml(html) {
  const matched = html.match(/<script type="application\/json" id="acceptance-data" nonce="[0-9a-f]+">([\s\S]*?)<\/script>/);
  return matched ? JSON.parse(matched[1]) : null;
}

/* ---------- 合同枚举与引用 ---------- */

test('非法枚举与类型被拒绝', () => {
  assert.ok(errorCodes(withStep({ verification: verification({ statement: { kind: 'graphql', text: 'x', origin: 'executed' } }) }))
    .includes('E_VERIFICATION_STATEMENT_KIND'));
  assert.ok(errorCodes(withStep({ verification: verification({ statement: { kind: 'sql', text: 'x', origin: 'generated' } }) }))
    .includes('E_VERIFICATION_STATEMENT_ORIGIN'));
  assert.ok(errorCodes(withStep({
    verification: verification({
      comparison: [{ label: '状态', expected: 'a', actual: 'b', status: 'green' }],
    }),
  })).includes('E_VERIFICATION_COMPARISON_STATUS'));
  assert.ok(errorCodes(withStep({ reproduction: reproduction({ kind: 'ftp' }) })).includes('E_REPRODUCTION_KIND'));
  assert.ok(errorCodes(withStep({ reproduction: reproduction({ urlStatus: 'maybe' }) })).includes('E_REPRODUCTION_URL_STATUS'));
  assert.ok(errorCodes(withStep({ verification: 'sql 已执行' })).includes('E_VERIFICATION'));
  assert.ok(errorCodes(withStep({ verification: verification({ limitations: '一条' }) })).includes('E_VERIFICATION_LIMITATIONS'));
  assert.ok(errorCodes(withStep({ verification: verification({ conclusion: 12 }) })).includes('E_VERIFICATION_FIELD'));

  const blankTitles = makeData({
    groups: [{ id: 'g1', title: '分组一', displayTitle: ' ' }],
    cases: [{
      id: 'C1',
      groupId: 'g1',
      title: '用例一',
      displayTitle: '',
      objective: '目标',
      status: 'not_run',
      steps: [dataStep('s1', { displayTitle: '   ' })],
      checks: [],
    }],
  });
  const codes = errorCodes(blankTitles);
  assert.ok(codes.includes('E_GROUP_DISPLAY_TITLE'));
  assert.ok(codes.includes('E_CASE_DISPLAY_TITLE'));
  assert.ok(codes.includes('E_STEP_DISPLAY_TITLE'));
});

test('verification / reproduction 证据引用必须存在', () => {
  const focusMissing = withStep({ verification: verification({ focus: [{ label: 'L', reason: 'R', actual: 'A', evidenceIds: ['nope'] }] }) });
  assert.ok(errorCodes(focusMissing).includes('E_VERIFICATION_FOCUS_EVIDENCE_UNKNOWN'));

  const compareMissing = withStep({ verification: verification({ comparison: [{ label: 'L', expected: 'a', actual: 'a', status: 'passed', evidenceIds: ['ghost'] }] }) });
  assert.ok(errorCodes(compareMissing).includes('E_VERIFICATION_COMPARISON_EVIDENCE_UNKNOWN'));

  const sourceMissing = withStep({ reproduction: reproduction({ sourceIds: ['ghost'] }) });
  assert.ok(errorCodes(sourceMissing).includes('E_REPRODUCTION_SOURCE_UNKNOWN'));

  const wrongType = withStep({ verification: verification({ focus: [{ label: 'L', reason: 'R', actual: 'A', evidenceIds: 'ev1' }] }) });
  assert.ok(errorCodes(wrongType).includes('E_EVIDENCE_REF_TYPE'));

  assert.deepEqual(errorCodes(makeDataWithEvidence({ verification: verification(), reproduction: reproduction() })), []);
});

test('已核验入口必须是真实 https，未核验不能伪装链接', () => {
  assert.ok(errorCodes(withStep({ reproduction: reproduction({ url: 'http://dms.example.test/query' }) }))
    .includes('E_REPRODUCTION_URL_HTTPS'));
  assert.ok(errorCodes(withStep({ reproduction: reproduction({ url: 'https://dms.example.test/query/{sellerId}' }) }))
    .includes('E_REPRODUCTION_URL_PLACEHOLDER'));
  assert.ok(errorCodes(withStep({ reproduction: reproduction({ url: 'https://console.example.test/query/...' }) }))
    .includes('E_REPRODUCTION_URL_PLACEHOLDER'));
  assert.ok(errorCodes(withStep({ reproduction: reproduction({ url: 'dms控制台' }) }))
    .includes('E_REPRODUCTION_URL_INVALID'));
  assert.ok(errorCodes(withStep({ reproduction: reproduction({ url: 'https://dms.example.test/query', reason: '' }) }))
    .includes('E_REPRODUCTION_REASON'));

  const unavailableWithUrl = withStep({
    reproduction: reproduction({ urlStatus: 'unavailable', url: 'https://dms.example.test/query', reason: '历史测试无控制台链接' }),
  });
  assert.ok(errorCodes(unavailableWithUrl).includes('E_REPRODUCTION_URL_UNAVAILABLE'));

  const unavailableMissingReason = withStep({ reproduction: reproduction({ urlStatus: 'unavailable', url: null, reason: ' ' }) });
  assert.ok(errorCodes(unavailableMissingReason).includes('E_REPRODUCTION_REASON'));

  const unavailableOk = withStep({ reproduction: reproduction({ urlStatus: 'unavailable', url: null, reason: '历史测试未保留控制台链接' }) });
  assert.deepEqual(errorCodes(unavailableOk), []);

  const paramsWrong = withStep({ reproduction: reproduction({ params: { sql: 'x' } }) });
  assert.ok(errorCodes(paramsWrong).includes('E_REPRODUCTION_PARAMS'));
});

test('statement 原文边界：unavailable 明确未留存，reconstructed 不标执行原文', () => {
  const unavailableText = withStep({
    verification: verification({ statement: { kind: 'sql', text: 'select 1', origin: 'unavailable', explanation: '执行时未留存原文' } }),
  });
  assert.ok(errorCodes(unavailableText).includes('E_VERIFICATION_STATEMENT_UNAVAILABLE'));

  const unavailableVague = withStep({
    verification: verification({ statement: { kind: 'sql', text: '', origin: 'unavailable', explanation: '连接失败' } }),
  });
  assert.ok(errorCodes(unavailableVague).includes('E_VERIFICATION_STATEMENT_UNAVAILABLE'));

  const unavailableOk = withStep({
    verification: verification({ statement: { kind: 'sql', text: '', origin: 'unavailable', explanation: '本轮只读查询执行记录未留存原文' } }),
  });
  assert.deepEqual(errorCodes(unavailableOk), []);

  const reconstructedMissing = withStep({
    verification: verification({ statement: { kind: 'sql', text: 'select status from t', origin: 'reconstructed' } }),
  });
  assert.ok(errorCodes(reconstructedMissing).includes('E_VERIFICATION_STATEMENT_RECONSTRUCTED'));

  const reconstructedClaims = withStep({
    verification: verification({ statement: { kind: 'sql', text: 'select status from t', origin: 'reconstructed', explanation: '该 SQL 是执行原文' } }),
  });
  assert.ok(errorCodes(reconstructedClaims).includes('E_VERIFICATION_STATEMENT_RECONSTRUCTED'));

  const reconstructedOk = withStep({
    verification: verification({
      statement: {
        kind: 'sql',
        text: 'select status from withdraw_account where seller_id = ?',
        origin: 'reconstructed',
        explanation: '根据接口返回的字段名整理还原，非执行原文',
      },
    }),
  });
  assert.deepEqual(errorCodes(reconstructedOk), []);

  const executedMissingText = withStep({
    verification: verification({ statement: { kind: 'sql', text: '', origin: 'executed' } }),
  });
  assert.ok(errorCodes(executedMissingText).includes('E_VERIFICATION_STATEMENT_TEXT'));
});

/* ---------- 状态不由生成器推断 ---------- */

test('comparison.status 完全来自 Agent，预期等同也不自动变绿', (t) => {
  const data = makeDataWithEvidence({
    verification: verification({
      comparison: [
        { label: '状态', expected: '生效', actual: '生效', status: 'failed', evidenceIds: ['ev1'] },
        { label: '数量', expected: '1', actual: '2', status: 'passed', evidenceIds: ['ev1'] },
        { label: '未判断', expected: 'x', actual: 'x', status: 'not_run', evidenceIds: ['ev1'] },
      ],
    }),
  });
  assert.deepEqual(validateStructure(data).errors, []);

  const built = build(t, data, 'comparison');
  assert.equal(built.result.status, 0, built.result.stderr || built.result.stdout);
  const comparison = built.payload.cases[0].steps[0].verification.comparison;
  assert.deepEqual(comparison.map((item) => item.status), ['failed', 'passed', 'not_run']);
  assert.equal(comparison[0].expected, comparison[0].actual, '预期与实际相同但状态为 failed 时保留 failed');

  const model = createStudioModel(built.payload);
  assert.deepEqual(model.cases[0].steps[0].verification.comparison.map((item) => item.status), ['failed', 'passed', 'not_run']);
});

/* ---------- 语义标题 / 旧数据兼容 ---------- */

test('displayTitle 与 pageView.caption 保留，导航不按 id 猜标题', (t) => {
  const data = makeData({
    groups: [{ id: 'g1', title: 'F-01 提现户', displayTitle: '提现户新增' }],
    cases: [{
      id: 'C-99',
      groupId: 'g1',
      title: '打开提现户页面',
      displayTitle: '提现户页面打开',
      objective: '验证页面可用',
      status: 'not_run',
      steps: [pageStep('s1', { displayTitle: '查看提现户列表', pageView: { title: '提现户', caption: '商家提现户列表' } })],
      checks: [],
    }, {
      id: 'C-100',
      groupId: 'g1',
      title: '无 displayTitle 的用例',
      objective: '验证回退',
      status: 'not_run',
      steps: [pageStep('s2')],
      checks: [],
    }],
  });
  assert.deepEqual(validateStructure(data).errors, []);

  const built = build(t, data, 'titles');
  assert.equal(built.result.status, 0, built.result.stderr || built.result.stdout);
  const payloadCase = built.payload.cases[0];
  assert.equal(payloadCase.displayTitle, '提现户页面打开');
  assert.equal(payloadCase.steps[0].displayTitle, '查看提现户列表');
  assert.equal(payloadCase.steps[0].pageView.caption, '商家提现户列表');
  assert.equal(payloadCase.id, 'C-99', '原 id 保留用于关联');
  assert.equal(built.payload.groups[0].displayTitle, '提现户新增');

  const model = createStudioModel(built.payload);
  assert.equal(model.nav[0].label, '提现户新增');
  assert.equal(model.nav[0].cases[0].label, '提现户页面打开');
  assert.equal(model.nav[0].cases[0].id, 'C-99');
  assert.equal(model.nav[0].cases[0].steps[0].label, '查看提现户列表');
  assert.equal(model.nav[0].cases[1].label, '无 displayTitle 的用例', '缺省回退 title，不用 id');
  assert.notEqual(model.nav[0].cases[1].label, 'C-100');
  assert.equal(model.cases[0].steps[0].pageView.caption, '商家提现户列表');
});

test('旧数据没有新字段仍可构建，状态不变并提示查询原文缺失', (t) => {
  const data = makeData({
    evidence: [{ id: 'ev1', title: '历史截图', type: 'text', value: '旧材料' }],
    cases: [{
      id: 'C-old',
      groupId: 'g1',
      title: '历史用例',
      objective: '旧数据兼容',
      status: 'failed',
      steps: [dataStep('s1', { status: 'failed', actual: '接口返回 500', evidenceIds: ['ev1'] })],
      checks: [{ id: 'k1', title: '核对', expected: '成功', actual: '失败', status: 'failed', evidenceIds: ['ev1'] }],
    }],
  });
  assert.deepEqual(validateStructure(data).errors, []);

  const built = build(t, data, 'legacy');
  assert.equal(built.result.status, 0, built.result.stderr || built.result.stdout);
  const step = built.payload.cases[0].steps[0];
  assert.equal(step.status, 'failed');
  assert.equal(step.actual, '接口返回 500');
  assert.equal(built.payload.cases[0].checks[0].status, 'failed');
  assert.equal(step.verification, undefined);
  assert.equal(step.reproduction, undefined);

  const model = createStudioModel(built.payload);
  const modelStep = model.cases[0].steps[0];
  assert.equal(modelStep.verificationState, 'legacy');
  assert.equal(modelStep.verification, null);
  assert.equal(modelStep.legacyNotice, LEGACY_VERIFICATION_NOTICE);
  assert.equal(modelStep.action, '读取数据');
  assert.equal(modelStep.expected, '数据一致');
  assert.equal(modelStep.actual, '接口返回 500');
  assert.equal(modelStep.status, 'failed');
  assert.equal(modelStep.reproduction, null);
});

/* ---------- 资源模式 ---------- */

function imageData() {
  return {
    schemaVersion: 1,
    report: { id: 'image-mode', title: '图片资源模式', environment: '本地', example: true },
    groups: [{ id: 'g1', title: '分组一' }],
    evidence: [
      { id: 'img-a', title: '截图 A', type: 'image', category: 'data', file: 'a.png' },
      { id: 'img-b', title: '截图 B', type: 'image', category: 'data', file: 'b.png' },
    ],
    cases: [{
      id: 'C1',
      groupId: 'g1',
      title: '图片用例',
      objective: '校验去重',
      status: 'not_run',
      steps: [dataStep('s1', { evidenceIds: ['img-a', 'img-b'] })],
      checks: [],
    }],
  };
}

test('external 模式图片按 sha 去重写原字节，inline 模式内联原字节', (t) => {
  const dir = tmpDir(t);
  fs.writeFileSync(path.join(dir, 'a.png'), PNG_1PX);
  fs.writeFileSync(path.join(dir, 'b.png'), PNG_1PX);
  const file = path.join(dir, 'acceptance.json');
  fs.writeFileSync(file, JSON.stringify(imageData(), null, 2));

  const externalOut = path.join(tmpDir(t), 'external');
  const external = runCli(['build', file, '--out', externalOut, '--asset-mode', 'external', '--json']);
  assert.equal(external.status, 0, external.stderr || external.stdout);

  const imagesDir = path.join(externalOut, 'images');
  const imageFiles = fs.readdirSync(imagesDir);
  assert.equal(imageFiles.length, 1, '相同字节只写一份');
  const imageBytes = fs.readFileSync(path.join(imagesDir, imageFiles[0]));
  assert.deepEqual(imageBytes, PNG_1PX, '外置图片保留原始字节');
  assert.match(imageFiles[0], /^[0-9a-f]{64}\.png$/);

  const html = fs.readFileSync(path.join(externalOut, 'index.html'), 'utf8');
  assert.ok(!html.includes('data:image/png;base64'), '外置页面不内联图片 base64');
  assert.ok(!/<iframe\b/i.test(html), '无第二层 iframe');
  assert.notDeepEqual(fs.readFileSync(path.join(externalOut, 'index.html')).subarray(0, 2), Buffer.from([0x1f, 0x8b]), '页面不是 gzip');
  assert.ok(fs.statSync(path.join(externalOut, 'index.html')).size < 4 * 1024 * 1024);

  const payload = readPayloadFromHtml(html);
  assert.equal(payload.assetMode, 'external');
  const imageEvidence = payload.evidence.filter((item) => item.type === 'image');
  assert.equal(imageEvidence.length, 2);
  for (const item of imageEvidence) {
    assert.equal(item.dataUri, `./images/${imageFiles[0].replace(/\.png$/, '')}.png`);
    assert.ok(!item.dataUri.startsWith('data:'));
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(externalOut, 'manifest.json'), 'utf8'));
  assert.equal(manifest.assetMode, 'external');
  assert.equal(manifest.resources.images.length, 1);
  assert.equal(manifest.resources.images[0].path, `images/${imageFiles[0]}`);
  assert.equal(manifest.resources.images[0].bytes, PNG_1PX.length);
  assert.equal(manifest.resources.images[0].embedded, false);
  assert.deepEqual(manifest.resources.images[0].evidenceIds.sort(), ['img-a', 'img-b']);
  assert.equal(manifest.resources.duplicatedBytes, 1);
  assert.ok(manifest.output.some((item) => item.path === `images/${imageFiles[0]}`));

  const inlineOut = path.join(tmpDir(t), 'inline');
  const inline = runCli(['build', file, '--out', inlineOut, '--json']);
  assert.equal(inline.status, 0, inline.stderr || inline.stdout);
  assert.ok(!fs.existsSync(path.join(inlineOut, 'images')), '内联模式不产生图片目录');
  const inlineHtml = fs.readFileSync(path.join(inlineOut, 'index.html'), 'utf8');
  const inlinePayload = readPayloadFromHtml(inlineHtml);
  assert.equal(inlinePayload.assetMode, 'inline');
  for (const item of inlinePayload.evidence) {
    assert.ok(item.dataUri.startsWith('data:image/png;base64,'));
    assert.deepEqual(Buffer.from(item.dataUri.split(',')[1], 'base64'), PNG_1PX);
  }
});

test('external 模式单页超过 4MiB 时拒绝构建', (t) => {
  const dir = tmpDir(t);
  const big = path.join(dir, 'big.txt');
  fs.writeFileSync(big, 'x'.repeat(4 * 1024 * 1024 + 64 * 1024));
  const data = makeData({
    evidence: [{ id: 'big', title: '大文本证据', type: 'text', file: 'big.txt' }],
    cases: [{
      id: 'C1', groupId: 'g1', title: '大页面', objective: '限制校验', status: 'not_run',
      steps: [dataStep('s1', { evidenceIds: ['big'] })], checks: [],
    }],
  });
  fs.writeFileSync(path.join(dir, 'acceptance.json'), JSON.stringify(data));
  const out = path.join(tmpDir(t), 'too-large');
  const result = runCli(['build', path.join(dir, 'acceptance.json'), '--out', out, '--asset-mode', 'external', '--json']);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((item) => item.code === 'E_PAGE_TOO_LARGE'), JSON.stringify(report.errors));
  assert.ok(!fs.existsSync(out), '失败不留下验收包');
});

/* ---------- 视图解析与渲染 ---------- */

function writeViewerRoot(t, name) {
  const root = tmpDir(t);
  const dir = path.join(root, 'assets', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'template.html'), [
    '<!DOCTYPE html><html><head>',
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'nonce-{{NONCE}}\'; style-src \'nonce-{{NONCE}}\'; img-src data:; font-src data:">',
    '<title>{{PAGE_TITLE}}</title><style nonce="{{NONCE}}">/*test*/</style></head>',
    '<body><header id="studio-marker">{{REPORT_TITLE}}</header>',
    '<!--INLINE_CSS--><!--INLINE_DATA--><!--INLINE_RRWEB--><!--INLINE_APP_JS--></body></html>',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'app.css'), 'body{color:#111}');
  fs.writeFileSync(path.join(dir, 'app.js'), 'globalThis.__studio_loaded = true;');
  fs.writeFileSync(path.join(dir, 'code-view.js'), 'globalThis.__code_view_loaded = true;');
  /* 代码阅读 vendor 与 studio 同级：缺任一都视为视图资源不完整。 */
  const codeViewVendor = path.join(root, 'assets', 'vendor', 'code-view');
  fs.mkdirSync(codeViewVendor, { recursive: true });
  fs.writeFileSync(path.join(codeViewVendor, 'sql-formatter.mysql.min.js'), 'globalThis.sqlFormatter={format:null};');
  fs.writeFileSync(path.join(codeViewVendor, 'highlight-sql-json-http-java.min.js'), 'globalThis.hljs={};');
  return root;
}

function minimalPayload(assetMode = 'inline') {
  return {
    schemaVersion: 1,
    assetMode,
    report: { id: 'r1', title: '渲染测试', environment: '本地', example: true },
    groups: [],
    cases: [],
    recordings: [],
    evidence: [],
  };
}

test('视图只解析 studio，缺 studio 时明确失败且不回退旧 shell', (t) => {
  const studioRoot = writeViewerRoot(t, 'studio');
  const studio = resolveViewer({ root: studioRoot });
  assert.equal(studio.id, 'studio');
  assert.equal(studio.legacy, false);
  assert.deepEqual(studio.warnings, []);

  const legacyRoot = writeViewerRoot(t, 'shell');
  fs.writeFileSync(path.join(legacyRoot, 'assets', 'shell', 'case-filter.js'), '/*filter*/');
  const vendorDir = path.join(legacyRoot, 'assets', 'vendor');
  fs.mkdirSync(vendorDir, { recursive: true });
  fs.writeFileSync(path.join(vendorDir, 'app.css'), 'body{}');
  assert.throws(
    () => resolveViewer({ root: legacyRoot }),
    (error) => error instanceof BuildError && error.code === 'E_VIEWER_ASSETS_MISSING' && /不回退旧 shell/.test(error.message),
    '旧 shell 完整也不作为自动回退路径'
  );

  const partialRoot = writeViewerRoot(t, 'studio');
  fs.unlinkSync(path.join(partialRoot, 'assets', 'studio', 'app.js'));
  assert.throws(
    () => resolveViewer({ root: partialRoot }),
    (error) => error instanceof BuildError && error.code === 'E_VIEWER_ASSETS_MISSING' && /app\.js/.test(error.message),
    '缺少任一 studio 文件都失败并指出缺失项'
  );

  const emptyRoot = tmpDir(t);
  assert.throws(() => resolveViewer({ root: emptyRoot }), (error) => error instanceof BuildError && error.code === 'E_VIEWER_ASSETS_MISSING');
});

test('studio 缺失时 build 失败且不生成验收包', (t) => {
  const skillRoot = tmpDir(t);
  fs.cpSync(path.join(ROOT, 'scripts'), path.join(skillRoot, 'scripts'), { recursive: true });
  const { file } = writeData(t, makeData());
  const out = path.join(tmpDir(t), 'no-studio');
  const result = spawnSync(process.execPath, [path.join(skillRoot, 'scripts', 'acceptance.mjs'), 'build', file, '--out', out, '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 1, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.stage, 'assets');
  assert.ok(report.errors.some((item) => item.code === 'E_VIEWER_ASSETS_MISSING'), JSON.stringify(report.errors));
  assert.ok(!fs.existsSync(out), '失败不生成旧视图或半成品');
});

test('studio 模板渲染：nonce、唯一数据入口、无 CDN、external 放行同源图片', () => {
  const viewer = {
    id: 'studio',
    legacy: false,
    templateText: [
      '<!DOCTYPE html><html><head>',
      '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'nonce-{{NONCE}}\'; style-src \'nonce-{{NONCE}}\'; img-src data:; font-src data:">',
      '<title>{{PAGE_TITLE}}</title></head>',
      '<body data-report="{{REPORT_TITLE}}"><div id="studio-marker"></div>',
      '<!--INLINE_CSS--><!--INLINE_DATA--><!--INLINE_RRWEB--><!--INLINE_APP_JS--></body></html>',
    ].join('\n'),
    css: 'body{color:#111}',
    appJs: 'globalThis.__studio_loaded = true;',
  };
  const nonce = createNonce();
  const inlineHtml = renderIndexHtml({ templateText: viewer.templateText, payload: minimalPayload('inline'), nonce, viewer });
  assert.ok(inlineHtml.includes(`nonce="${nonce}"`));
  assert.ok(inlineHtml.includes('id="studio-marker"'));
  assert.equal((inlineHtml.match(/id="acceptance-data"/g) || []).length, 1);
  assert.ok(!/<iframe\b/i.test(inlineHtml));
  assert.ok(!/https?:\/\/(?!www\.w3\.org)/.test(inlineHtml.replace(/<script[\s\S]*?<\/script>/gi, '')), '标记与样式无远程资源');
  assert.equal(readPayloadFromHtml(inlineHtml).report.title, '渲染测试');

  const externalHtml = renderIndexHtml({ templateText: viewer.templateText, payload: minimalPayload('external'), nonce, viewer });
  assert.match(externalHtml, /img-src[^;]*'self'/, '外置模式自动放行同源相对路径');

  const privateViewer = Object.assign({}, viewer, { appJs: 'window.V3_DATA = {};' });
  assert.throws(() => renderIndexHtml({ templateText: viewer.templateText, payload: minimalPayload(), nonce, viewer: privateViewer }),
    (error) => error instanceof BuildError && error.code === 'E_PRIVATE_BINDING');

  const framed = Object.assign({}, viewer, { templateText: viewer.templateText.replace('<body', '<iframe></iframe><body') });
  assert.throws(() => renderIndexHtml({ templateText: framed.templateText, payload: minimalPayload(), nonce, viewer: framed }),
    (error) => error instanceof BuildError && error.code === 'E_NESTED_FRAME');

  const moduleViewer = Object.assign({}, viewer, { appJs: 'export default function init() {}' });
  assert.throws(() => renderIndexHtml({ templateText: viewer.templateText, payload: minimalPayload(), nonce, viewer: moduleViewer }),
    (error) => error instanceof BuildError && error.code === 'E_VIEWER_SCRIPT_FORMAT');
});

test('CLI 拒绝非法 --asset-mode', (t) => {
  const { file } = writeData(t, makeData());
  const result = runCli(['build', file, '--out', path.join(tmpDir(t), 'bad'), '--asset-mode', 'zip', '--json']);
  assert.equal(result.status, 2);
});

/* ---------- 代码阅读内联 ---------- */

test('构建把代码阅读 vendor 按 nonce 内联：顺序正确、唯一数据入口、页面仍小于 4MiB', (t) => {
  const sql = 'select e.id, case when e.state = 1 then \'新建\' else \'其他\' end as s from t_exception_order e '
    + 'where e.id in (1, 2) and e.name like \'王%\'';
  const data = withStep({
    verification: verification({ statement: { kind: 'sql', text: sql, origin: 'executed', explanation: '只读查询原文' } }),
  });
  const { result, out, payload } = build(t, data);
  assert.equal(result.status, 0, result.stderr || result.stdout.slice(0, 2000));
  const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
  const nonce = (html.match(/script-src 'nonce-([0-9a-f]+)'/) || [])[1];
  assert.ok(nonce, 'CSP 必须声明本次 nonce');

  const order = [
    'globalThis.sqlFormatter',
    'globalThis.hljs',
    'globalThis.AcceptanceCodeView',
    'window.StudioViewer',
  ].map((marker) => {
    const at = html.indexOf(marker);
    assert.notEqual(at, -1, '缺少内联标记：' + marker);
    return at;
  });
  assert.deepEqual([...order].sort((a, b) => a - b), order, '内联顺序必须是 vendor → code-view → 视图脚本');

  const scriptTags = html.match(/<script(?![^>]*type="application\/json")[^>]*>/g) || [];
  scriptTags.forEach((tag) => assert.ok(tag.includes(`nonce="${nonce}"`), '内联脚本都必须带本次 nonce：' + tag));
  assert.equal((html.match(/id="acceptance-data"/g) || []).length, 1, '数据入口仍然唯一');
  assert.ok(!/<link\b/i.test(html) && !/@import\s/i.test(html), '不引入远程样式');
  assert.ok(!/\beval\s*\(|new Function\s*\(/.test(html), '内联代码不得执行动态代码');

  const notices = fs.readFileSync(path.join(out, 'THIRD-PARTY-NOTICES.txt'), 'utf8');
  assert.ok(notices.includes('sql-formatter 15.9.0 (MIT)'));
  assert.ok(notices.includes('highlight.js 11.12.0 (BSD-3-Clause)'));

  const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
  assert.equal(manifest.assets.codeView.sqlFormatter.version, '15.9.0');
  assert.equal(manifest.assets.codeView.highlighter.license, 'BSD-3-Clause');
  assert.match(manifest.assets.codeView.sqlFormatter.sha256, /^[0-9a-f]{64}$/);

  assert.ok(Buffer.byteLength(html) < 4 * 1024 * 1024, '单页仍需小于 4MiB');
  assert.equal(payload.cases[0].steps[0].verification.statement.text, sql, '载荷里的原文不得被格式化改写');
});

/* ---------- 真实 40 条已分类数据 ---------- */

test('真实 40 条 classified 数据通过 validate', (t) => {
  if (!fs.existsSync(REAL_DATA)) {
    t.skip(`缺少真实数据：${REAL_DATA}`);
    return;
  }
  const result = runCli(['validate', REAL_DATA, '--json']);
  assert.equal(result.status, 0, result.stderr || result.stdout.slice(0, 2000));
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.stats.cases, 40);
  assert.equal(report.stats.evidence, JSON.parse(fs.readFileSync(REAL_DATA, 'utf8')).evidence.length);
  assert.equal(report.errors.length, 0);
});

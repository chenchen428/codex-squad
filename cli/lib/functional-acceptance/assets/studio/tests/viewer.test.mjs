import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const V = require('../app.js');
const HERE = path.dirname(fileURLToPath(import.meta.url));

const REAL_DATA = process.env.ACCEPTANCE_TEST_DATA || '';
const projectTest = fs.existsSync(REAL_DATA) ? test : test.skip;

const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/* 原始稿里的模拟文案/金额/连接状态不得进入产物；这里列出验收合同禁止出现的串。 */
const BANNED_FACTS = ['DMS_READONLY', '全局只读审计保护', '38已验证', 'SUCCESS820元', '2462.69',
  'CLM-PAY99201', '确认步骤无误', '24ms'];

let realCache = null;
function real() {
  if (!realCache) {
    assert.ok(fs.existsSync(REAL_DATA), '缺少标准载荷：' + REAL_DATA);
    const data = JSON.parse(fs.readFileSync(REAL_DATA, 'utf8'));
    realCache = { data, model: V.buildModel(data) };
  }
  return realCache;
}

/* 生成器会把证据文件原文注入 content；这里按同样规则补齐，用于验证真实结果表。 */
let hydratedCache = null;
function realWithEvidenceContent() {
  if (!hydratedCache) {
    const data = JSON.parse(fs.readFileSync(REAL_DATA, 'utf8'));
    const dataDir = path.dirname(REAL_DATA);
    data.evidence.forEach((ev) => {
      if (!ev.file || ev.type === 'image') return;
      const text = fs.readFileSync(path.join(dataDir, ev.file), 'utf8');
      ev.content = ev.type === 'json' ? JSON.stringify(JSON.parse(text), null, 2) : text;
    });
    hydratedCache = { data, model: V.buildModel(data) };
  }
  return hydratedCache;
}

function stepsOf(model) {
  const out = [];
  model.cases.forEach((c) => c.steps.forEach((s) => out.push({ c, s })));
  return out;
}

function fixture() {
  return {
    schemaVersion: 1,
    report: {
      id: 'fixture-report',
      title: '理赔新增提现户 · 验证报告',
      environment: '项目预发',
      revision: 'abc123 / def456',
      executedAt: '2026-10-30T10:00:00+08:00',
      example: false,
    },
    groups: [
      { id: 'g-f02', title: 'F-02 商家选户与确认', displayTitle: '商家选择收款账户', requirement: 'F-02' },
      { id: 'g-execution-audit', title: '测试执行审计（与产品用例分开）', displayTitle: '测试执行审计（与产品用例分开）' },
    ],
    evidence: [
      { id: 'img-page', title: '商家页截图', type: 'image', category: 'data', source: 'fixture', file: 'root-evidence/page.png', dataUri: PNG_1PX },
      { id: 'ev-text', title: '请求与响应记录', type: 'text', category: 'data', source: 'fixture', file: 'root-evidence/request.txt', content: '<img src=x onerror=alert(1)> 期望原文' },
      { id: 'ev-json', title: '数据库前后快照', type: 'json', category: 'data', source: 'fixture', content: { claim: 0, payment: 0 } },
      {
        id: 'ev-rows', title: '当前执行打款汇总', type: 'json', category: 'data', source: 'fixture',
        content: {
          columns: ['状态', '金额'],
          rows: [{ '状态': '打款中', '金额': '100.00 CNY' }, { '状态': '已打款', '金额': '0.00 CNY' }],
        },
      },
      {
        id: 'ev-nested', title: '包裹在 payload 里的结果', type: 'json', category: 'data', source: 'fixture',
        content: { payload: { columns: ['工单号', '状态'], rows: [['CLM-1', '待确认']] } },
      },
    ],
    cases: [
      {
        id: 'PRE-ALIPAY-LIMIT-01',
        groupId: 'g-f02',
        title: '后端拒绝支付宝超额请求，未生成理赔或付款',
        displayTitle: '支付宝超额请求会被拒绝',
        requirement: 'F-02',
        objective: '验证后端金额上限保护。',
        status: 'passed',
        caseRole: 'new',
        caseRoleReason: '本轮新增提现户场景的金额上限保护。',
        caseRoleSources: ['specs/商家确认.spec.json#alipay-limit'],
        preconditions: ['测试商家 100001'],
        checks: [
          { id: 'chk-1', title: '拒绝后不产生理赔', stepId: 'db-before', expected: '理赔数量不变', actual: '理赔 0→0', status: 'passed', evidenceIds: ['ev-json'] },
        ],
        steps: [
          {
            id: 'db-before',
            type: 'data',
            title: '核对调用前状态',
            action: '只读核对理赔与付款数量',
            expected: '未生成理赔或付款',
            actual: '理赔 0、付款 0',
            status: 'passed',
            evidenceIds: ['ev-json', 'ev-rows', 'ev-nested'],
            verification: {
              question: '超额确认会不会已经写出理赔？',
              method: '只读查询理赔与付款数量',
              focus: [{ label: '调用前无副作用', reason: '避免拒绝后残留单据', actual: '理赔 0、付款 0', evidenceIds: ['ev-json'] }],
              comparison: [
                { label: '理赔笔数', expected: '0', actual: '0', status: 'blocked', evidenceIds: ['ev-json'] },
              ],
              resultSets: [
                { evidenceId: 'ev-nested', label: '包裹层结果', jsonPointer: '/payload' },
              ],
              statement: {
                kind: 'sql',
                text: 'SELECT count(*) FROM claim WHERE merchant_id = 100001',
                origin: 'executed',
                explanation: '只读查询原样留存。',
                parameters: [{ name: 'merchant_id', value: '100001', reason: '仅限目标测试商家' }],
              },
              conclusion: '调用前无理赔与付款。',
              limitations: ['仅覆盖人民币场景。'],
            },
            reproduction: {
              kind: 'db',
              label: 'dms sql run',
              url: null,
              urlStatus: 'unavailable',
              reason: 'DMS deep link missing; CLI verified',
              params: '{"database":"ot_logistics_sharding_phys_cn/cn-0000"}',
              instructions: '打开 DMS，执行只读 SQL。',
              constraints: ['只读 SELECT'],
              sourceIds: ['ev-json'],
            },
          },
          {
            id: 'limit-page',
            type: 'page',
            title: '在商家页查看超额方案',
            page: '物流订单详情 / 赔付异常 / 超额方案',
            action: '打开原测试方案页面',
            expected: '仍显示 500000 元待确认',
            actual: '页面仍待确认',
            status: 'passed',
            evidenceIds: ['img-page', 'ev-text'],
            pageView: {
              title: '拒绝后的既有测试方案',
              caption: '物流订单详情 / 赔付异常 / 超额方案',
              url: 'https://pre-scm.test.internal/pages/detail?id=1',
              imageEvidenceId: 'img-page',
            },
            verification: {
              question: '页面是否会显示历史失败金额？',
              method: '独立汇总后与页面逐项比对',
              focus: [{ label: '仅计当前执行', reason: '防止历史失败金额重复累计', actual: '页面 100.00 元', evidenceIds: ['img-page'] }],
              comparison: [
                { label: '打款中金额', expected: '100.00 CNY', actual: '100.00 CNY', status: 'passed', evidenceIds: ['ev-text'] },
              ],
              statement: {
                kind: 'sql',
                text: 'SELECT status, sum(amount) FROM pay_order_record\nWHERE is_current_execution = 1 GROUP BY status;',
                origin: 'executed',
                explanation: '测试环境只读聚合脚本。',
                parameters: [
                  { name: 'is_current_execution = 1', value: '1', reason: '只取最新当前执行，剔除历史重试' },
                ],
              },
              conclusion: '页面与独立汇总一致。',
              limitations: ['没有外币样本。'],
            },
            reproduction: {
              kind: 'page',
              label: '商家确认页',
              url: 'https://pre-scm.test.internal/pages/detail?id=1',
              urlStatus: 'verified',
              reason: '入口来自本轮页面记录',
              params: '',
              instructions: '打开页面，按步骤查看超额方案。',
              constraints: ['只读回看，不点击确认'],
              sourceIds: ['img-page'],
            },
          },
          {
            id: 'reject',
            type: 'api',
            title: '提交超额确认请求',
            action: '提交一次 confirm 请求',
            expected: '返回金额超限',
            actual: 'resultCode -9',
            status: 'passed',
            evidenceIds: ['ev-text'],
            verification: {
              question: '拒绝原因是否确为金额超限？',
              method: '查看接口返回码与文案',
              focus: [],
              comparison: [
                { label: '拒绝原因', expected: '金额超限', actual: 'resultCode -9', status: 'not_run', evidenceIds: ['ev-text'] },
              ],
              statement: {
                kind: 'http',
                text: '',
                origin: 'unavailable',
                explanation: '未在当前步骤材料中留存请求原文。',
                parameters: [],
              },
              conclusion: '',
              limitations: [],
            },
          },
        ],
      },
      {
        id: 'PRE-REG-01',
        groupId: 'g-f02',
        title: '退款统计仅计当前执行',
        displayTitle: '退款统计口径回归',
        requirement: 'F-09',
        objective: '回归统计口径。',
        status: 'failed',
        caseRole: 'regression',
        caseRoleReason: '保护既有统计口径。',
        caseRoleSources: ['specs/退款统计.spec.json#current-execution'],
        preconditions: [],
        checks: [
          { id: 'chk-2', title: '统计与页面一致', stepId: 'stats', expected: '19 笔', actual: '20 笔', status: 'failed', evidenceIds: ['ev-json'] },
        ],
        steps: [
          {
            id: 'stats',
            type: 'data',
            title: '独立汇总退款统计',
            action: '按当前执行口径汇总',
            expected: '19 笔',
            actual: '20 笔',
            status: 'failed',
            evidenceIds: ['ev-json'],
            reproduction: {
              kind: 'db',
              label: 'dms sql run',
              url: 'https://dms.test.internal/console',
              urlStatus: 'verified',
              reason: '入口来自复现清单',
              params: 'SELECT count(*) FROM refund WHERE is_current_execution = 1;',
              instructions: '在 DMS 执行只读 SQL。',
              constraints: [],
              sourceIds: ['ev-json'],
            },
          },
        ],
      },
      {
        id: 'PRE-AUDIT-01',
        groupId: 'g-execution-audit',
        title: '执行审计：本地脚本失败',
        displayTitle: '执行审计本地脚本失败',
        requirement: '仅测试数据',
        objective: '记录执行审计结果。',
        status: 'failed',
        caseRole: 'audit',
        caseRoleReason: '测试执行审计记录，与产品用例分开。',
        caseRoleSources: ['root-recon/step-repro-presentation-current.py'],
        preconditions: [],
        checks: [],
        steps: [
          {
            id: 'audit-run',
            type: 'data',
            title: '执行审计脚本',
            action: '运行只读审计脚本',
            expected: '退出码 0',
            actual: '退出码 1',
            status: 'failed',
            evidenceIds: [],
          },
        ],
      },
    ],
  };
}

/* ---------- 标准载荷：规模与分类口径 ---------- */
projectTest('真实标准 payload：40 例 / 186 证据 / 146 步，业务与审计分开统计', () => {
  const { data, model } = real();
  assert.equal(model.cases.length, 40);
  assert.equal(data.evidence.length, 186);
  assert.equal(data.evidence.filter((ev) => ev.id.startsWith('ued-')).length, 5, 'UED 设计证据 5 条');
  assert.equal(model.groups.length, 7);
  assert.equal(stepsOf(model).length, 146);

  const counts = V.computeCounts(model, V.defaultFilters());
  assert.deepEqual(counts.totals, { all: 40, business: 39, audit: 1 });
  assert.equal(counts.role.new, 24);
  assert.equal(counts.role.regression, 13);
  assert.equal(counts.role.mixed, 2);
  assert.equal(counts.role.audit, 1);
  assert.equal(counts.role.unknown, 0);
  assert.equal(counts.status.failed, 0, '业务失败不统计审计记录');
  assert.equal(counts.status.passed, 34);
  assert.equal(counts.status.blocked, 5);
  assert.equal(counts.auditStatus.failed, 1);
  assert.equal(counts.page.page, 28);
  assert.equal(counts.page.data, 12);

  const typeCount = { page: 0, data: 0, api: 0, message: 0 };
  stepsOf(model).forEach(({ s }) => { typeCount[s.type] = (typeCount[s.type] || 0) + 1; });
  assert.deepEqual(typeCount, { page: 57, data: 59, api: 23, message: 7 });
  assert.equal(model.cases.filter((c) => c.isAudit).length, 1);
});

projectTest('真实标准 payload：右栏连续渲染，全部步骤都有疑问、对照与折叠材料', () => {
  const { model } = real();
  const all = stepsOf(model);
  let withStatement = 0;
  let executed = 0;
  let unavailable = 0;
  let withComparison = 0;
  let comparisonItems = 0;
  const chunks = [];

  all.forEach(({ c, s }) => {
    const vm = V.buildVerification(s, c);
    if (vm.statement) {
      withStatement += 1;
      if (vm.statement.origin === 'executed') executed += 1;
      if (!vm.statement.text) unavailable += 1;
    }
    if (vm.comparison.length) {
      withComparison += 1;
      comparisonItems += vm.comparison.length;
    }

    const inspector = V.renderInspector(s, c, model);
    assert.ok(inspector.html.includes('业务疑问'), '缺少业务疑问：' + s.id);
    assert.ok(inspector.html.includes(vm.question), '业务疑问与输入不一致：' + s.id);
    assert.ok(inspector.html.includes('结论'), '缺少结论段：' + s.id);
    assert.ok(inspector.html.includes('ins-details'), '缺少折叠的原始记录：' + s.id);
    assert.ok(!/data-ins-tab=|inspector-tabs/.test(inspector.html), '右栏不应再有页签：' + s.id);

    const cards = (inspector.html.match(/class="cmp-card"/g) || []).length;
    assert.equal(cards, vm.comparison.length, '对照卡片数量与输入不一致：' + s.id);
    if (vm.comparison.length) {
      assert.ok(inspector.html.includes('预期 / 对照'));
      assert.ok(inspector.html.includes('实际结果'));
      assert.ok(inspector.status.text.includes('项通过'), '状态行应给出通过数量：' + s.id);
    }

    chunks.push(inspector.html);
  });

  assert.ok(withStatement > 0, '标准载荷应当包含查询/请求原文');
  assert.equal(executed, 17, '执行原文 17 条');
  assert.ok(unavailable > 0, '存在未留存原文的步骤');
  assert.equal(executed + unavailable + (all.length - withStatement), all.length);
  assert.ok(withComparison > 0);
  assert.ok(comparisonItems >= withComparison, '每个核对步骤至少比一项');

  const html = chunks.join('');
  BANNED_FACTS.forEach((token) => assert.ok(!html.includes(token), '出现虚构事实：' + token));
  assert.ok(!/原始状态|按文本展示/.test(html));
  assert.ok(!/outputs-local|\/Users\//.test(html));
});

projectTest('真实标准 payload：非页面步骤的中央核验台把语句与真实结果同屏', () => {
  const { model } = realWithEvidenceContent();
  const all = stepsOf(model);
  const pageSteps = all.filter(({ s }) => V.isPageStep(s));
  assert.equal(pageSteps.length, 57);

  let withImage = 0;
  pageSteps.forEach(({ c, s }) => {
    const image = V.resolveStepImage(s, model.evidenceById);
    const bar = V.renderStageBar(s, c, model);
    if (image.src) {
      withImage += 1;
      assert.ok(bar.includes('系统截图'));
      assert.ok(bar.includes('data-fit'));
      assert.ok(bar.includes('data-original'));
      assert.ok(bar.includes('data-fullscreen'));
      assert.ok(bar.includes('data-zoom="in"'));
      assert.ok(bar.includes('id="zoom-label"'));
      assert.ok(!bar.includes('data-console'), '有截图时不渲染核验台切换');
    } else {
      assert.ok(bar.includes('步骤验证'), '缺图页面步骤应落到核验台：' + s.id);
    }
  });
  assert.ok(withImage > 0, '页面步骤应当能解析出截图');

  const nonPage = all.filter(({ s }) => !V.isPageStep(s));
  let withResultSets = 0;
  nonPage.forEach(({ c, s }) => {
    const bar = V.renderStageBar(s, c, model);
    assert.ok(bar.includes('步骤验证'), '非页面步骤应走核验台：' + s.id);
    assert.ok(!bar.includes('data-fit'));
    const html = V.renderConsole(s, c, model, V.SPLIT.initial);
    assert.ok(!/data-stage-tab=|data-ins-tab=/.test(html), '核验台不再有资料页签：' + s.id);
    assert.ok(html.includes('data-console-pane="statement"'), '缺少语句区：' + s.id);
    assert.ok(html.includes('data-console-pane="result"'), '缺少结果区：' + s.id);
    assert.ok(html.includes('data-split-gutter'), '缺少可拖动的分隔条：' + s.id);
    assert.ok(html.includes('role="separator"'), '分隔条缺少语义角色：' + s.id);
    assert.ok(html.includes('tabindex="0"'), '分隔条必须可键盘聚焦：' + s.id);
    const stage = V.buildStageModel(s, c, model);
    if (stage.resultSets.length) {
      withResultSets += 1;
      assert.ok(html.includes('result-table'), '有结果集却未渲染表格：' + s.id);
      stage.resultSets.forEach((set) => {
        assert.ok(html.includes('data-result-evidence="' + set.evidenceId + '"'), '结果表未标注来源证据：' + s.id);
        assert.ok(set.rows.length > 0 || stage.statement, '结果集应来自证据原文：' + s.id);
      });
    }
  });
  assert.ok(withResultSets > 0, '标准载荷里应有可直接展示的真实结果集');

  // 默认步骤必须是「第一个能展示截图的页面步骤」，索引随数据变化，不写死。
  const imageCase = model.cases.find((c) => c.steps.some((s) => V.isPageStep(s) && V.resolveStepImage(s, model.evidenceById).src));
  const expectedIndex = imageCase.steps.findIndex((s) => V.isPageStep(s) && V.resolveStepImage(s, model.evidenceById).src);
  assert.equal(V.defaultStepIndex(imageCase, model.evidenceById), expectedIndex);
});

projectTest('真实标准 payload：未留存原文的步骤不渲染替代查询', () => {
  const { model } = real();
  const missing = stepsOf(model).filter(({ c, s }) => {
    const vm = V.buildVerification(s, c);
    return vm.statement && !vm.statement.text;
  });
  assert.equal(missing.length, 72);

  missing.forEach(({ c, s }) => {
    const html = V.renderConsole(s, c, model, V.SPLIT.initial);
    assert.ok(html.includes('原文未留存') || html.includes('未留存查询或请求原文'), '未标注原文缺失：' + s.id);
    const statementPane = html.slice(html.indexOf('data-console-pane="statement"'), html.indexOf('data-console-pane="result"'));
    assert.ok(!/SELECT |INSERT |UPDATE |DELETE /i.test(statementPane), '未留存原文却出现了查询语句：' + s.id);
    const inspector = V.renderInspector(s, c, model);
    assert.ok(!inspector.html.includes('data-copy-key="stage-statement"'), '无原文不应提供复制按钮');
    assert.ok(!inspector.html.includes('data-copy-key="ins-statement"'), '无原文不应提供复制按钮');
  });

  assert.equal(V.statementCopyText({ text: '', origin: 'unavailable' }), '');
});

projectTest('真实标准 payload：列表只展示业务标题，内部 ID 仅用于搜索', () => {
  const { model } = real();
  const html = V.renderCaseGroups(model, V.defaultFilters(), model.cases[0].id);
  assert.ok(html.includes(model.cases[0].navTitle));
  assert.ok(html.includes('测试执行审计（与产品用例分开）'));
  model.cases.forEach((c) => assert.ok(!html.includes(c.id), '导航出现了内部 ID：' + c.id));
  assert.ok(!/data-case="/.test(html), '选择关联应使用索引而不是 ID');
  assert.ok(!/outputs-local|\/Users\/|material-symbols/.test(html));

  const target = model.cases[3];
  const hits = V.filterCases(model, { ...V.defaultFilters(), query: target.id.toLowerCase() });
  assert.ok(hits.some((c) => c.id === target.id));
});

/* ---------- 语义导航与筛选用例 ---------- */
test('语义导航只展示业务标题，不泄露内部 ID 与过程提示', () => {
  const model = V.buildModel(fixture());
  const html = V.renderCaseGroups(model, V.defaultFilters(), model.cases[0].id);
  assert.ok(html.includes('支付宝超额请求会被拒绝'));
  assert.ok(html.includes('商家选择收款账户'));
  assert.ok(!/PRE-|F-0|CASE-/.test(html), '导航空文本不应出现内部 ID');
  assert.ok(!/补拍|原执行未替换|本地只读|真实证据只读|不重绘|数据库连接正常/.test(html));
  assert.ok(!/data-case="/.test(html), '选择关联用索引而不是把 ID 写进 DOM');
});

test('搜索仍可命中内部 ID（ID 只用于搜索与详情）', () => {
  const model = V.buildModel(fixture());
  const hits = V.filterCases(model, { ...V.defaultFilters(), query: 'pre-audit-01' });
  assert.deepEqual(hits.map((c) => c.id), ['PRE-AUDIT-01']);
});

test('默认步骤优先选择带真实截图的步骤', () => {
  const model = V.buildModel(fixture());
  assert.equal(V.defaultStepIndex(model.cases[0], model.evidenceById), 1);
  assert.equal(V.defaultStepIndex(model.cases[1], model.evidenceById), 0);
});

/* ---------- 右栏连续检视流 ---------- */
test('右栏连续阅读：疑问 → 关注点 → 条件 → 对照 → 结论 → 边界，没有页签', () => {
  const model = V.buildModel(fixture());
  const c = model.cases[0];
  const step = c.steps[1];

  const out = V.renderInspector(step, c, model);
  assert.ok(!/data-ins-tab=|inspector-tabs/.test(out.html), '右栏不应再渲染页签');
  assert.ok(out.html.includes('业务疑问'));
  assert.ok(out.html.includes('页面是否会显示历史失败金额？'));
  assert.ok(out.html.includes('为什么这样查'));
  assert.ok(out.html.includes('核心关注点（1）'));
  assert.ok(out.html.includes('为何关注：防止历史失败金额重复累计'));
  assert.ok(out.html.includes('关键条件与设置理由'));
  assert.ok(out.html.includes('is_current_execution = 1'));
  assert.ok(out.html.includes('预期 / 对照'));
  assert.ok(out.html.includes('实际结果'));
  assert.ok(out.html.includes('1 / 1 项通过'));
  assert.ok(out.html.includes('100.00 CNY'));
  assert.ok(out.html.includes('结论'));
  assert.ok(out.html.includes('页面与独立汇总一致。'));
  assert.ok(out.html.includes('结论边界'));
  assert.ok(out.html.includes('没有外币样本。'));
  assert.ok(out.html.includes('ins-details'), '原始记录应折叠在底部');
  assert.ok(out.html.includes('复现入口'));
  assert.ok(out.html.includes('已核验 https 入口'));
  assert.equal(out.status.key, 'passed');
  assert.ok(out.status.text.includes('1 / 1 项通过'));

  // 顺序必须稳定：疑问在关注点之前，结论在对照之后。
  const order = ['业务疑问', '核心关注点', '逐项预期与实际对照', '结论边界'];
  const positions = order.map((token) => out.html.indexOf(token));
  positions.forEach((pos, i) => assert.ok(pos >= 0, '缺少段落：' + order[i]));
  assert.deepEqual(positions.slice().sort((a, b) => a - b), positions, '段落顺序发生变化');

  const blockedCase = V.renderInspector(model.cases[0].steps[0], model.cases[0], model);
  assert.equal(blockedCase.status.key, 'blocked');
  assert.ok(blockedCase.status.text.includes('1 项受阻'));
});

test('对照卡片分侧展示并支持输入覆盖来源；中央核验台同屏展示语句与真实结果', () => {
  const payload = fixture();
  const model = V.buildModel(payload);
  const dataStep = model.cases[0].steps[0];

  payload.cases[0].steps[1].verification.comparison[0].expectedSource = '页面确认弹窗';
  payload.cases[0].steps[1].verification.comparison[0].actualSource = 'DMS 只读查询';
  const changed = V.buildModel(payload);
  const out = V.renderInspector(changed.cases[0].steps[1], changed.cases[0], changed);
  assert.ok(out.html.includes('来源：页面确认弹窗'));
  assert.ok(out.html.includes('来源：DMS 只读查询'));

  const console = V.renderConsole(dataStep, model.cases[0], model, V.SPLIT.initial);
  assert.ok(console.includes('查询语句'));
  assert.ok(console.includes('SELECT count(*) FROM claim WHERE merchant_id = 100001'));
  assert.ok(console.includes('查询结果'));
  assert.ok(console.includes('result-table'));
  assert.ok(console.includes('打款中'));
  assert.ok(console.includes('100.00 CNY'));
  assert.ok(console.includes('包裹层结果'), '显式 resultSets 的语义标签应展示');
  assert.ok(console.includes('CLM-1'), 'jsonPointer 指向的结果应被读取');
  assert.ok(console.includes('data-result-evidence="ev-rows"'), '结果表必须标注来源证据');
  assert.ok(console.includes('data-result-evidence="ev-nested"'));
  const firstTable = console.indexOf('data-result-evidence="ev-rows"');
  const nestedTable = console.indexOf('data-result-evidence="ev-nested"');
  assert.ok(firstTable < nestedTable, '多组结果保持 evidenceIds 顺序，按内容而非 ID 特判');
  assert.ok(!console.includes('原始状态'));
});

test('比对表随输入数据变化，状态原样消费', () => {
  const payload = fixture();
  const model = V.buildModel(payload);
  const before = V.renderInspector(model.cases[0].steps[0], model.cases[0], model);
  assert.ok(before.html.includes('cmp-status blocked'));
  assert.ok(before.html.includes('理赔笔数'));

  payload.cases[0].steps[0].verification.comparison[0].actual = '3';
  payload.cases[0].steps[0].verification.comparison[0].status = 'failed';
  const changed = V.buildModel(payload);
  const after = V.renderInspector(changed.cases[0].steps[0], changed.cases[0], changed);
  assert.ok(after.html.includes('cmp-status failed'));
  assert.ok(after.html.includes('>3<'));
  assert.ok(!after.html.includes('cmp-status blocked'));
  assert.equal(after.status.key, 'failed');
});

test('缺少 verification 时用步骤记录与关联核对项生成摘要', () => {
  const model = V.buildModel(fixture());
  const c = model.cases[1];
  const step = c.steps[0];
  const vm = V.buildVerification(step, c);
  assert.equal(vm.provided, false);
  assert.equal(vm.fallback, true);
  assert.equal(vm.comparison.length, 1);
  assert.equal(vm.comparison[0].status, 'failed');
  assert.ok(vm.limitations[0].includes('未提供结构化验证说明'));

  const inspector = V.renderInspector(step, c, model);
  assert.ok(inspector.html.includes('步骤记录'));
  assert.ok(!inspector.html.includes('该步骤未提供结构化验证说明'));
  assert.ok(inspector.html.includes('本步骤要确认：19 笔'));
  assert.ok(inspector.html.includes('记录状态'));
  assert.ok(inspector.html.includes('19 笔'));
  assert.ok(inspector.html.includes('cmp-status failed'));
  const visible = inspector.html.split('<details')[0];
  assert.ok(!/SELECT |SUM\(/i.test(visible), '说明区不得生成替代查询');
  assert.ok(inspector.html.includes('refund WHERE'), '留存参数放在折叠的复现区');
  assert.equal(inspector.status.key, 'failed');

  assert.ok(V.renderConsole(step, c, model, V.SPLIT.initial).includes('数据库前后快照'));
});

test('状态标签原样映射，审计状态不伪装成产品失败', () => {
  assert.equal(V.statusLabel('passed'), '通过');
  assert.equal(V.statusLabel('failed'), '失败');
  assert.equal(V.statusLabel('failed', true), '审计执行失败');
  assert.equal(V.statusLabel('not_run', true), '审计待执行');

  const model = V.buildModel(fixture());
  const audit = model.cases[2];
  assert.equal(V.isAudit(audit), true);

  const bar = V.renderCaseBar(model, audit, model.report);
  assert.ok(bar.includes('审计执行失败'));
  assert.ok(bar.includes('执行审计记录 · 非产品用例'));
  assert.equal(V.renderCaseHeader, V.renderCaseBar);

  const counts = V.computeCounts(model, V.defaultFilters());
  assert.equal(counts.status.failed, 1, '业务失败只统计产品用例');
  assert.equal(counts.auditStatus.failed, 1, '审计状态单独统计');

  const businessModel = V.buildModel({ ...fixture(), cases: fixture().cases.filter(c => c.id !== 'PRE-REG-01') });
  const businessFilters = V.renderFilters(businessModel, V.defaultFilters());
  assert.ok(businessFilters.status.includes('失败 0'), '业务状态不含审计失败');
  const auditFilters = V.renderFilters(businessModel, { ...V.defaultFilters(), role: 'audit' });
  assert.ok(auditFilters.status.includes('失败 1'), '选中审计目的时展示审计状态');
  assert.ok(!/计数为其余筛选|混合只计一条|filter-note/.test(businessFilters.status + businessFilters.role + businessFilters.page));
});

test('状态/目的/类型/搜索为独立 AND 组合', () => {
  const model = V.buildModel(fixture());
  const base = V.defaultFilters();
  assert.deepEqual(V.filterCases(model, { ...base, status: 'failed' }).map((c) => c.id), ['PRE-REG-01']);
  assert.deepEqual(V.filterCases(model, { ...base, role: 'audit' }).map((c) => c.id), ['PRE-AUDIT-01']);
  assert.deepEqual(V.filterCases(model, { ...base, page: 'page' }).map((c) => c.id), ['PRE-ALIPAY-LIMIT-01']);
  assert.deepEqual(V.filterCases(model, { ...base, page: 'data', query: '退款' }).map((c) => c.id), ['PRE-REG-01']);
  assert.deepEqual(V.filterCases(model, { ...base, role: 'new', status: 'failed' }).map((c) => c.id), []);
  const counts = V.computeCounts(model, base);
  assert.equal(counts.totals.business, 2);
  assert.equal(counts.totals.audit, 1);
  assert.equal(counts.role.mixed, 0);
  assert.equal(counts.status.all, 2);
  assert.equal(counts.page.page, 1);
});

test('分类兼容标准化后的 raw.caseRole 与映射 role，筛选不再落到待分类', () => {
  assert.equal(V.caseRoleOf({ raw: { caseRole: 'new' } }), 'new');
  assert.equal(V.caseRoleOf({ raw: { caseRole: 'audit' } }), 'audit');
  assert.equal(V.caseRoleOf({ caseRole: 'mixed' }), 'mixed');
  assert.equal(V.caseRoleOf({ role: 'regression' }), 'regression');
  assert.equal(V.caseRoleOf({ raw: { caseRole: 'regression' }, role: 'regression' }), 'regression');

  const model = V.buildModel(fixture());
  assert.deepEqual(model.cases.map((c) => c.role), ['new', 'regression', 'audit']);
  assert.ok(model.cases.every((c) => c.raw && c.caseRole === c.role), '标准化后同时保留 raw 与映射 caseRole');

  const normalized = model.cases.map((c) => ({
    id: c.id, status: c.status, steps: c.steps, searchText: c.searchText,
    role: c.role, isAudit: c.isAudit, raw: c.raw,
  }));
  const counts = V.computeCounts({ cases: normalized, evidenceById: model.evidenceById }, V.defaultFilters());
  assert.equal(counts.role.new, 1);
  assert.equal(counts.role.regression, 1);
  assert.equal(counts.role.audit, 1);
  assert.equal(counts.role.unknown, 0);

  const rawOnly = [{ raw: { caseRole: 'audit' }, status: 'failed', steps: [], searchText: '' }];
  assert.equal(V.filterCases({ cases: rawOnly, evidenceById: {} }, { ...V.defaultFilters(), role: 'audit' }).length, 1);
  assert.equal(V.computeCounts({ cases: rawOnly, evidenceById: {} }, V.defaultFilters()).role.unknown, 0);
});

/* ---------- 空集 ---------- */
test('空集：筛选无匹配时给出诚实提示且不再渲染步骤', () => {
  const model = V.buildModel(fixture());
  const empty = V.renderCaseGroups(model, { ...V.defaultFilters(), query: '完全不存在的关键词' }, '');
  assert.ok(empty.includes('当前筛选没有匹配的用例'));
  assert.ok(empty.includes('AND 组合'));

  const noStatus = V.renderCaseGroups(model, { ...V.defaultFilters(), status: 'blocked' }, '');
  assert.ok(noStatus.includes('当前筛选没有匹配的用例'));

  const realEmpty = V.renderCaseGroups(fs.existsSync(REAL_DATA) ? real().model : model, { ...V.defaultFilters(), query: 'zzz-no-such-case' }, '');
  assert.ok(realEmpty.includes('当前筛选没有匹配的用例'));

  const auditConsole = V.renderConsole(model.cases[2].steps[0], model.cases[2], model, V.SPLIT.initial);
  assert.ok(auditConsole.includes('该步骤未关联原始材料'));
  assert.ok(!auditConsole.includes('console-details'));
  assert.ok(V.renderInspector(model.cases[2].steps[0], model.cases[2], model)
    .html.includes('结论'));
});

/* ---------- 中央证据区 ---------- */
test('页面步骤渲染截图工具条，非页面步骤渲染上下同屏的核验台', () => {
  const model = V.buildModel(fixture());
  const c = model.cases[0];

  assert.equal(V.isPageStep(c.steps[1]), true);
  assert.equal(V.isPageStep(c.steps[0]), false);

  const pageBar = V.renderStageBar(c.steps[1], c, model);
  assert.ok(pageBar.includes('系统截图'));
  assert.ok(pageBar.includes('物流订单详情 / 赔付异常 / 超额方案'));
  assert.ok(pageBar.includes('data-zoom="out"'));
  assert.ok(pageBar.includes('data-zoom="in"'));
  assert.ok(pageBar.includes('data-fit'));
  assert.ok(pageBar.includes('data-original'));
  assert.ok(pageBar.includes('data-fullscreen'));
  assert.ok(pageBar.includes('data-toggle-inspector'));
  assert.ok(!pageBar.includes('data-stage-tab='));

  const dataBar = V.renderStageBar(c.steps[0], c, model);
  assert.ok(dataBar.includes('步骤验证'));
  assert.ok(dataBar.includes('真实结果 2 组'));
  assert.ok(dataBar.includes('data-toggle-inspector'));
  assert.ok(!dataBar.includes('data-stage-tab='));
  assert.ok(!dataBar.includes('data-ins-tab='));

  const apiBar = V.renderStageBar(c.steps[2], c, model);
  assert.ok(apiBar.includes('步骤验证'));
  assert.ok(apiBar.includes('请求 / 响应') || apiBar.includes('步骤材料'));

  const html = V.renderConsole(c.steps[0], c, model, V.SPLIT.initial);
  assert.ok(html.includes('--console-ratio:40%'), '默认比例应为 40/60');
  assert.ok(html.indexOf('data-console-pane="statement"') < html.indexOf('data-console-pane="result"'), '语句在上、结果在下');
  assert.equal((html.match(/data-split-gutter/g) || []).length, 1);
  assert.ok(html.includes('aria-valuemin="20"'));
  assert.ok(html.includes('aria-valuemax="80"'));
  assert.ok(html.includes('aria-valuenow="40"'));
});

test('分栏比例：拖动折算与键盘步进共用纯函数并受边界约束', () => {
  assert.equal(V.ratioFromPointer(100, 400, 260, 0.2, 0.8), 0.4);
  assert.equal(V.ratioFromPointer(100, 400, 60, 0.2, 0.8), 0.2, '向上越界钳制到最小值');
  assert.equal(V.ratioFromPointer(100, 400, 900, 0.2, 0.8), 0.8, '向下越界钳制到最大值');
  assert.equal(V.ratioFromPointer(100, 0, 100, 0.2, 0.8), 0.2, '高度为 0 时不产生 NaN');

  assert.equal(V.stepRatio(0.4, V.SPLIT.step, 0.2, 0.8), 0.44);
  assert.equal(V.stepRatio(0.4, -V.SPLIT.step, 0.2, 0.8), 0.36);
  assert.equal(V.stepRatio(0.2, -V.SPLIT.step, 0.2, 0.8), 0.2);
  assert.equal(V.stepRatio(0.8, V.SPLIT.step, 0.2, 0.8), 0.8);
  assert.equal(V.stepRatio(0.95, 0, 0.2, 0.8), 0.8, '异常输入也回到区间内');
  assert.deepEqual(V.SPLIT, { min: 0.2, max: 0.8, step: 0.04, initial: 0.4 });
});

test('结果表只按内容识别：columns+rows、单行 row、2-D 数组与包裹层', () => {
  const rows = {
    columns: ['状态', '金额'],
    rows: [{ '状态': '打款中', '金额': '100.00 CNY' }, ['已打款', '0.00 CNY']],
  };
  const table = V.jsonTable(V.readJsonTree(JSON.stringify(rows)), JSON.stringify(rows));
  assert.deepEqual(table.columns, ['状态', '金额']);
  assert.equal(table.rows.length, 2);
  assert.equal(table.rows[0][1].text, '100.00 CNY');
  assert.equal(table.rows[1][0].text, '已打款');

  const single = '{"row":{"单号":"CLM-1","状态":"待确认","备注":null,"缺失":null}}';
  const one = V.jsonTable(V.readJsonTree(single), single);
  assert.deepEqual(one.columns, ['单号', '状态', '备注', '缺失']);
  assert.deepEqual(one.rows[0].map((cell) => cell.kind), ['text', 'text', 'null', 'null']);

  assert.equal(V.jsonTable(V.readJsonTree('{"rows":3}'), '{"rows":3}'), null, 'rows 不是数组时不算结果集');
  assert.equal(V.jsonTable(V.readJsonTree('{"rows":[["a"]]}'), '{"rows":[["a"]]}'), null, '缺 columns 时不猜测列名');
  assert.equal(V.jsonTable(V.readJsonTree('{"metadata":{"a":1}}'), '{"metadata":{"a":1}}'), null);

  const src = '{"columns":["n"],"rows":[[9007199254740993],[1.000000],[1e3]]}';
  const big = V.jsonTable(V.readJsonTree(src), src);
  assert.deepEqual(big.rows.map((r) => r[0].text), ['9007199254740993', '1.000000', '1e3'], '原值不得被格式化改动');

  const missing = '{"columns":["a","b"],"rows":[{"a":""}]}';
  const partial = V.jsonTable(V.readJsonTree(missing), missing);
  assert.equal(partial.rows[0][0].kind, 'text');
  assert.equal(partial.rows[0][0].text, '');
  assert.equal(partial.rows[0][1].kind, 'missing');

  /* CLI 读库结果常用 columnNames + rowCount + rows；只有显式 resultSets 指向时才取这层。 */
  const payload = fixture();
  payload.evidence.push({
    id: 'ev-cli-result', title: '被排除的历史执行', type: 'json', category: 'data', source: 'fixture',
    content: { success: true, traceId: 't-1', results: [{ columnNames: ['historical_detail_id', 'payment_amount'], rowCount: 1, rows: [{ historical_detail_id: '27007', payment_amount: '0.060000' }] }] },
  });
  payload.cases[0].steps[0].evidenceIds = ['ev-cli-result'];
  payload.cases[0].steps[0].verification.resultSets = [{ evidenceId: 'ev-cli-result', label: '被排除的历史执行', jsonPointer: '/results/0' }];
  const shaped = V.buildModel(payload);
  const step = shaped.cases[0].steps[0];
  const sets = V.buildResultSets(step, shaped, V.buildVerification(step, shaped.cases[0]));
  assert.equal(sets.length, 1);
  assert.deepEqual(sets[0].columns, ['historical_detail_id', 'payment_amount']);
  assert.equal(sets[0].rows[0][1].text, '0.060000', '尾零原样保留');
  assert.equal(sets[0].copyKey, 'result-ev-cli-result-0');
});

test('接口响应只认业务响应字段，请求模板明确标注不是原始参数', () => {
  const payload = fixture();
  payload.evidence.push({
    id: 'ev-api', title: 'HSF 调用记录', type: 'api', category: 'data', source: 'fixture',
    content: { invoke_result: { code: 'SUCCESS', amount: '100.00' }, success: true, metadata: { traceId: 't-1' } },
  });
  payload.cases[0].steps[2].evidenceIds.push('ev-api');
  payload.cases[0].steps[2].reproduction = {
    kind: 'api', label: 'HSF 调用', url: null, urlStatus: 'unavailable', reason: '入口未核验',
    params: '{"orderId":"${orderId}"}', instructions: '', constraints: [], sourceIds: [],
  };
  const model = V.buildModel(payload);
  const step = model.cases[0].steps[2];

  const response = V.buildResponse(step, model);
  assert.equal(response.evidenceId, 'ev-api');
  assert.equal(response.pointer, '/invoke_result');
  const console = V.renderConsole(step, model.cases[0], model, V.SPLIT.initial);
  assert.ok(console.includes('实际响应'));
  assert.ok(console.includes('100.00'));
  assert.ok(console.includes('复制调用记录'));
  assert.ok(console.includes('参数模板'));
  assert.ok(console.includes('占位符模板，不是原始执行参数'));
  const paneStart = console.indexOf('data-console-pane="result"');
  const fieldsTable = console.slice(paneStart, console.indexOf('<details', paneStart));
  assert.ok(!fieldsTable.includes('traceId'), 'metadata 不应作为业务响应字段展示');
  assert.ok(console.includes('traceId'), '原始 metadata 只在折叠的原文里保留');

  const noResponse = V.buildResponse(model.cases[0].steps[1], model);
  assert.equal(noResponse, null, '页面步骤没有响应字段时不得凭空生成');
});

test('复现入口：未核验禁用并写原因，已核验才输出 https 链接', () => {
  const model = V.buildModel(fixture());
  const unavailable = V.renderRepro(model.cases[0].steps[0], model.cases[0], model);
  assert.ok(unavailable.includes('is-disabled'));
  assert.ok(unavailable.includes('入口未核验'));
  assert.ok(!/href="https?:/.test(unavailable));
  assert.ok(unavailable.includes('DMS deep link missing; CLI verified'));
  assert.ok(unavailable.includes('复制输入参数'));

  const verified = V.renderRepro(model.cases[0].steps[1], model.cases[0], model);
  assert.ok(/href="https:\/\/pre-scm\.test\.internal\//.test(verified));
  assert.ok(verified.includes('rel="noopener noreferrer"'));
  assert.ok(verified.includes('复制操作说明'), '页面类步骤复制操作说明而不是把响应当输入');
  assert.ok(!verified.includes('is-disabled'));

  assert.ok(V.renderRepro(model.cases[2].steps[0], model.cases[2], model).includes('该步骤未提供复现入口与参数'));
});

/* ---------- 复制 ---------- */
test('复制：按渲染键取原文，不依赖 DOM 文本，也不把说明当输入', () => {
  const model = V.buildModel(fixture());
  V.__setModel(model);
  assert.equal(V.copyTextByKey('repro-params'), '', '新渲染前复制表为空');
  assert.equal(V.copyTextByKey('missing-key'), '');

  const repro = V.renderRepro(model.cases[0].steps[0], model.cases[0], model);
  assert.equal(V.copyTextByKey('repro-params'), '{"database":"ot_logistics_sharding_phys_cn/cn-0000"}');

  const pageRepro = V.renderRepro(model.cases[0].steps[1], model.cases[0], model);
  assert.equal(V.copyTextByKey('repro-instructions'), '打开页面，按步骤查看超额方案。');
  assert.ok(pageRepro.includes('data-copy-key="repro-instructions"'));

  const consoleHtml = V.renderConsole(model.cases[0].steps[0], model.cases[0], model, V.SPLIT.initial);
  assert.equal(V.copyTextByKey('stage-statement'), 'SELECT count(*) FROM claim WHERE merchant_id = 100001');
  assert.ok(consoleHtml.includes('data-copy-key="stage-statement"'));
  assert.ok(V.copyTextByKey('result-ev-rows').includes('"打款中"'), '结果表复制的是证据原文');
  assert.ok(consoleHtml.includes('data-copy-key="result-ev-rows"'));
  assert.ok(V.copyTextByKey('result-ev-nested-0').includes('CLM-1'));

  const inspector = V.renderInspector(model.cases[0].steps[1], model.cases[0], model);
  assert.equal(V.copyTextByKey('ins-statement-params'), 'is_current_execution = 1：1');
  assert.ok(V.copyTextByKey('ins-repro-instructions').length > 0);

  const keys = [...(repro + pageRepro + consoleHtml + inspector.html).matchAll(/data-copy-key="([^"]+)"/g)]
    .map((m) => m[1]);
  assert.ok(keys.length >= 4);
  keys.forEach((key) => assert.ok(V.copyTextByKey(key).length > 0, '复制键没有内容：' + key));

  assert.equal(V.reproCopyText({ params: '', instructions: '打开 DMS' }), '打开 DMS');
});

/* ---------- 证据与安全 ---------- */
test('原始证据按文本展示，不执行输入 HTML', () => {
  const model = V.buildModel(fixture());
  const html = V.renderEvidenceItems(['ev-text'], model.evidenceById);
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(!/<img src=x/i.test(html));
  assert.ok(html.includes('root-evidence/request.txt'));

  const json = V.renderEvidenceItems(['ev-json'], model.evidenceById);
  assert.ok(json.includes('查看原始内容'));
  assert.ok(json.includes('&quot;claim&quot;: 0'));

  assert.ok(V.renderEvidenceItems(['not-there'], model.evidenceById).includes('证据未随报告提供'));
});

test('截图来源只接受内联图片或报告内相对路径', () => {
  const model = V.buildModel(fixture());
  assert.ok(V.resolveStepImage(model.cases[0].steps[1], model.evidenceById).src.startsWith('data:image/png'));
  assert.equal(V.resolveStepImage(model.cases[0].steps[0], model.evidenceById).src, '');
  assert.equal(V.safeImgSrc('javascript:alert(1)'), '');
  assert.equal(V.safeImgSrc('https://evil.test/x.png'), '');
  assert.equal(V.safeImgSrc('../secret.png'), '');
  assert.equal(V.safeImgSrc('./images/hash.jpg'), './images/hash.jpg');
  assert.equal(V.safeImgSrc('./images/../secret.jpg'), '');
  assert.equal(V.safeImgSrc(PNG_1PX), PNG_1PX);
  assert.equal(V.safeHttpsUrl('http://plain.test/x'), '');
  assert.equal(V.safeHttpsUrl('javascript:alert(1)'), '');
});

/* ---------- 缩放/平移计算 ---------- */
test('缩放围绕鼠标点，平移有边界，适应/原图可复算', () => {
  assert.ok(V.wheelFactor(100, 0) < 1);
  assert.ok(V.wheelFactor(-100, 0) > 1);
  assert.equal(V.wheelFactor(0, 0), 1);
  assert.equal(V.wheelFactor(1, 1), V.wheelFactor(16, 0));

  const zoomed = V.zoomAt({ scale: 1, tx: 0, ty: 0 }, 2, 120, 80, 1000, 500, 1000, 500);
  assert.equal(zoomed.scale, 2);
  assert.ok(Math.abs((120 - zoomed.tx) / zoomed.scale - 120) < 1e-9);
  assert.ok(Math.abs((80 - zoomed.ty) / zoomed.scale - 80) < 1e-9);
  assert.equal(V.zoomAt({ scale: 4, tx: 0, ty: 0 }, 10, 0, 0, 1000, 500, 1000, 500).scale, 5);

  const centered = V.clampPan({ scale: 1, tx: -999, ty: 999 }, 100, 100, 800, 600);
  assert.equal(centered.tx, 350);
  assert.equal(centered.ty, 250);

  const bounded = V.clampPan({ scale: 4, tx: 999, ty: 999 }, 1000, 500, 800, 600);
  assert.equal(bounded.tx, 0);
  assert.equal(bounded.ty, 0);
  const bounded2 = V.clampPan({ scale: 4, tx: -99999, ty: -99999 }, 1000, 500, 800, 600);
  assert.equal(bounded2.tx, -3200);
  assert.equal(bounded2.ty, -1400);

  const fit = V.fitTo(1000, 500, 800, 600);
  assert.equal(fit.scale, 0.8);
  assert.equal(fit.tx, 0);
  assert.equal(fit.ty, 100);
  assert.equal(fit.mode, 'fit');

  const original = V.originalSize(1000, 500, 800, 600);
  assert.equal(original.scale, 1);
  assert.equal(original.tx, 0);
  assert.equal(original.ty, 50);
  assert.equal(original.mode, 'original');
});

/* ---------- 图标 ---------- */
test('图标改为内联 SVG，不依赖图标字体文本', () => {
  const svg = V.icon('fact_check');
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.includes('viewBox="0 0 24 24"'));
  assert.ok(!/>fact_check</.test(svg), '不应输出 ligature 英文名');

  const required = ['fact_check', 'help_outline', 'close', 'search', 'account_tree', 'image', 'fullscreen',
    'fullscreen_exit', 'description', 'content_copy', 'data_object', 'terminal', 'table_chart', 'task_alt',
    'grid_on', 'compare_arrows', 'psychology', 'aspect_ratio', 'dock_to_left', 'verified', 'open_in_new',
    'link_off', 'info', 'code', 'expand_more', 'arrow_forward', 'check', 'check_circle', 'error', 'block',
    'pending', 'schedule', 'dot', 'drag_handle', 'visibility', 'inventory_2'];
  required.forEach((name) => assert.ok(V.ICON_PATHS[name], '缺少图标：' + name));
  Object.keys(V.ICON_PATHS).forEach((name) => {
    assert.ok(/^<(path|circle|rect)/.test(V.ICON_PATHS[name]), '图标内容不是 SVG 图元：' + name);
  });

  const model = V.buildModel(fixture());
  const c = model.cases[0];
  const html = V.renderCaseGroups(model, V.defaultFilters(), c.id) +
    V.renderCaseBar(model, c, model.report) +
    V.renderSteps(c, 1) +
    V.renderStageBar(c.steps[1], c, model) +
    V.renderConsole(c.steps[0], c, model, V.SPLIT.initial) +
    V.renderInspector(c.steps[0], c, model).html +
    V.renderRepro(c.steps[0], c, model);
  assert.ok(!/material-symbols/.test(html));
  // 证据类型标签的文本就是 image/data/json，属于业务数据，先剥离再检查图标 ligature 文本。
  const withoutTypeLabels = html.replace(/<span class="ev-type">[^<]*<\/span>/g, '');
  assert.ok(!/>\s*(fact_check|content_copy|account_tree|description|terminal|table_chart|task_alt|compare_arrows|dock_to_left|arrow_forward|psychology|verified|help_outline|inventory_2)\s*</.test(withoutTypeLabels));
});

/* ---------- 构建前置条件 ---------- */
test('模板与脚本满足固定视口、CSP、自包含、无私有绑定的构建前置条件', () => {
  const template = fs.readFileSync(path.join(HERE, '..', 'template.html'), 'utf8');
  const appJs = fs.readFileSync(path.join(HERE, '..', 'app.js'), 'utf8');
  const appCss = fs.readFileSync(path.join(HERE, '..', 'app.css'), 'utf8');

  assert.ok(template.includes("default-src 'none'"));
  assert.ok(template.includes('nonce-{{NONCE}}'));
  assert.ok(template.includes('img-src data:'));
  assert.ok(template.includes('<!--INLINE_CSS-->'));
  assert.ok(template.includes('<!--INLINE_DATA-->'));
  assert.ok(template.includes('<!--INLINE_RRWEB-->'));
  assert.ok(template.includes('<!--INLINE_APP_JS-->'));
  assert.ok(!/<link\b/i.test(template));
  assert.ok(!/https?:\/\//i.test(template));
  assert.ok(!/V3_DATA|outputs-local|\/Users\//.test(template));

  ['class="workbench"', 'id="list-pane"', 'id="case-bar"', 'id="steps-strip"', 'id="work-body"',
    'id="stage-shell"', 'id="stage-bar"', 'id="stage-canvas"', 'id="stage-world"', 'id="stage-image"',
    'id="stage-empty"', 'id="stage-panel"', 'id="repro"', 'id="inspector"', 'id="inspector-status"',
    'id="inspector-body"'].forEach((token) => assert.ok(template.includes(token), '模板缺少：' + token));
  assert.ok(!/inspector-tabs|stage-tabs/.test(template), '模板不应再有页签容器');

  assert.ok(appCss.includes('--list-width: 230px'));
  assert.ok(appCss.includes('--inspector-width: 340px'));
  assert.ok(appCss.includes('--topbar-height: 48px'));
  assert.ok(appCss.includes('--casebar-height: 40px'));
  assert.ok(appCss.includes('--steps-height: 70px'));
  assert.ok(appCss.includes('height: 100vh'));
  assert.ok(appCss.includes('overflow: hidden'));
  assert.ok(appCss.includes('.inspector.is-collapsed'));
  assert.ok(appCss.includes('.inspector-body'));
  assert.ok(appCss.includes('.console-top { flex: 0 0 var(--console-ratio'));
  assert.ok(appCss.includes('.result-table th'));
  assert.ok(appCss.includes('position: sticky'));
  assert.ok(appCss.includes('overflow: auto'));
  assert.ok(!/\.stage-tab|\.ins-tab|\.inspector-tabs/.test(appCss), 'CSS 不应残留页签样式');
  assert.ok(!/verify-wrap|material-symbols|\.sidebar\b/.test(appCss), 'CSS 不应残留旧版布局');

  [appJs, appCss].forEach((text) => {
    assert.ok(!/material-symbols/.test(text));
    assert.ok(!/V3_DATA|outputs-local|\/Users\//.test(text));
  });
  assert.ok(!/renderVerifyWrap|\.verify-wrap/.test(appJs), 'V5 底部说明布局不应残留在脚本中');
  assert.ok(appJs.includes('resetCopyStore'));
  assert.ok(appJs.includes('data-split-gutter'));
  assert.ok(appJs.includes('role="separator"'));
  assert.ok(!/data-stage-tab|data-ins-tab|renderStagePanel|renderInspectorTabs|stageTabOf/.test(appJs),
    '旧的中央/右侧页签实现必须彻底删除');
  assert.ok(!/(^|\n)\s*(?:import|export)\s+[\w{*]/.test(appJs), '内联脚本必须是普通脚本');
  assert.ok(!/\bfetch\s*\(|XMLHttpRequest|WebSocket/.test(appJs), '视图不得发起网络请求');
});


test('部分验证和未执行项不汇总成全部通过，空对照不产生过程提示', () => {
 const payload = fixture();
 const step = payload.cases[0].steps[1];
 for (const status of ['partial','not_run']) {
  step.verification.comparison[0].status = status;
  const model = V.buildModel(payload);
  const view = V.renderInspector(model.cases[0].steps[1], model.cases[0], model);
  assert.notEqual(view.status.key, 'passed');
 }
 step.verification.comparison = [];
 const model = V.buildModel(payload);
 const view = V.renderInspector(model.cases[0].steps[1], model.cases[0], model);
 assert.ok(!view.html.includes('该步骤没有逐项对照'));
});

test('表头业务名仅改展示，技术字段和结果原值保留', () => {
 const payload = fixture();
 payload.evidence.push({id:'semantic',title:'查询结果',type:'json',category:'data',source:'fixture',content:{columns:['id','amount'],rows:[['251505005','1.000000']]}});
 const step = payload.cases[0].steps[0];
 step.evidenceIds=['semantic'];
 step.verification.resultSets=[{evidenceId:'semantic',label:'调用前',columnLabels:{id:'记录ID',amount:'赔付金额'}}];
 const model=V.buildModel(payload);
 const html=V.renderConsole(model.cases[0].steps[0],model.cases[0],model,V.SPLIT.initial);
 assert.ok(html.includes('column-label">记录ID'));
 assert.ok(html.includes('column-field">id'));
 assert.ok(html.includes('1.000000'));
 assert.deepEqual(V.buildResultSets(model.cases[0].steps[0],model,V.buildVerification(model.cases[0].steps[0],model.cases[0]))[0].columns,['id','amount']);
});


test('工具保留的 resultLines 直接展示为返回内容，不伪造响应字段', () => {
 const payload=fixture();
 payload.evidence.push({id:'tool-output',title:'工具输出',type:'json',category:'api',source:'fixture',content:{metadata:{success:true},resultLines:['校验通过','未提交理赔单']}});
 payload.cases[0].steps[2].evidenceIds=['tool-output'];
 const model=V.buildModel(payload);
 const html=V.renderConsole(model.cases[0].steps[2],model.cases[0],model,V.SPLIT.initial);
 assert.ok(html.includes('response-lines'));
 assert.ok(html.includes('未提交理赔单'));
 assert.ok(!html.includes('该步骤没有留存查询结果'));
});

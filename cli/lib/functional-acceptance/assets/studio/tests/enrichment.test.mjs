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

/* ---------- 用例设计依据：为什么测此用例 ---------- */

const DESIGN = {
  why: '理赔提现户是本次新增能力，商家能否选到正确账户直接决定打款去向。',
  sources: [
    { kind: 'requirement', label: '需求原话', quote: '理赔打款需支持商家选择已绑定提现户', ref: '变更单 10001 §2.1' },
    { kind: 'rule', label: '既有规则', quote: '同一时刻只允许一个生效收款账户', ref: 'F-02 规则' },
    { kind: 'design', label: '设计稿', url: 'https://www.figma.com/design/example' },
    { kind: 'history', label: '不安全的地址', url: 'http://insecure.example/x' },
  ],
};

test('caseDesign 只接受带 why 与来源的结构，并保留无链接时的原话与出处', () => {
  assert.equal(V.normalizeCaseDesign({ sources: DESIGN.sources }), null, '缺少 why 不生成依据');
  assert.equal(V.normalizeCaseDesign({ why: '   ' }), null);
  const design = V.normalizeCaseDesign(DESIGN);
  assert.equal(design.why, DESIGN.why);
  assert.equal(design.sources.length, 4);
  assert.equal(design.sources[2].url, 'https://www.figma.com/design/example');
  assert.equal(design.sources[3].url, '', 'http 链接不得变成可点链接');
  assert.equal(design.sources[0].quote, '理赔打款需支持商家选择已绑定提现户');
  assert.equal(design.sources[0].ref, '变更单 10001 §2.1');
});

test('caseDesignHtml 输出为什么测此用例、来源类别、原话与可跳转链接', () => {
  const design = V.normalizeCaseDesign(DESIGN);
  const html = V.caseDesignHtml({ caseRole: 'new', raw: { caseRole: 'new' }, caseDesign: design });
  assert.ok(html.includes('data-ins-section="case-design"'));
  assert.ok(html.includes('为什么测此用例'));
  assert.ok(html.includes(DESIGN.why));
  assert.ok(html.includes('测新追溯来源'));
  assert.ok(html.includes('需求原话'));
  assert.ok(html.includes('既有规则'));
  assert.ok(html.includes('变更单 10001 §2.1'));
  assert.ok(html.includes('href="https://www.figma.com/design/example"'));
  assert.ok(html.includes('rel="noopener noreferrer"'));
  assert.ok(!html.includes('insecure.example'), '未核验的 http 地址必须整条丢弃');
  assert.ok(html.includes('不用“怎么查/怎么做”代替缘由'), '测新用例给出追溯口径');
});

test('caseDesignHtml 按用例角色切换溯源口径：回归指向既有规则/影响路径/历史问题', () => {
  const design = V.normalizeCaseDesign(DESIGN);
  const reg = V.caseDesignHtml({ caseRole: 'regression', raw: { caseRole: 'regression' }, caseDesign: design });
  assert.ok(reg.includes('回归追溯来源'));
  assert.ok(reg.includes('既有规则、影响路径或历史问题'));
  const audit = V.caseDesignHtml({ caseRole: 'audit', raw: { caseRole: 'audit' }, caseDesign: design });
  assert.ok(audit.includes('执行审计依据'));
  assert.equal(V.caseDesignHtml({ caseRole: 'new', raw: { caseRole: 'new' } }), '', '没有依据时不生成卡片');
});

/* ---------- 蓝图复现预填 ---------- */

const PREFILL = {
  url: 'https://preview.example.com/blueprint/tool#/insurance',
  parameters: [{ name: 'claimId', value: '10001' }, { name: 'amount', value: '1610.950000' }],
  environment: '项目预发',
  note: '入口来自已核验的蓝图工具路由；打开后需人工确认再执行。',
};

test('prefillHref 把参数合成 JSON 放进 params 查询值，已有查询串用 & 追加', () => {
  const prefill = V.normalizePrefill(PREFILL);
  const href = V.prefillHref(prefill);
  assert.equal(href, PREFILL.url + '?params=' +
    encodeURIComponent('{"claimId":"10001","amount":"1610.950000"}'));
  assert.ok(!/[{}]/.test(href), '花括号必须被编码，地址本身不含占位符');

  const withQuery = V.prefillHref({ ...prefill, url: 'https://preview.example.com/blueprint?tool=insurance' });
  assert.ok(withQuery.startsWith('https://preview.example.com/blueprint?tool=insurance&params='));

  assert.equal(V.prefillHref(null), '');
  assert.equal(V.prefillHref({ url: '', parameters: [] }), '');
});

test('prefill 只接受 https 已核验地址与具名参数，参数原值按字符串保留', () => {
  assert.equal(V.normalizePrefill({ url: 'http://preview.example.com/x', parameters: PREFILL.parameters }), null);
  assert.equal(V.normalizePrefill({ url: PREFILL.url, parameters: [] }), null, '没有参数不能叫预填');
  assert.equal(V.normalizePrefill({ url: PREFILL.url, parameters: [{ value: '只给值' }] }), null, '缺少参数名');
  const prefill = V.normalizePrefill({ ...PREFILL, parameters: [{ name: 'amount', value: '1610.950000' }, { name: 'orderId', value: '27007' }] });
  assert.equal(prefill.parameters[0].value, '1610.950000', '尾随零不丢');
  assert.ok(V.prefillParamText(prefill).includes('"27007"'), '大整数按字符串保留，不转数字');
  assert.equal(V.prefillSummary(prefill), '已带入 2 个参数 · 项目预发');
});

test('prefillPopHtml 明确“打开仅预填、需主动执行”，并提供真实参数与地址', () => {
  const prefill = V.normalizePrefill(PREFILL);
  const html = V.prefillPopHtml(prefill);
  assert.ok(html.includes('打开仅预填，需主动执行'), '必须声明不自动执行');
  assert.ok(html.includes('报告不发起任何业务调用'));
  assert.ok(html.includes('已带入 2 个参数 · 项目预发'));
  assert.ok(html.includes('claimId') && html.includes('10001'));
  assert.ok(html.includes('href="' + V.prefillHref(prefill) + '"'));
  assert.ok(html.includes('target="_blank"'));
  assert.ok(html.includes('复制参数'));
});

test('用户直接点击步骤复现条即可带入参数，不必先打开参数弹层', () => {
  const prefill = V.normalizePrefill(PREFILL);
  const html = V.renderRepro({ reproduction: { kind: 'lantu', label: '蓝图', prefill } }, {}, {});
  assert.ok(html.includes('href="' + V.prefillHref(prefill) + '"'));
  assert.ok(!html.includes('href="' + PREFILL.url + '"'));
});

/* ---------- 关注单元格 ---------- */

const FOCUS = [{
  label: '失败金额未重复累计',
  reason: '同一付款义务的历史失败不能再次计入失败统计',
  expected: '31.74',
  actual: '31.74',
  evidenceIds: ['ev-c8-db', 'ev-c8-excluded'],
  cellRefs: [{ resultSet: 0, row: 0, column: 'failedTotalAmount', note: '第一行为本次统计' }],
}];

test('buildFocusMap 用结果集序号+行号+字段定位，同一单元格可挂多个核对点', () => {
  const focus = [FOCUS[0], { ...FOCUS[0], label: '阈值也不越界' }];
  const map = V.buildFocusMap(focus);
  assert.deepEqual(Object.keys(map), ['0:0:failedTotalAmount']);
  assert.equal(map['0:0:failedTotalAmount'].length, 2);
  assert.equal(map['0:0:failedTotalAmount'][1].index, 2);
});

test('focusPopHtml 说明为什么关注、预期、实际、证据与字段位置', () => {
  const map = V.buildFocusMap(FOCUS);
  const html = V.focusPopHtml({
    hits: map['0:0:failedTotalAmount'], setIndex: 0, row: 0, column: 'failedTotalAmount',
    setTitle: '统计查询结果', label: '',
  });
  assert.ok(html.includes('为什么关注'));
  assert.ok(html.includes(FOCUS[0].reason));
  assert.ok(html.includes('预期') && html.includes('31.74'));
  assert.ok(html.includes('实际'));
  assert.ok(html.includes('第一行为本次统计'));
  assert.ok(html.includes('统计查询结果'));
  assert.ok(html.includes('字段 failedTotalAmount（第 1 行）'));
  assert.ok(html.includes('证据 2 条'));
  assert.equal(V.focusPopHtml(null), '');
});

test('focusListHtml 给出可定位按钮，right inspector 保留整体叙述', () => {
  const html = V.focusListHtml(FOCUS);
  assert.ok(html.includes('data-goto-result="0"'));
  assert.ok(html.includes('data-goto-row="0"'));
  assert.ok(html.includes('data-goto-column="failedTotalAmount"'));
  assert.ok(html.includes('为何关注：' + FOCUS[0].reason));
  assert.equal(V.focusRefText(FOCUS[0].cellRefs[0]), '结果表 1 · 第 1 行 · 字段 failedTotalAmount · 第一行为本次统计');
});

test('normalizeFocus 丢弃不完整 cellRef，不按值相等推断关注点', () => {
  const model = V.buildModel({
    schemaVersion: 1,
    report: { id: 'r', title: 't' },
    groups: [{ id: 'g', title: 'g' }],
    cases: [{
      id: 'c1', groupId: 'g', title: 'c', status: 'passed', caseRole: 'regression', caseRoleReason: 'x', caseRoleSources: ['a'], checks: [],
      steps: [{
        id: 's1', type: 'data', title: 's', action: 'a', expected: 'e', actual: 'a', status: 'passed', evidenceIds: [],
        verification: {
          question: 'q', method: 'm', conclusion: 'c', focus: [{
            label: '关注', reason: 'r', expected: 'e', actual: 'a', evidenceIds: [],
            cellRefs: [{ resultSet: 0, row: 0, column: 'amount' }, { resultSet: 'x', row: 0, column: 'amount' }, { resultSet: 0, row: 1 }],
          }],
        },
      }],
    }],
    evidence: [],
  });
  const focus = V.buildVerification(model.cases[0].steps[0], model.cases[0]).focus[0];
  assert.equal(focus.cellRefs.length, 1, '序号/行号/字段缺一不可');
  assert.equal(focus.cellRefs[0].column, 'amount');
});

/* ---------- 行详情与原始值 ---------- */

const ROW_SRC = '{"row":{"id":9007199254740993,"amount":"1.5000","note":null,"html":"<b>x</b>","html":"dup"}}';

function rowSet() {
  const table = V.jsonTable(V.readJsonTree(ROW_SRC), ROW_SRC);
  return { text: ROW_SRC, columns: table.columns, rowNodes: table.rowNodes, index: 0, title: '当前统计', label: '', evidenceId: 'ev' };
}

test('rowFields 按原文片段保留大整数、尾随零、null 与重复键次序', () => {
  const fields = V.rowFields(rowSet(), 0);
  assert.deepEqual(fields.map((f) => f.name), ['id', 'amount', 'note', 'html', 'html']);
  assert.equal(fields[0].raw, '9007199254740993', '大整数按原文，不经 Number');
  assert.equal(fields[1].raw, '"1.5000"');
  assert.equal(fields[2].raw, 'null');
  assert.equal(fields[3].duplicate, true);
  assert.equal(fields[3].ordinal, 1);
  assert.equal(fields[4].ordinal, 2);
  assert.equal(fields[4].raw, '"dup"');
});

test('rowRawText 返回整行原文，rowDetailHtml 转义 HTML 并提供字段/整行复制', () => {
  const set = rowSet();
  assert.equal(V.rowRawText(set, 0), '{"id":9007199254740993,"amount":"1.5000","note":null,"html":"<b>x</b>","html":"dup"}');
  const html = V.rowDetailHtml(set, 0);
  assert.ok(html.includes('&lt;b&gt;x&lt;/b&gt;'), '原文中的 HTML 必须转义展示');
  assert.ok(!html.includes('<b>x</b>'), '不得把证据原文当 HTML 执行');
  assert.ok(html.includes('重复键 1/2') && html.includes('重复键 2/2'));
  assert.ok(html.includes('复制整行 JSON'));
  assert.equal((html.match(/data-copy-key="row-field-/g) || []).length, 5, '每个字段一个复制入口');
  assert.equal(V.rowRawText(set, 9), '');
});

test('buildResultSets 产出的结果集自带原文，行详情可直接切片复制', () => {
  const model = { evidenceById: { 'ev-1': { id: 'ev-1', title: '当前统计', type: 'json', content: ROW_SRC } } };
  const sets = V.buildResultSets({ evidenceIds: ['ev-1'] }, model, {});
  assert.equal(sets.length, 1);
  const set = sets[0];
  assert.equal(set.text, ROW_SRC, '结果集必须保留原文供行详情切片');
  assert.equal(V.rowRawText(set, 0), '{"id":9007199254740993,"amount":"1.5000","note":null,"html":"<b>x</b>","html":"dup"}');
  assert.equal(V.rowFields(set, 0)[0].raw, '9007199254740993');
  assert.ok(V.rowDetailHtml(set, 0).includes('复制整行 JSON'), '有原文时不得退化为“整行原文不可用”');
});

/* ---------- 图片标注与灯箱 ---------- */

test('normalizeAnnotations 统一编号与色调，丢弃无尺寸的框', () => {
  const list = V.normalizeAnnotations([
    { label: 'A', x: 10, y: 20, w: 30, h: 40, tone: 'risk', number: 5 },
    { label: 'B' },
    { label: 'C', x: 1, y: 2, w: 3, h: 4, tone: 'unknown' },
  ]);
  assert.equal(list.length, 2);
  assert.equal(list[0].number, 5);
  assert.equal(list[0].tone, 'risk');
  assert.equal(list[1].number, 3, '未给序号时按原下标编号');
  assert.equal(list[1].tone, 'focus', '未知色调回落到 focus');
});

test('layoutAnnotationBox 用原图像素换算屏幕像素，缩放平移后框线跟随', () => {
  const a = { x: 100, y: 50, w: 200, h: 100 };
  assert.deepEqual(V.layoutAnnotationBox(a, { scale: 1, tx: 0, ty: 0 }), { left: 100, top: 50, width: 200, height: 100 });
  assert.deepEqual(V.layoutAnnotationBox(a, { scale: 2, tx: -30, ty: 10 }), { left: 170, top: 110, width: 400, height: 200 });
  const tiny = V.layoutAnnotationBox({ x: 0, y: 0, w: 1, h: 1 }, { scale: 1, tx: 0, ty: 0 });
  assert.equal(tiny.width, 2, '极小框保留最小可点面积');
});

test('annotationsHtml / legendHtml 输出编号徽标与说明，可被灯箱开关控制', () => {
  const list = V.normalizeAnnotations([{ label: '合计行', tone: 'risk', note: '失败金额列', x: 1, y: 2, w: 3, h: 4 }]);
  const html = V.annotationsHtml(list);
  assert.ok(html.includes('class="lb-anno tone-risk"'));
  assert.ok(html.includes('①'));
  assert.ok(html.includes('title="合计行：失败金额列"'));
  const legend = V.legendHtml(list);
  assert.ok(legend.includes('合计行') && legend.includes('失败金额列'));
});

test('zoomAt / fitTo / originalSize 在灯箱内保持焦点并按视口夹住平移', () => {
  const fit = V.fitTo(1000, 800, 500, 400);
  assert.equal(fit.mode, 'fit');
  assert.equal(fit.scale, 0.5);
  assert.equal(fit.tx, 0);
  const zoomed = V.zoomAt({ scale: 1, tx: 0, ty: 0 }, 2, 100, 100, 1000, 800, 500, 400);
  assert.equal(zoomed.scale, 2);
  assert.equal(zoomed.tx, -100, '缩放围绕指针位置');
  const clamped = V.zoomAt({ scale: 1, tx: 0, ty: 0 }, 50, 250, 200, 1000, 800, 500, 400);
  assert.equal(clamped.scale, 5, '缩放上限夹住');
  assert.equal(clamped.tx, -1000, '平移按指针缩放后不越界');
  assert.equal(V.originalSize(1000, 800, 500, 400).mode, 'original');
});

/* ---------- UED 设计对照 ---------- */

test('uedHtml 只引用报告内真实图片证据，缺素材时不画示意预览', () => {
  const model = {
    evidenceById: {
      'ued-1': { id: 'ued-1', type: 'image', title: '选户弹层设计稿', file: 'ued-evidence/x.png', dataUri: PNG_1PX, annotations: [{ label: 'A' }] },
      'txt-1': { id: 'txt-1', type: 'text', content: 'not an image' },
    },
  };
  const ued = V.normalizeUed({ evidenceId: 'ued-1', title: '选户弹层', caption: '单选卡片', sourceUrl: 'https://www.figma.com/design/x', note: '真实设计稿裁切' });
  const html = V.uedHtml({ ued }, model);
  assert.ok(html.includes('data-lightbox-evidence="ued-1"'), '缩略图可点开统一灯箱');
  assert.ok(html.includes('UED 设计稿'));
  assert.ok(html.includes('1 处标注'));
  assert.ok(html.includes('href="https://www.figma.com/design/x"'));
  assert.ok(html.includes('真实设计稿裁切'));
  assert.equal(V.uedHtml({ ued: { evidenceId: 'txt-1' } }, model), '', '非图片证据不生成设计对照');
  assert.equal(V.uedHtml({ ued: { evidenceId: 'missing' } }, model), '');
  assert.equal(V.normalizeUed({}), null);
});

/* ---------- 业务分组筛选 ---------- */

projectTest('业务分组与状态/目的/搜索 AND 组合，计数与空态一致', () => {
  const raw = JSON.parse(fs.readFileSync(REAL_DATA, 'utf8'));
  const model = V.buildModel(raw);
  const group = raw.groups[0].id;
  const filters = { ...V.defaultFilters(), group };

  const expectedGroup = raw.cases.filter((c) => c.groupId === group).length;
  assert.equal(V.filterCases(model, filters).length, expectedGroup);

  const counts = V.computeCounts(model, filters);
  assert.equal(counts.group[group], expectedGroup);
  assert.equal(counts.group.all, raw.cases.length);

  const passed = raw.cases.filter((c) => c.groupId === group && c.status === 'passed' && c.caseRole !== 'audit').length;
  assert.equal(V.filterCases(model, { ...filters, status: 'passed' }).length, passed);
  assert.equal(V.computeCounts(model, { ...filters, status: 'passed' }).group[group], passed);

  const search = V.filterCases(model, { ...filters, status: 'passed', query: '不可能出现的检索词 zzzz' });
  assert.equal(search.length, 0);
  assert.ok(V.renderCaseGroups(model, { ...filters, query: '不可能出现的检索词 zzzz' }).includes('当前筛选没有匹配的用例'));
});

projectTest('真实图片证据都带真实区域标注，编号连续且框在图像坐标内', () => {
  const raw = JSON.parse(fs.readFileSync(REAL_DATA, 'utf8'));
  const images = raw.evidence.filter((ev) => ev.type === 'image');
  assert.equal(images.length, 57);
  images.forEach((ev) => {
    assert.ok(Array.isArray(ev.annotations) && ev.annotations.length, '缺少标注：' + ev.id);
    ev.annotations.forEach((box, index) => {
      assert.equal(box.number, index + 1, '编号应按顺序生成：' + ev.id);
      assert.ok(['focus', 'context', 'risk'].includes(box.tone), '未知色调：' + ev.id);
      assert.ok(box.w > 0 && box.h > 0 && box.x >= 0 && box.y >= 0, '标注框必须有真实尺寸：' + ev.id);
    });
  });
  const ued = raw.evidence.filter((ev) => ev.id.startsWith('ued-'));
  assert.equal(ued.length, 5, 'UED 设计证据来自真实缓存裁切');
  ued.forEach((ev) => assert.ok(ev.file && ev.file.startsWith('ued-evidence/'), 'UED 证据必须指向真实文件'));
});

projectTest('真实用例都带设计依据与来源，且不把步骤动作当缘由', () => {
  const raw = JSON.parse(fs.readFileSync(REAL_DATA, 'utf8'));
  assert.equal(raw.cases.length, 40);
  const kinds = new Set();
  raw.cases.forEach((c) => {
    assert.ok(c.caseDesign && c.caseDesign.why, '缺少 why：' + c.id);
    assert.ok(c.caseDesign.sources.length, '缺少来源：' + c.id);
    c.caseDesign.sources.forEach((s) => {
      kinds.add(s.kind);
      assert.ok(s.quote || s.ref || s.url, '来源必须有原话/出处/链接：' + c.id);
      const firstStep = (c.steps[0] || {}).action || '';
      if (s.quote && firstStep) assert.notEqual(s.quote.trim(), firstStep.trim(), '来源原话不能照抄步骤动作：' + c.id);
    });
  });
  ['requirement', 'rule', 'impact', 'confirmation', 'evidence', 'design']
    .forEach((kind) => assert.ok(kinds.has(kind), '缺少来源类别：' + kind));
  raw.cases.filter((c) => c.caseRole === 'regression').forEach((c) => {
    const regressionKinds = c.caseDesign.sources.map((s) => s.kind);
    assert.ok(regressionKinds.some((k) => ['rule', 'impact', 'history', 'evidence'].includes(k)),
      '回归用例要追溯到既有规则/影响路径/历史问题：' + c.id);
  });
});

projectTest('真实载荷里每个关注单元格都能定位到已有结果集的行与字段', () => {
  const raw = JSON.parse(fs.readFileSync(REAL_DATA, 'utf8'));
  const dataDir = path.dirname(REAL_DATA);
  raw.evidence.forEach((ev) => {
    if (!ev.file || ev.type === 'image') return;
    const text = fs.readFileSync(path.join(dataDir, ev.file), 'utf8');
    ev.content = ev.type === 'json' ? JSON.stringify(JSON.parse(text), null, 2) : text;
  });
  const model = V.buildModel(raw);
  let refs = 0;
  model.cases.forEach((c) => {
    c.steps.forEach((s) => {
      const verification = s.verification;
      if (!verification) return;
      const focus = verification.focus || [];
      if (!focus.some((f) => f.cellRefs && f.cellRefs.length)) return;
      const sets = V.buildResultSets(s, model, verification);
      assert.ok(Array.isArray(verification.resultSets) && verification.resultSets.length, '关注单元格需要显式结果集：' + s.id);
      focus.forEach((f) => (f.cellRefs || []).forEach((ref) => {
        refs += 1;
        const set = sets[ref.resultSet];
        assert.ok(set, '结果集越界：' + s.id);
        assert.ok(set.rows[ref.row], '行越界：' + s.id);
        assert.ok(set.columns.includes(ref.column), '字段不存在：' + s.id + ' / ' + ref.column);
      }));
    });
  });
  assert.ok(refs >= 70, '关注单元格引用数量：' + refs);
});

projectTest('真实载荷的预填地址由已核验入口合成，且每步参数值不含占位符', () => {
  const raw = JSON.parse(fs.readFileSync(REAL_DATA, 'utf8'));
  let steps = 0;
  raw.cases.forEach((c) => c.steps.forEach((s) => {
    const prefill = s.reproduction && s.reproduction.prefill;
    if (!prefill) return;
    steps += 1;
    const normalized = V.normalizePrefill(prefill);
    assert.ok(normalized, '预填结构不合法：' + s.id);
    assert.ok(normalized.url.startsWith('https://'), '预填地址必须是 https：' + s.id);
    assert.ok(!/[{}]/.test(normalized.url), '预填地址不得含占位符：' + s.id);
    normalized.parameters.forEach((p) => assert.ok(p.value && !/[<>{}]/.test(p.value), '参数值含占位符：' + s.id + '/' + p.name));
    const href = V.prefillHref(normalized);
    assert.ok(href.includes('params=' + encodeURIComponent(JSON.stringify(Object.fromEntries(normalized.parameters.map((p) => [p.name, p.value]))))));
  }));
  assert.ok(steps >= 12, '预填步骤数量：' + steps);
});

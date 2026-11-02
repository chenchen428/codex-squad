import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));

/* 浏览器里两个 vendor bundle 挂在全局；Node 侧用同一份产物，保证测的就是线上那份代码。 */
const VENDOR = path.join(HERE, '..', '..', 'vendor', 'code-view');
globalThis.hljs = require(path.join(VENDOR, 'highlight-sql-json-http-java.min.js'));
globalThis.sqlFormatter = require(path.join(VENDOR, 'sql-formatter.mysql.min.js'));

const CV = require('../code-view.js');
globalThis.AcceptanceCodeView = CV;
const V = require('../app.js');

const REAL_DATA = process.env.ACCEPTANCE_TEST_DATA || '';
const projectTest = fs.existsSync(REAL_DATA) ? test : test.skip;

/* 把 <pre> 里的 HTML 还原成纯文本，用于断言“展示的原文 == 输入的原文”。 */
function textOf(preHtml) {
  return preHtml
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function blockOf(html, mode) {
  const match = new RegExp('<pre class="pre code-block" data-code-mode="' + mode + '"[^>]*>([\\s\\S]*?)</pre>').exec(html);
  assert.ok(match, '缺少 data-code-mode="' + mode + '" 的代码块');
  return { html: match[1], text: textOf(match[1]) };
}

const SQL = "select e.id, (select count(*) from t_claim_apply a where a.order_id=e.id and a.deleted=0) as claim_count, " +
  "case when e.state=1 then '新建' when e.state=2 then '已确认' else '其他' end as state_label " +
  "from t_exception_order e where e.id in (255096003,255096004) and e.name like '王%' /* 中文注释 */ order by e.id desc";

test('SQL 默认格式化为多行：SELECT/FROM/WHERE/CASE/子查询各自换行并缩进', () => {
  const html = CV.render({ text: SQL, hint: 'sql' });
  const formatted = blockOf(html, 'formatted').text;
  const lines = formatted.split('\n');

  assert.ok(lines.length > 12, '格式化后应显著多行，实际 ' + lines.length + ' 行');
  assert.match(formatted, /\nFROM\n/, 'FROM 应独占并换行');
  assert.match(formatted, /\nWHERE\n/, 'WHERE 应独占并换行');
  assert.match(formatted, /\n\s+WHEN /, 'CASE 分支应新行缩进');
  assert.match(formatted, /\n\s+END\b/, 'END 应新行');
  assert.match(formatted, /\n\s+\(\n\s+SELECT\n/, '子查询应换行缩进');

  const original = blockOf(html, 'original').text;
  assert.equal(original, SQL, '原文块必须与输入逐字节相同');
  assert.ok(html.includes('data-code-toggle'), '有格式化结果时应提供原文切换');
  assert.ok(html.includes('已格式化'));
});

test('SQL 词法有区分：关键字/字符串/数字/注释各自成 token，引号与 Unicode 保持原样', () => {
  const html = CV.render({ text: SQL, hint: 'sql' });
  assert.match(html, /class="hljs-keyword">SELECT</);
  assert.match(html, /class="hljs-keyword">CASE</);
  assert.match(html, /class="hljs-string">&#x27;新建&#x27;</);
  assert.match(html, /class="hljs-number">255096003</);
  assert.match(html, /class="hljs-comment">\/\* 中文注释 \*\//);
  assert.ok(blockOf(html, 'original').text.includes("'王%'"), '中文通配符不能被改写');
});

test('非法/截断 SQL 保留原文并标注原因，不生成假 SQL', () => {
  const broken = "SELECT 1 /* 未闭合注释";
  const html = CV.render({ text: broken, hint: 'sql' });
  const body = blockOf(html, 'original').text;
  assert.equal(body, broken);
  assert.ok(html.includes('data-code-fallback="sql-truncated"'));
  assert.ok(!html.includes('data-code-toggle'), '没有可信格式化结果时不给切换入口');
  assert.equal(CV.format(broken, 'sql').ok, false);

  const unparsable = 'SELECT * FROM (';
  assert.equal(CV.format(unparsable, 'sql').ok, false);
  const fallback = CV.render({ text: unparsable, hint: 'sql' });
  assert.equal(blockOf(fallback, 'original').text, unparsable);
  assert.ok(fallback.includes('格式化未生效'), '失败原因要如实展示，而不是隐去');
});

test('JSON 合法文本美化并高亮键/字符串/数字/bool/null', () => {
  const raw = '{"claim":0,"paid":true,"detail":null,"name":"王五","nested":{"a":[1,2]}}';
  const html = CV.render({ text: raw, hint: 'json' });
  const formatted = blockOf(html, 'formatted').text;

  assert.equal(JSON.parse(formatted).nested.a[1], 2);
  assert.ok(formatted.split('\n').length > 5, '合法 JSON 应展开为多行');
  assert.equal(JSON.stringify(JSON.parse(formatted)), JSON.stringify(JSON.parse(raw)), '美化不能改变内容');

  assert.match(html, /class="hljs-attr">&quot;claim&quot;</);
  assert.match(html, /class="hljs-string">&quot;王五&quot;/);
  assert.match(html, /class="hljs-number">0</);
  assert.match(html, /class="hljs-literal">/);
  assert.equal(blockOf(html, 'original').text, raw);
});

/* 独立于实现的判据：把字符串外的空白全部去掉后，输入与展示必须完全一致。 */
function stripWsOutsideStrings(text) {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === '\\') { out += text[i + 1] ?? ''; i += 1; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') continue;
    out += ch;
  }
  return out;
}

test('JSON 格式化只改空白：大整数/尾零/指数/-0/重复键按原字节保留', () => {
  const raw = '{"id":9007199254740993,"amount":1.000000,"exp":1e3,"neg":-0,"code":1,"code":2}';
  const res = CV.format(raw, 'json');

  assert.equal(res.ok, true);
  assert.equal(stripWsOutsideStrings(res.text), stripWsOutsideStrings(raw), '字符串外只允许改空白');
  assert.ok(res.text.includes('"id": 9007199254740993'), '大整数不能被舍入成 9007199254740992');
  assert.ok(!res.text.includes('9007199254740992'), '不能出现舍入后的数值');
  assert.ok(res.text.includes('"amount": 1.000000'), '尾零不能被吃掉');
  assert.ok(res.text.includes('"exp": 1e3'), '指数写法不能被展开');
  assert.ok(res.text.includes('"neg": -0'), '-0 不能变成 0');
  assert.equal((res.text.match(/"code": [12]/g) || []).length, 2, '重复键必须各保留一条');
  assert.ok(res.text.includes('\n'), '仍应展开为多行');
});

test('JSON 字符串内部字节不变：\\u 转义、emoji、反斜杠与引号原样输出', () => {
  const raw = '{"s":"\\u4e2d\\u6587","emoji":"😀","esc":"a\\"b\\\\c\\n","arr":[1,[2,{}],[]],"o":{}}';
  const res = CV.format(raw, 'json');

  assert.equal(res.ok, true);
  assert.ok(res.text.includes('"s": "\\u4e2d\\u6587"'), '\\u 转义不能被解码成中文');
  assert.ok(res.text.includes('"emoji": "😀"'));
  assert.ok(res.text.includes('"esc": "a\\"b\\\\c\\n"'), '转义序列不能改写');
  assert.equal(stripWsOutsideStrings(res.text), stripWsOutsideStrings(raw), '数组/嵌套/空容器同样只改空白');
  assert.match(res.text, /\n\s+1,\n\s+\[/, '嵌套数组应换行缩进');
});

test('渲染层同样不因 JSON 排版改动证据数值，且原文块与切换保留', () => {
  const raw = '{"id":9007199254740993,"amount":1.000000,"code":1,"code":2}';
  const html = CV.render({ text: raw, hint: 'json' });
  const formatted = blockOf(html, 'formatted').text;

  assert.ok(formatted.includes('9007199254740993'));
  assert.ok(formatted.includes('1.000000'));
  assert.ok(blockOf(html, 'original').text === raw, '原文块必须逐字节等于输入');
  assert.ok(html.includes('data-code-toggle'), '有格式化结果时应可切回原文');
});

test('非法 JSON 不高亮成 JSON，退回原文并标注', () => {
  const raw = '{"a":1,}';
  const html = CV.render({ text: raw, hint: 'json' });
  assert.equal(blockOf(html, 'original').text, raw);
  assert.ok(html.includes('data-code-fallback="json-invalid"'));
  assert.ok(!html.includes('hljs-attr'), '非法 JSON 不能伪造属性高亮');
});

test('输入 HTML/script 只当字面量：既有高亮路径也不产出可执行标签', () => {
  const payloads = [
    '<img src=x onerror=alert(1)>',
    '<script>alert(2)</script>',
    '{"x":"<img src=x onerror=alert(1)>"}',
    "SELECT '<script>alert(3)</script>' AS p",
    'GET /a?x=<script>alert(4)</script> HTTP/1.1',
  ];
  payloads.forEach((payload) => {
    const html = CV.render({ text: payload });
    assert.ok(!/<(?:img|script)\b/i.test(html.replace(/<pre[\s\S]*?<\/pre>/g, '')), '容器标记外不得出现输入标签：' + payload);
    const original = blockOf(html, 'original');
    assert.ok(!/<(?:img|script)\b/i.test(original.html), '代码块里输入必须是转义字面量：' + payload);
    assert.equal(original.text, payload, '转义后还原必须与输入一致：' + payload);
  });

  assert.equal(CV.highlight('<b>x</b>', 'text'), '&lt;b&gt;x&lt;/b&gt;');
});

test('代码块语言识别：已知语言按提示高亮，未知不伪造格式', () => {
  assert.equal(CV.detectLanguage(SQL), 'sql');
  assert.equal(CV.detectLanguage('  -- 注释\nSELECT 1'), 'sql');
  assert.equal(CV.detectLanguage('{"a":1}'), 'json');
  assert.equal(CV.detectLanguage('POST /luyou/alg/api/x.json'), 'http');
  assert.equal(CV.detectLanguage('importClaimSettlementItem（只校验）'), 'text');
  assert.equal(CV.detectLanguage('merchant_id：100001'), 'text');

  assert.equal(CV.detectLanguage('{"a":1}', 'hsf'), 'java', '调用方明确标注 HSF 时按方法签名高亮');
  assert.equal(CV.detectLanguage('POST /a HTTP/1.1', 'http'), 'http');

  const hsf = CV.render({ text: 'retryPayment(com.example.payment.PaymentOrderRetryRequestDTO)', hint: 'hsf' });
  assert.ok(hsf.includes('data-code-lang="java"'));
  assert.ok(hsf.includes('code-token method'), 'HSF 签名应标出方法名');
  assert.ok(hsf.includes('code-token type'), 'HSF 签名应标出参数类型');
  assert.equal(blockOf(hsf, 'original').text, 'retryPayment(com.example.payment.PaymentOrderRetryRequestDTO)');
  assert.ok(!hsf.includes('data-code-toggle'), '没有格式化器时不给格式化入口');

  const http = CV.render({ text: 'POST /luyou/alg/api/claim-withdrawal-10001/query-statistics.json', hint: 'http' });
  assert.ok(http.includes('data-code-lang="http"'));
  assert.ok(http.includes('code-token keyword'));
  assert.equal(blockOf(http, 'original').text,
    'POST /luyou/alg/api/claim-withdrawal-10001/query-statistics.json');

  const plain = CV.render({ text: 'merchant_id：100001' });
  assert.ok(plain.includes('data-code-fallback="no-formatter"'));
  assert.ok(!plain.includes('hljs-'), '未知语言只做转义，不伪造 token');
});

/* ---------- 与视图集成 ---------- */
function fixture() {
  return {
    schemaVersion: 1,
    report: { id: 'r', title: 't', environment: 'e', executedAt: '2026-10-30T10:00:00+08:00', example: false },
    groups: [{ id: 'g1', title: 'G1' }],
    evidence: [
      { id: 'ev-json', title: '前后快照', type: 'json', content: { claim: 0, detail: { paid: true } } },
      { id: 'ev-text', title: '请求响应', type: 'text', content: '<img src=x onerror=alert(1)> 期望原文' },
    ],
    cases: [{
      id: 'C1',
      groupId: 'g1',
      title: '用例',
      status: 'passed',
      checks: [],
      steps: [{
        id: 's1',
        type: 'data',
        title: '步骤',
        action: '查询',
        expected: 'e',
        actual: 'a',
        status: 'passed',
        evidenceIds: ['ev-json', 'ev-text'],
        verification: {
          question: 'q',
          method: 'm',
          focus: [],
          comparison: [],
          conclusion: 'c',
          limitations: [],
          statement: { kind: 'sql', origin: 'executed', text: SQL, explanation: '说明', parameters: [] },
        },
        reproduction: { kind: 'db', label: 'DMS', urlStatus: 'unavailable', reason: '无入口', params: SQL },
      }],
    }],
  };
}

test('中央核验台、右侧检视器、复现参数共用同一代码渲染器', () => {
  const model = V.buildModel(fixture());
  const c = model.cases[0];
  const step = c.steps[0];

  const stage = V.renderConsole(step, c, model, V.SPLIT.initial);
  const inspector = V.renderInspector(step, c, model).html;
  const repro = V.renderRepro(step, c, model);

  [stage, inspector].forEach((html) => {
    assert.ok(html.includes('class="code-view"'), '语句区必须使用统一代码视图');
    assert.ok(html.includes('data-code-mode="formatted"'));
    assert.ok(html.includes('data-code-mode="original"'));
  });
  const codeViews = inspector.match(/class="code-view"/g) || [];
  assert.ok(codeViews.length >= 2, '检视器里复现参数与折叠证据共用同一代码渲染器，实际 ' + codeViews.length);
  assert.ok(inspector.includes('复现入口'));
  assert.ok(repro.includes('复制输入参数'), '复现入口仍是“输入参数”，不与语句原文混淆');
});

test('复制原文与原文逐字节相等，格式化不改底层 text/evidence/status', () => {
  const data = fixture();
  const model = V.buildModel(data);
  V.__setModel(model);
  const c = model.cases[0];
  const step = c.steps[0];

  V.renderConsole(step, c, model, V.SPLIT.initial);
  assert.equal(V.copyTextByKey('stage-statement'), SQL, '复制键必须指向未格式化的原字符串');

  V.renderInspector(step, c, model);
  assert.equal(V.copyTextByKey('ins-statement'), '', '右栏不重复语句原文，语句复制键只在中央核验台');
  assert.equal(V.copyTextByKey('ins-repro-params'), SQL, '复现参数复制的是输入模板原文');

  V.renderEvidenceItems(['ev-json', 'ev-text'], model.evidenceById);
  assert.equal(V.copyTextByKey('ev-content-ev-json'),
    JSON.stringify({ claim: 0, detail: { paid: true } }, null, 2), '证据复制内容必须等于载荷里的内容');
  assert.equal(V.copyTextByKey('ev-content-ev-text'), '<img src=x onerror=alert(1)> 期望原文');

  assert.equal(model.cases[0].steps[0].verification.statement.text, SQL, '格式化不得回写模型');
  assert.equal(model.cases[0].steps[0].status, 'passed');
  assert.equal(model.evidenceById['ev-text'].content, '<img src=x onerror=alert(1)> 期望原文');
});

test('视图里的证据内容仍以文本展示，展开后走代码视图', () => {
  const model = V.buildModel(fixture());
  const html = V.renderEvidenceItems(['ev-text'], model.evidenceById);
  assert.ok(html.includes('查看原始内容'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(!/<img src=x/i.test(html));

  const json = V.renderEvidenceItems(['ev-json'], model.evidenceById);
  assert.ok(json.includes('class="code-view"'));
  assert.ok(json.includes('data-code-lang="json"'));
  assert.match(json, /class="hljs-attr">&quot;claim&quot;/);
});

test('切换按钮只决定显示“原文”还是“格式化”，文案随之变化', () => {
  assert.equal(CV.toggleLabel(false), '查看原文');
  assert.equal(CV.toggleLabel(true), '查看格式化');

  const html = CV.render({ text: SQL, hint: 'sql' });
  assert.ok(html.includes('aria-pressed="false"'));
  assert.ok(html.includes('<span data-code-toggle-label>查看原文</span>'));
  assert.ok(/data-code-mode="original"[^>]*hidden/.test(html), '默认展示格式化结果，原文折叠');
  assert.ok(!/data-code-mode="formatted"[^>]*hidden/.test(html));
});

/* ---------- 真实数据 ---------- */
projectTest('当前真实 SQL 报告：全部语句可格式化且内容不被改写', () => {
  const data = JSON.parse(fs.readFileSync(REAL_DATA, 'utf8'));
  const statements = [];
  data.cases.forEach((c) => (c.steps || []).forEach((s) => {
    const st = s.verification && s.verification.statement;
    if (st && st.kind === 'sql' && st.text) statements.push(st.text);
  }));
  assert.ok(statements.length >= 12, '真实报告中应有多条 SQL，实际 ' + statements.length);

  statements.forEach((sql) => {
    const result = CV.format(sql, 'sql');
    assert.equal(result.ok, true, '真实 SQL 不应格式化失败：' + sql.slice(0, 40));
    assert.notEqual(result.text, sql, '真实 SQL 应确实被重新排版');
    assert.equal(result.text.replace(/\s+/g, ''), sql.replace(/\s+/g, ''),
      '格式化只能改空白，不能增删任何字符');
    assert.ok(result.text.split('\n').length > 3, '真实 SQL 应是多行可读');
  });

  const model = V.buildModel(data);
  const rendered = V.renderConsole(model.cases[0].steps[0], model.cases[0], model, V.SPLIT.initial);
  assert.ok(rendered.includes('code-view') || rendered.includes('panel-note'));
});


test('HSF 和 DMS 的请求参数按内容识别为 JSON，控制台类型不能覆盖载荷语言', () => {
  const data = fixture();
  const model = V.buildModel(data);
  const c = model.cases[0];
  const step = c.steps[0];
  step.reproduction = {kind:'hsf',label:'HSFOps',urlStatus:'unavailable',reason:'未提供',params:'{"paymentOrderId":243001,"accountType":"BANK"}'};
  const html=V.renderInspector(step,c,model).html;
  assert.ok(html.includes('data-code-lang="json"'));
  assert.ok(html.includes('hljs-attr'));
});

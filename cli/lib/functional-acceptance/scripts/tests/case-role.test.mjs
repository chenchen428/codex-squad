import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import filterApi from '../../assets/shell/case-filter.js';
import { validateStructure } from '../lib/contract.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const CLI = path.join(ROOT, 'scripts', 'acceptance.mjs');

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ita-case-role-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function errorCodes(data) {
  return validateStructure(data).errors.map((item) => item.code);
}

function pageStep(id, status = 'not_run') {
  return {
    id,
    type: 'page',
    title: '页面 ' + id,
    page: '验收页面',
    action: '执行操作',
    expected: '展示结果',
    actual: status === 'passed' ? '已展示' : '未执行',
    status,
  };
}

function dataStep(id, status = 'not_run') {
  return {
    id,
    type: 'data',
    title: '数据 ' + id,
    action: '读取数据',
    expected: '数据一致',
    actual: status === 'passed' ? '一致' : '未执行',
    status,
  };
}

function failedCheck(id, stepId) {
  return { id, title: '核对 ' + id, expected: '一致', actual: '不一致', status: 'failed', stepId };
}

function makeCase(id, overrides = {}) {
  return Object.assign(
    {
      id,
      groupId: 'g1',
      title: '用例 ' + id,
      objective: '目标 ' + id,
      status: 'not_run',
      steps: [dataStep('s1')],
      checks: [],
    },
    overrides
  );
}

function makeData(cases) {
  return {
    schemaVersion: 1,
    report: { id: 'role-test', title: '分类测试', environment: '本地测试', example: true },
    groups: [{ id: 'g1', title: '分组一' }],
    cases,
  };
}

function withRole(caseRole, extra = {}) {
  return Object.assign({ caseRole }, extra);
}

function readPayload(out) {
  const htmlPath = path.join(out, 'index.html');
  if (!fs.existsSync(htmlPath)) return null;
  const html = fs.readFileSync(htmlPath, 'utf8');
  const matched = html.match(/<script type="application\/json" id="acceptance-data" nonce="[0-9a-f]+">([\s\S]*?)<\/script>/);
  return matched ? JSON.parse(matched[1]) : null;
}

function buildFromPath(t, input, name = 'pkg') {
  const out = path.join(tmpDir(t), name);
  const result = runCli(['build', input, '--out', out, '--json']);
  return { result, out, payload: readPayload(out) };
}

function buildFixture(t, data, name = 'pkg') {
  const dataDir = tmpDir(t);
  const input = path.join(dataDir, 'acceptance.json');
  fs.writeFileSync(input, JSON.stringify(data, null, 2));
  return buildFromPath(t, input, name);
}

test('旧样例省略 caseRole：validate/build 通过并按未分类展示', (t) => {
  const examplePath = path.join(ROOT, 'examples', 'acceptance.json');
  const validated = runCli(['validate', examplePath, '--json']);
  assert.equal(validated.status, 0, validated.stderr || validated.stdout);
  const report = JSON.parse(validated.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.errors.length, 0);

  const example = JSON.parse(fs.readFileSync(examplePath, 'utf8'));
  for (const item of example.cases) {
    assert.equal(item.caseRole, undefined);
    assert.equal(filterApi.roleOf(item), 'unknown');
  }

  const built = buildFromPath(t, examplePath);
  assert.equal(built.result.status, 0, built.result.stderr || built.result.stdout);
  assert.ok(built.payload, '验收包内联数据可解析');
  for (const item of built.payload.cases) assert.equal(filterApi.roleOf(item), 'unknown');
  for (const item of built.payload.cases) {
    const source = example.cases.find((c) => c.id === item.id);
    assert.equal(item.status, source.status);
  }
});

test('显式 unknown 允许不填依据，非法分类被拒绝', () => {
  assert.deepEqual(errorCodes(makeData([makeCase('U1', withRole('unknown'))])), []);

  const invalid = errorCodes(makeData([makeCase('U2', withRole('smoke'))]));
  assert.ok(invalid.includes('E_CASE_ROLE'), invalid.join(','));

  const wrongType = errorCodes(makeData([makeCase('U3', withRole(7))]));
  assert.ok(wrongType.includes('E_CASE_ROLE'), wrongType.join(','));
});

test('new/regression/mixed/audit 缺少原因或来源时拒绝', () => {
  for (const role of ['new', 'regression', 'mixed', 'audit']) {
    const none = errorCodes(makeData([makeCase('R-' + role, withRole(role))]));
    assert.ok(none.includes('E_CASE_ROLE_REASON_REQUIRED'), `${role}: ${none.join(',')}`);
    assert.ok(none.includes('E_CASE_ROLE_SOURCES_REQUIRED'), `${role}: ${none.join(',')}`);

    const reasonOnly = errorCodes(makeData([
      makeCase('R-' + role, withRole(role, { caseRoleReason: '需求新增行为' })),
    ]));
    assert.deepEqual(reasonOnly, ['E_CASE_ROLE_SOURCES_REQUIRED']);

    const sourcesOnly = errorCodes(makeData([
      makeCase('R-' + role, withRole(role, { caseRoleSources: ['需求说明'] })),
    ]));
    assert.deepEqual(sourcesOnly, ['E_CASE_ROLE_REASON_REQUIRED']);

    const blankSource = errorCodes(makeData([
      makeCase('R-' + role, withRole(role, { caseRoleReason: '依据', caseRoleSources: ['  '] })),
    ]));
    assert.ok(blankSource.includes('E_CASE_ROLE_SOURCES'), blankSource.join(','));

    const ok = errorCodes(makeData([
      makeCase('R-' + role, withRole(role, { caseRoleReason: '依据', caseRoleSources: ['需求说明'] })),
    ]));
    assert.deepEqual(ok, []);
  }

  const badReason = errorCodes(makeData([
    makeCase('R-bad', withRole('new', { caseRoleReason: 12, caseRoleSources: ['需求说明'] })),
  ]));
  assert.ok(badReason.includes('E_CASE_ROLE_REASON'), badReason.join(','));

  const badSources = errorCodes(makeData([
    makeCase('R-bad', withRole('new', { caseRoleReason: '依据', caseRoleSources: '需求说明' })),
  ]));
  assert.ok(badSources.includes('E_CASE_ROLE_SOURCES'), badSources.join(','));
});

test('mixed 只按一条计数，audit 独立成组', () => {
  const cases = [
    makeCase('N1', withRole('new', { caseRoleReason: '新增', caseRoleSources: ['需求'] })),
    makeCase('N2', withRole('new', { caseRoleReason: '新增', caseRoleSources: ['需求'] })),
    makeCase('M1', withRole('mixed', { caseRoleReason: '新增与存量', caseRoleSources: ['需求'] })),
    makeCase('A1', withRole('audit', { caseRoleReason: '执行审计', caseRoleSources: ['审计记录'] })),
    makeCase('U1'),
  ];
  const groups = [{ id: 'g1', title: '分组一' }];
  const counts = filterApi.counts(cases, groups, {});
  assert.equal(counts.role.all, 5);
  assert.equal(counts.role.new, 2);
  assert.equal(counts.role.regression, 0);
  assert.equal(counts.role.mixed, 1);
  assert.equal(counts.role.audit, 1);
  assert.equal(counts.role.unknown, 1);
  assert.equal(
    ['new', 'regression', 'mixed', 'audit', 'unknown'].reduce((sum, key) => sum + counts.role[key], 0),
    counts.role.all
  );

  const failedAudit = makeCase('A2', withRole('audit', {
    caseRoleReason: '审计执行失败，不代表产品失败',
    caseRoleSources: ['审计记录'],
    status: 'failed',
    steps: [dataStep('s1', 'failed')],
    checks: [failedCheck('c1', 's1')],
  }));
  const mixed = cases.concat(failedAudit);
  const next = filterApi.counts(mixed, groups, {});
  assert.equal(next.role.new, 2, '审计失败不并入测新');
  assert.equal(next.role.audit, 2);
  assert.equal(
    filterApi.matches(failedAudit, '分组一', { role: 'new' }),
    false,
    '审计记录不进入测新筛选'
  );
  assert.equal(filterApi.matches(failedAudit, '分组一', { role: 'audit' }), true);
});

test('审计执行失败不计入业务失败统计，原 status 保留', (t) => {
  const cases = [
    makeCase('B1', withRole('new', {
      caseRoleReason: '新增失败',
      caseRoleSources: ['需求'],
      status: 'failed',
      steps: [dataStep('s1', 'failed')],
      checks: [failedCheck('c1', 's1')],
    })),
    makeCase('B2', withRole('regression', {
      caseRoleReason: '存量通过',
      caseRoleSources: ['回归清单'],
      status: 'passed',
      steps: [dataStep('s1', 'passed')],
      checks: [{ id: 'c1', title: '核对', expected: '一致', actual: '一致', status: 'passed', stepId: 's1' }],
    })),
    makeCase('A1', withRole('audit', {
      caseRoleReason: '审计脚本执行失败，不代表产品失败',
      caseRoleSources: ['审计记录'],
      status: 'failed',
      steps: [dataStep('s1', 'failed')],
      checks: [failedCheck('c1', 's1')],
    })),
  ];
  const groups = [{ id: 'g1', title: '分组一' }];
  const counts = filterApi.counts(cases, groups, {});
  assert.deepEqual(counts.totals, { all: 3, business: 2, audit: 1 });
  assert.equal(counts.status.failed, 1, '业务失败只统计业务记录');
  assert.equal(counts.status.passed, 1);
  assert.equal(counts.status.all, 2, '业务状态筛选合计不含审计记录');
  assert.equal(counts.auditStatus.failed, 1, '审计执行失败单独计数');
  assert.equal(counts.auditStatus.all, 1);

  const auditCase = cases[2];
  assert.equal(filterApi.statusOf(auditCase), 'failed', '原 status 仍为 failed，不被改写');
  assert.equal(filterApi.matches(auditCase, '分组一', { status: 'failed' }), false, '业务失败筛选不含审计记录');
  assert.equal(filterApi.matches(auditCase, '分组一', { status: 'failed', role: 'audit' }), true, '执行审计目的下可按执行状态查看');
  assert.deepEqual(
    cases.filter((c) => filterApi.matches(c, '分组一', { status: 'failed' })).map((c) => c.id),
    ['B1'],
    '业务失败列表与计数一致'
  );

  const statusFailed = filterApi.counts(cases, groups, { status: 'failed' });
  assert.equal(statusFailed.role.audit, 1, '审计记录仍可从目的行进入');
  assert.equal(statusFailed.role.new, 1);

  const auditOnly = filterApi.counts(cases, groups, { role: 'audit' });
  assert.equal(auditOnly.status.all, 0, '执行审计目的下状态行不再统计业务记录');
  assert.equal(auditOnly.auditStatus.failed, 1, '执行审计目的下改看审计执行状态');

  const built = buildFixture(t, makeData(cases), 'audit-count');
  assert.equal(built.result.status, 0, built.result.stderr || built.result.stdout);
  const payloadAudit = built.payload.cases.find((c) => c.id === 'A1');
  assert.equal(payloadAudit.status, 'failed', '构建产物不改写审计记录原 status');
  assert.ok(payloadAudit.caseRole === 'audit' && payloadAudit.caseRoleReason, '产物保留分类目的与依据');
  const html = fs.readFileSync(path.join(built.out, 'index.html'), 'utf8');
  assert.equal((html.match(/id="acceptance-data"/g) || []).length, 1, '产物只有一个标准数据入口');
});

test('状态 / 目的 / 页面范围与搜索按 AND 组合，数量口径一致', () => {
  const cases = [
    makeCase('A', withRole('new', {
      caseRoleReason: '新增跳转',
      caseRoleSources: ['需求'],
      status: 'failed',
      steps: [pageStep('p1', 'failed')],
      checks: [failedCheck('c1', 'p1')],
    })),
    makeCase('B', withRole('regression', {
      caseRoleReason: '保护存量',
      caseRoleSources: ['回归清单'],
      status: 'failed',
      steps: [pageStep('p1', 'failed')],
      checks: [failedCheck('c1', 'p1')],
    })),
    makeCase('C', withRole('new', {
      caseRoleReason: '新增数据核对',
      caseRoleSources: ['需求'],
      status: 'failed',
      steps: [dataStep('d1', 'failed')],
      checks: [failedCheck('c1', 'd1')],
    })),
    makeCase('D', withRole('new', {
      caseRoleReason: '新增页面',
      caseRoleSources: ['需求'],
      status: 'passed',
      steps: [pageStep('p1', 'passed')],
      checks: [{ id: 'c1', title: '核对', expected: '展示', actual: '已展示', status: 'passed', stepId: 'p1' }],
    })),
    makeCase('E', withRole('mixed', {
      caseRoleReason: '新增与存量',
      caseRoleSources: ['需求'],
      status: 'failed',
      steps: [dataStep('d1', 'failed')],
      checks: [failedCheck('c1', 'd1')],
    })),
  ];
  const groups = [{ id: 'g1', title: '分组一' }];
  const ids = (filters) => cases.filter((c) => filterApi.matches(c, '分组一', filters)).map((c) => c.id);

  assert.deepEqual(ids({ status: 'failed', role: 'new', page: 'data' }), ['C']);
  assert.deepEqual(ids({ status: 'failed', role: 'new', page: 'page' }), ['A']);
  assert.deepEqual(ids({ status: 'failed', role: 'new', page: 'data', query: 'C' }), ['C']);
  assert.deepEqual(ids({ status: 'failed', role: 'new', page: 'data', query: 'B' }), []);
  assert.deepEqual(ids({ role: 'new', page: 'page' }), ['A', 'D']);
  assert.deepEqual(ids({ status: 'passed', page: 'page' }), ['D']);
  assert.deepEqual(ids({ role: 'regression' }), ['B']);
  assert.deepEqual(ids({ role: 'mixed', page: 'data' }), ['E']);
  assert.deepEqual(ids({ query: '新增页面' }), ['D']);

  const counts = filterApi.counts(cases, groups, { role: 'new', page: 'data' });
  assert.equal(counts.status.all, 1);
  assert.equal(counts.status.failed, 1);
  assert.equal(counts.status.passed, 0);
  assert.equal(counts.role.all, 2, '目的“全部”= 其余条件不变时的记录数');
  assert.equal(counts.page.all, 3, '范围“全部”= 测新用例数');
  assert.equal(counts.role.new, 1);
  assert.equal(counts.page.data, 1);
});

test('build 保留原 status/actual/checks，mixed 与 audit 不改变执行事实', (t) => {
  const mixed = makeCase('M1', withRole('mixed', {
    caseRoleReason: '新增与存量',
    caseRoleSources: ['需求说明', '回归清单'],
    status: 'failed',
    steps: [dataStep('d1', 'failed')],
    checks: [failedCheck('c1', 'd1')],
  }));
  const audit = makeCase('A1', withRole('audit', {
    caseRoleReason: '审计失败',
    caseRoleSources: ['审计记录'],
    status: 'failed',
    steps: [dataStep('d2', 'failed')],
    checks: [failedCheck('c2', 'd2')],
  }));
  const input = makeData([mixed, audit]);
  const built = buildFixture(t, input, 'mixed-audit');
  assert.equal(built.result.status, 0, built.result.stderr || built.result.stdout);
  assert.ok(built.payload);

  for (const source of input.cases) {
    const target = built.payload.cases.find((c) => c.id === source.id);
    assert.equal(target.status, source.status);
    assert.equal(target.caseRole, source.caseRole);
    source.steps.forEach((step, index) => {
      assert.equal(target.steps[index].status, step.status);
      assert.equal(target.steps[index].actual, step.actual);
    });
    source.checks.forEach((check, index) => {
      assert.equal(target.checks[index].status, check.status);
      assert.equal(target.checks[index].actual, check.actual);
    });
  }
  assert.equal(filterApi.counts(input.cases, input.groups, {}).role.mixed, 1);
  assert.equal(filterApi.counts(input.cases, input.groups, {}).role.audit, 1);
});

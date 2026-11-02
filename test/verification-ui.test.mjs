// 右上角核验状态与最新结论弹层的模型测试：只认真实 acceptance，核验中不回退到旧结论。
import test from 'node:test';
import assert from 'node:assert/strict';
import {formatDateTime, verificationModel} from '../cli/ui/runtime-info-model.mjs';

function task(overrides = {}) {
  return {id: 't1', title: '修复报表筛选', memberId: 'm1', status: 'accepted', attempts: [], ...overrides};
}

function accepted(index, acceptance = {}, overrides = {}) {
  return {
    id: `attempt-${index}`,
    index,
    status: 'accepted',
    verification: {attemptId: `attempt-${index}`, index, at: '2026-10-27T04:00:00.000Z'},
    acceptance: {at: '2026-10-27T04:05:06.000Z', note: `第 ${index} 轮验收说明`, ...acceptance},
    ...overrides,
  };
}

function verifying(index, overrides = {}) {
  return {
    id: `attempt-${index}`,
    index,
    status: 'verifying',
    verification: {attemptId: `attempt-${index}`, index, at: '2026-10-27T04:00:00.000Z'},
    ...overrides,
  };
}

test('同一任务多次核验只暴露最新一次结论，旧结论仅内部保留', () => {
  const model = verificationModel(task({
    attempts: [
      accepted(1, {note: '第一轮验收'}, {acceptance: {at: '2026-10-26T05:00:00.000Z', note: '第一轮验收'}}),
      accepted(2, {note: '第二轮验收'}, {acceptance: {at: '2026-10-27T05:00:00.000Z', note: '第二轮验收'}}),
    ],
  }));
  assert.equal(model.count, 2);
  assert.equal(model.stampCount, 2);
  assert.deepEqual(model.entries.map(entry => entry.attemptIndex), [1, 2]);
  assert.equal(model.latest.attemptIndex, 2);
  assert.equal(model.latest.accepted, true);
  assert.equal(model.latest.title, 'Codex 已核验');
  assert.equal(model.latest.sheet.note.text, '第二轮验收');
  assert.equal(model.latest.sheet.subtitle, `核验时间：${formatDateTime('2026-10-27T05:00:00.000Z')}`);
  assert.doesNotMatch(JSON.stringify(model.latest), /第一轮验收/);
});

test('最新一轮正在核验时不回退到旧已通过结论', () => {
  const model = verificationModel(task({
    status: 'verifying',
    attempts: [accepted(1, {note: '第一轮验收'}), verifying(2)],
  }));
  assert.equal(model.count, 2);
  assert.equal(model.stampCount, 1);
  assert.equal(model.latest.attemptIndex, 2);
  assert.equal(model.latest.status, 'verifying');
  assert.equal(model.latest.accepted, false);
  assert.equal(model.latest.title, 'Codex 核验中');
  assert.equal(model.latest.entryLabel, '查看结论');
  assert.equal(model.latest.sheet.note.text, null);
  assert.equal(model.latest.sheet.warning, null);
  const serialized = JSON.stringify(model.latest);
  assert.doesNotMatch(serialized, /第一轮验收|已核验|已通过/);
});

test('核验中且尚未上报时间时如实说未上报，不冒充已核验', () => {
  const model = verificationModel(task({
    status: 'verifying',
    attempts: [{id: 'a1', index: 1, status: 'verifying'}],
  }));
  assert.equal(model.latest.status, 'verifying');
  assert.equal(model.latest.sheet.subtitle, '提交核验时间未上报');
  assert.equal(model.latest.sheet.note.present, false);
  assert.equal(model.latest.sheet.note.emptyText, '验收记录未提供说明（未上报）。');
  assert.doesNotMatch(JSON.stringify(model.latest), /已通过|已核验/);
});

test('已核验弹层只含最新结论、验收时间与真实说明', () => {
  const model = verificationModel(task({
    attempts: [accepted(1, {
      note: '逐条核对筛选边界，本地报告页通过。',
      files: [{path: 'cli/ui/app.tsx', sha256: 'abcdef0123456789'}],
      fingerprint: 'fp-1',
      currentFingerprint: 'fp-2',
      diff: '+added line',
    })],
  }));
  const entry = model.latest;
  assert.equal(entry.sheet.title, '核验结论');
  assert.equal(entry.sheet.badge, 'Codex 已核验');
  assert.equal(entry.sheet.note.label, '核验结果说明');
  assert.equal(entry.sheet.note.text, '逐条核对筛选边界，本地报告页通过。');
  assert.equal('meta' in entry.sheet, false);
  assert.equal(entry.sheet.subtitle, `核验时间：${formatDateTime('2026-10-27T04:05:06.000Z')}`);
  assert.equal((JSON.stringify(entry.sheet).match(/核验时间：/g) || []).length, 1);
  const serialized = JSON.stringify(entry.sheet);
  assert.doesNotMatch(serialized, /cli\/ui\/app\.tsx|abcdef0123456789|fp-1|fp-2|\+added line|files|fingerprint|diff/);
  assert.doesNotMatch(serialized, /attempt|轮次|历史|盖章/);
});

test('验收说明未上报时标为未上报，不补写免责声明', () => {
  const model = verificationModel(task({
    attempts: [{id: 'a1', index: 1, status: 'accepted', acceptance: {at: '2026-10-27T04:05:06.000Z'}}],
  }));
  const sheet = model.latest.sheet;
  assert.equal(sheet.note.present, false);
  assert.equal(sheet.note.text, null);
  assert.equal(sheet.note.emptyText, '验收记录未提供说明（未上报）。');
  assert.equal(sheet.subtitle, `核验时间：${formatDateTime('2026-10-27T04:05:06.000Z')}`);
  assert.equal('meta' in sheet, false);
  assert.doesNotMatch(JSON.stringify(sheet), /测试通过|全部测试|文件清单|指纹|files|fingerprint/);
});

test('没有核验事实时不产生右上角状态', () => {
  const model = verificationModel(task({status: 'done', attempts: [{id: 'a1', index: 1, status: 'done'}]}));
  assert.equal(model.latest, null);
  assert.equal(model.hasRecords, false);
  assert.equal(model.count, 0);
  assert.equal(model.stampCount, 0);
  assert.deepEqual(model.entries, []);
});

test('顶层验收记录作为回退来源，不编造尝试序号', () => {
  const model = verificationModel(task({
    acceptance: {at: '2026-10-27T04:05:06.000Z', note: '顶层验收说明'},
    verification: {attemptId: 'x', at: '2026-10-27T04:00:00.000Z'},
  }));
  assert.equal(model.latest.attemptIndex, null);
  assert.equal(model.latest.title, 'Codex 已核验');
  assert.equal(model.latest.sheet.note.text, '顶层验收说明');
});

test('后续文件变化不增加过程提示，仍只展示该次核验结论', () => {
  const model = verificationModel(task({
    attempts: [accepted(1, {
      note: '验收时通过，覆盖报表筛选。',
      changedSinceVerification: true,
      fingerprint: 'fp-old',
      currentFingerprint: 'fp-new',
    })],
  }));
  const entry = model.latest;
  assert.equal(entry.accepted, true);
  assert.equal(entry.sheet.changed, true);
  assert.equal(entry.sheet.warning, null);
  assert.equal(entry.sheet.note.text, '验收时通过，覆盖报表筛选。');
  assert.doesNotMatch(JSON.stringify(entry.sheet), /fp-old|fp-new|fingerprint/);
});

test('停止状态保留在真实核验结论弹层中', () => {
  const stop = {requestedAt: '2026-10-27T03:00:00.000Z', reason: '用户主动停止', state: 'stopped'};
  const stoppedOnly = verificationModel(task({
    status: 'stopped',
    stop,
    attempts: [{id: 'a1', index: 1, status: 'stopped'}],
  }));
  assert.equal(stoppedOnly.latest, null);
  assert.equal(stoppedOnly.stop.state, 'stopped');

  const acceptedThenStop = verificationModel(task({status: 'accepted', stop, attempts: [accepted(1)]}));
  assert.equal(acceptedThenStop.latest.sheet.stop.state, 'stopped');
  assert.equal(acceptedThenStop.latest.sheet.stop.label, '已停止');
  assert.equal(acceptedThenStop.latest.sheet.stop.reason, '用户主动停止');
  assert.equal(acceptedThenStop.latest.sheet.stop.requestedLabel, formatDateTime(stop.requestedAt));
});

test('模型不暴露底部核验账本所需的历史数量入口', () => {
  const model = verificationModel(task({attempts: [accepted(1), verifying(2)]}));
  const serialized = JSON.stringify(model.latest);
  assert.doesNotMatch(serialized, /为什么盖章|盖章|尝试#|阶段性存档|核验执行/);
  assert.equal(model.latest.entryLabel, '查看结论');
});

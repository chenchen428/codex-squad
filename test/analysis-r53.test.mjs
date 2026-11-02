import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {analysisObservations, observationStages} from '../cli/ui/analysis-report.mjs';

const DESIGN = new URL('../cli/ui/design/v9/analytics-r53-original.html', import.meta.url);
const EXPORTED_CSS = new URL('../cli/ui/design/v9/r53-exported.css', import.meta.url);
const SOURCE = new URL('../cli/ui/design/v9/source.json', import.meta.url);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function savedData(categories) {
  return {
    analysis: {
      statsAvailable: true,
      available: true,
      summary: '本轮依据已保存执行快照提炼。',
      categories,
    },
    tasks: [],
    sessions: [],
  };
}

test('R53 原始稿与导出 CSS 逐字节保存，并与来源记录一致', async () => {
  const [html, css, rawSource] = await Promise.all([
    readFile(DESIGN, 'utf8'),
    readFile(EXPORTED_CSS, 'utf8'),
    readFile(SOURCE, 'utf8'),
  ]);
  const source = JSON.parse(rawSource);
  const htmlHash = sha256(html);
  const cssHash = sha256(css);

  assert.equal(htmlHash, 'ddf3a1ed1235ee61f61aca85c9f69843ad87c6e02e817198319a01ba93b0dcd4');
  assert.equal(source.files['analytics-r53-original.html'], htmlHash);
  assert.equal(source.files['r53-exported.css'], cssHash);
  assert.ok(source.screens.some(screen => screen.name.endsWith('ea897eb4f2d844a6a1fbeb75de52a48d') && screen.sha256 === htmlHash));
  assert.equal(source.r53AnalysisDecision.screen, 'ea897eb4f2d844a6a1fbeb75de52a48d');
});

test('四段式问题卡按真实字段映射顺序固定', () => {
  const stages = observationStages({
    title: '重复执行简单检查',
    observation: '同一会话出现重复命令。',
    action: '简单命令由主线程直接执行。',
    verification: '下一轮不再创建同类小队任务。',
  });

  assert.deepEqual(stages.map(stage => stage.key), ['problem', 'evidence', 'next', 'verification']);
  assert.deepEqual(stages.map(stage => stage.label), ['【具体问题】', '【相关证据】', '【下一步】', '【验证方法】']);
  assert.deepEqual(stages.map(stage => stage.text), [
    '重复执行简单检查',
    '同一会话出现重复命令。',
    '简单命令由主线程直接执行。',
    '下一轮不再创建同类小队任务。',
  ]);
  assert.deepEqual(stages.map(stage => stage.missing), [false, false, false, false]);
});

test('已保存分析缺失段落时明确说明，不用推测补位', () => {
  const stages = observationStages({title: '仅保存了问题标题'});

  assert.equal(stages[0].missing, false);
  assert.equal(stages[0].text, '仅保存了问题标题');
  for (const stage of stages.slice(1)) {
    assert.equal(stage.missing, true);
    assert.match(stage.text, /已保存分析未提供/);
  }
});

test('问题列表只消费同轮已保存观察，空分析不生成条目', () => {
  const model = analysisObservations(savedData({
    skills_tools: [{
      title: '检查被重复执行',
      observation: '派工后主线程再次执行同类命令。',
      action: '简单命令不再派工。',
      verification: '命令结果由主线程直接返回。',
      evidenceRefs: [],
    }],
    time: [],
    tokens: [],
  }));
  assert.equal(model.total, 1);
  assert.equal(model.empty, false);
  assert.equal(model.items[0].title, '检查被重复执行');
  assert.deepEqual(observationStages(model.items[0]).map(stage => stage.text), [
    '检查被重复执行',
    '派工后主线程再次执行同类命令。',
    '简单命令不再派工。',
    '命令结果由主线程直接返回。',
  ]);

  const unavailable = analysisObservations({analysis: {statsAvailable: true, available: false}, tasks: [], sessions: []});
  assert.equal(unavailable.total, 0);
  assert.equal(unavailable.empty, true);
});

// 周期分析报告纯视图模型的行为测试：只断言用户可观察的合同（观察上限、空态、未上报、链接归属、状态机、双执行器对齐）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {aggregateAnalytics} from '../cli/lib/analytics.mjs';
import {buildSquadBenefits} from '../cli/lib/squad-benefits.mjs';
import {
  analysisObservations, analysisStatus, analyticsRequestPath, cliView, codexThreadUrl, codexUsageView,
  deliveryEfficiency, kpiCards, mergeAnalyticsSnapshot, qoderUsageView, readAnalyticsSnapshot, reportModel,
  reportWindow, RANGE_OPTIONS, sessionRows, skillRows, squadBenefits, trendSeries, UNREPORTED,
  usageComparison, usageView,
} from '../cli/ui/analysis-report.mjs';

const SCOPE_TASK_URL = 'https://scope.example/scene-token/#session/a1';
const SCOPE_OVERVIEW_URL = 'https://scope.example/scene-token/#overview';

test('CLI 名称不重复，执行成功的业务失败仍可展开查看',()=>{
  const model=cliView(stats({capabilities:{cli:{rows:[{name:'lgb',command:'lgb capability invoke',calls:1,execution:{succeeded:1,failed:0,unknown:0},business:{succeeded:0,failed:1,unknown:0},failures:[{category:'business',count:1}],sessions:[]}]}}}));
  assert.equal(model.rows[0].title,'lgb capability invoke');
  assert.equal(model.rows[0].failures,1);
  assert.equal(model.rows[0].hasFailures,true);
  assert.equal(model.rows[0].failureCategories[0].label,'业务调用失败');
});

function stats(overrides = {}) {
  const base = {
    schemaVersion: 1,
    scope: 'global',
    observedAt: '2026-10-22T08:00:00.000Z',
    range: {days: 7, from: '2026-10-16T00:00:00.000Z', to: '2026-10-22T08:00:00.000Z'},
    analysis: {available: false, statsAvailable: true},
    metrics: {
      sessionCount: 1, taskCount: 10, attemptCount: 4, continuationCount: 0,
      running: 3, returned: 5, accepted: 4, failed: 0, stopped: 0, unknown: 0,
      blocked: 1, pending: 1, failedAttempts: 0,
      firstReturn: {numerator: 0, denominator: 0, rate: null}, completedDurationMs: 0,
    },
    tokens: {
      inputTokens: 1000, outputTokens: 250, cachedInputTokens: 500, totalTokens: 1250,
      reportedAttempts: 4, totalAttempts: 4,
      coverage: {
        inputTokens: {reported: 4, total: 4},
        outputTokens: {reported: 4, total: 4},
        cachedInputTokens: {reported: 4, total: 4},
        totalTokens: {reported: 4, total: 4},
      },
      models: [], mainSession: 'unavailable', mainSessionNote: '',
    },
    trend: [{date: '2026-10-20', attempts: 2, reportedAttempts: 2, tokens: {inputTokens: 10, outputTokens: 5}}],
    tasks: [{threadId: 't1', id: 'a1', title: '订单工作台'}],
    sessions: [{
      threadId: 't1', title: '本地会话标题', summary: '本地会话摘要',
      representativeTasks: [{id: 'a1', title: '订单工作台', goal: '修复筛选边界'}],
      taskCount: 10, attemptCount: 4, continuationCount: 0, running: 3, returned: 0,
      accepted: 4, failed: 0, stopped: 0, unknown: 0,
      tokens: {inputTokens: 1000, outputTokens: 250, cachedInputTokens: 500, totalTokens: 1250},
      links: {overview: SCOPE_OVERVIEW_URL, tasks: [{taskId: 'a1', url: SCOPE_TASK_URL}]},
    }],
    capabilities: {tools: [], skillReads: [], activation: null, activationNote: ''},
    insights: [],
  };
  const merged = {...base, ...overrides};
  if (overrides.metrics) merged.metrics = {...base.metrics, ...overrides.metrics};
  if (overrides.tokens) merged.tokens = {...base.tokens, ...overrides.tokens};
  return merged;
}

function withAnalysis(analysis, overrides = {}) {
  return {...stats(overrides), analysis: {statsAvailable: true, ...analysis}};
}

function emptyStats(analysis = {available: false, statsAvailable: false, reason: 'NO_SUCCESSFUL_REPORT'}) {
  return {
    schemaVersion: 1,
    scope: 'global',
    observedAt: '2026-10-22T08:00:00.000Z',
    range: {days: 7, from: '2026-10-16T00:00:00.000Z', to: '2026-10-22T08:00:00.000Z'},
    metrics: {
      sessionCount: 0, taskCount: 0, attemptCount: 0, continuationCount: 0,
      running: 0, returned: 0, accepted: 0, failed: 0, stopped: 0, unknown: 0,
      blocked: 0, pending: 0, failedAttempts: 0,
      firstReturn: {numerator: 0, denominator: 0, rate: null}, completedDurationMs: 0,
    },
    tokens: {
      inputTokens: null, outputTokens: null, cachedInputTokens: null, totalTokens: null,
      reportedAttempts: 0, totalAttempts: 0,
      coverage: {
        inputTokens: {reported: 0, total: 0},
        outputTokens: {reported: 0, total: 0},
        cachedInputTokens: {reported: 0, total: 0},
        totalTokens: {reported: 0, total: 0},
      },
      models: [], mainSession: 'unavailable', mainSessionNote: '',
    },
    trend: [], tasks: [], sessions: [],
    capabilities: {tools: [], skillReads: [], activation: null, activationNote: ''},
    insights: [],
    coverage: {sources: {expected: 0, loaded: 0, unavailable: []}},
    analysis,
  };
}

function suggestion(title, refs) {
  return {title, observation: '证据说明', action: '动作', verification: '验证', evidenceRefs: refs};
}

function usageFixture() {
  return {
    schemaVersion: 1,
    available: true,
    observedAt: '2026-10-22T08:00:00.000Z',
    scope: 'local',
    totals: {inputTokens: 8000, cachedInputTokens: 3000, outputTokens: 2000, totalTokens: 10000},
    sessions: [
      {
        threadId: 't1', title: '订单工作台会话', kind: 'squad', squadThreadId: 's1',
        models: [{model: 'gpt-5-codex', totalTokens: 7000}],
        totalTokens: 7000, turnCount: 12,
      },
      {
        threadId: 't2', title: '周期分析报告', kind: 'analysis',
        models: [{model: 'gpt-5-codex', totalTokens: 2000}],
        totalTokens: 2000, turnCount: 2,
      },
      {
        threadId: 't3', title: '未关联会话', kind: 'unassigned',
        models: [{model: 'gpt-5', totalTokens: 1000}],
        totalTokens: 1000, turnCount: 1,
      },
    ],
    models: [
      {model: 'gpt-5-codex', totalTokens: 9000},
      {model: 'gpt-5', totalTokens: 1000},
    ],
    coverage: {threads: 4, readableThreads: 3, missingThreads: 1, unattributedModelRecords: 2},
    note: '仅统计本机记录',
  };
}

test('观察条目按类别顺序扁平输出，每类最多三条且保留轻量分类标签', () => {
  const data = withAnalysis({
    available: true,
    summary: '本轮主要问题是重复扫描和长尾命令。',
    categories: {
      skills_tools: [suggestion('s1', ['task:t1:a1']), suggestion('s2', []), suggestion('s3', []), suggestion('s4', [])],
      time: [suggestion('t1', [])],
      tokens: [],
    },
  });
  const observations = analysisObservations(data);
  assert.equal(observations.hasSummary, true);
  assert.equal(observations.intro, '本轮主要问题是重复扫描和长尾命令。');
  assert.equal(observations.total, 4);
  assert.deepEqual(observations.items.map(item => item.title), ['s1', 's2', 's3', 't1']);
  assert.deepEqual(observations.items.map(item => item.categoryLabel), ['技能与工具', '技能与工具', '技能与工具', '耗时与节奏']);
  assert.deepEqual(observations.items.map(item => item.number), ['01', '02', '03', '04']);
  assert.equal(observations.empty, false);
});

test('观察流没有机械三分组容器，空态与未生成状态如实区分', () => {
  const empty = analysisObservations(withAnalysis({available: false, reason: 'NO_SUCCESSFUL_REPORT'}));
  assert.equal(empty.empty, true);
  assert.equal(empty.items.length, 0);
  assert.match(empty.emptyText, /尚未生成观察/);
  assert.match(empty.intro, /尚未生成/);

  const noSnapshot = analysisObservations(emptyStats());
  assert.equal(noSnapshot.empty, true);
  assert.match(noSnapshot.emptyText, /尚无统计快照/);
  assert.match(noSnapshot.intro, /统计尚未生成/);

  const availableEmpty = analysisObservations(withAnalysis({available: true}));
  assert.equal(availableEmpty.empty, true);
  assert.match(availableEmpty.emptyText, /没有可用的观察条目/);
  assert.equal(Object.hasOwn(availableEmpty, 'groups'), false);
});

test('无报告时不出现示例数据，观察流为空且保留真实统计', () => {
  const data = withAnalysis({available: false, reason: 'NO_SUCCESSFUL_REPORT'});
  const model = reportModel(data, {days: null, rank: 'tokens'}, {currentThreadId: 't1'});
  assert.doesNotMatch(JSON.stringify(model), /示例/);
  assert.equal(model.observations.empty, true);
  assert.equal(model.observations.items.length, 0);
  assert.equal(model.highlight.showLink, false);
  assert.equal(model.state.available, false);
  // 冻结统计仍如实展示，但只来自真实快照而非占位数据。
  assert.equal(model.sessions.rows.length, 1);
  assert.equal(model.sessions.rows[0].title, '本地会话标题');
});

test('未上报不按 0 计算：token 显示未上报，缺失尝试单独计数', () => {
  const data = withAnalysis({available: false}, {
    tokens: {totalTokens: null, inputTokens: null, outputTokens: null, cachedInputTokens: null, reportedAttempts: 0, totalAttempts: 4},
    metrics: {attemptCount: 4},
  });
  const cards = kpiCards(data);
  assert.equal(cards[0].value, UNREPORTED);
  assert.equal(cards[0].badge.text, '0/4 尝试已报');
  assert.deepEqual(cards[0].footer.map(item => item.text), [`入 ${UNREPORTED}`, `出 ${UNREPORTED}`, '4 次未上报']);
});

test('缓存命中率仅在覆盖完整且分母有效时计算', () => {
  const partial = kpiCards(withAnalysis({available: false}, {
    tokens: {inputTokens: 100, cachedInputTokens: 50, coverage: {inputTokens: {reported: 1, total: 2}, cachedInputTokens: {reported: 1, total: 2}}},
  }));
  assert.equal(partial[1].badge.text, '命中率未上报');

  const full = kpiCards(withAnalysis({available: false}));
  assert.equal(full[1].badge.text, '50.0% 命中');
});

test('会话排行只保留宿主标题、计数和可读入口，不泄漏技术摘要与原生任务 ID', () => {
  const data = withAnalysis({
    available: true,
    sessionDescriptions: [{threadId: 't1', title: '模型标题', description: '模型描述', taskLinks: [{taskId: 'a1', url: SCOPE_TASK_URL}]}],
  });
  const row = sessionRows(data).rows[0];
  assert.equal(row.title, '本地会话标题');
  assert.equal(row.scopeLabel, '查看小队');
  assert.equal(row.codexLabel, '打开会话');
  assert.equal(row.taskCount, 10);
  assert.equal(row.attempts, 4);
  assert.equal(row.tokenLabel, '1.3K');
  assert.equal('description' in row, false);
  assert.equal('representative' in row, false);
  assert.equal('taskId' in row, false);
  const serialized = JSON.stringify(row);
  assert.doesNotMatch(serialized, /模型描述|本地会话摘要|修复筛选边界|task:t1/);
});

test('任务详情链接取原归属 scope URL，Codex 链接取真实 threadId', () => {
  const row = sessionRows(withAnalysis({available: true})).rows[0];
  assert.equal(row.scopeHref, SCOPE_TASK_URL);
  assert.equal(row.hasScope, true);
  assert.equal(row.codexHref, 'codex://threads/t1');
  assert.match(row.scopeHref, /#session\/a1$/);
});

test('无 scope 入口时不编造任务链接，但保留真实 Codex 会话链接', () => {
  const data = withAnalysis({available: true}, {
    sessions: [{threadId: 't9', title: '无链接会话', summary: '', representativeTasks: [{id: 'b1', title: '任务'}], taskCount: 1, attemptCount: 1, tokens: {totalTokens: null}}],
  });
  const row = sessionRows(data).rows[0];
  assert.equal(row.hasScope, false);
  assert.equal(row.scopeHref, null);
  assert.equal(row.hasCodex, true);
  assert.equal(row.codexHref, 'codex://threads/t9');
});

test('观察证据只暴露可读任务链接，未知引用降级为证据名且不带原生 ID', () => {
  const data = withAnalysis({
    available: true,
    categories: {skills_tools: [suggestion('收敛规则', [
      'task:t1:a1', 'metric:t1:a1:totalTokens', 'thread:t1', 'task:ghost:nope',
    ])], time: [], tokens: []},
  });
  const item = analysisObservations(data).items[0];
  // 同一任务下的 task/metric 引用合并为一条可读任务入口，不重复堆叠同一链接。
  assert.deepEqual(item.refs.map(ref => ref.href), [SCOPE_TASK_URL, SCOPE_OVERVIEW_URL]);
  assert.equal(item.refs[0].label, '订单工作台');
  assert.equal(item.refs[1].label, '本地会话标题');
  assert.deepEqual(item.evidenceNames, ['查看关联任务']);
  assert.equal(item.hasDetails, true);
  const serialized = JSON.stringify(item);
  assert.doesNotMatch(serialized, /task:|metric:|totalTokens|ghost/);
});

test('报告窗口来自冻结快照，选择区间不改变已展示范围', () => {
  const data = withAnalysis({available: true, window: {days: 7, from: '2026-10-16T00:00:00.000Z', to: '2026-10-22T08:00:00.000Z'}});
  const window = reportWindow(data);
  assert.equal(window.days, 7);
  assert.equal(reportModel(data, {days: 30, rank: 'tokens'}).windowDays, 7);
  assert.deepEqual(RANGE_OPTIONS.map(option => option.days), [7, 30, null]);
  assert.match(window.summary, /近 7 天/);
});

test('运行中与失败都只给只读状态，不提供再次发起入口', () => {
  const running = analysisStatus(withAnalysis({available: false, latestRun: {runId: 'r1', status: 'running', phase: 'analyzing'}}), {});
  assert.equal(running.phase, 'running');
  assert.equal(running.badge.text, '报告正在更新');
  assert.equal('canRun' in running, false);

  const failed = analysisStatus(withAnalysis({available: true, runId: 'r0', latestRun: {runId: 'r1', status: 'failed', error: '采集失败'}}), {});
  assert.equal(failed.phase, 'failed');
  assert.equal(failed.available, true);
  assert.equal('canRun' in failed, false);
  assert.match(failed.badge.text, /保留上次成功报告/);
});

test('状态只描述已保存报告与更新时间，不暴露分析会话链接', () => {
  const idle = analysisStatus(withAnalysis({available: false}), {});
  assert.equal(idle.badge.text, '统计已更新 · 尚无报告');
  assert.equal(Object.hasOwn(idle, 'hasSession'), false);
  assert.equal(Object.hasOwn(idle, 'codexUrl'), false);
  const running = analysisStatus(withAnalysis({available: false, latestRun: {status: 'running', realCodexThreadId: 'codex-9'}}), {});
  assert.equal(Object.hasOwn(running, 'codexUrl'), false);
  assert.match(running.note, /正在更新/);
});

function efficiencyTasks() {
  return [
    {id: 'a1', threadId: 't1', title: '订单工作台', accepted: true, terminal: true, category: 'returned', fullAttemptCount: 1, attemptCount: 1, failedAttempts: 0, durationMs: 60000, tokens: {totalTokens: 1000}},
    {id: 'b1', threadId: 't1', title: '库存同步', accepted: false, terminal: false, category: 'running', fullAttemptCount: 2, attemptCount: 2, failedAttempts: 1, runningDurationMs: 2000, tokens: {totalTokens: 500}},
    {id: 'c1', threadId: 't2', title: '未知任务', accepted: false, terminal: true, category: 'failed', fullAttemptCount: 3, attemptCount: 3, failedAttempts: 2, tokens: {totalTokens: null}},
    {id: 'd1', threadId: 't1', title: '退款修复', accepted: true, terminal: true, category: 'returned', fullAttemptCount: 2, attemptCount: 2, failedAttempts: 0, durationMs: 1000, tokens: {totalTokens: 2000}},
  ];
}

test('优先跟进只列真实未核验工作，执行轮次与失败次数按事实陈述', () => {
  const view = deliveryEfficiency(stats({tasks: efficiencyTasks()}));
  assert.equal(view.available, true);
  assert.equal(view.empty, false);
  assert.equal(view.headline, '[ 优先跟进 · FOCUS NOW ]');
  assert.equal(view.focusTitle, '优先跟进这几项工作');
  assert.match(view.focusIntro, /已有较多投入，还没有核验结论/);
  assert.equal(Object.hasOwn(view, 'metrics'), false);
  assert.equal(view.focusTotal, 1);
  assert.equal(view.focusEmpty, false);
  const [focus] = view.focus;
  assert.equal(focus.title, '库存同步');
  assert.deepEqual([focus.rounds, focus.attempts, focus.failedAttempts], [2, 2, 1]);
  assert.equal(focus.roundsLabel, '执行 2 轮');
  assert.equal(focus.failureLabel, '失败 1 次');
  assert.equal(focus.tokenLabel, '500');
  assert.equal(focus.durationLabel, '0:02');
  assert.equal(focus.linkLabel, '查看结果');
  assert.equal(focus.hasScope, true);
  assert.equal(focus.scopeHref, SCOPE_OVERVIEW_URL);
  assert.equal(view.focusNote, '');
  const serialized = JSON.stringify(view);
  assert.doesNotMatch(serialized, /返工率|低效|浪费|收益|质量评分|原因/);
  assert.doesNotMatch(serialized, /一次执行完成|unverified-investment/);
});

test('优先跟进最多三项，按已报 Token 取最高投入且缺失轮次不补零', () => {
  const tasks = Array.from({length: 5}, (_, index) => ({
    id: `f${index}`, threadId: 't1', title: `待核验 ${index}`,
    accepted: false, terminal: index % 2 === 0, category: 'returned',
    fullAttemptCount: index === 4 ? null : index + 1,
    attemptCount: index + 2, failedAttempts: index,
    tokens: {totalTokens: (index + 1) * 100},
  }));
  tasks.push({id: 'skip', threadId: 't1', title: '已核验', accepted: true, tokens: {totalTokens: 99999}});
  tasks.push({id: 'silent', threadId: 't1', title: '未报用量', accepted: false, tokens: {totalTokens: null}});
  const view = deliveryEfficiency(stats({tasks}));
  assert.equal(view.focusTotal, 5);
  assert.equal(view.focus.length, 3);
  assert.deepEqual(view.focus.map(item => item.title), ['待核验 4', '待核验 3', '待核验 2']);
  assert.equal(view.focus[0].rounds, null);
  assert.equal(view.focus[0].roundsLabel, '轮次未记录');
  assert.equal(view.focus[0].tokenLabel, '500');
  assert.equal(view.focusNote, '按已报 Token 展示前 3 个，共 5 个未核验任务。');
  assert.equal(JSON.stringify(view.focus).includes('已核验'), false);
  assert.equal(JSON.stringify(view.focus).includes('未报用量'), false);
});

test('优先跟进没有可列任务或统计时如实空态，不补零也不推断原因', () => {
  const noTasks = deliveryEfficiency(stats({tasks: []}));
  assert.equal(noTasks.available, false);
  assert.equal(noTasks.empty, true);
  assert.equal(noTasks.focusEmpty, true);
  assert.equal(noTasks.focusEmptyText, '没有已上报投入但尚未核验的工作。');
  assert.match(noTasks.emptyText, /没有可展示的任务记录/);
  assert.equal(Object.hasOwn(noTasks, 'metrics'), false);
  assert.deepEqual(noTasks.focus, []);

  const noStats = deliveryEfficiency(emptyStats());
  assert.equal(noStats.empty, true);
  assert.match(noStats.focusEmptyText, /尚无统计快照/);
  assert.match(noStats.emptyText, /尚无统计快照/);
  assert.equal(JSON.stringify(noStats).includes('0 / 0'), false);
});

test('每日投入表覆盖审计区间全部日期，缺失日期与缺失用量都不按 0 补齐', () => {
  const series = trendSeries(stats({
    trend: [
      {date: '2026-10-20', attempts: 2, reportedAttempts: 2, tokens: {inputTokens: 10, outputTokens: 5}},
      {date: '2026-10-21', attempts: 3, reportedAttempts: 1, tokens: {inputTokens: null, outputTokens: null}},
    ],
  }));
  assert.equal(series.title, '每天投入了多少');
  assert.match(series.scopeNote, /小队执行器已上报的记录/);
  assert.match(series.scopeNote, /不代表 Codex 与 Qoder 账户的全部投入/);
  assert.equal(series.rows.length, 7);
  assert.equal(series.metaLabel, '已报 1 / 7 天');
  assert.equal(series.windowRange, '10-16 ~ 10-22 (7日审计)');
  assert.equal(series.empty, false);
  assert.equal('columns' in series, false);

  const reported = series.rows.find(row => row.date === '2026-10-20');
  assert.equal(reported.tokenLabel, '15');
  assert.equal(reported.unreportedLabel, '0 次');
  assert.equal(reported.missing, false);

  const unreported = series.rows.find(row => row.date === '2026-10-21');
  assert.equal(unreported.tokenReported, false);
  assert.equal(unreported.tokenLabel, UNREPORTED);
  assert.equal(unreported.unreportedAttempts, 3);
  assert.equal(unreported.unreportedLabel, '3 次');

  const missing = series.rows.filter(row => row.missing);
  assert.equal(missing.length, 5);
  assert.equal(missing.every(row => row.tokenLabel === UNREPORTED && row.unreportedLabel === '无记录'), true);
  assert.equal(series.rows.some(row => row.tokenLabel === '0'), false);
  assert.equal(series.rows.some(row => row.unreportedLabel === '0 次' && row.missing), false);
});

test('每日投入保留仅上报总Token的回执和明确的零值', () => {
  const series=trendSeries(stats({trend:[
    {date:'2026-10-20',attempts:2,reportedAttempts:1,tokens:{totalTokens:125000,inputTokens:null,outputTokens:null}},
    {date:'2026-10-21',attempts:1,reportedAttempts:1,tokens:{totalTokens:0,inputTokens:null,outputTokens:null}},
  ]}));
  const totalOnly=series.rows.find(row=>row.date==='2026-10-20');
  assert.equal(totalOnly.tokenReported,true);
  assert.equal(totalOnly.tokenLabel,'125.0K');
  assert.equal(totalOnly.unreportedLabel,'1 次');
  const zero=series.rows.find(row=>row.date==='2026-10-21');
  assert.equal(zero.tokenReported,true);
  assert.equal(zero.tokenLabel,'0');
  assert.equal(zero.unreportedLabel,'0 次');
});

test('技能为 0 时不伪装成已有报告，CLI 无记录时明确空态', () => {
  assert.equal(skillRows(stats()).empty, true);
  const cli = cliView(stats());
  assert.equal(cli.empty, true);
  assert.equal(cli.available, false);
  assert.equal(cli.emptyText, '尚无可识别CLI记录');
  assert.deepEqual(cli.rows, []);
  assert.equal(kpiCards(withAnalysis({available: false}, {capabilities: {tools: [], skillReads: []}}))[3].value, '4');
});

test('技能读取列出全部真实技能种类，不截断也不省略', () => {
  const skillReads = Array.from({length: 17}, (_, index) => ({name: `skill-${index}`, reads: index + 1}));
  const view = skillRows(stats({capabilities: {tools: [], skillReads, activation: null, activationNote: ''}}));
  assert.equal(view.available, true);
  assert.equal(view.empty, false);
  assert.equal(view.rows.length, 17);
  assert.equal(view.total, 153);
  assert.equal(view.rows[16].name, 'skill-16');
  assert.equal(view.rows[16].reads, 17);
});

test('Codex 线程链接对特殊字符做转义', () => {
  assert.equal(codexThreadUrl('a/b c'), 'codex://threads/a%2Fb%20c');
  assert.equal(codexThreadUrl(''), null);
});

test('本机消耗展示总/输入含缓存/缓存/输出，并按真实会话与模型排行', () => {
  const data = stats({codexUsage: usageFixture()});
  const view = codexUsageView(data);
  assert.equal(view.available, true);
  assert.equal(view.empty, false);
  assert.equal(view.observedLabel, '本机记录 · 更新于 10/22 08:00 UTC');
  assert.equal(view.coverageLabel, '已读取 3/4 个会话记录 · 1 个不可读 · 2 条记录未标注模型');
  assert.equal(view.coverageSummary, '已读取 3/4 个会话');
  assert.deepEqual(view.totals.total, {value: '10.0', unit: 'K'});
  assert.deepEqual(view.totals.input, {value: '8.0', unit: 'K'});
  assert.deepEqual(view.totals.cached, {value: '3.0', unit: 'K'});
  assert.deepEqual(view.totals.output, {value: '2.0', unit: 'K'});
  assert.deepEqual(view.totals.rawInput, {value: '5.0', unit: 'K'});
  assert.equal(view.totals.cacheShare, '37.5%');
  assert.deepEqual(view.totals.shares, {cached: 30, rawInput: 50, output: 20});
  assert.equal('inputIncludesCache' in view.totals, false);
  assert.deepEqual(view.leaders.map(leader => leader.title), ['订单工作台会话', '周期分析报告', '未关联会话']);
  assert.deepEqual(view.leaders.map(leader => leader.tokenLabel), ['7.0K', '2.0K', '1.0K']);
  assert.deepEqual(view.leaders.map(leader => leader.percent), ['70.0%', '20.0%', '10.0%']);
  assert.deepEqual(view.leaders[0].models, ['gpt-5-codex']);
  assert.equal(view.leaders[0].kindLabel, '小队会话');
  assert.equal(view.leaders[1].kindLabel, '分析报告');
  assert.equal(view.leaders[2].kindLabel, '未关联会话');
  assert.deepEqual(view.groups.map(group => [group.label, group.tokenLabel, group.percent]), [
    ['分析报告自消耗', '2.0K', '20.0%'],
    ['未关联小队的独立会话', '1.0K', '10.0%'],
  ]);
  assert.deepEqual(view.models.map(model => [model.name, model.tokenLabel, model.percent]), [
    ['gpt-5-codex', '9.0K', '90.0%'],
    ['gpt-5', '1.0K', '10.0%'],
  ]);
  assert.equal(view.modelsCount, 2);
  assert.equal(view.modelsOmitted, 0);
  assert.equal(view.note, '仅统计本机记录');
  const technical = usageFixture();
  technical.note = '本机已记录用量；缓存包含在输入中，推理包含在输出中。';
  assert.equal(codexUsageView(stats({codexUsage: technical})).note, null);
  const serialized = JSON.stringify(view);
  assert.doesNotMatch(serialized, /remainingPercent|账户额度|credits|余额|qoder/i);
  assert.doesNotMatch(serialized, /1250/);
});

test('没有 Codex 记录时明确空态，不借用任务 token 或额度占位', () => {
  const view = codexUsageView(stats());
  assert.equal(view.available, false);
  assert.equal(view.empty, true);
  assert.equal(view.emptyTitle, '暂无本机消耗记录');
  assert.equal(view.emptyText, '尚未读取到本机 Codex 消耗记录。');
  assert.equal(view.totals, null);
  assert.deepEqual(view.leaders, []);
  assert.deepEqual(view.groups, []);
  assert.deepEqual(view.models, []);
  assert.equal(view.observedLabel, '本机记录 · 时间未上报');
  const serialized = JSON.stringify(view);
  assert.doesNotMatch(serialized, /1\.3K|1250|remainingPercent|credits/);

  const explained = codexUsageView(stats({codexUsage: {schemaVersion: 1, available: false, note: '本机暂无 Codex 记录；未读取账户额度。'}}));
  assert.equal(explained.emptyText, '本机暂无 Codex 记录；未读取账户额度。');
});

test('本机消耗在没有总量时按会话求和，模型只保留前四类', () => {
  const usage = usageFixture();
  usage.totals = {};
  usage.models = Array.from({length: 6}, (_, index) => ({model: `model-${index}`, totalTokens: (6 - index) * 1000}));
  const view = codexUsageView(stats({codexUsage: usage}));
  assert.deepEqual(view.totals.total, {value: '10.0', unit: 'K'});
  assert.equal(view.models.length, 4);
  assert.deepEqual(view.models.map(model => model.name), ['model-0', 'model-1', 'model-2', 'model-3']);
  assert.equal(view.modelsCount, 6);
  assert.equal(view.modelsOmitted, 2);
});

test('本机消耗列出全部有记录会话，不截成 Top3 后结束', () => {
  const usage = usageFixture();
  usage.totals = {totalTokens: 10000};
  usage.sessions = [
    {threadId: 't5', title: '会话 B', kind: 'unassigned', models: [{model: 'gpt-5-mini', totalTokens: 500}], totalTokens: 500, turnCount: 1},
    {threadId: 't1', title: '订单工作台会话', kind: 'squad', models: [{model: 'gpt-5-codex', totalTokens: 7000}], totalTokens: 7000, turnCount: 12},
    {threadId: 't4', title: '会话 A', kind: 'analysis', models: [{model: 'gpt-5-codex', totalTokens: 500}], totalTokens: 500, turnCount: 2},
    {threadId: 't2', title: '周期分析报告', kind: 'analysis', models: [{model: 'gpt-5-codex', totalTokens: 2000}], totalTokens: 2000, turnCount: 2},
  ];
  const view = codexUsageView(stats({codexUsage: usage}));
  assert.equal(view.sessionsCount, 4);
  assert.equal(view.allSessions.length, 4);
  assert.equal(view.leaders.length, 3);
  assert.deepEqual(view.allSessions.map(session => session.title), [
    '订单工作台会话', '周期分析报告', '会话 A', '会话 B',
  ]);
  assert.deepEqual(view.allSessions.map(session => session.tokenLabel), ['7.0K', '2.0K', '500', '500']);
  assert.deepEqual(view.allSessions.map(session => session.percent), ['70.0%', '20.0%', '5.0%', '5.0%']);
  const fourth = view.allSessions[3];
  assert.equal(fourth.kindLabel, '未关联会话');
  assert.equal(fourth.scopeHref, null);
  assert.equal(fourth.codexHref, 'codex://threads/t5');
  const third = view.allSessions[2];
  assert.equal(third.kindLabel, '分析报告');
  assert.deepEqual(third.models, ['gpt-5-codex']);
  assert.equal(third.turnCount, 2);
  assert.equal(third.scopeHref, null);
  assert.equal(third.codexHref, 'codex://threads/t4');
  assert.equal(view.allSessions[0].scopeHref, SCOPE_TASK_URL);
  assert.doesNotMatch(JSON.stringify(view.allSessions), /quota|credits|剩余额度/);
});

test('消耗覆盖如实区分不可读、未记录、无时间戳与未标注模型', () => {
  const usage = usageFixture();
  usage.coverage = {
    threads: 6, readableThreads: 3, missingThreads: 1,
    unreportedThreads: 2, unreportedWithTokens: 1,
    undatedRecords: 3, unattributedModelRecords: 2,
  };
  const view = codexUsageView(stats({codexUsage: usage}));
  assert.equal(view.coverageLabel, [
    '已读取 3/6 个会话记录',
    '1 个不可读',
    '2 个会话未记录本窗口用量',
    '1 个有历史用量但本窗口无记录',
    '3 条记录无时间戳',
    '2 条记录未标注模型',
  ].join(' · '));
});

function qoderFixture() {
  return {
    schemaVersion: 1,
    executor: 'qoder',
    available: true,
    observedAt: '2026-10-22T08:00:00.000Z',
    range: {days: 7, from: '2026-10-16T00:00:00.000Z', to: '2026-10-22T08:00:00.000Z'},
    totals: {inputTokens: 4000, cachedInputTokens: 1000, outputTokens: 1000, totalTokens: 5000},
    coverage: {reportedAttempts: 3, totalAttempts: 4, executedAttempts: 4, undatedAttempts: 0, futureAttempts: 0, beforeWindowAttempts: 0},
    models: [
      {model: 'qwen3-coder', source: 'actual', attempts: 2, reportedAttempts: 2, actualAttempts: 2, configuredAttempts: 0, unknownAttempts: 0, tokens: {totalTokens: 4000}},
      {model: 'qwen-max', source: 'configured', attempts: 1, reportedAttempts: 1, actualAttempts: 0, configuredAttempts: 1, unknownAttempts: 0, tokens: {totalTokens: 1000}},
    ],
    sessions: [
      {threadId: 't1', title: '', tokens: {totalTokens: 4000}, coverage: {reportedAttempts: 2, totalAttempts: 2}, models: [{model: 'qwen3-coder'}]},
      {threadId: 't5', title: 'Qoder 独立会话', tokens: {totalTokens: null}, coverage: {reportedAttempts: 1, totalAttempts: 2}, models: [{model: 'qwen-max'}]},
    ],
    note: '仅统计 member.executor=qoder 的已记录用量。',
  };
}

test('旧快照没有 Qoder 明细时明确未生成，不回退 Codex 执行器数据', () => {
  const view = qoderUsageView(stats());
  assert.equal(view.present, false);
  assert.equal(view.available, false);
  assert.equal(view.empty, true);
  assert.equal(view.emptyTitle, '尚未生成 Qoder 用量明细');
  assert.equal(view.observedLabel, 'Qoder 本机记录 · 未生成明细');
  assert.equal(view.totals, null);
  assert.deepEqual(view.models, []);
  assert.deepEqual(view.sessions, []);
  assert.match(view.note, /不与 Codex 合并/);
  const serialized = JSON.stringify(view);
  assert.doesNotMatch(serialized, /1\.2K|1250|quota|credits|剩余/);
});

test('Qoder 用量展示真实模型、输入缓存输出与执行覆盖', () => {
  const data = stats({executorUsage: {qoder: qoderFixture()}, codexUsage: usageFixture()});
  const view = qoderUsageView(data);
  assert.equal(view.present, true);
  assert.equal(view.available, true);
  assert.equal(view.empty, false);
  assert.equal(view.observedLabel, 'Qoder 本机记录 · 更新于 10/22 08:00 UTC');
  assert.equal(view.coverageLabel, '已记录 3/4 次执行用量');
  assert.equal(view.coverageSummary, '已记录 3/4 次执行');
  assert.deepEqual(view.totals.total, {value: '5.0', unit: 'K'});
  assert.deepEqual(view.totals.input, {value: '4.0', unit: 'K'});
  assert.deepEqual(view.totals.cached, {value: '1.0', unit: 'K'});
  assert.deepEqual(view.totals.output, {value: '1.0', unit: 'K'});
  assert.equal(view.totals.cacheShare, '25.0%');
  assert.equal('inputIncludesCache' in view.totals, false);
  assert.deepEqual(view.models.map(model => [model.name, model.sourceLabel, model.tokenLabel, model.percent]), [
    ['qwen3-coder', '实际模型', '4.0K', '80.0%'],
    ['qwen-max', '配置模型', '1.0K', '20.0%'],
  ]);
  assert.equal(view.modelsCount, 2);
  assert.equal(view.sessionsCount, 2);
  const [aligned, standalone] = view.sessions;
  assert.equal(aligned.title, '本地会话标题');
  assert.equal(aligned.kindLabel, '小队会话');
  assert.deepEqual(aligned.models, ['qwen3-coder']);
  assert.equal(aligned.tokenLabel, '4.0K');
  assert.equal(aligned.percent, '80.0%');
  assert.equal(aligned.scopeHref, SCOPE_OVERVIEW_URL);
  assert.equal(aligned.codexHref, 'codex://threads/t1');
  assert.equal(standalone.title, 'Qoder 独立会话');
  assert.equal(standalone.tokenLabel, UNREPORTED);
  assert.equal(standalone.percent, '—');
  assert.equal(standalone.scopeHref, null);
  assert.equal(view.note, 'Qoder 已上报的执行用量；不与 Codex 合并。');
  assert.doesNotMatch(JSON.stringify(view), /缓存输入|不可重复相加/);
  assert.doesNotMatch(JSON.stringify(view), /member\.executor|executor=|qoder:total/);
  assert.doesNotMatch(JSON.stringify(view), /quota|credits|剩余|金额|余额/);
});

test('Qoder 明细存在但本窗口无执行时说明空态与覆盖', () => {
  const usage = qoderFixture();
  usage.available = false;
  const view = qoderUsageView(stats({executorUsage: {qoder: usage}}));
  assert.equal(view.present, true);
  assert.equal(view.available, false);
  assert.equal(view.emptyTitle, '本窗口没有 Qoder 执行用量');
  assert.equal(view.coverageLabel, '已执行 4 次');
  assert.equal(view.coverageSummary, '已执行 4 次');
  assert.equal(view.totals, null);
});

test('对比按小队对齐两侧 Token，不合并也不换算金额', () => {
  const data = stats({codexUsage: usageFixture(), executorUsage: {qoder: qoderFixture()}});
  const compare = usageComparison(data);
  assert.equal(compare.available, true);
  assert.equal(compare.empty, false);
  assert.equal(compare.observedLabel, '同一统计窗口 · 按小队对比');
  assert.equal(compare.rows.length, 2);
  const aligned = compare.rows.find(row => row.title === '订单工作台会话');
  assert.equal(aligned.kindLabel, '小队会话');
  assert.equal(aligned.codexLabel, '7.0K');
  assert.equal(aligned.qoderLabel, '4.0K');
  assert.equal(aligned.scopeHref, SCOPE_OVERVIEW_URL);
  assert.equal(aligned.codexHref, 'codex://threads/t1');
  const standalone = compare.rows.find(row => row.title === 'Qoder 独立会话');
  assert.equal(standalone.kindLabel, '仅 Qoder 记录');
  assert.equal(standalone.codexLabel, '无记录');
  assert.equal(standalone.qoderLabel, UNREPORTED);
  assert.equal(compare.codexOnly.length, 2);
  assert.deepEqual(compare.codexOnly.map(row => [row.title, row.kindLabel, row.codexLabel, row.qoderLabel]), [
    ['周期分析报告', '分析报告', '2.0K', '未对齐'],
    ['未关联会话', '未关联会话', '1.0K', '未对齐'],
  ]);
  assert.equal(compare.summary, 'Codex 10.0K · Qoder 5.0K · 各自独立，不合并');
  assert.equal(compare.coverageLabel, '已对齐 2 个会话 · Codex 分析/独立会话 2 行单列');
  assert.equal(compare.coverageSummary, '已对齐 2 个会话');
  assert.match(compare.note, /不能换算为金额或效率优劣/);
  assert.doesNotMatch(JSON.stringify(compare), /quota|credits|剩余|余额|¥|￥/);
});

test('用量视图提供 Codex/Qoder/对比三种模式，且不改变快照来源', () => {
  const data = stats({codexUsage: usageFixture(), executorUsage: {qoder: qoderFixture()}});
  const view = usageView(data);
  assert.deepEqual(view.modes.map(mode => [mode.value, mode.label]), [['codex', 'Codex'], ['qoder', 'Qoder'], ['compare', '对比']]);
  assert.equal(view.codex.available, true);
  assert.equal(view.qoder.available, true);
  assert.equal(view.compare.available, true);
  assert.equal(Object.hasOwn(view.codex, 'qoder'), false);
  const model = reportModel(data, {days: 7, rank: 'tokens'});
  assert.deepEqual(model.usage.modes.map(mode => mode.label), ['Codex', 'Qoder', '对比']);
  assert.equal('status' in model, false);
  assert.equal('suggestions' in model, false);
  assert.equal('codexUsage' in model, false);
  assert.equal('efficiency' in model, true);
  assert.equal('observations' in model, true);
});

test('CLI 超过 3 行时默认前 3 条，可筛选出不在前 3 的 lgb 并展开全部', () => {
  const rows = Array.from({length: 9}, (_, index) => ({
    name: 'a1',
    command: `repo view ${index + 1}`,
    calls: 20 - index,
    execution: {succeeded: 20 - index, failed: 0, unknown: 0},
    business: {succeeded: 20 - index, failed: 0, unknown: 0},
    failures: [],
    sessions: [],
  }));
  rows.push({
    name: 'lgb',
    command: 'log query',
    calls: 1,
    execution: {succeeded: 1, failed: 0, unknown: 0},
    business: {succeeded: 1, failed: 0, unknown: 0},
    failures: [],
    sessions: [],
  });
  const data = stats({capabilities: {tools: [], skillReads: [], cli: {rows, unclassifiedCalls: 0}}});

  const initial = cliView(data);
  assert.equal(initial.rowCount, 10);
  assert.equal(initial.filteredCount, 10);
  assert.equal(initial.shownCount, 3);
  assert.equal(initial.hiddenCount, 7);
  assert.equal(initial.canExpand, true);
  assert.equal(initial.toggleLabel, '展开全部 10 条指令');
  assert.equal(initial.filters.some(option => option.value === 'lgb'), true);
  assert.equal(initial.filters.find(option => option.value === 'lgb').label, 'lgb (1 条)');
  assert.equal(initial.rows.some(row => row.name === 'lgb'), false);

  const filtered = cliView(data, {filter: 'lgb'});
  assert.equal(filtered.filter, 'lgb');
  assert.equal(filtered.filteredCount, 1);
  assert.equal(filtered.shownCount, 1);
  assert.equal(filtered.hiddenCount, 0);
  assert.equal(filtered.canExpand, false);
  assert.equal(filtered.toggleLabel, null);
  assert.deepEqual(filtered.rows.map(row => row.title), ['lgb log query']);

  const a1 = cliView(data, {filter: 'a1'});
  assert.equal(a1.filteredCount, 9);
  assert.equal(a1.shownCount, 3);
  assert.equal(a1.hiddenCount, 6);
  assert.equal(a1.toggleLabel, '展开全部 9 条指令');

  const expanded = cliView(data, {filter: 'a1', expanded: true});
  assert.equal(expanded.expanded, true);
  assert.equal(expanded.shownCount, 9);
  assert.equal(expanded.hiddenCount, 0);
  assert.equal(expanded.toggleLabel, '收起至前 3 条');
  assert.deepEqual(expanded.rows.map(row => row.command), rows.slice(0, 9).map(row => row.command));

  const unknownFilter = cliView(data, {filter: 'ghost'});
  assert.equal(unknownFilter.filter, 'all');
  assert.equal(unknownFilter.shownCount, 3);
});

test('CLI 筛选与展开不改变真实计数', () => {
  const rows = Array.from({length: 10}, (_, index) => ({
    name: index < 6 ? 'a1' : 'sf',
    command: `command ${index + 1}`,
    calls: index + 1,
    execution: {succeeded: index, failed: 1, unknown: 0},
    business: {succeeded: index, failed: 1, unknown: 0},
    failures: [{category: 'execution', count: 1}],
    sessions: [],
  }));
  const data = stats({capabilities: {tools: [], skillReads: [], cli: {rows, unclassifiedCalls: 4}}});
  const view = cliView(data, {filter: 'sf', expanded: true});
  assert.equal(view.totalCalls, 55);
  assert.equal(view.rowCount, 10);
  assert.equal(view.filteredCount, 4);
  assert.equal(view.shownCount, 4);
  assert.equal(view.unclassifiedCalls, 4);
  assert.equal(view.coverageLabel, '执行状态确认 55/55');
});

test('CLI 表现按真实调用排序，未确认状态不进分母但明示确认覆盖率', () => {
  const data = stats({
    capabilities: {
      tools: [], skillReads: [], activation: null, activationNote: '',
      cli: {
        rows: [
          {
            name: 'a1', command: 'repo view', calls: 12,
            execution: {succeeded: 9, failed: 1, unknown: 2},
            business: {succeeded: 8, failed: 1, unknown: 3},
            failures: [{category: 'permission', count: 1}, {category: 'timeout', count: 0}],
            sessions: [{threadId: 't1', title: '本地会话标题', taskId: 'a1', taskTitle: '订单工作台'}],
            params: '--token secret-value',
          },
          {
            name: 'sf', command: 'log query', calls: 20,
            execution: {succeeded: 20, failed: 0, unknown: 0},
            business: {succeeded: 0, failed: 0, unknown: 20},
            failures: [],
            sessions: [],
          },
        ],
        unclassifiedCalls: 3,
        note: '仅统计已识别指令',
      },
    },
  });
  const view = cliView(data);
  assert.equal(view.available, true);
  assert.equal(view.empty, false);
  assert.equal(view.totalCalls, 32);
  assert.equal(view.rowCount, 2);
  assert.equal(view.unknownCalls, 2);
  assert.equal(view.unclassifiedCalls, 3);
  assert.equal(view.coverageLabel, '执行状态确认 30/32');
  assert.equal(view.note, '仅统计已识别指令');

  assert.deepEqual(view.rows.map(row => row.title), ['sf log query', 'a1 repo view']);
  const sf = view.rows[0];
  assert.equal(sf.calls, 20);
  assert.equal(sf.execution.rate, '100.0%');
  assert.equal(sf.execution.confirmedLabel, '确认 20/20');
  assert.equal(sf.business.display, '— (未确认)');
  assert.equal(sf.hasFailures, false);

  const a1 = view.rows[1];
  assert.equal(a1.calls, 12);
  assert.equal(a1.execution.rate, '90.0%');
  assert.equal(a1.execution.display, '90.0%');
  assert.equal(a1.execution.confirmedLabel, '确认 10/12');
  assert.equal(a1.execution.unknown, 2);
  assert.equal(a1.business.rate, '88.9%');
  assert.equal(a1.failures, 1);
  assert.equal(a1.hasFailures, true);
  assert.deepEqual(a1.failureCategories, [{category: 'permission', label: '权限/认证', count: 1}]);
  assert.deepEqual(a1.sessions.map(session => session.label), ['本地会话标题 · 订单工作台']);
  assert.equal(a1.sessions[0].taskHref, SCOPE_TASK_URL);
  assert.equal(a1.sessions[0].codexHref, 'codex://threads/t1');
  const serialized = JSON.stringify(view);
  assert.doesNotMatch(serialized, /secret-value|--token|params/);
});

test('CLI 无记录或统计快照缺失时给出对应空态', () => {
  const noRows = cliView(stats({capabilities: {tools: [], skillReads: [], cli: {rows: [], unclassifiedCalls: 5}}}));
  assert.equal(noRows.empty, true);
  assert.equal(noRows.emptyText, '尚无可识别CLI记录');
  assert.equal(noRows.unclassifiedCalls, 5);

  const noSnapshot = cliView(emptyStats());
  assert.equal(noSnapshot.empty, true);
  assert.equal(noSnapshot.emptyText, '尚无统计快照，CLI 调用未统计。');

  const zeroCalls = cliView(stats({capabilities: {tools: [], skillReads: [], cli: {rows: [{name: 'a1', command: 'repo view', calls: 0}]}}}));
  assert.equal(zeroCalls.empty, true);
  assert.equal(zeroCalls.emptyText, '尚无可识别CLI记录');
});

test('报告模型不包含账户额度，也不把 CLI 表现混入技能观察', () => {
  const model = reportModel(withAnalysis({available: true}), {days: 7, rank: 'tokens'});
  const serialized = JSON.stringify(model);
  // 允许显式声明“不读取账户额度”的说明，但不能出现额度字段或数值。
  assert.doesNotMatch(serialized, /quota|remainingPercent|credits|剩余额度|余额/);
  assert.equal('tools' in model, false);
  assert.equal(model.cli.available, false);
  assert.equal(model.usage.codex.empty, true);
  assert.equal(model.usage.qoder.present, false);
});

test('切换统计区间按选中 days 读取已保存统计，刷新只发 GET', async () => {
  const calls = [];
  const runs = {
    schemaVersion: 1,
    current: {runId: 'run-current', days: 7, status: 'running', phase: 'analyzing'},
    history: [],
    schedule: {enabled: false},
  };
  const savedFor = days => ({
    ...stats(),
    analysis: {
      available: false, statsAvailable: true, runId: `run-${days}`,
      window: {days: days === 'all' ? null : Number(days)},
      statsObservedAt: '2026-10-22T08:00:00.000Z', statFingerprint: `fingerprint-${days}`,
    },
  });
  const request = (url, init = {}) => {
    calls.push({url, method: init.method || 'GET'});
    if (url === './api/analysis/runs') return Promise.resolve({ok: true, json: async () => runs});
    const days = new URL(url, 'http://local').searchParams.get('days');
    return Promise.resolve({ok: true, json: async () => savedFor(days)});
  };

  const first = await readAnalyticsSnapshot({days: 7, request});
  assert.equal(first.analysis.runId, 'run-7');
  assert.equal(first.analysis.latestRun.runId, 'run-current');
  assert.equal((await readAnalyticsSnapshot({days: 30, request})).analysis.runId, 'run-30');
  assert.equal((await readAnalyticsSnapshot({days: null, request})).analysis.runId, 'run-all');

  assert.deepEqual(
    calls.filter(call => call.url.startsWith('./api/analytics')).map(call => call.url),
    ['./api/analytics?days=7', './api/analytics?days=30', './api/analytics?days=all'],
  );
  assert.equal(calls.filter(call => call.url === './api/analysis/runs').length, 3);
  assert.equal(calls.filter(call => call.method !== 'GET').length, 0);
  assert.equal(analyticsRequestPath(7), './api/analytics?days=7');
  assert.equal(analyticsRequestPath(null), './api/analytics?days=all');
});

test('统计与运行列表并行读取，运行列表不可用也不阻塞数字', async () => {
  const started = [];
  let releaseStats;
  const request = (url) => {
    started.push(url);
    if (url === './api/analysis/runs') return Promise.resolve({ok: false, status: 503, json: async () => ({})});
    return new Promise(resolve => {
      releaseStats = () => resolve({ok: true, json: async () => savedForStats()});
    });
  };
  const savedForStats = () => ({
    ...stats(),
    analysis: {available: false, statsAvailable: true, runId: 'run-saved'},
  });

  const pending = readAnalyticsSnapshot({days: 7, request});
  await Promise.resolve();
  assert.deepEqual(started.sort(), ['./api/analytics?days=7', './api/analysis/runs'].sort());
  releaseStats();
  const data = await pending;
  assert.equal(data.analysis.latestRun, null);
  assert.equal(kpiCards(data)[2].value, '10');
  assert.equal(kpiCards(data)[3].value, '4');
});

test('AI 运行或失败时 statsAvailable 仍展示已保存统计的真实数字', () => {
  const base = stats();
  const latestRuns = [
    {runId: 'r2', status: 'running', phase: 'analyzing'},
    {runId: 'r2', status: 'failed', phase: 'completed', error: '采集失败'},
  ];
  for (const latestRun of latestRuns) {
    const data = {
      ...base,
      analysis: {
        available: false, statsAvailable: true, runId: 'r2', latestRun,
        window: {days: 7, from: base.range.from, to: base.range.to},
        statsObservedAt: base.observedAt, statFingerprint: 'digest-2',
      },
    };
    const model = reportModel(data, {days: 7, rank: 'tokens'});
    assert.equal(model.state.statsAvailable, true);
    assert.equal(model.state.available, false);
    assert.equal(model.kpis[0].value, '1.3');
    assert.equal(model.kpis[2].value, '10');
    assert.equal(model.kpis[3].value, '4');
    assert.equal(model.sessions.rows.length, 1);
    assert.equal(model.observations.empty, true);
    assert.match(model.observations.emptyText, /AI 分析尚未生成观察/);
    assert.match(model.highlight.text, /统计快照已更新/);
  }
  assert.match(analysisStatus({
    ...base,
    analysis: {available: false, statsAvailable: true, latestRun: {status: 'running', phase: 'analyzing'}},
  }).badge.text, /报告正在更新/);
  assert.match(analysisStatus({
    ...base,
    analysis: {available: false, statsAvailable: true, latestRun: {status: 'failed'}},
  }).badge.text, /统计已更新.*未生成/);
});

test('无统计快照时展示真实空态，不把空统计显示为 0', () => {
  const model = reportModel(emptyStats(), {days: 7, rank: 'tokens'});
  assert.equal(model.state.statsAvailable, false);
  assert.equal(model.state.phase, 'idle');
  assert.equal('canRun' in model.state, false);
  assert.deepEqual(model.kpis.map(card => card.value), [UNREPORTED, UNREPORTED, UNREPORTED, UNREPORTED]);
  assert.equal(model.kpis.some(card => card.value === '0'), false);
  assert.equal(model.efficiency.available, false);
  assert.equal(model.efficiency.empty, true);
  assert.match(model.efficiency.emptyText, /尚无统计快照/);
  assert.equal(model.sessions.rows.length, 0);
  assert.match(model.sessions.emptyText, /尚无统计快照/);
  assert.equal(model.trend.available, false);
  assert.equal(model.trend.empty, true);
  assert.deepEqual(model.trend.rows, []);
  assert.equal(model.trend.title, '每天投入了多少');
  assert.equal(model.trend.metaLabel, '尚无统计快照');
  assert.equal(model.skills.available, false);
  assert.equal(model.cli.available, false);
  assert.equal(model.usage.codex.available, false);
  assert.equal(model.usage.qoder.present, false);
  assert.match(model.highlight.text, /尚无统计快照/);
  assert.equal(model.observations.empty, true);
  assert.match(model.observations.emptyText, /尚无统计快照/);
});

test('缺少统计可用性回执时保持空态，不推断数字已经可用', () => {
  for (const analysis of [undefined, {available: false}, {available: true}]) {
    const model = reportModel(stats({analysis}), {days: 7});
    assert.equal(model.state.statsAvailable, false);
    assert.deepEqual(model.kpis.map(card => card.value), [UNREPORTED, UNREPORTED, UNREPORTED, UNREPORTED]);
    assert.equal(model.sessions.rows.length, 0);
  }
});

test('需关注计数来自真实状态，待执行不冒充待验收', () => {
  const data=stats({metrics:{
    taskCount:10,accepted:2,returned:5,running:1,
    failed:1,blocked:0,unknown:1,stopped:1,pending:1,
  }});
  const tasks=kpiCards(data).find(card=>card.key==='tasks');
  assert.equal(tasks.badge.text,'2 需关注');
  assert.ok(tasks.footer.some(item=>item.text==='待验 3'));
});

test('合并运行状态时不携带上一轮 AI 综述与建议', () => {
  const saved = {
    ...stats(),
    analysis: {
      available: false, statsAvailable: true, runId: 'run-new',
      latestRun: {runId: 'run-old', status: 'succeeded'},
    },
  };
  const merged = mergeAnalyticsSnapshot(saved, {
    schemaVersion: 1,
    current: {runId: 'run-new', days: 7, status: 'running', phase: 'collecting'},
    history: [{runId: 'run-old', status: 'succeeded'}],
    schedule: {enabled: false},
  });
  assert.equal(merged.analysis.runId, 'run-new');
  assert.equal(merged.analysis.latestRun.runId, 'run-new');
  assert.equal(merged.analysis.available, false);
  assert.equal(merged.analysis.summary, undefined);
  assert.equal(merged.analysis.categories, undefined);
  assert.deepEqual(merged.analysis.schedule, {enabled: false});
});

test('未生成的区间不展示其他区间的失败记录，其他区间运行时仅显示全局忙碌',()=>{
  const saved=emptyStats();
  const unrelated={runId:'all-run',days:null,status:'interrupted',phase:'completed'};
  saved.analysis.latestRun=unrelated;
  const idle=mergeAnalyticsSnapshot(saved,{history:[unrelated]});
  assert.equal(idle.analysis.latestRun,null);
  assert.equal(reportModel(idle,{days:7}).state.phase,'idle');
  const busy=mergeAnalyticsSnapshot(saved,{current:{...unrelated,status:'running'}});
  const state=reportModel(busy,{days:7}).state;
  assert.equal(busy.analysis.latestRun,null);
  assert.equal(state.phase, 'running');
  assert.equal('canRun' in state, false);
  assert.match(state.badge.text,/其他区间/);
});

function benefitsFixture(overrides = {}) {
  return {
    schemaVersion: 1,
    generatedAt: '2026-10-22T08:00:00.000Z',
    range: {from: '2026-10-16T00:00:00.000Z', to: '2026-10-22T08:00:00.000Z'},
    summary: {
      baselineCodexTokens: 100000, actualCodexTokens: 40000, qoderTokens: 20000,
      codexTokensSaved: 60000, tokenSavingRate: 0.6,
      baselineSeconds: 7200, squadSeconds: 3600, secondsSaved: 3600, timeSavingRate: 0.5,
    },
    coverage: {
      completedDeliveries: 2, tokenEstimatedDeliveries: 1, timeEstimatedDeliveries: 1, observedDeliveries: 2,
      reasons: [
        {code: 'baseline-missing', label: '没有可核对的历史纯 Codex 完整交付基线。', count: 1},
        {code: 'speed-missing-model', label: '缺少该模型近期有效的实测输出速度。', count: 1, detail: {model: 'gpt-5-codex', unit: 'qoder'}},
      ],
    },
    observation: '两笔已完成交付的 Codex 用量低于历史基线。',
    deliveries: [
      {
        deliveryId: 'w1:t1', threadId: 't1', title: '订单工作台', status: 'completed',
        range: {
          startedAt: '2026-10-20T09:00:00.000Z', completedAt: '2026-10-20T10:00:00.000Z',
          endedAt: '2026-10-20T10:00:00.000Z', lastActivityAt: '2026-10-20T10:00:00.000Z',
        },
        actual: {
          codex: {tokens: 40000, inputTokens: 30000, outputTokens: 10000, used: true, complete: true},
          qoder: {tokens: 20000, inputTokens: 15000, outputTokens: 5000, used: true, complete: true},
        },
        baseline: {
          tokens: 100000, sourceRef: 'h1', completedAt: '2026-10-01T10:00:00.000Z',
          pureCodex: true, complete: true, conditionsMatched: true,
        },
        estimate: {codexTokensSaved: 60000, baselineSeconds: 7200, squadSeconds: 3600, secondsSaved: 3600},
        excludedReasons: [],
      },
      {
        deliveryId: 'w2:t2', threadId: 't2', title: '库存同步', status: 'completed',
        range: {startedAt: '2026-10-21T09:00:00.000Z', completedAt: '2026-10-21T10:00:00.000Z'},
        actual: {
          codex: {tokens: 1000, inputTokens: 800, outputTokens: 200, used: true, complete: true},
          qoder: {tokens: 0, used: false},
        },
        baseline: null,
        estimate: null,
        excludedReasons: [
          {code: 'baseline-missing', label: '没有可核对的历史纯 Codex 完整交付基线。'},
          {code: 'speed-missing-model', label: '缺少该模型近期有效的实测输出速度。', detail: {model: 'gpt-5-codex', unit: 'qoder'}},
        ],
      },
    ],
    speeds: [{model: 'qwen3-coder', basis: 'model', samples: 2, tokensPerSecond: 42, rough: false}],
    ...overrides,
  };
}

function benefitsStats(overrides = {}) {
  const base = stats();
  return stats({
    benefits: benefitsFixture(),
    sessions: [
      ...base.sessions,
      {
        threadId: 'h1', title: '历史订单会话', summary: '', representativeTasks: [],
        taskCount: 1, attemptCount: 1, tokens: {totalTokens: null},
        links: {
          overview: 'https://scope.example/scene-token/#overview-history',
          tasks: [{taskId: 'h1', url: 'https://scope.example/scene-token/#session/h1'}],
        },
      },
    ],
    ...overrides,
  });
}

test('计算依据先展示纳入净收益的工作，仍保留未纳入项与原始数据', () => {
  const benefits=benefitsFixture();
  benefits.deliveries.reverse();
  const before=structuredClone(benefits);
  const view=squadBenefits(benefitsStats({benefits}));
  assert.deepEqual(view.details.deliveries.map(row=>[row.title,row.included]),[['订单工作台',true],['库存同步',false]]);
  assert.deepEqual(benefits,before);
});

test('收益依据保留可读来源和投入，内部匹配原文不进入用户视图', () => {
  const benefits=benefitsFixture();
  benefits.deliveries[0].baseline.semanticMatch={basis:[{aspect:'workType',deliveryText:'读取 AGENTS.md、TASK.md',baselineText:'内部验收记录 evidence/READY.json'}]};
  const view=squadBenefits(benefitsStats({benefits})).details.deliveries[0];
  assert.equal(view.sources[0].label,'历史订单会话');
  assert.equal(view.baselineTokenLabel,'100.0K');
  assert.equal(view.actualCodexLabel,'40.0K');
  assert.doesNotMatch(JSON.stringify(view),/AGENTS\.md|TASK\.md|evidence\/READY\.json/);
});

test('小队收益外层只给 Token 与耗时两个真实估算和可读覆盖', () => {
  const view = squadBenefits(benefitsStats());
  assert.equal(view.present, true);
  assert.equal(view.available, true);
  assert.equal(view.empty, false);
  assert.equal(view.state, 'positive');
  assert.equal(view.title, '小队收益');
  assert.equal('detailLabel' in view, false);
  const [tokens, time] = view.metrics;
  assert.equal(tokens.label, '测算少用 Codex Token');
  assert.equal(tokens.value, '60.0K');
  assert.equal(tokens.percent, '60%');
  assert.equal(tokens.tone, 'ok');
  assert.equal(Object.hasOwn(tokens, 'detail'), false);
  assert.equal(time.label, '测算节省处理时间');
  assert.equal(time.value, '约 1 小时');
  assert.equal(time.percent, '50%');
  assert.equal(time.tone, 'ok');
  assert.equal(Object.hasOwn(time, 'detail'), false);
  assert.equal(view.coverageLabel, '覆盖 1 / 2 次已完成交付');
  assert.equal(view.observation, '两笔已完成交付的 Codex 用量低于历史基线。');
  assert.deepEqual(view.observationLinks, []);
  const serialized = JSON.stringify(view.metrics);
  assert.doesNotMatch(serialized, /收益|评分|返工|金额|余额|credits/);
});

test('收益计算依据展示真实交付、基线来源、模型速度与跨周期口径', () => {
  const details = squadBenefits(benefitsStats()).details;
  assert.equal(details.title, '小队收益计算依据');
  assert.equal(details.present, true);
  assert.equal(details.emptyText, null);
  assert.equal(details.rangeLabel, '2026-10-16 00:00 UTC ~ 2026-10-22 08:00 UTC');
  assert.equal(details.generatedLabel, '生成时间 2026-10-22 08:00:00 UTC');
  const investment = details.groups.find(group => group.title === '投入对比');
  assert.deepEqual(investment.rows.map(row => [row.label, row.value]), [
    ['纯 Codex 基线', '100.0K Token · 2 小时'],
    ['可比交付的实际 Codex 投入', '40.0K Token'],
    ['可比交付的 Qoder 投入', '20.0K Token'],
    ['小队等效处理时间（Codex + Qoder）', '1 小时'],
  ]);
  const estimate = details.groups.find(group => group.title === '测算结果');
  assert.deepEqual(estimate.rows.map(row => [row.label, row.value, row.percent]), [
    ['测算少用 Codex Token', '60.0K', '60%'],
    ['测算节省处理时间', '约 1 小时', '50%'],
  ]);
  assert.equal(details.deliveryTotal, 2);
  assert.equal(details.includedCount, 1);
  assert.equal(details.excludedCount, 1);
  assert.equal(details.previewLimit, 3);
  assert.equal(details.canExpand, false);
  assert.equal(details.expandLabel, '展开全部 2 项');
  assert.equal(details.collapseLabel, '收起至 3 项');
  assert.equal(details.countLabel, '共 2 项 · 1 项已纳入 · 1 项未计入');
  assert.equal(details.summaryLabel, '计算口径与覆盖');
  assert.match(details.tableNote, /行内“依据”/);
  const included = details.deliveries.find(delivery => delivery.title === '订单工作台');
  assert.equal(included.statusLabel, '已完成');
  assert.equal(included.rangeLabel, '2026-10-20 09:00 UTC ~ 2026-10-20 10:00 UTC');
  assert.equal(included.actualLabel, 'Codex 40.0K · Qoder 20.0K');
  assert.equal(included.actualCodexLabel, '40.0K');
  assert.equal(included.actualQoderLabel, '20.0K');
  assert.equal(included.qoderUsed, true);
  assert.equal(included.baselineLabel, '基线 100.0K');
  assert.equal(included.baselineTokenLabel, '100.0K');
  assert.equal(included.baselineTimeLabel, '基线耗时 2 小时');
  assert.equal(included.netTokenLabel, '+60.0K');
  assert.equal(included.netTimeLabel, '+1 小时');
  assert.equal(included.tokenSavingLabel, '减少 60.0K');
  assert.equal(included.timeSavingLabel, '节省 1 小时');
  assert.deepEqual(included.sources, [{
    label: '历史订单会话',
    href: 'https://scope.example/scene-token/#overview-history',
  }]);
  assert.deepEqual(included.links, [
    {label: '打开会话', href: SCOPE_OVERVIEW_URL},
  ]);
  assert.equal(included.included, true);
  const excluded = details.deliveries.find(delivery => delivery.title === '库存同步');
  assert.equal(excluded.included, false);
  assert.equal(excluded.actualLabel, 'Codex 1.0K · Qoder 未参与');
  assert.equal(excluded.actualCodexLabel, '1.0K');
  assert.equal(excluded.actualQoderLabel, '未参与');
  assert.equal(excluded.qoderUsed, false);
  assert.equal(excluded.baselineTokenLabel, UNREPORTED);
  assert.equal(excluded.netTokenLabel, UNREPORTED);
  assert.equal(excluded.netTimeLabel, UNREPORTED);
  assert.equal(excluded.tokenSavingLabel, '暂无法估算');
  assert.equal(excluded.sourcesNote, '基线来源未上报');
  assert.deepEqual(excluded.exclusions, ['没有可核对的历史纯 Codex 完整交付基线。', '缺少该模型近期有效的实测输出速度。']);
  assert.deepEqual(details.exclusionSummary.map(row => [row.label, row.countLabel]), [
    ['没有可核对的历史纯 Codex 完整交付基线。', '1 个交付'],
    ['缺少该模型近期有效的实测输出速度。', '1 个交付'],
  ]);
  assert.deepEqual(details.speeds.rows.map(row => [row.label, row.valueLabel, row.basisLabel, row.samplesLabel]), [
    ['qwen3-coder', '约 42 Token/秒', '模型实测', '2 个实测样本'],
  ]);
  assert.equal(details.speeds.partial, false);
  assert.match(details.speeds.note, /中位数/);
  assert.match(details.note, /跨周期/);
  const serialized = JSON.stringify(details);
  assert.doesNotMatch(serialized, /deliveryId|threadId|baselineCodexTokens|actualCodexTokens|codexTokensSaved|timeSavingRate|qoder:total|benefit:|sourceRef/);
});

test('小队收益直接消费 buildSquadBenefits 的真实交付输出', () => {
  const conditions = {
    workType: 'feature', scale: 'small', model: 'gpt-5-codex',
    reasoning: 'medium', acceptance: 'tests', tools: 'edit', permissions: 'standard',
  };
  const deliveryEvidence = [
    {
      deliveryId: 'w1:t1', threadId: 't1', parentWorkId: 'w1', accepted: true,
      completedAt: '2026-10-20T10:00:00.000Z', title: '订单工作台',
      range: {startedAt: '2026-10-20T09:00:00.000Z'}, conditions,
      actual: {
        codex: {
          sourceRef: 'cx1', complete: true, includesMain: true, includesSubagents: true,
          models: [{model: 'gpt-5-codex', source: 'actual', inputTokens: 30000, outputTokens: 10000}],
        },
        qoder: {
          used: true, sourceRef: 'q1', complete: true,
          models: [{model: 'qwen3-coder', source: 'actual', inputTokens: 15000, outputTokens: 5000}],
        },
      },
      baseline: {
        sourceRef: 'base1', pureCodex: true, complete: true,
        includesMain: true, includesSubagents: true,
        completedAt: '2026-10-01T10:00:00.000Z', conditions,
        models: [{model: 'gpt-5-codex', source: 'actual', inputTokens: 80000, outputTokens: 20000}],
      },
    },
    {
      deliveryId: 'w2:t2', threadId: 't2', parentWorkId: 'w2', accepted: true,
      completedAt: '2026-10-21T10:00:00.000Z', title: '库存同步', conditions,
      actual: {
        codex: {
          sourceRef: 'cx2', complete: true, includesMain: true, includesSubagents: true,
          models: [{model: 'gpt-5-codex', source: 'actual', inputTokens: 2000, outputTokens: 500}],
        },
        qoder: {used: false},
      },
      baseline: null,
    },
  ];
  const speedSamples = [
    {sourceRef: 'sp1', scope: 'model', model: 'gpt-5-codex', source: 'actual', outputTokens: 10000, durationMs: 100000, endedAt: '2026-10-20T10:00:00.000Z'},
    {sourceRef: 'sp2', scope: 'model', model: 'qwen3-coder', source: 'actual', outputTokens: 5000, durationMs: 50000, endedAt: '2026-10-20T10:00:00.000Z'},
  ];
  const benefits = buildSquadBenefits({
    deliveryEvidence, speedSamples, now: new Date('2026-10-22T08:00:00.000Z'), days: 7,
  });
  const data = stats({
    benefits,
    tasks: [],
    sessions: [
      {
        threadId: 't1', title: '订单工作台会话', summary: '', representativeTasks: [],
        taskCount: 1, attemptCount: 1, tokens: {totalTokens: null},
        links: {overview: SCOPE_OVERVIEW_URL, tasks: []},
      },
      {
        threadId: 'base1', title: '历史纯 Codex 基线', summary: '', representativeTasks: [],
        taskCount: 1, attemptCount: 1, tokens: {totalTokens: null},
        links: {overview: 'https://scope.example/scene-token/#overview-history', tasks: []},
      },
    ],
  });
  const view = squadBenefits(data);
  assert.equal(view.state, 'positive');
  assert.deepEqual(view.metrics.map(metric => [metric.label, metric.value, metric.percent]), [
    ['测算少用 Codex Token', '60.0K', '60%'],
    ['测算节省处理时间', '不足 1 分钟', '25%'],
  ]);
  assert.equal(view.coverageLabel, '覆盖 1 / 2 次已完成交付');

  const details = view.details;
  const included = details.deliveries.find(delivery => delivery.title === '订单工作台');
  assert.equal(included.statusLabel, '已完成');
  assert.equal(included.actualLabel, 'Codex 40.0K · Qoder 20.0K');
  assert.equal(included.actualCodexLabel, '40.0K');
  assert.equal(included.actualQoderLabel, '20.0K');
  assert.equal(included.baselineLabel, '基线 100.0K');
  assert.equal(included.baselineTokenLabel, '100.0K');
  assert.equal(included.netTokenLabel, '+60.0K');
  assert.equal(included.baselineTimeLabel, '基线耗时 3 分钟');
  assert.equal(included.timeSavingLabel, '节省 不足 1 分钟');
  assert.deepEqual(included.sources, [{
    label: '历史纯 Codex 基线',
    href: 'https://scope.example/scene-token/#overview-history',
  }]);
  assert.equal(included.included, true);

  const excluded = details.deliveries.find(delivery => delivery.title === '库存同步');
  assert.equal(excluded.included, false);
  assert.equal(excluded.actualLabel, 'Codex 2.5K · Qoder 未参与');
  assert.deepEqual(excluded.exclusions, ['没有可核对的历史纯 Codex 完整交付基线。']);
  assert.deepEqual(details.exclusionSummary.map(row => [row.label, row.countLabel]), [
    ['没有可核对的历史纯 Codex 完整交付基线。', '1 个交付'],
  ]);
  assert.deepEqual(details.speeds.rows.map(row => [row.label, row.valueLabel, row.basisLabel, row.samplesLabel]), [
    ['gpt-5-codex', '约 100 Token/秒', '模型实测', '1 个实测样本'],
    ['qwen3-coder', '约 100 Token/秒', '模型实测', '1 个实测样本'],
  ]);
  const serialized = JSON.stringify(details);
  assert.doesNotMatch(serialized, /base1|cx1|cx2|q1|sp1|sp2|sourceRef|threadId|deliveryId/);
});

test('模型速度部分缺失时标为未上报，整轮粗估单独标注', () => {
  const partial = squadBenefits(benefitsStats({
    benefits: benefitsFixture({
      speeds: [
        {model: 'qwen3-coder', basis: 'model', samples: 2, tokensPerSecond: 42, rough: false},
        {model: 'gpt-5-codex', basis: 'run', samples: 1, tokensPerSecond: null, rough: true},
      ],
    }),
  })).details.speeds;
  assert.equal(partial.partial, true);
  assert.deepEqual(partial.rows.map(row => [row.label, row.valueLabel, row.basisLabel, row.rough]), [
    ['qwen3-coder', '约 42 Token/秒', '模型实测', false],
    ['gpt-5-codex', '速度未上报', '整轮粗估', true],
  ]);

  const rough = squadBenefits(benefitsStats({
    benefits: benefitsFixture({
      speeds: [{model: 'gpt-5-codex', basis: 'run', samples: 3, tokensPerSecond: 25.4, rough: true}],
    }),
  })).details.speeds;
  assert.equal(rough.partial, false);
  assert.deepEqual(rough.rows.map(row => [row.label, row.valueLabel, row.basisLabel]), [
    ['gpt-5-codex', '约 25 Token/秒', '整轮粗估'],
  ]);
});

test('收益为负时保留固定节省标题与真实负号，并说明实际投入高于基线', () => {
  const view = squadBenefits(benefitsStats({
    benefits: benefitsFixture({
      summary: {
        baselineCodexTokens: 100000, actualCodexTokens: 105000, qoderTokens: 10000,
        codexTokensSaved: -5000, tokenSavingRate: -0.05,
        baselineSeconds: 7200, squadSeconds: 7800, secondsSaved: -600, timeSavingRate: -0.0833,
      },
    }),
  }));
  assert.equal(view.state, 'negative');
  assert.equal(view.visible, true);
  assert.equal(view.empty, false);
  assert.equal(view.metrics[0].label, '测算少用 Codex Token');
  assert.equal(view.metrics[0].value, '-5.0K');
  assert.equal(view.metrics[0].percent, '-5%');
  assert.equal(view.metrics[0].tone, 'warn');
  assert.equal(view.metrics[1].label, '测算节省处理时间');
  assert.equal(view.metrics[1].value, '约 -10 分钟');
  assert.equal(view.metrics[1].percent, '-8.3%');
  assert.equal(view.metrics[1].tone, 'warn');
  assert.match(view.details.signedNote, /负值表示/);
  assert.match(view.details.signedNote, /多用、多投入/);
  assert.match(view.details.signedNote, /而不是节省/);
});

test('收益为 0 时仍保留区域并显示持平', () => {
  const view = squadBenefits(benefitsStats({
    benefits: benefitsFixture({
      summary: {
        baselineCodexTokens: 100000, actualCodexTokens: 100000,
        codexTokensSaved: 0, tokenSavingRate: 0,
        baselineSeconds: 1000, squadSeconds: 1000, secondsSaved: 0, timeSavingRate: 0,
      },
    }),
  }));
  assert.equal(view.visible, true);
  assert.equal(view.empty, false);
  assert.equal(view.metrics[0].missing, false);
  assert.equal(view.metrics[0].value, '持平');
  assert.equal(view.metrics[1].missing, false);
  assert.equal(view.metrics[1].value, '持平');
});

test('收益不可估算时隐藏整个区域，不按 0 或示例值补齐', () => {
  const legacy = squadBenefits(stats());
  assert.equal(legacy.present, false);
  assert.equal(legacy.available, false);
  assert.equal(legacy.empty, true);
  assert.equal(legacy.visible, false);
  assert.equal(legacy.emptyTitle, '暂无法估算');
  assert.equal(legacy.emptyText, '本周期尚无收益报告。');
  assert.equal(legacy.state, 'missing');
  assert.deepEqual(legacy.metrics.map(metric => [metric.value, metric.missing]), [
    ['暂无法估算', true],
    ['暂无法估算', true],
  ]);
  assert.equal(legacy.coverageLabel, '尚无可比较的已完成交付');
  assert.equal(legacy.details.emptyText, '本周期尚无收益报告。');
  assert.doesNotMatch(JSON.stringify(legacy), /0\.0K|示例|固定比例/);

  const noSummary = squadBenefits(stats({benefits: {schemaVersion: 1, deliveries: [], speeds: []}}));
  assert.equal(noSummary.present, true);
  assert.equal(noSummary.visible, false);
  assert.equal(noSummary.empty, true);
  assert.equal(noSummary.emptyText, '本周期收益报告尚未包含汇总结果。');

  const noBaseline = squadBenefits(benefitsStats({benefits: benefitsFixture({summary: {}})}));
  assert.equal(noBaseline.present, true);
  assert.equal(noBaseline.visible, false);
  assert.equal(noBaseline.state, 'missing');
  assert.equal(noBaseline.emptyText, '暂无法估算');
});

test('部分汇总缺失时保留已可估指标，另一项明确暂无法估算', () => {
  const view = squadBenefits(benefitsStats({
    benefits: benefitsFixture({
      summary: {
        baselineCodexTokens: 100000, actualCodexTokens: 40000, qoderTokens: 10000,
        codexTokensSaved: 60000, tokenSavingRate: 0.6,
        baselineSeconds: null, squadSeconds: null, secondsSaved: null,
      },
    }),
  }));
  assert.equal(view.state, 'partial');
  assert.equal(view.visible, true);
  assert.equal(view.empty, false);
  assert.equal(view.metrics[0].missing, false);
  assert.equal(view.metrics[0].value, '60.0K');
  assert.equal(view.metrics[1].missing, true);
  assert.equal(view.metrics[1].value, '暂无法估算');
});

test('没有可比较交付时覆盖说明为空态，不显示 0/0', () => {
  const view = squadBenefits(benefitsStats({
    benefits: benefitsFixture({
      coverage: {completedDeliveries: 0, tokenEstimatedDeliveries: 0, timeEstimatedDeliveries: 0, observedDeliveries: 0},
    }),
  }));
  assert.equal(view.coverageLabel, '尚无可比较的已完成交付');
  assert.equal(JSON.stringify(view.details).includes('0 / 0'), false);
});

test('收益观察来自保存快照或可读观察，不补造原因', () => {
  const saved = squadBenefits(benefitsStats());
  assert.equal(saved.observation, '两笔已完成交付的 Codex 用量低于历史基线。');
  assert.deepEqual(saved.observationLinks, []);

  const data = {
    ...withAnalysis({
      available: true,
      summary: '',
      categories: {skills_tools: [suggestion('收敛规则', ['task:t1:a1', 'qoder:total', 'benefit:coverage'])], time: [], tokens: []},
    }),
    benefits: benefitsFixture({observation: ''}),
  };
  const fallback = squadBenefits(data);
  assert.equal(fallback.observation, '证据说明');
  assert.deepEqual(fallback.observationLinks.map(link => link.href), [SCOPE_TASK_URL]);
});

test('收益与 Qoder 统计引用只显示可读名称，不显示原始引用', () => {
  const item = analysisObservations(withAnalysis({
    available: true,
    categories: {skills_tools: [suggestion('对齐用量', ['qoder:total', 'benefit:coverage', 'benefit:total'])], time: [], tokens: []},
  })).items[0];
  assert.deepEqual(item.evidenceNames, ['Qoder 用量汇总', '小队收益汇总']);
  assert.doesNotMatch(JSON.stringify(item), /qoder:total|benefit:/);
});

test('优先跟进直接消费 aggregateAnalytics 的真实任务输出', () => {
  const attempt = (id, startedAt = '2026-01-09T00:00:00.000Z') => ({
    id, index: 1, status: 'completed', startedAt,
    endedAt: new Date(Date.parse(startedAt) + 600000).toISOString(),
    sessionId: 'native-1', usage: null, events: [], handoff: {goal: 'g'}, result: 'r', error: null,
  });
  const acceptedTask = (id, attempts) => ({
    id, title: `任务 ${id}`, memberId: 'm', status: 'waiting_review', attempts,
    acceptance: {fingerprint: `fp-${id}`, at: '2026-01-09T00:11:00.000Z'},
  });
  const result = aggregateAnalytics([{
    schemaVersion: 1, connected: true, observedAt: '2026-01-09T12:00:00.000Z',
    binding: {threadId: 'thread-real', workspace: '/w', projectId: 'p', parentWorkId: 'parent', title: '真实会话'},
    members: [],
    tasks: [
      acceptedTask('one', [attempt('a1')]),
      acceptedTask('two', [attempt('a2'), {...attempt('a3', '2026-01-09T01:00:00.000Z'), index: 2}]),
    ],
    usage: {inputTokens: null, outputTokens: null, cachedInputTokens: null, totalTokens: null, reportedAttempts: 0, totalAttempts: 0, mainSession: 'unavailable'},
    cursor: 'c',
  }], {scope: 'global', now: new Date('2026-01-10T12:00:00.000Z')});
  const accepted = result.tasks.filter(task => task.accepted);
  assert.equal(accepted.length, 2);
  assert.deepEqual(accepted.map(task => task.fullAttemptCount).sort(), [1, 2]);
  const view = deliveryEfficiency({...result, analysis: {statsAvailable: true, available: false}});
  assert.equal(view.available, true);
  assert.equal(view.focusTotal, 0);
  assert.equal(view.focusEmpty, true);
  assert.deepEqual(view.focus, []);
  assert.equal(Object.hasOwn(view, 'metrics'), false);
});

test('CLI 449 条已保存指令默认 3 条，展开后逐行增加并可按 lgb 筛选', () => {
  const rows = Array.from({length: 449}, (_, index) => ({
    name: index < 439 ? 'a1' : 'lgb',
    command: `command ${index + 1}`,
    calls: 449 - index,
    execution: {succeeded: 449 - index, failed: 0, unknown: 0},
    business: {succeeded: 449 - index, failed: 0, unknown: 0},
    failures: [],
    sessions: [],
  }));
  const data = stats({capabilities: {tools: [], skillReads: [], cli: {rows, unclassifiedCalls: 95}}});
  const initial = cliView(data);
  assert.equal(initial.rowCount, 449);
  assert.equal(initial.filteredCount, 449);
  assert.equal(initial.shownCount, 3);
  assert.equal(initial.rows.length, 3);
  assert.equal(initial.hiddenCount, 446);
  assert.equal(initial.canExpand, true);
  assert.equal(initial.toggleLabel, '展开全部 449 条指令');
  assert.equal(initial.filters.find(option => option.value === 'lgb').label, 'lgb (10 条)');

  const expanded = cliView(data, {expanded: true});
  assert.equal(expanded.shownCount, 449);
  assert.equal(expanded.rows.length, 449);
  assert.equal(expanded.rows.length, expanded.shownCount);
  assert.equal(expanded.hiddenCount, 0);
  assert.equal(expanded.toggleLabel, '收起至前 3 条');

  const collapsed = cliView(data, {expanded: false});
  assert.equal(collapsed.shownCount, 3);
  assert.equal(collapsed.rows.length, 3);

  const filtered = cliView(data, {filter: 'lgb'});
  assert.equal(filtered.filteredCount, 10);
  assert.equal(filtered.shownCount, 3);
  assert.equal(filtered.rows.length, 3);
  assert.equal(filtered.rows.every(row => row.name === 'lgb'), true);
  assert.equal(filtered.toggleLabel, '展开全部 10 条指令');

  const filteredExpanded = cliView(data, {filter: 'lgb', expanded: true});
  assert.equal(filteredExpanded.filteredCount, 10);
  assert.equal(filteredExpanded.shownCount, 10);
  assert.equal(filteredExpanded.rows.length, filteredExpanded.shownCount);
  assert.equal(filteredExpanded.rows.every(row => row.name === 'lgb'), true);
  assert.equal(filteredExpanded.unclassifiedCalls, 95);
});

test('收益展示保留一位百分比并使用近似分钟和小时',()=>{
  const view=squadBenefits(benefitsStats({benefits:benefitsFixture({summary:{baselineCodexTokens:1600000,actualCodexTokens:850000,qoderTokens:600000,codexTokensSaved:750000,tokenSavingRate:0.46875,baselineSeconds:1950,squadSeconds:1170,secondsSaved:780,timeSavingRate:0.4}})}));
  assert.equal(view.metrics[0].percent,'46.9%');
  assert.equal(view.metrics[1].value,'约 13 分钟');
  const negative=squadBenefits(benefitsStats({benefits:benefitsFixture({summary:{codexTokensSaved:-1200,tokenSavingRate:-1.2}})}));
  assert.equal(negative.metrics[0].value,'-1.2K');
  assert.equal(negative.metrics[0].percent,'-120%');
});

test('旧报告里的验证引用展示可读名称',()=>{
  const data=withAnalysis({available:true,categories:{tokens:[{title:'核对投入',action:'核对记录',verification:'metric:s1:t1:totalTokens',evidenceRefs:['metric:s1:t1:totalTokens']}]}});
  const item=analysisObservations(data).items.find(row=>row.categoryKey==='tokens');
  assert.doesNotMatch(item.verification,/metric:|totalTokens/);
});

test('计算依据保留本周期 32 项交付和模型速度，页内表先展示三条并可展开收回',()=>{
  const base=benefitsFixture();
  const deliveries=Array.from({length:32},(_,i)=>({...base.deliveries[1],deliveryId:'delivery-'+i,title:'交付 '+i}));
  const speeds=Array.from({length:8},(_,i)=>({model:'model-'+i,basis:'model',samples:2,tokensPerSecond:100,rough:false}));
  const view=squadBenefits(benefitsStats({benefits:benefitsFixture({deliveries,speeds})}));
  const details=view.details;
  assert.equal(details.deliveries.length,32);
  assert.equal(details.deliveriesOmitted,0);
  assert.equal(details.speeds.rows.length,8);
  assert.equal(details.previewLimit,3);
  assert.equal(details.canExpand,true);
  assert.equal(details.expandLabel,'展开全部 32 项');
  assert.equal(details.collapseLabel,'收起至 3 项');
  assert.equal(details.includedCount,0);
  assert.equal(details.excludedCount,32);
  assert.equal(details.countLabel,'共 32 项 · 0 项已纳入 · 32 项未计入');
  assert.equal(details.deliveries.every(item=>item.included===false),true);
  assert.equal(details.deliveries.every(item=>item.baselineTokenLabel===UNREPORTED),true);
  assert.equal(details.deliveries.every(item=>item.netTokenLabel===UNREPORTED),true);
  assert.equal(details.deliveries.every(item=>item.exclusions.length===2),true);
  assert.doesNotMatch(JSON.stringify(details),/delivery-\d|sourceRef|baselineCodexTokens/);
});

function cliRowsFixture(rows) {
  return stats({capabilities: {tools: [], skillReads: [], cli: {rows, unclassifiedCalls: 7}}});
}

test('CLI 调用数按原始数字排序，跨 K/M/B 量级不按标签字典序', () => {
  const data = cliRowsFixture([
    {name: 'a1', command: 'sync mega', calls: 2_100_000_000, execution: {succeeded: 2_100_000_000, failed: 0, unknown: 0}, business: {succeeded: 2_100_000_000, failed: 0, unknown: 0}, failures: []},
    {name: 'a1', command: 'sync small', calls: 950, execution: {succeeded: 950, failed: 0, unknown: 0}, business: {succeeded: 950, failed: 0, unknown: 0}, failures: []},
    {name: 'lgb', command: 'sync million', calls: 3_400_000, execution: {succeeded: 3_400_000, failed: 0, unknown: 0}, business: {succeeded: 3_400_000, failed: 0, unknown: 0}, failures: []},
    {name: 'lgb', command: 'sync thousand', calls: 1_200, execution: {succeeded: 1_200, failed: 0, unknown: 0}, business: {succeeded: 1_200, failed: 0, unknown: 0}, failures: []},
  ]);
  const defaultView = cliView(data);
  assert.deepEqual(defaultView.rows.map(row => row.command), ['sync mega', 'sync million', 'sync thousand']);
  assert.equal(defaultView.sort, null);

  const asc = cliView(data, {sort: {key: 'calls', direction: 'asc'}, expanded: true});
  assert.deepEqual(asc.rows.map(row => row.calls), [950, 1_200, 3_400_000, 2_100_000_000]);
  assert.deepEqual(asc.sort, {key: 'calls', direction: 'asc'});
  const desc = cliView(data, {sort: {key: 'calls', direction: 'desc'}, expanded: true});
  assert.deepEqual(desc.rows.map(row => row.calls), [2_100_000_000, 3_400_000, 1_200, 950]);
});

test('CLI 成功率排序使用已知分母原值，未知分母两方向都置末且不当作 0 或失败', () => {
  const data = cliRowsFixture([
    {name: 'a1', command: 'all ok', calls: 10, execution: {succeeded: 10, failed: 0, unknown: 0}, business: {succeeded: 10, failed: 0, unknown: 0}, failures: []},
    {name: 'a1', command: 'half ok', calls: 8, execution: {succeeded: 1, failed: 1, unknown: 0}, business: {succeeded: 1, failed: 1, unknown: 0}, failures: [{category: 'execution', count: 1}]},
    {name: 'a1', command: 'all failed', calls: 6, execution: {succeeded: 0, failed: 2, unknown: 0}, business: {succeeded: 0, failed: 2, unknown: 0}, failures: [{category: 'execution', count: 2}]},
    {name: 'lgb', command: 'unconfirmed', calls: 100, execution: {succeeded: 0, failed: 0, unknown: 100}, business: {succeeded: 0, failed: 0, unknown: 100}, failures: []},
  ]);
  const asc = cliView(data, {sort: {key: 'execution', direction: 'asc'}, expanded: true});
  assert.deepEqual(asc.rows.map(row => row.command), ['all failed', 'half ok', 'all ok', 'unconfirmed']);
  assert.equal(asc.rows[0].sortValues.execution, 0);
  assert.equal(asc.rows[3].sortValues.execution, null);
  assert.equal(asc.rows[3].execution.rate, null);
  assert.equal(asc.rows[3].execution.display, '— (未确认)');
  assert.equal(asc.rows[3].hasFailures, false);

  const desc = cliView(data, {sort: {key: 'execution', direction: 'desc'}, expanded: true});
  assert.deepEqual(desc.rows.map(row => row.command), ['all ok', 'half ok', 'all failed', 'unconfirmed']);
  assert.equal(desc.rows[3].sortValues.execution, null);

  const byBusiness = cliView(data, {sort: {key: 'business', direction: 'asc'}, expanded: true});
  assert.equal(byBusiness.rows[3].command, 'unconfirmed');
  assert.equal(byBusiness.rows[3].sortValues.business, null);
});

test('CLI 搜索大小写无关、支持多词与中文，并与名称筛选取交集', () => {
  const data = cliRowsFixture([
    {name: 'a1', command: 'Repo View', calls: 30, execution: {succeeded: 30, failed: 0, unknown: 0}, business: {succeeded: 30, failed: 0, unknown: 0}, failures: []},
    {name: 'a1', command: 'repo create', calls: 20, execution: {succeeded: 20, failed: 0, unknown: 0}, business: {succeeded: 20, failed: 0, unknown: 0}, failures: []},
    {name: 'a1', command: '订单 工作台', calls: 10, execution: {succeeded: 10, failed: 0, unknown: 0}, business: {succeeded: 10, failed: 0, unknown: 0}, failures: []},
    {name: 'lgb', command: 'Log Query', calls: 5, execution: {succeeded: 5, failed: 0, unknown: 0}, business: {succeeded: 5, failed: 0, unknown: 0}, failures: []},
  ]);
  const upper = cliView(data, {query: 'REPO', expanded: true});
  assert.deepEqual(upper.rows.map(row => row.command), ['Repo View', 'repo create']);
  assert.equal(upper.filteredCount, 2);

  const multi = cliView(data, {query: 'repo VIEW', expanded: true});
  assert.deepEqual(multi.rows.map(row => row.command), ['Repo View']);
  assert.equal(multi.query, 'repo VIEW');

  const chinese = cliView(data, {query: '订单 工作台'});
  assert.deepEqual(chinese.rows.map(row => row.command), ['订单 工作台']);

  const intersected = cliView(data, {filter: 'a1', query: 'repo', expanded: true});
  assert.equal(intersected.filter, 'a1');
  assert.deepEqual(intersected.rows.map(row => row.command), ['Repo View', 'repo create']);

  const crossField = cliView(data, {query: 'a1 repo', expanded: true});
  assert.deepEqual(crossField.rows.map(row => row.command), ['Repo View', 'repo create']);
});

test('CLI 搜索无匹配仍可搜索、覆盖与总调用保留，清空后恢复', () => {
  const data = cliRowsFixture([
    {name: 'a1', command: 'Repo View', calls: 30, execution: {succeeded: 29, failed: 1, unknown: 0}, business: {succeeded: 30, failed: 0, unknown: 0}, failures: [{category: 'execution', count: 1}]},
    {name: 'lgb', command: 'Log Query', calls: 5, execution: {succeeded: 5, failed: 0, unknown: 0}, business: {succeeded: 5, failed: 0, unknown: 0}, failures: []},
  ]);
  const before = cliView(data);
  const totalCalls = before.totalCalls;
  const rowCount = before.rowCount;
  const filters = before.filters;
  const coverage = before.coverageLabel;

  const missing = cliView(data, {query: 'ghost command'});
  assert.equal(missing.available, true);
  assert.equal(missing.empty, false);
  assert.equal(missing.noMatches, true);
  assert.deepEqual(missing.rows, []);
  assert.equal(missing.filteredCount, 0);
  assert.equal(missing.shownCount, 0);
  assert.equal(missing.hiddenCount, 0);
  assert.equal(missing.canExpand, false);
  assert.equal(missing.toggleLabel, null);
  assert.equal(missing.totalCalls, totalCalls);
  assert.equal(missing.rowCount, rowCount);
  assert.equal(missing.unclassifiedCalls, 7);
  assert.equal(missing.coverageLabel, coverage);
  assert.deepEqual(missing.filters, filters);

  const filteredMissing = cliView(data, {filter: 'lgb', query: 'repo'});
  assert.equal(filteredMissing.filter, 'lgb');
  assert.equal(filteredMissing.noMatches, true);
  assert.equal(filteredMissing.rowCount, 2);

  const cleared = cliView(data, {query: '   '});
  assert.equal(cleared.query, '');
  assert.equal(cleared.noMatches, false);
  assert.equal(cleared.filteredCount, rowCount);
  assert.equal(cleared.shownCount, 2);
});

test('CLI 449 条真实体量下先筛选排序再预览，结果计数与总调用准确', () => {
  const rows = Array.from({length: 449}, (_, index) => ({
    name: index < 439 ? 'a1' : 'lgb',
    command: index % 2 === 0 ? `Repo Sync ${index + 1}` : `Log Read ${index + 1}`,
    calls: 449 - index,
    execution: {succeeded: 449 - index, failed: 0, unknown: 0},
    business: {succeeded: 449 - index, failed: 0, unknown: 0},
    failures: [],
    sessions: [],
  }));
  const data = stats({capabilities: {tools: [], skillReads: [], cli: {rows, unclassifiedCalls: 95}}});

  const repo = cliView(data, {query: 'repo sync'});
  assert.equal(repo.rowCount, 449);
  assert.equal(repo.totalCalls, 449 * 450 / 2);
  assert.equal(repo.filteredCount, 225);
  assert.equal(repo.shownCount, 3);
  assert.equal(repo.hiddenCount, 222);
  assert.equal(repo.toggleLabel, '展开全部 225 条指令');

  const repoAsc = cliView(data, {query: 'repo sync', sort: {key: 'calls', direction: 'asc'}});
  assert.deepEqual(repoAsc.rows.map(row => row.calls), [1, 3, 5]);
  assert.equal(repoAsc.rows.every(row => row.command.startsWith('Repo Sync')), true);

  const scoped = cliView(data, {query: 'a1 repo sync'});
  assert.equal(scoped.filteredCount, 220);

  const lgb = cliView(data, {filter: 'lgb', query: 'repo', sort: {key: 'command', direction: 'asc'}, expanded: true});
  assert.equal(lgb.filteredCount, 5);
  assert.equal(lgb.shownCount, 5);
  assert.deepEqual(
    lgb.rows.map(row => row.command),
    ['Repo Sync 441', 'Repo Sync 443', 'Repo Sync 445', 'Repo Sync 447', 'Repo Sync 449'],
  );
  assert.equal(lgb.totalCalls, 449 * 450 / 2);
  assert.equal(lgb.rowCount, 449);
});

test('会话排行暴露任务、尝试与已报 Token 的原始排序值', () => {
  const row = sessionRows(stats()).rows[0];
  assert.deepEqual(row.sortValues, {tasks: 10, attempts: 4, tokens: 1250});
  const missing = sessionRows(stats({
    sessions: [{
      threadId: 't9', title: '无用量会话', representativeTasks: [], taskCount: 2, attemptCount: 1,
      tokens: {totalTokens: null}, links: {},
    }],
  })).rows[0];
  assert.deepEqual(missing.sortValues, {tasks: 2, attempts: 1, tokens: null});
});

test('对比行与未对齐行暴露两侧真实 Token 数字，缺失为 null', () => {
  const compare = usageComparison(stats({codexUsage: usageFixture(), executorUsage: {qoder: qoderFixture()}}));
  const aligned = compare.rows.find(row => row.title === '订单工作台会话');
  assert.equal(aligned.codexTotal, 7000);
  assert.equal(aligned.qoderTotal, 4000);
  const qoderOnly = compare.rows.find(row => row.title === 'Qoder 独立会话');
  assert.equal(qoderOnly.codexTotal, null);
  assert.equal(qoderOnly.qoderTotal, null);
  assert.deepEqual(compare.codexOnly.map(row => [row.codexTotal, row.qoderTotal]), [[2000, null], [1000, null]]);
});

test('收益交付行暴露基线、两侧投入与节省的原始排序值', () => {
  const view = squadBenefits(benefitsStats());
  const [estimated, excluded] = view.details.deliveries;
  assert.deepEqual(estimated.sortValues, {
    baselineTokens: 100000,
    codexTokens: 40000,
    qoderTokens: 20000,
    savedTokens: 60000,
    savedSeconds: 3600,
  });
  assert.deepEqual(excluded.sortValues, {
    baselineTokens: null,
    codexTokens: 1000,
    qoderTokens: null,
    savedTokens: null,
    savedSeconds: null,
  });
});


test('收益测算以实际纳入的完整交付数说明，不把全部观察项算成收益', () => {
  const benefits=benefitsFixture({coverage:{observedDeliveries:32,completedDeliveries:7,tokenEstimatedDeliveries:1,timeEstimatedDeliveries:1},observation:'本期1个完整交付已有可比较的历史基线；收益据此估算。'});
  const before=structuredClone(benefits);
  const view=squadBenefits(benefitsStats({benefits}));
  assert.equal(view.summaryLine,'仅测算 1 项可比交付，不外推整体');
  assert.equal(view.coverageLabel,'覆盖 1 / 7 次已完成交付');
  assert.match(view.observation,/收益据此测算/);
  assert.equal(view.negativeNote,null);
  assert.deepEqual(benefits,before);
});

test('Token与处理时间的测算覆盖不同时分别说明，缺失数量不冒称已统计', () => {
  const view=coverage=>squadBenefits(benefitsStats({benefits:benefitsFixture({coverage})}));
  const different=view({tokenEstimatedDeliveries:3,timeEstimatedDeliveries:2});
  assert.equal(different.summaryLine,'仅测算 Token 3 项、时间 2 项可比交付，不外推整体');
  assert.equal(view({tokenEstimatedDeliveries:3,timeEstimatedDeliveries:0}).summaryLine,'仅测算 3 项可比交付的 Token，时间口径暂不可测算');
  assert.equal(view({tokenEstimatedDeliveries:0,timeEstimatedDeliveries:2}).summaryLine,'仅测算 2 项可比交付的时间，Token 口径暂不可测算');
  assert.equal(view({}).summaryLine,'测算覆盖未确认，不外推整体');
});

test('测算为负时保留符号和覆盖，并用可读文案说明多用与多投入', () => {
  const view=squadBenefits(benefitsStats({benefits:benefitsFixture({summary:{baselineCodexTokens:9041452,actualCodexTokens:29967655,qoderTokens:12364670,codexTokensSaved:-20926203,secondsSaved:-3230.147,baselineSeconds:2150.676},coverage:{completedDeliveries:7,tokenEstimatedDeliveries:1,timeEstimatedDeliveries:1}})}));
  assert.equal(view.summaryLine,'仅测算 1 项可比交付，不外推整体');
  assert.equal(view.metrics[0].value,'-20.93M');
  assert.equal(view.metrics[1].value,'约 -54 分钟');
  assert.match(view.negativeNote,/测算比全 Codex 基线多用 20.93M Codex Token/);
  assert.match(view.negativeNote,/多投入约 54 分钟处理时间/);
  assert.doesNotMatch(view.negativeNote,/实际.*时间|将节省/);
  const zero=squadBenefits(benefitsStats({benefits:benefitsFixture({summary:{codexTokensSaved:0,secondsSaved:0}})}));
  assert.equal(zero.negativeNote,null);
  assert.deepEqual(zero.metrics.map(metric=>metric.value),['持平','持平']);
});

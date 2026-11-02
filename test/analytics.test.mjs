import test from 'node:test';
import assert from 'node:assert/strict';
import {aggregateAnalytics,cliAttemptInputs} from '../cli/lib/analytics.mjs';

const NOW=new Date('2026-01-10T12:00:00.000Z');
const WORKSPACE='/Users/private/secret-worktree';

function attempt(id,overrides={}){
  return {
    id,
    index:overrides.index??1,
    status:'completed',
    startedAt:'2026-01-09T00:00:00.000Z',
    endedAt:'2026-01-09T00:10:00.000Z',
    sessionId:'native-1',
    model:'configured-model',
    actualModel:null,
    usage:null,
    handoff:{goal:'SECRET HANDOFF GOAL'},
    events:[],
    result:'SECRET RESULT',
    error:null,
    ...overrides
  };
}

function task(id,attempts,overrides={}){
  return {
    id,
    title:`任务 ${id}`,
    memberId:'member-1',
    status:'completed',
    attempts,
    acceptance:null,
    ...overrides
  };
}

function snapshot(threadId,tasks,overrides={}){
  return {
    schemaVersion:1,
    connected:true,
    observedAt:'2026-01-09T12:00:00.000Z',
    binding:{threadId,workspace:WORKSPACE,projectId:'project-1',parentWorkId:'parent-1',title:`会话 ${threadId}`},
    members:[],
    tasks,
    usage:{inputTokens:null,outputTokens:null,cachedInputTokens:null,totalTokens:null,reportedAttempts:0,totalAttempts:0,mainSession:'unavailable',currency:null},
    cursor:'cursor-1',
    ...overrides
  };
}

function usage(inputTokens=null,outputTokens=null,cachedInputTokens=null,totalTokens=null){
  return {inputTokens,outputTokens,cachedInputTokens,totalTokens};
}

test('executor usage separates Qoder receipts from historical Codex and unknown members',()=>{
  const data=aggregateAnalytics([snapshot('one',[
    task('q',[attempt('q',{usage:usage(10,2,3,12)})],{memberId:'q'}),
    task('c',[attempt('c',{usage:usage(20,5,0,25)})],{memberId:'c'}),
    task('u',[attempt('u',{usage:usage(30,6,0,36)})]),
  ],{members:[{id:'q',executor:'qoder'},{id:'c',executor:'codex'}]})],{scope:'global',now:NOW});
  assert.equal(data.tokens.totalTokens,73);
  assert.equal(data.tokens.executors.find(row=>row.executor==='qoder').totalTokens,12);
  assert.equal(data.tokens.executors.find(row=>row.executor==='codex').totalTokens,25);
  assert.equal(data.tokens.executors.find(row=>row.executor==='unknown').totalTokens,36);
  assert.equal(data.tokens.executors.find(row=>row.executor==='qoder').reportedAttempts,1);
});

test('empty input keeps unknown token fields null and zero reports stay zero',()=>{
  const empty=aggregateAnalytics([],{scope:'global',now:NOW});
  assert.equal(empty.schemaVersion,1);
  assert.equal(empty.metrics.sessionCount,0);
  assert.equal(empty.metrics.firstReturn.rate,null);
  assert.equal(empty.tokens.inputTokens,null);
  assert.equal(empty.tokens.outputTokens,null);
  assert.equal(empty.tokens.cachedInputTokens,null);
  assert.equal(empty.tokens.totalTokens,null);
  assert.deepEqual(empty.trend,[]);
  assert.deepEqual(empty.tasks,[]);
  assert.deepEqual(empty.sessions,[]);
  assert.equal(empty.tokens.mainSession,'unavailable');

  const zero=aggregateAnalytics([
    snapshot('thread-zero',[task('task-zero',[
      attempt('attempt-zero',{usage:usage(0,0,0,0)}),
      attempt('attempt-missing',{index:2,resumedFrom:'attempt-zero',status:'failed',startedAt:'2026-01-09T00:20:00.000Z',endedAt:'2026-01-09T00:25:00.000Z',usage:null})
    ])])
  ],{scope:'global',now:NOW});
  assert.equal(zero.tokens.inputTokens,0);
  assert.equal(zero.tokens.outputTokens,0);
  assert.equal(zero.tokens.cachedInputTokens,0);
  assert.equal(zero.tokens.totalTokens,0);
  assert.deepEqual(zero.tokens.coverage.inputTokens,{reported:1,total:2});
  assert.equal(zero.coverage.attemptsWithUsage,1);
  assert.equal(zero.coverage.attemptsWithoutUsage,1);
  assert.equal(zero.metrics.failedAttempts,1);
});

test('cached tokens are not added to input again',()=>{
  const result=aggregateAnalytics([
    snapshot('thread-cache',[task('task-cache',[attempt('attempt-cache',{usage:usage(100,20,60,120)})])])
  ],{scope:'global',now:NOW});
  assert.equal(result.tokens.inputTokens,100);
  assert.equal(result.tokens.outputTokens,20);
  assert.equal(result.tokens.cachedInputTokens,60);
  assert.equal(result.tokens.totalTokens,120);
});

test('duplicate snapshots, tasks and attempts are counted once while same-native continuations keep both usages',()=>{
  const first=attempt('attempt-1',{usage:usage(10,0,0,10)});
  const second=attempt('attempt-2',{
    index:2,
    resumedFrom:'attempt-1',
    sessionId:'native-1',
    startedAt:'2026-01-09T01:00:00.000Z',
    endedAt:'2026-01-09T01:10:00.000Z',
    usage:usage(20,0,0,20)
  });
  const olderBase=snapshot('thread-a',[
    task('task-1',[attempt('attempt-1',{status:'running',usage:usage(0,0,0,999)})],{status:'running'}),
    task('task-old-only',[attempt('attempt-old-only')])
  ],{observedAt:'2026-01-08T12:00:00.000Z'});
  const older={...olderBase,binding:{...olderBase.binding,title:'旧会话标题'}};
  const threadA=snapshot('thread-a',[
    task('task-1',[first,second],{status:'waiting_review'}),
    task('task-duplicate',[
      attempt('attempt-duplicate',{usage:usage(0,0,0,5)}),
      attempt('attempt-duplicate',{index:1,usage:usage(0,0,0,6)})
    ])
  ]);
  const threadB=snapshot('thread-b',[task('task-2',[attempt('attempt-3',{usage:usage(0,0,0,40)})])]);
  const session=aggregateAnalytics([older,threadA,threadA,threadB],{scope:'session',currentThreadId:'thread-a',now:NOW});
  assert.equal(session.coverage.snapshots,3);
  assert.equal(session.metrics.sessionCount,1);
  assert.equal(session.metrics.taskCount,3);
  assert.equal(session.metrics.attemptCount,4);
  assert.equal(session.metrics.continuationCount,1);
  assert.equal(session.tokens.totalTokens,36);
  assert.equal(session.sessions[0].title,'会话 thread-a');
  assert.equal(session.tasks.find(row=>row.id==='task-1').attemptCount,2);
  assert.equal(session.tasks.find(row=>row.id==='task-1').status,'waiting_review');
  assert.equal(session.tasks.find(row=>row.id==='task-1').tokens.totalTokens,30);
  assert.equal(session.tasks.find(row=>row.id==='task-duplicate').attemptCount,1);
  assert.equal(session.tasks.find(row=>row.id==='task-duplicate').tokens.totalTokens,6);
  assert.equal(session.tokens.mainSession,'unavailable');

  const global=aggregateAnalytics([older,threadA,threadA,threadB],{scope:'global',now:NOW});
  assert.equal(global.coverage.snapshots,4);
  assert.equal(global.metrics.sessionCount,2);
  assert.equal(global.metrics.taskCount,4);
  assert.equal(global.tokens.totalTokens,76);
  assert.deepEqual(global.sessions.map(row=>row.threadId).sort(),['thread-a','thread-b']);
});

test('days filters attempts by startedAt without zero filling undated or missing tokens',()=>{
  const recent=attempt('attempt-recent',{startedAt:'2026-01-09T00:00:00.000Z',endedAt:'2026-01-09T00:10:00.000Z',usage:usage(0,0,0,5)});
  const older=attempt('attempt-older',{startedAt:'2025-12-20T00:00:00.000Z',endedAt:'2025-12-20T00:10:00.000Z',usage:usage(0,0,0,7)});
  const undated=attempt('attempt-undated',{startedAt:undefined,endedAt:undefined,usage:null});
  const data=[
    snapshot('thread-a',[task('task-recent',[recent])]),
    snapshot('thread-b',[task('task-older',[older])]),
    snapshot('thread-c',[task('task-undated',[undated])])
  ];
  const week=aggregateAnalytics(data,{scope:'global',now:NOW,days:7});
  assert.equal(week.metrics.taskCount,1);
  assert.equal(week.metrics.attemptCount,1);
  assert.equal(week.tokens.totalTokens,5);
  assert.equal(week.coverage.undatedAttempts,0);
  assert.deepEqual(week.trend.map(point=>point.date),['2026-01-09']);

  const month=aggregateAnalytics(data,{scope:'global',now:NOW,days:30});
  assert.equal(month.metrics.taskCount,2);
  assert.equal(month.metrics.attemptCount,2);
  assert.equal(month.tokens.totalTokens,12);

  const all=aggregateAnalytics(data,{scope:'global',now:NOW});
  assert.equal(all.metrics.taskCount,3);
  assert.equal(all.metrics.attemptCount,3);
  assert.equal(all.tokens.totalTokens,12);
  assert.equal(all.tokens.coverage.totalTokens.reported,2);
  assert.equal(all.tokens.coverage.totalTokens.total,3);
  assert.equal(all.coverage.undatedAttempts,1);
  assert.deepEqual(all.trend.map(point=>point.date),['2025-12-20','2026-01-09']);
});

test('running, failed, stopped and unknown states stay separate and unknown stops running time',()=>{
  const result=aggregateAnalytics([
    snapshot('thread-status',[
      task('task-running',[attempt('attempt-running',{status:'running',startedAt:'2026-01-10T11:00:00.000Z',endedAt:undefined,usage:null})],{status:'running'}),
      task('task-unknown',[attempt('attempt-unknown',{status:'running',startedAt:'2026-01-10T10:00:00.000Z',endedAt:undefined,usage:null})],{status:'unknown'}),
      task('task-failed',[attempt('attempt-failed',{status:'failed',startedAt:'2026-01-10T10:00:00.000Z',endedAt:'2026-01-10T10:05:00.000Z'})],{status:'failed'}),
      task('task-stopped',[attempt('attempt-stopped',{status:'stopped',startedAt:'2026-01-10T10:00:00.000Z',endedAt:'2026-01-10T10:02:00.000Z'})],{status:'stopped'}),
      task('task-complete',[attempt('attempt-complete',{startedAt:'2026-01-10T10:00:00.000Z',endedAt:'2026-01-10T10:10:00.000Z'})]),
      task('task-accepted',[attempt('attempt-accepted',{startedAt:'2026-01-10T10:00:00.000Z',endedAt:'2026-01-10T10:05:00.000Z'})],{status:'waiting_review',acceptance:{fingerprint:'fp',at:'2026-01-10T10:06:00.000Z'}})
    ])
  ],{scope:'global',now:NOW});
  assert.deepEqual({
    running:result.metrics.running,
    returned:result.metrics.returned,
    accepted:result.metrics.accepted,
    failed:result.metrics.failed,
    stopped:result.metrics.stopped,
    unknown:result.metrics.unknown
  },{running:1,returned:2,accepted:1,failed:1,stopped:1,unknown:1});
  assert.equal(result.metrics.failedAttempts,1);
  assert.equal(result.metrics.completedDurationMs,900000);
  assert.equal(result.metrics.firstReturn.numerator,2);
  assert.equal(result.metrics.firstReturn.denominator,4);
  assert.equal(result.metrics.firstReturn.rate,0.5);

  assert.equal(result.tasks.find(row=>row.id==='task-accepted').status,'accepted');
  const running=result.tasks.find(row=>row.id==='task-running');
  assert.equal(running.durationMs,0);
  assert.equal(running.runningDurationMs,3600000);
  assert.equal(result.tasks.find(row=>row.id==='task-unknown').runningDurationMs,0);
  assert.equal(result.tasks.find(row=>row.id==='task-failed').durationMs,300000);
  assert.equal(result.tasks.find(row=>row.id==='task-stopped').durationMs,120000);
});

test('first return counts terminal tasks completed in one attempt, not first acceptance',()=>{
  const result=aggregateAnalytics([
    snapshot('thread-return',[
      task('task-first-a',[attempt('attempt-a')],{status:'completed'}),
      task('task-first-b',[attempt('attempt-b')],{status:'completed'}),
      task('task-accepted-after-continuation',[
        attempt('attempt-c1'),
        attempt('attempt-c2',{index:2,resumedFrom:'attempt-c1',startedAt:'2026-01-09T01:00:00.000Z',endedAt:'2026-01-09T01:10:00.000Z'})
      ],{status:'waiting_review',acceptance:{fingerprint:'fp-c',at:'2026-01-09T01:11:00.000Z'}}),
      task('task-failed-then-completed',[
        attempt('attempt-d1',{status:'failed'}),
        attempt('attempt-d2',{index:2,resumedFrom:'attempt-d1',startedAt:'2026-01-09T01:00:00.000Z',endedAt:'2026-01-09T01:10:00.000Z'})
      ],{status:'waiting_review'}),
      task('task-failed',[attempt('attempt-e',{status:'failed'})],{status:'failed'})
    ])
  ],{scope:'global',now:NOW});
  assert.equal(result.metrics.accepted,1);
  assert.equal(result.metrics.returned,4);
  assert.deepEqual(result.metrics.firstReturn,{numerator:2,denominator:5,rate:0.4});
});

test('tool capabilities deduplicate public events and skill reads stop at file reads',()=>{
  const events=[
    {id:'use-bash',kind:'tool_use',toolName:'Bash',text:'cat .agents/skills/a1/SKILL.md',status:'RUNNING'},
    {id:'use-bash',kind:'tool_result',toolName:'Bash',text:'/Users/private/.agents/skills/a1/SKILL.md',status:'SUCCEEDED'},
    {id:'read-a1',kind:'tool_use',toolName:'read_file',text:'/Users/private/.agents/skills/a1/SKILL.md',status:'RUNNING'},
    {id:'read-simplify',kind:'tool',toolName:'Read',text:'.agents/skills/simplify/SKILL.md',status:'SUCCEEDED'},
    {id:'read-command',kind:'tool_use',toolName:'Read',text:'cat .agents/skills/a1/SKILL.md',status:'SUCCEEDED'},
    {id:'failed-bash',kind:'tool_use',toolName:'Bash',text:'node --test --test-name-pattern PRIVATE_TEST_PATTERN',status:'FAILED'},
    {id:'progress-1',kind:'progress',text:'/Users/private/.agents/skills/a1/SKILL.md'},
    {id:'message-1',kind:'message',role:'assistant',text:'/Users/private/.agents/skills/a1/SKILL.md'}
  ];
  const result=aggregateAnalytics([
    snapshot('thread-tools',[task('task-tools',[attempt('attempt-tools',{events,handoff:{goal:'SECRET HANDOFF'},result:'SECRET OUTPUT'})])]),
    snapshot('thread-tools-2',[task('task-tools-2',[attempt('attempt-tools-2',{events:[
      {id:'bash-2',kind:'tool_use',toolName:'Bash',text:'pwd',status:'SUCCEEDED'}
    ]})])])
  ],{scope:'global',now:NOW});
  const tools=Object.fromEntries(result.capabilities.tools.map(tool=>[tool.toolName,tool]));
  assert.equal(tools.Bash.calls,3);
  assert.equal(tools.Bash.succeeded,2);
  assert.equal(tools.Bash.failed,1);
  assert.equal(tools.Bash.unknown,0);
  assert.equal(tools.Bash.sessionCount,2);
  assert.equal(tools.read_file.calls,1);
  assert.equal(tools.read_file.unknown,1);
  assert.equal(tools.Read.calls,2);
  assert.equal(tools.Read.succeeded,2);
  assert.equal(result.tasks[0].toolCalls,5);
  assert.equal(result.tasks[0].toolFailures,1);
  assert.deepEqual(result.capabilities.skillReads,[{name:'a1',reads:1},{name:'simplify',reads:1}]);
  assert.equal(result.capabilities.activation,null);
  assert.match(result.capabilities.activationNote,/未接入/);
  assert.match(result.capabilities.activationNote,/不等同于激活/);

  assert.equal(result.tasks[0].goal,'SECRET HANDOFF');
  assert.deepEqual(result.tasks[0].tools,[{name:'Bash',calls:2,succeeded:1,failed:1,unknown:0},{name:'Read',calls:2,succeeded:2,failed:0,unknown:0},{name:'read_file',calls:1,succeeded:0,failed:0,unknown:1}]);
  assert.deepEqual(result.tasks[0].skills,[{name:'a1',reads:1},{name:'simplify',reads:1}]);
  assert.equal(result.sessions[0].summary,'任务 task-tools：SECRET HANDOFF');
  assert.deepEqual(result.sessions[0].representativeTasks,[{id:'task-tools',title:'任务 task-tools',goal:'SECRET HANDOFF'}]);
  const serialized=JSON.stringify(result);
  for(const secret of ['/Users/private','.agents/skills','cat ','SECRET OUTPUT','PRIVATE_TEST_PATTERN','secret-worktree']){
    assert.equal(serialized.includes(secret),false,`不应输出 ${secret}`);
  }
  assert.equal(result.capabilities.cli.rows.some(row=>row.command==='node --test'),true);
  assert.equal(serialized.includes('"events"'),false);
  assert.equal(serialized.includes('"handoff"'),false);
  assert.deepEqual(Object.keys(result.tasks[0]).sort(),[
    'accepted','attemptCount','category','cli','continuationCount','durationMs','failedAttempts','fullAttemptCount','goal','id','runningDurationMs','skills','status','terminal','threadId','title','tokens','toolCalls','toolFailures','tools'
  ]);
  assert.deepEqual(Object.keys(result.sessions[0]).sort(),[
    'accepted','attemptCount','continuationCount','failed','representativeTasks','returned','running','stopped','summary','taskCount','threadId','title','tokens','unknown'
  ]);
});

test('cli metrics attribute real commands per attempt without leaking arguments or result text',()=>{
  const eventsA=[
    {id:'call-shared',kind:'tool_use',toolName:'Bash',text:'lgb capability invoke --token sk-secret',status:'RUNNING'},
    {id:'call-shared',kind:'tool_result',toolName:'Bash',text:'Process exited with code 0\n/Users/private/output',status:'SUCCEEDED'},
    {id:'call-shared',kind:'tool_result',toolName:'Bash',text:'duplicate result event',status:'SUCCEEDED'}
  ];
  const eventsB=[
    {id:'call-shared',kind:'tool_use',toolName:'Bash',text:'sf workflow create --name demo',status:'RUNNING'},
    {id:'call-shared',kind:'tool_result',toolName:'Bash',text:'exit code: 1\nInvalid option: --name',status:'FAILED'}
  ];
  const result=aggregateAnalytics([
    snapshot('thread-cli',[
      task('task-cli',[
        attempt('attempt-cli-1',{events:eventsA}),
        attempt('attempt-cli-2',{index:2,resumedFrom:'attempt-cli-1',startedAt:'2026-01-09T01:00:00.000Z',endedAt:'2026-01-09T01:10:00.000Z',events:eventsB})
      ])
    ])
  ],{scope:'global',now:NOW});
  const cli=result.capabilities.cli;
  assert.equal(cli.unclassifiedCalls,0);
  assert.match(cli.note,/不参与成功率/);
  assert.match(cli.note,/未确认的调用不进入成功率分母/);
  assert.match(cli.note,/Qoder/);
  assert.match(cli.note,/主 Codex 会话未采集/);
  const byName=Object.fromEntries(cli.rows.map(row=>[row.name,row]));
  assert.deepEqual(Object.keys(byName).sort(),['lgb','sf']);
  assert.equal(byName.lgb.command,'lgb capability invoke');
  assert.equal(byName.lgb.calls,1);
  assert.deepEqual(byName.lgb.execution,{succeeded:1,failed:0,unknown:0});
  assert.deepEqual(byName.lgb.business,{succeeded:0,failed:0,unknown:1});
  assert.deepEqual(byName.lgb.failures,[]);
  assert.deepEqual(byName.lgb.sessions,[{threadId:'thread-cli',title:'会话 thread-cli',taskId:'task-cli',taskTitle:'任务 task-cli'}]);
  assert.equal(byName.sf.command,'sf workflow create');
  assert.equal(byName.sf.calls,1);
  assert.deepEqual(byName.sf.execution,{succeeded:0,failed:1,unknown:0});
  assert.deepEqual(byName.sf.failures,[{category:'argument',count:1}]);

  assert.equal(result.tasks[0].cli.calls,2);
  assert.equal(result.tasks[0].cli.unclassifiedCalls,0);
  assert.deepEqual(result.tasks[0].cli.rows.map(row=>row.name).sort(),['lgb','sf']);

  const serialized=JSON.stringify(result);
  for(const secret of ['sk-secret','--token','--name','/Users/private','Invalid option','duplicate result event','resultText','callText']){
    assert.equal(serialized.includes(secret),false,`不应输出 ${secret}`);
  }
});

test('generic and unparsable command tools count as unclassified instead of entering the cli ranking',()=>{
  const result=aggregateAnalytics([
    snapshot('thread-generic',[task('task-generic',[attempt('attempt-generic',{events:[
      {id:'cat',kind:'tool_use',toolName:'Bash',text:'cat /Users/private/file',status:'SUCCEEDED'},
      {id:'unknown-exec',kind:'tool_use',toolName:'execute',text:'',status:'FAILED'},
      {id:'mcp',kind:'tool_use',toolName:'mcp__a1__query',text:'{"query":"secret"}',status:'SUCCEEDED'}
    ]})])])
  ],{scope:'global',now:NOW});
  assert.equal(result.capabilities.cli.unclassifiedCalls,2);
  assert.deepEqual(result.capabilities.cli.rows.map(row=>row.name),['mcp__a1__query']);
  assert.equal(JSON.stringify(result).includes('/Users/private'),false);
  assert.equal(JSON.stringify(result).includes('secret'),false);
});

test('model groups prefer actualModel, mark configured fallback and keep unknown unattributed',()=>{
  const result=aggregateAnalytics([
    snapshot('thread-models',[task('task-models',[
      attempt('attempt-actual',{actualModel:'actual-model',model:'configured-a',usage:usage(10,0,4,10)}),
      attempt('attempt-configured',{index:2,resumedFrom:'attempt-actual',model:'configured-b',actualModel:null,startedAt:'2026-01-09T01:00:00.000Z',endedAt:'2026-01-09T01:10:00.000Z',usage:usage(0,0,0,20)}),
      attempt('attempt-unknown',{index:3,resumedFrom:'attempt-configured',model:null,actualModel:null,startedAt:'2026-01-09T02:00:00.000Z',endedAt:'2026-01-09T02:10:00.000Z',usage:null})
    ])])
  ],{scope:'global',now:NOW});
  const models=Object.fromEntries(result.tokens.models.map(group=>[String(group.model),group]));
  assert.equal(models['actual-model'].source,'actual');
  assert.equal(models['actual-model'].tokens.inputTokens,10);
  assert.equal(models['actual-model'].tokens.cachedInputTokens,4);
  assert.equal(models['actual-model'].tokens.totalTokens,10);
  assert.equal(models['configured-b'].source,'configured');
  assert.equal(models['configured-b'].tokens.totalTokens,20);
  assert.equal(models.null.source,'unknown');
  assert.equal(models.null.reportedAttempts,0);
});

test('trend groups by UTC day and leaves missing token values null',()=>{
  const result=aggregateAnalytics([
    snapshot('thread-trend',[task('task-trend',[
      attempt('day-1',{startedAt:'2026-01-01T23:30:00.000Z',endedAt:'2026-01-02T00:00:00.000Z',usage:usage(10,0,0,10)}),
      attempt('day-2',{index:2,resumedFrom:'day-1',startedAt:'2026-01-02T01:00:00.000Z',endedAt:'2026-01-02T01:10:00.000Z',usage:usage(0,0,0,0)}),
      attempt('day-3',{index:3,resumedFrom:'day-2',startedAt:'2026-01-03T00:30:00.000Z',endedAt:'2026-01-03T00:40:00.000Z',usage:null}),
      attempt('undated',{index:4,resumedFrom:'day-3',startedAt:undefined,endedAt:undefined,usage:usage(0,0,0,5)})
    ])])
  ],{scope:'global',now:NOW});
  assert.deepEqual(result.trend.map(point=>point.date),['2026-01-01','2026-01-02','2026-01-03']);
  assert.equal(result.trend[0].attempts,1);
  assert.equal(result.trend[0].tokens.totalTokens,10);
  assert.equal(result.trend[1].tokens.totalTokens,0);
  assert.equal(result.trend[2].tokens.totalTokens,null);
  assert.equal(result.trend[2].reportedAttempts,0);
  assert.equal(result.tokens.totalTokens,15);
  assert.equal(result.tokens.coverage.totalTokens.reported,3);
  assert.equal(result.tokens.coverage.totalTokens.total,4);
});

test('insights stay numeric and bounded without causal or savings claims',()=>{
  const result=aggregateAnalytics([
    snapshot('thread-insights',[task('task-hot',[
      attempt('hot-1',{usage:usage(0,0,0,90)}),
      attempt('hot-2',{index:2,resumedFrom:'hot-1',status:'failed',startedAt:'2026-01-09T01:00:00.000Z',endedAt:'2026-01-09T01:05:00.000Z',usage:null})
    ],{status:'waiting_review'})])
  ],{scope:'global',now:NOW});
  const byKind=Object.fromEntries(result.insights.map(insight=>[insight.kind,insight]));
  assert.equal(byKind.top_task_share.taskId,'task-hot');
  assert.equal(byKind.top_task_share.evidence.share,1);
  assert.equal(byKind.failed_attempts.evidence.failedAttempts,1);
  assert.equal(byKind.continuation_boundary.evidence.continuationCount,1);
  assert.equal(byKind.usage_coverage.evidence.mainSession,'unavailable');
  const continuation=byKind.continuation_boundary.message;
  assert.match(continuation,/不代表质量或因果结论/);
  assert.equal(continuation.includes('节省'),false);
  assert.equal(continuation.includes('必然'),false);
  assert.ok(result.insights.length<=4);
});

test('invalid scope, days and session identity fail fast',()=>{
  assert.throws(()=>aggregateAnalytics([],{scope:'team'}),/scope/);
  assert.throws(()=>aggregateAnalytics([],{scope:'global',days:14}),/days/);
  assert.throws(()=>aggregateAnalytics([],{scope:'session'}),/currentThreadId/);
});


test('blocked tasks require attention and are not counted as pending',()=>{
  const result=aggregateAnalytics([snapshot('status',[task('blocked',[],{status:'blocked'}),task('queued',[],{status:'queued'})])],{scope:'global',now:NOW});
  assert.equal(result.metrics.blocked,1);
  assert.equal(result.metrics.pending,1);
});

test('cliAttemptInputs exposes workspace, continuation identity, window and public records',()=>{
  const view=snapshot('thread-input',[
    task('task-input',[
      attempt('attempt-old',{
        sessionId:null,startedAt:'2026-01-01T00:00:00.000Z',endedAt:'2026-01-01T00:10:00.000Z',
        events:[{id:'call-old',kind:'tool_use',toolName:'Bash',text:'lgb capability invoke',status:'RUNNING'}],
      }),
      attempt('attempt-new',{
        index:2,resumedFrom:'attempt-old',sessionId:'native-1',
        startedAt:'2026-01-09T00:00:00.000Z',endedAt:'2026-01-09T00:10:00.000Z',
        events:[{id:'call-new',kind:'tool_use',toolName:'Bash',text:'sf workflow create',status:'RUNNING'}],
      }),
    ])
  ],{members:[{id:'member-1',executor:'qoder'}]});
  const inputs=cliAttemptInputs([view],{now:NOW,days:7});
  assert.equal(inputs.nowMs,NOW.getTime());
  assert.equal(inputs.fromMs,NOW.getTime()-7*86400000);
  assert.equal(inputs.tasks.length,1);
  const [taskInput]=inputs.tasks;
  assert.equal(taskInput.id,'task-input');
  assert.equal(taskInput.threadId,'thread-input');
  assert.equal(taskInput.threadTitle,'会话 thread-input');
  assert.equal(taskInput.workspace,WORKSPACE);

  const [oldAttempt,newAttempt]=taskInput.attempts;
  assert.equal(oldAttempt.attemptId,'attempt-old');
  assert.equal(oldAttempt.sessionId,null);
  assert.equal(oldAttempt.included,false,'窗口外尝试不进入公开记录统计');
  assert.equal(oldAttempt.records[0].callText,'lgb capability invoke');
  assert.equal(newAttempt.sessionId,'native-1');
  assert.equal(newAttempt.resumedFrom,'attempt-old');
  assert.equal(newAttempt.executor,'qoder','成员执行器随尝试进入原生归属输入');
  assert.equal(newAttempt.included,true);
  assert.equal(newAttempt.records[0].id,'call-new');

  const all=cliAttemptInputs([view],{now:NOW,days:null});
  assert.equal(all.fromMs,null);
  assert.equal(all.tasks[0].attempts.every(item=>item.included),true);
});

test('executorUsage.qoder isolates explicit qoder attempts per native thread without touching Codex totals',()=>{
  const view=snapshot('thread-q',[
    task('task-q',[attempt('attempt-q',{usage:usage(10,2,3,12),actualModel:'q-actual'})],{memberId:'q'}),
    task('task-c',[attempt('attempt-c',{usage:usage(20,5,0,25)})],{memberId:'c'}),
    task('task-u',[attempt('attempt-u',{usage:usage(30,6,0,36)})])
  ],{members:[{id:'q',executor:'qoder'},{id:'c',executor:'codex'}]});
  const result=aggregateAnalytics([view,view],{scope:'global',now:NOW});
  const qoder=result.executorUsage.qoder;

  assert.equal(qoder.schemaVersion,1);
  assert.equal(qoder.executor,'qoder');
  assert.equal(qoder.available,true);
  assert.equal(qoder.available!==undefined,true);
  assert.deepEqual(qoder.totals,{inputTokens:10,cachedInputTokens:3,outputTokens:2,totalTokens:12});
  assert.equal(qoder.coverage.totalAttempts,1,'Codex 执行器与重复快照都不进入 Qoder 总量');
  assert.equal(qoder.coverage.reportedAttempts,1);
  assert.deepEqual(qoder.coverage.cachedInputTokens,{reported:1,total:1});
  assert.equal(qoder.sessions.length,1);
  assert.equal(qoder.sessions[0].threadId,view.binding.threadId,'使用原生宿主 threadId 供 Codex usage.sessions 对齐');
  assert.equal(qoder.sessions[0].title,view.binding.title);
  assert.deepEqual(qoder.sessions[0].tokens,qoder.totals);
  assert.deepEqual(qoder.sessions[0].models.map(group=>[group.model,group.source]),[['q-actual','actual']]);
  assert.match(qoder.note,/不换算费用/);
  assert.match(qoder.note,/等价比较/);

  assert.equal(result.tokens.totalTokens,73,'原有 Codex 与其他执行器汇总保持不变');
  assert.equal(result.tokens.executors.find(row=>row.executor==='qoder').totalTokens,12);
  assert.equal(result.metrics.attemptCount,3);
});

test('executorUsage uses the frozen cutoff for 7/30/all, excludes future attempts and keeps model provenance',()=>{
  const view=snapshot('thread-window-q',[
    task('task-window-q',[
      attempt('attempt-recent-q',{usage:usage(0,0,0,5),actualModel:'actual-q'}),
      attempt('attempt-old-q',{index:2,startedAt:'2025-12-20T00:00:00.000Z',endedAt:'2025-12-20T00:10:00.000Z',usage:usage(0,0,0,7)}),
      attempt('attempt-future-q',{index:3,startedAt:'2026-01-11T00:00:00.000Z',endedAt:'2026-01-11T00:10:00.000Z',usage:usage(0,0,0,9),actualModel:null,model:null})
    ])
  ],{members:[{id:'member-1',executor:'qoder'}]});
  const codexOnly=snapshot('thread-window-c',[
    task('task-window-c',[attempt('attempt-codex-only',{usage:usage(0,0,0,40)})],{memberId:'c'})
  ],{members:[{id:'c',executor:'codex'}]});
  const data=[view,view,codexOnly];

  const week=aggregateAnalytics(data,{scope:'global',now:NOW,days:7}).executorUsage.qoder;
  assert.equal(week.totals.totalTokens,5);
  assert.equal(week.coverage.totalAttempts,1);
  assert.equal(week.coverage.beforeWindowAttempts,1);
  assert.equal(week.coverage.futureAttempts,1);
  assert.deepEqual(week.sessions.map(session=>session.threadId),['thread-window-q']);

  const month=aggregateAnalytics(data,{scope:'global',now:NOW,days:30}).executorUsage.qoder;
  assert.equal(month.totals.totalTokens,12);
  assert.equal(month.coverage.beforeWindowAttempts,0);

  const all=aggregateAnalytics(data,{scope:'global',now:NOW,days:null}).executorUsage.qoder;
  assert.equal(all.totals.totalTokens,12,'all 仍排除未来尝试');
  assert.equal(all.coverage.totalAttempts,2);
  assert.equal(all.coverage.futureAttempts,1);
  assert.deepEqual(all.sessions.map(session=>session.threadId),['thread-window-q']);
  const byModel=Object.fromEntries(all.models.map(group=>[String(group.model),group]));
  assert.equal(byModel['actual-q'].source,'actual');
  assert.equal(byModel['configured-model'].source,'configured');

  const withoutQoder=aggregateAnalytics([codexOnly],{scope:'global',now:NOW,days:null}).executorUsage.qoder;
  assert.equal(withoutQoder.available,false);
  assert.deepEqual(withoutQoder.totals,{inputTokens:null,cachedInputTokens:null,outputTokens:null,totalTokens:null});
  assert.deepEqual(withoutQoder.sessions,[]);
  assert.deepEqual(withoutQoder.models,[]);
});

test('executorUsage session totals stay conserved and partial fields never become zero',()=>{
  const view=snapshot('thread-conserve',[
    task('task-one',[
      attempt('attempt-one',{usage:usage(10,null,null,12)}),
      attempt('attempt-two',{index:2,usage:usage(null,5,3,null)}),
      attempt('attempt-three',{index:3,usage:usage(null,null,null,null)})
    ]),
    task('task-two',[attempt('attempt-four',{usage:usage(0,0,0,0)})])
  ],{members:[{id:'member-1',executor:'qoder'}]});
  const qoder=aggregateAnalytics([view],{scope:'global',now:NOW,days:null}).executorUsage.qoder;

  assert.deepEqual(qoder.totals,{inputTokens:10,cachedInputTokens:3,outputTokens:5,totalTokens:12});
  assert.equal(qoder.coverage.totalAttempts,4);
  assert.equal(qoder.coverage.reportedAttempts,3);
  assert.deepEqual(qoder.coverage.inputTokens,{reported:2,total:4});
  assert.deepEqual(qoder.coverage.cachedInputTokens,{reported:2,total:4});
  assert.deepEqual(qoder.coverage.outputTokens,{reported:2,total:4});
  assert.deepEqual(qoder.coverage.totalTokens,{reported:2,total:4});
  for(const key of ['inputTokens','cachedInputTokens','outputTokens','totalTokens']){
    const sum=qoder.sessions.map(session=>session.tokens[key]??0).reduce((total,value)=>total+value,0);
    assert.equal(sum,qoder.totals[key]??0,`${key} 会话合计应守恒`);
  }
});

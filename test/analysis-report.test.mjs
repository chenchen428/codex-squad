import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {aggregateAnalytics} from '../cli/lib/analytics.mjs';
import {
  ANALYSIS_OUTPUT_SCHEMA,MAX_PROMPT_BYTES,analysisBlock,buildEvidence,buildPrompt,buildReport,digestJson,
  emptyAnalytics,reportView,statsView,validateAnalysisOutput,validateReport,
} from '../cli/lib/analysis-report.mjs';

const THREAD='22222222-2222-4222-8222-222222222222';
const NOW=new Date('2026-10-26T12:00:00.000Z');

function attempt(id,overrides={}){
  return {
    id,index:1,status:'completed',startedAt:'2026-10-25T01:00:00.000Z',endedAt:'2026-10-25T01:10:00.000Z',
    sessionId:'qoder-attempt-session',model:'configured-model',actualModel:null,
    usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,totalTokens:12},
    handoff:{goal:'解决登录失败并补齐验证'},events:[],result:null,error:null,...overrides,
  };
}
function task(id,overrides={}){
  return {id,title:`任务 ${id}`,memberId:'member-1',status:'completed',attempts:[attempt(`${id}-attempt`)],acceptance:null,...overrides};
}
function statsFixture(){
  return aggregateAnalytics([{
    schemaVersion:1,connected:true,observedAt:'2026-10-25T12:00:00.000Z',
    binding:{threadId:THREAD,workspace:'/Users/private/secret-worktree',projectId:'p',parentWorkId:'w',title:'登录修复小队'},
    members:[],cursor:'cursor-1',
    tasks:[
      task('task-a',{title:'修复登录',status:'waiting_review',attempts:[attempt('a1',{
        events:[
          {id:'bash-1',kind:'tool_use',toolName:'Bash',text:'node --test',status:'SUCCEEDED'},
          {id:'skill-1',kind:'tool',toolName:'Read',text:'.agents/skills/a1/SKILL.md',status:'SUCCEEDED'},
        ],
      })]}),
      task('task-b',{title:'补齐验证',status:'failed',attempts:[attempt('b1',{status:'failed',endedAt:'2026-10-25T01:20:00.000Z'})]}),
    ],
  }],{scope:'global',now:NOW});
}
function evidenceFixture(){
  return buildEvidence(statsFixture(),{window:{key:'7',days:7,from:'2026-10-19T12:00:00.000Z',to:'2026-10-26T12:00:00.000Z'}});
}
function outputFixture(evidence,overrides={}){
  const task=evidence.tasks.find(item=>item.taskId==='task-a')||evidence.tasks[0];
  const tool=task.tools[0];
  const refs=[`thread:${task.threadId}`,task.ref,tool.ref,`metric:${task.threadId}:${task.taskId}:totalTokens`];
  return {
    schemaVersion:1,summary:'近 7 天主要投入在登录修复与小队的验证补齐。',
    categories:{
      skills_tools:[{title:'复用技能读取',observation:'任务读取了技能定义文件。',action:'只在任务匹配时读取技能。',verification:tool.ref,evidenceRefs:[tool.ref]}],
      time:[],
      tokens:[{title:'关注高 token 任务',observation:'该任务 token 上报完整。',action:'按任务拆分后续尝试。',verification:`metric:${task.threadId}:${task.taskId}:totalTokens`,evidenceRefs:[`metric:${task.threadId}:${task.taskId}:totalTokens`]}],
    },
    sessionDescriptions:[{threadId:task.threadId,title:'登录修复',description:'围绕登录失败完成修复并补齐验证。',representativeTaskIds:[task.taskId]}],
    ...overrides,
  };
}
function contextFor(evidence){
  return {threads:evidence.sessions,tasks:evidence.tasks,refs:evidence.refs};
}

test('strict model schema rejects stats fields, unknown refs and unbounded suggestions',()=>{
  const evidence=evidenceFixture();
  const context=contextFor(evidence);
  const valid=validateAnalysisOutput(outputFixture(evidence),context);
  assert.equal(valid.schemaVersion,1);
  assert.equal(valid.categories.skills_tools.length,1);
  assert.deepEqual(valid.categories.time,[]);
  assert.deepEqual(valid.sessionDescriptions[0].representativeTaskIds,['task-a']);

  assert.throws(()=>validateAnalysisOutput({...outputFixture(evidence),stats:{metrics:{taskCount:99}}},context),error=>error.code==='SQUAD_ANALYSIS_SCHEMA_INVALID');
  assert.throws(()=>validateAnalysisOutput({...outputFixture(evidence),summary:'x',metrics:{}},context),error=>error.code==='SQUAD_ANALYSIS_SCHEMA_INVALID');
  const unknownRef=outputFixture(evidence);
  unknownRef.categories.skills_tools[0].evidenceRefs=['task:unknown-thread:missing'];
  assert.throws(()=>validateAnalysisOutput(unknownRef,context),error=>error.code==='SQUAD_ANALYSIS_REF_INVALID');
  const missingRef=outputFixture(evidence);
  missingRef.categories.time=[{title:'x',observation:'x',action:'x',verification:'x',evidenceRefs:[]}];
  assert.throws(()=>validateAnalysisOutput(missingRef,context),error=>error.code==='SQUAD_ANALYSIS_SCHEMA_INVALID');
  const tooMany=outputFixture(evidence);
  tooMany.categories.tokens=Array.from({length:4},()=>outputFixture(evidence).categories.tokens[0]);
  assert.throws(()=>validateAnalysisOutput(tooMany,context),error=>error.code==='SQUAD_ANALYSIS_SCHEMA_INVALID');
  const unknownThread=outputFixture(evidence);
  unknownThread.sessionDescriptions[0].threadId='thread-not-frozen';
  assert.throws(()=>validateAnalysisOutput(unknownThread,context),error=>error.code==='SQUAD_ANALYSIS_REF_INVALID');
  const wrongTask=outputFixture(evidence);
  wrongTask.sessionDescriptions[0].representativeTaskIds=['task-not-in-thread'];
  assert.throws(()=>validateAnalysisOutput(wrongTask,context),error=>error.code==='SQUAD_ANALYSIS_REF_INVALID');
  const noTask=outputFixture(evidence);
  noTask.sessionDescriptions[0].representativeTaskIds=[];
  assert.throws(()=>validateAnalysisOutput(noTask,context),error=>error.code==='SQUAD_ANALYSIS_SCHEMA_INVALID');
  assert.equal(ANALYSIS_OUTPUT_SCHEMA.properties.sessionDescriptions.items.properties.representativeTaskIds.minItems,1);
  assert.equal(ANALYSIS_OUTPUT_SCHEMA.additionalProperties,false);
  assert.equal(ANALYSIS_OUTPUT_SCHEMA.properties.categories.additionalProperties,false);
});

test('evidence freezes deterministic stats, caps prompt size and exposes real refs',()=>{
  const evidence=evidenceFixture();
  assert.equal(evidence.omitted.promptTrimmed,false);
  assert.equal(evidence.tasks.some(item=>item.taskId==='task-a'),true);
  assert.equal(evidence.sessions[0].threadId,THREAD);
  assert.equal(evidence.sessions[0].codexUrl,`codex://threads/${THREAD}`);
  assert.equal(evidence.sessions[0].representativeTasks.length>=1,true);
  assert.equal(evidence.refs.includes(`task:${THREAD}:task-a`),true);
  assert.equal(evidence.refs.includes(`tool:${THREAD}:task-a:Bash`),true);
  assert.equal(evidence.refs.includes(`skill:${THREAD}:task-a:a1`),true);
  assert.equal(evidence.refs.includes(`metric:${THREAD}:task-a:totalTokens`),true);
  assert.equal(evidence.tasks.find(item=>item.taskId==='task-a').goal,'解决登录失败并补齐验证');
  assert.equal(JSON.stringify(evidence).includes('/Users/private'),false);
  assert.equal(JSON.stringify(evidence).includes('qoder-attempt-session'),false);
  assert.equal(evidence.codex.available,false);
  assert.equal(evidence.refs.includes('codex:total'),false);
  assert.equal(evidence.cli.rows.some(row=>row.ref.startsWith('cli:')),true);
  assert.equal(evidence.refs.some(ref=>ref.startsWith('cli:')),true);
  const taskA=evidence.tasks.find(item=>item.taskId==='task-a');
  assert.equal(taskA.cli.rows.length>0,true);
  assert.equal(evidence.refs.includes(`cli-task:${THREAD}:task-a:node --test`),true);

  const prompt=buildPrompt(evidence);
  assert.match(prompt,/不得改写/);
  assert.match(prompt,/JSON Schema/);
  assert.equal(prompt.includes('"refs"'),true);
  assert.equal(prompt.includes('并为真实会话生成具体业务描述'),false);
  assert.match(prompt,/sessionDescriptions 可为空数组/);
  assert.match(prompt,/不同执行器/);
  assert.match(prompt,/evidence\.cli/);
  assert.equal(Buffer.byteLength(prompt,'utf8')<=MAX_PROMPT_BYTES,true);
});

test('evidence keeps missing acceptance separate from task status',()=>{
  const evidence=evidenceFixture();
  const waiting=evidence.tasks.find(item=>item.taskId==='task-a');
  const failed=evidence.tasks.find(item=>item.taskId==='task-b');
  assert.equal(waiting.status,'waiting_review');
  assert.equal(waiting.acceptance,false,'缺少有效验收记录不改变任务状态');
  assert.equal(failed.status,'failed');
  assert.equal(failed.acceptance,false);
});

function codexUsageFixture(observedAt){
  const session={
    threadId:THREAD,title:'登录修复小队',kind:'squad',squadThreadId:THREAD,
    models:[{model:'gpt-test',inputTokens:10050,cachedInputTokens:20,outputTokens:200,totalTokens:10250}],
    inputTokens:10050,cachedInputTokens:20,outputTokens:200,totalTokens:10250,turnCount:1,
  };
  return {
    schemaVersion:1,available:true,observedAt,scope:'local',
    totals:{inputTokens:10050,cachedInputTokens:20,outputTokens:200,totalTokens:10250},
    sessions:[session],
    models:[{model:'gpt-test',inputTokens:10050,cachedInputTokens:20,outputTokens:200,totalTokens:10250}],
    coverage:{
      threads:1,readableThreads:1,missingThreads:0,usageThreads:1,
      unreportedThreads:0,unreportedWithTokens:0,undatedRecords:0,unattributedModelRecords:0,
    },
    note:'本机已记录用量；缓存包含在输入中，推理包含在输出中。Qoder 用量另列。未记录到用量的会话未计入数值，仅在覆盖信息中单列。',
  };
}

test('benefit candidates keep public goals searchable and separate local delivery from unified verification',()=>{
  const stats=statsFixture();
  stats.benefits={summary:{},coverage:{},observation:'',deliveries:[]};
  const delivery={
    ref:'benefit-delivery:w:host',deliveryId:'w:host',threadId:THREAD,title:'登录修复',
    startedAt:'2026-10-25T01:00:00.000Z',completedAt:'2026-10-25T02:00:00.000Z',
    taskCount:1,omittedTasks:0,
    tasks:[{title:'修复登录',goal:'修复登录',status:'completed',accepted:true,acceptanceNote:'通过验收',attempts:1,failedAttempts:0}],
    finalMessage:'本轮本机实现与证据已完成，真实共享 API 待统一验证。',
    publicGoals:[
      {text:'预检：确认目录与依赖。',turn:'t1',at:'2026-10-25T00:50:00.000Z'},
      {text:'正式需求：完成本机实现与聚焦测试。',turn:'t1',at:'2026-10-25T01:00:00.000Z'},
      {text:'追加需求：增加增量视图并保留筛选。',turn:'t2',at:'2026-10-25T01:40:00.000Z'},
    ],
    userMessages:['启动说明'],
    codex:{totalTokens:450,inputTokens:100,outputTokens:350,threads:1,models:[{model:'gpt-test',totalTokens:450}]},
    qoder:{used:false,totalTokens:0,attempts:0,models:[]},
    hardConditions:{model:'gpt-test',reasoning:'high',tools:'workspace-write',permissions:'on-request'},
  };
  const baseline={
    ref:'benefit-baseline:codex-session:base',baselineId:'codex-session:base',threadId:'base-thread',title:'历史登录重构',
    startedAt:'2026-10-20T01:00:00.000Z',completedAt:'2026-10-20T02:00:00.000Z',
    totalTokens:1000,inputTokens:100,outputTokens:900,models:[{model:'gpt-test',totalTokens:1000}],
    subagentThreads:0,turnCount:1,
    finalMessage:'历史交付已完成。',
    publicGoals:[{text:'历史正式需求：重构登录模块。',turn:'b1',at:'2026-10-20T01:00:00.000Z'}],
    userMessages:[],
    hardConditions:delivery.hardConditions,
  };
  const benefitCandidates={deliveries:[delivery],baselines:[baseline]};
  const evidence=buildEvidence(stats,{window:stats.range,benefitCandidates});
  assert.deepEqual(evidence.benefits.candidates.deliveries[0].publicGoals.map(goal=>goal.text),delivery.publicGoals.map(goal=>goal.text));
  assert.equal(evidence.refs.includes(delivery.ref),true);
  assert.equal(evidence.refs.includes(baseline.ref),true);

  const prompt=buildPrompt(evidence);
  assert.match(prompt,/publicGoals/);
  assert.match(prompt,/不得只看 final 末尾/);
  assert.match(prompt,/仍不可匹配/);

  const output={
    ...outputFixture(evidence),
    benefitMatches:[{
      deliveryId:delivery.deliveryId,baselineId:baseline.baselineId,
      basis:[
        {aspect:'workType',deliveryText:'完成本机实现',baselineText:'重构登录模块',deliveryRef:delivery.ref,baselineRef:baseline.ref},
        {aspect:'scale',deliveryText:'追加需求',baselineText:'历史正式需求',deliveryRef:delivery.ref,baselineRef:baseline.ref},
        {aspect:'acceptance',deliveryText:'真实共享 API 待统一验证',baselineText:'历史交付已完成',deliveryRef:delivery.ref,baselineRef:baseline.ref},
      ],
    }],
  };
  const validated=validateAnalysisOutput(output,{...contextFor(evidence),benefitCandidates});
  assert.equal(validated.benefitMatches.length,1);
  assert.equal(validated.benefitMatches[0].basis[0].deliveryText,'完成本机实现');
});

test('evidence carries independent Codex usage and CLI metrics with verifiable refs',()=>{
  const stats=statsFixture();
  stats.codexUsage=codexUsageFixture(stats.observedAt);
  const evidence=buildEvidence(stats,{window:stats.range});
  assert.equal(evidence.codex.available,true);
  assert.deepEqual(evidence.codex.totals,stats.codexUsage.totals);
  assert.deepEqual(evidence.tokens.totalTokens,stats.tokens.totalTokens);
  assert.equal(evidence.codex.coverage.usageThreads,1);
  assert.equal(evidence.codex.note.includes('Qoder 用量另列'),true);
  assert.equal(evidence.refs.includes('codex:total'),true);
  assert.equal(evidence.refs.includes(`codex:thread:${THREAD}`),true);
  assert.equal(evidence.refs.includes('codex:model:gpt-test'),true);
  assert.equal(evidence.omitted.codexSessions,0);
  assert.equal(evidence.omitted.cli,0);
  assert.equal(evidence.refs.includes('cli:node --test'),true);

  const output=outputFixture(evidence);
  output.categories.tokens[0]={
    ...output.categories.tokens[0],verification:'codex:total',
    evidenceRefs:['codex:total','codex:model:gpt-test'],
  };
  output.categories.time=[{
    title:'合并重复调用',observation:'CLI 记录显示重复调用。',action:'合并相同命令。',
    verification:'cli:node --test',evidenceRefs:['cli:node --test',`cli-task:${THREAD}:task-a:node --test`],
  }];
  const validated=validateAnalysisOutput(output,contextFor(evidence));
  assert.deepEqual(validated.categories.time[0].evidenceRefs,['cli:node --test',`cli-task:${THREAD}:task-a:node --test`]);
  assert.deepEqual(validated.categories.tokens[0].evidenceRefs,['codex:total','codex:model:gpt-test']);
  assert.equal(Buffer.byteLength(buildPrompt(evidence),'utf8')<=MAX_PROMPT_BYTES,true);
});

test('empty session descriptions are valid and the wire schema satisfies strict object requirements',()=>{
  const evidence=evidenceFixture();
  const minimal={
    schemaVersion:1,summary:'只保留可验证建议。',
    categories:{skills_tools:[],time:[],tokens:[]},
  };
  const validated=validateAnalysisOutput(minimal,contextFor(evidence));
  assert.deepEqual(validated.sessionDescriptions,[]);
  const strictObjects=value=>{
    if(!value||typeof value!=='object')return;
    if(value.type==='object')assert.deepEqual([...value.required].sort(),Object.keys(value.properties).sort());
    for(const child of Object.values(value))if(typeof child==='object')strictObjects(child);
  };
  strictObjects(ANALYSIS_OUTPUT_SCHEMA);

  const stats=evidenceFixtureStats();
  const report=buildReport({
    run:{
      runId:'66666666-6666-4666-8666-666666666666',trigger:'manual',
      sourceFingerprint:'f'.repeat(64),realCodexThreadId:'thread-real-3',window:stats.range,
    },
    stats,analysis:validated,evidenceDigest:'e'.repeat(64),
  });
  assert.equal(validateReport(report).analysis.sessionDescriptions.length,0);
  assert.deepEqual(analysisBlock(report).sessionDescriptions,[]);
});

test('evidence stays bounded by trimming details and drops stale refs',()=>{
  const stats=statsFixture();
  const base=stats.tasks.find(task=>task.id==='task-a');
  stats.tasks=Array.from({length:40},(_,index)=>{
    const task=structuredClone(base);
    task.id=`task-${index}`;
    task.title=`任务 ${index} ${'t'.repeat(100)}`;
    task.goal=`目标 ${'g'.repeat(600)}`;
    task.tools=Array.from({length:12},(_,tool)=>({name:`tool-${index}-${tool}-${'n'.repeat(60)}`,calls:1,failed:0}));
    task.skills=Array.from({length:10},(_,skill)=>({name:`skill-${index}-${skill}-${'s'.repeat(60)}`,reads:1}));
    task.cli={
      calls:6,unclassifiedCalls:0,
      rows:Array.from({length:6},(_,row)=>({
        name:'node',command:`node --test-${index}-${row} ${'c'.repeat(100)}`,calls:1,
        execution:{succeeded:1,failed:0,unknown:0},business:{succeeded:0,failed:0,unknown:1},failures:[],
      })),
    };
    return task;
  });
  const evidence=buildEvidence(stats);
  assert.equal(evidence.omitted.promptTrimmed,true);
  assert.equal(evidence.tasks.length<40,true);
  assert.equal(Buffer.byteLength(JSON.stringify(evidence),'utf8')<=MAX_PROMPT_BYTES,true);
  assert.equal(Buffer.byteLength(buildPrompt(evidence),'utf8')<=MAX_PROMPT_BYTES,true,'The complete prompt, including instructions, must stay bounded.');
  const taskRefs=new Set(evidence.tasks.map(task=>task.ref));
  for(const ref of evidence.refs){
    if(/^(?:metric|tool|skill|cli-task):/.test(ref)){
      const parts=ref.split(':');
      assert.equal(taskRefs.has(`task:${parts[1]}:${parts[2]}`),true,`stale ref ${ref}`);
    }
  }
});

test('report publishes stats and analysis from one frozen digest',async()=>{
  const evidence=evidenceFixture();
  const stats=evidenceFixtureStats();
  const analysis=validateAnalysisOutput(outputFixture(evidence),contextFor(evidence));
  const run={
    runId:'33333333-3333-4333-8333-333333333333',trigger:'manual',sourceFingerprint:'a'.repeat(64),
    realCodexThreadId:'thread-real-1',window:evidence.window,
  };
  const report=buildReport({run,stats,analysis,evidenceDigest:'b'.repeat(64)});
  assert.equal(report.statsDigest,digestJson(stats));
  assert.equal(report.realCodexThreadId,'thread-real-1');
  assert.equal(report.codexUrl,'codex://threads/thread-real-1');
  assert.equal(validateReport(report).runId,run.runId);
  const block=analysisBlock(report);
  assert.equal(block.available,true);
  assert.equal(block.statsAvailable,true);
  assert.equal(block.statFingerprint,digestJson(stats));
  assert.equal(block.codexThreadId,'thread-real-1');
  assert.deepEqual(block.categories,analysis.categories);

  const tampered=structuredClone(report);
  tampered.stats.metrics.taskCount=99;
  assert.throws(()=>validateReport(tampered),error=>error.code==='SQUAD_ANALYSIS_REPORT_CORRUPT');
  await assert.rejects(reportView(tampered),error=>error.code==='SQUAD_ANALYSIS_REPORT_CORRUPT');
  const corrupt=structuredClone(report);
  corrupt.analysis={schemaVersion:1,summary:'无建议',categories:{},sessionDescriptions:[]};
  assert.throws(()=>validateReport(corrupt),error=>error.code==='SQUAD_ANALYSIS_REPORT_CORRUPT');
  await assert.rejects(reportView(corrupt),error=>error.code==='SQUAD_ANALYSIS_REPORT_CORRUPT');
  assert.equal(digestJson({b:2,a:1}),digestJson({a:1,b:2}));
});
function evidenceFixtureStats(){
  return statsFixture();
}

test('report view resolves only verified private scope links',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'squad-report-'));
  try{
    const stats=statsFixture();
    const evidence=buildEvidence(stats,{window:stats.range});
    const analysis=validateAnalysisOutput(outputFixture(evidence),contextFor(evidence));
    const report=buildReport({
      run:{runId:'44444444-4444-4444-8444-444444444444',trigger:'manual',sourceFingerprint:'c'.repeat(64),realCodexThreadId:'thread-real-2',window:stats.range},
      stats,analysis,evidenceDigest:'d'.repeat(64),
    });

    const anonymous=await reportView(report);
    assert.equal(anonymous.sessions[0].links,null);
    assert.equal(anonymous.analysis.sessionDescriptions[0].taskLinks,null);

    const token='a'.repeat(48);
    async function writeScope(home,scopeWorkspace,bindingWorkspace=scopeWorkspace){
      await mkdir(join(home,'bindings'),{recursive:true});
      await mkdir(join(home,'service','scopes'),{recursive:true});
      await writeFile(join(home,'bindings',`${THREAD}.json`),JSON.stringify({
        schemaVersion:1,threadId:THREAD,workspace:bindingWorkspace,projectId:'p',parentWorkId:'w',title:'登录修复小队',
        tasks:[],attempts:{},workers:{},reviews:{},retirements:{},createdAt:'',updatedAt:'',
      }));
      await writeFile(join(home,'service',`${THREAD}.json`),JSON.stringify({threadId:THREAD,workspace:scopeWorkspace,token,reviewDirectory:null}));
      await writeFile(join(home,'service','scopes',`${token}.json`),JSON.stringify({threadId:THREAD,workspace:scopeWorkspace,token}));
    }

    const validHome=join(directory,'valid'),invalidHome=join(directory,'invalid');
    await writeScope(validHome,validHome);
    await writeScope(invalidHome,validHome,invalidHome);

    const origin='http://127.0.0.1:57999';
    const view=await reportView(report,{home:validHome,origin});
    assert.equal(view.schemaVersion,1);
    assert.equal(view.scope,'global');
    assert.deepEqual(view.sessions[0].links.overview,`${origin}/${token}/`);
    const taskLink=view.sessions[0].links.tasks.find(item=>item.taskId==='task-a');
    assert.deepEqual(taskLink,{taskId:'task-a',url:`${origin}/${token}/#session/task-a`});
    assert.deepEqual(view.analysis.sessionDescriptions[0].taskLinks,[{taskId:'task-a',url:`${origin}/${token}/#session/task-a`}]);
    assert.equal(view.analysis.sessionDescriptions[0].codexUrl,`codex://threads/${THREAD}`);
    assert.equal(JSON.stringify(view).includes(validHome),false);
    assert.equal(JSON.stringify(view).includes('secret-worktree'),false);

    const detached=await reportView(report,{home:invalidHome,origin});
    assert.equal(detached.sessions[0].links,null);
  }finally{await rm(directory,{recursive:true,force:true})}
});

test('empty envelope is explicit and never fabricates a successful report',()=>{
  const empty=emptyAnalytics({days:7,now:NOW,latestRun:{runId:'r',status:'failed'}});
  assert.equal(empty.schemaVersion,1);
  assert.equal(empty.scope,'global');
  assert.equal(empty.metrics.taskCount,0);
  assert.equal(empty.tokens.totalTokens,null);
  assert.equal(empty.analysis.available,false);
  assert.equal(empty.analysis.statsAvailable,false);
  assert.equal(empty.analysis.reason,'NO_SUCCESSFUL_REPORT');
  assert.equal(empty.analysis.window.days,7);
  assert.equal(empty.analysis.latestRun.runId,'r');
  assert.deepEqual(empty.coverage.sources,{expected:0,loaded:0,unavailable:[]});
  assert.equal(empty.codexUsage.schemaVersion,1);
  assert.equal(empty.codexUsage.available,false);
  assert.equal(empty.codexUsage.scope,'local');
  assert.deepEqual(empty.codexUsage.totals,{inputTokens:0,cachedInputTokens:0,outputTokens:0,totalTokens:0});
  assert.deepEqual(empty.codexUsage.sessions,[]);
  assert.equal(empty.codexUsage.note.length>0,true);
});

test('renaming the host chat updates Codex and Qoder usage names without changing recorded totals',async()=>{
  const codexHome=await mkdtemp(join(tmpdir(),'squad-usage-title-'));
  const {DatabaseSync}=await import('node:sqlite');
  const db=new DatabaseSync(join(codexHome,'state_5.sqlite'));
  try{
    db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,name TEXT)');
    db.prepare('INSERT INTO threads VALUES(?,?,?)').run(THREAD,'原名称','现在的会话名');
    const stats={...statsFixture(),codexUsage:{schemaVersion:1,sessions:[{threadId:THREAD,title:'原名称',totalTokens:100}],totals:{totalTokens:100}},executorUsage:{qoder:{sessions:[{threadId:THREAD,title:'原名称',tokens:{totalTokens:200}}],totals:{totalTokens:200}}}};
    const first=await statsView(stats,{codexHome});
    assert.equal(first.codexUsage.sessions[0].title,'现在的会话名');
    assert.equal(first.executorUsage.qoder.sessions[0].title,'现在的会话名');
    db.prepare('UPDATE threads SET name=? WHERE id=?').run('用户刚改的名称',THREAD);
    const next=await statsView(stats,{codexHome});
    assert.equal(next.codexUsage.sessions[0].title,'用户刚改的名称');
    assert.equal(next.executorUsage.qoder.sessions[0].title,'用户刚改的名称');
    assert.equal(next.codexUsage.totals.totalTokens,100);
    assert.equal(next.executorUsage.qoder.totals.totalTokens,200);
    assert.equal(stats.codexUsage.sessions[0].title,'原名称','冻结统计原件不被改写');
  }finally{db.close();await rm(codexHome,{recursive:true,force:true})}
});

test('stats view keeps frozen Codex usage and fills older snapshots explicitly',async()=>{
  const stats=statsFixture();
  const codexUsage={
    schemaVersion:1,available:true,observedAt:'2026-10-26T12:00:00.000Z',scope:'local',
    totals:{inputTokens:90,cachedInputTokens:20,outputTokens:10,totalTokens:100},
    sessions:[{threadId:THREAD,title:'登录修复小队',kind:'squad',squadThreadId:THREAD,models:[],inputTokens:90,cachedInputTokens:20,outputTokens:10,totalTokens:100,turnCount:1}],
    models:[{model:'gpt-test',inputTokens:90,cachedInputTokens:20,outputTokens:10,totalTokens:100}],
    coverage:{threads:1,readableThreads:1,missingThreads:0,unattributedModelRecords:0},
    note:'local metadata',
  };
  const view=await statsView({...stats,codexUsage},{analysis:null});
  assert.deepEqual(view.codexUsage,codexUsage);
  assert.equal(view.metrics.taskCount,stats.metrics.taskCount);
  const legacy=await statsView(stats,{analysis:null});
  assert.equal(legacy.codexUsage.available,false);
  assert.equal(legacy.codexUsage.scope,'local');
  assert.equal(legacy.codexUsage.totals.totalTokens,0);
  assert.equal(legacy.codexUsage.observedAt,stats.observedAt);
});

test('stats view renders a frozen snapshot without fabricating suggestions',async()=>{
  const stats=statsFixture();
  const analysis={
    available:false,statsAvailable:true,reason:'ANALYSIS_RUNNING',
    runId:'55555555-5555-4555-8555-555555555555',trigger:'manual',window:stats.range,
    statsObservedAt:stats.observedAt,statFingerprint:'e'.repeat(64),latestRun:null,
  };
  const view=await statsView(stats,{analysis});
  assert.equal(view.schemaVersion,1);
  assert.equal(view.scope,'global');
  assert.equal(view.metrics.taskCount,stats.metrics.taskCount);
  assert.equal(view.tokens.totalTokens,stats.tokens.totalTokens);
  assert.deepEqual(view.analysis,analysis);
  assert.equal(view.analysis.summary,undefined);
  assert.equal(view.analysis.sessionDescriptions,undefined);
  assert.equal(view.sessions[0].links,null);
  await assert.rejects(statsView({scope:'global'}),error=>error.code==='SQUAD_ANALYSIS_STATS_INVALID');
});

test('model evidence keeps Qoder totals separate from legacy squad and native Codex tokens',()=>{
  const stats=statsFixture();
  stats.codexUsage=codexUsageFixture(stats.observedAt);
  stats.executorUsage.qoder={available:true,totals:{inputTokens:900,outputTokens:30,cachedInputTokens:null,totalTokens:930},coverage:{reportedAttempts:1,totalAttempts:2},models:[]};
  const evidence=buildEvidence(stats,{window:stats.range});
  assert.equal(evidence.qoder.totals.totalTokens,930);
  assert.equal(evidence.qoder.totals.cachedInputTokens,null);
  assert.equal(evidence.codex.totals.totalTokens,10250);
  assert.equal(evidence.tokens.totalTokens,stats.tokens.totalTokens);
  assert.ok(evidence.refs.includes('qoder:total'));
  const output=outputFixture(evidence);
  output.categories.tokens[0].evidenceRefs=['qoder:total'];
  output.categories.tokens[0].verification='qoder:total';
  assert.equal(validateAnalysisOutput(output,contextFor(evidence)).categories.tokens[0].evidenceRefs[0],'qoder:total');
});

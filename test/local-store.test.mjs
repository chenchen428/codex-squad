import {createLocalStore} from '../cli/lib/local-store.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync,statSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

const storeUrl=new URL('../cli/lib/local-store.mjs',import.meta.url).href;

function environment(t){
  const root=mkdtempSync(join(tmpdir(),'codex-squad-local-store-'));
  const home=join(root,'data');
  const workspace=join(root,'workspace');
  mkdirSync(workspace,{recursive:true});
  const stores=[];
  t.after(()=>{
    for(const store of stores)try{store.close();}catch{}
    rmSync(root,{recursive:true,force:true});
  });
  return {
    root,home,workspace,
    open(overrides={}){const store=createLocalStore({home,workspace,...overrides});stores.push(store);return store;},
  };
}

async function seedProject(store,clientRequestId='project-request'){
  return (await store.operate('project.create',{name:'本地项目',clientRequestId})).project;
}

async function seedTask(store,overrides={}){
  const project=overrides.projectId?{id:overrides.projectId}:await seedProject(store);
  return (await store.operate('work.create',{
    projectId:project.id,title:'任务',description:'说明',status:'todo',
    sourceType:'codex-squad',sourceRef:`ref-${Math.random().toString(36).slice(2)}`,...overrides,
  })).task;
}

async function startGeneration(store,taskId){
  const scan=await store.reserveExecution({manual:true,cardId:taskId});
  assert.equal(scan.claims.length,1,JSON.stringify(scan));
  return store.startExecution(scan.claims[0].claimKey,{
    boardOwnerMachineFingerprint:'machine-test',boardWorkspaceName:'workspace',
  });
}

function executionEvent(sessionId,sequence,payload,overrides={}){
  return {
    schemaVersion:'agent-bridge.conversation/v1',
    eventId:overrides.eventId||`event-${sequence}`,
    sessionId,runId:`${sessionId}:1`,sequence,
    entityId:overrides.entityId||`entity-${sequence}`,entityRevision:1,
    type:overrides.type||'SQUAD_ATTEMPT_EVENT',operation:'APPEND',
    occurredAt:overrides.occurredAt||'2026-01-01T00:00:00.000Z',
    origin:{providerId:'codex-squad'},payload,
  };
}

async function appendEvent(store,{taskId,generation,sessionId,sequence,event}){
  return store.appendExecutionEvent(taskId,{
    generation,sequence,sessionId,event,createdAt:'2026-01-01T00:00:00.000Z',
  });
}

function publicSnapshot(workspace){
  const threadId='11111111-1111-1111-1111-111111111111';
  return {
    schemaVersion:1,connected:true,
    binding:{threadId,workspace,projectId:'project-legacy',parentWorkId:'task-parent',title:'Codex 小队 · workspace'},
    parent:{id:'task-parent',title:'Codex 小队 · workspace',description:'历史父任务',status:'backlog'},
    tasks:[
      {
        id:'task-legacy',title:'历史成员任务',memberId:'implementer',status:'waiting_review',sessionId:'native-2',reason:null,
        attempts:[
          {
            id:'att-1',index:1,status:'completed',startedAt:'2026-01-01T00:00:00.000Z',endedAt:'2026-01-01T00:01:00.000Z',
            sessionId:'native-1',model:'DeepSeek-Flash',actualModel:null,
            usage:{inputTokens:10,outputTokens:2,cachedInputTokens:4,totalTokens:12},
            handoff:{goal:'首轮目标',scope:['src/a.ts'],criteria:['npm test 通过'],context:'首轮背景',writePaths:['src/a.ts']},
            events:[
              {id:'msg-1',time:'2026-01-01T00:00:20.000Z',kind:'message',role:'assistant',text:'首轮完成',status:'completed',revision:2},
              {id:'tool-1',time:'2026-01-01T00:00:30.000Z',kind:'tool',role:'tool',toolName:'Bash',text:'npm test',status:'SUCCEEDED',revision:1},
            ],
            result:'首轮完成',error:null,resumedFrom:null,
          },
          {
            id:'att-2',index:2,generation:2,status:'completed',startedAt:'2026-01-02T00:00:00.000Z',endedAt:'2026-01-02T00:01:00.000Z',
            sessionId:'native-2',model:'DeepSeek-Flash',actualModel:'deepseek-flash-2026',
            usage:{inputTokens:3,outputTokens:1,cachedInputTokens:1,totalTokens:4},
            handoff:{goal:'补边界',scope:['src/a.ts'],criteria:['npm test 通过'],context:'增量'},
            events:[{id:'msg-2',time:'2026-01-02T00:00:30.000Z',kind:'message',role:'assistant',text:'边界完成',status:'completed',revision:1}],
            result:'边界完成',error:null,resumedFrom:'att-1',
          },
        ],
        acceptance:{attemptId:'att-2',index:2,fingerprint:'fp-legacy',note:'负责人已核对',at:'2026-01-02T00:02:00.000Z',files:['src/a.ts']},
      },
      {
        id:'task-running',title:'历史运行任务',memberId:'implementer',status:'running',sessionId:'native-running',reason:null,
        attempts:[{
          id:'att-running',index:1,status:'running',startedAt:'2026-01-03T00:00:00.000Z',endedAt:null,
          sessionId:'native-running',model:'DeepSeek-Flash',usage:null,
          handoff:{goal:'未完成目标',scope:['src/b.ts'],criteria:['等待结果']},
          events:[{id:'msg-running',time:'2026-01-03T00:00:10.000Z',kind:'message',role:'assistant',text:'仍在执行',status:'streaming',revision:1}],
          result:null,error:null,resumedFrom:null,
        }],
        acceptance:null,
      },
    ],
  };
}

test('projects and works are idempotent by request/source and task versions use CAS',async t=>{
  const env=environment(t);
  const store=env.open();
  const first=await seedProject(store,'project-same');
  const second=await seedProject(store,'project-same');
  assert.equal(second.id,first.id);
  const other=await seedProject(store,'project-other');
  assert.notEqual(other.id,first.id);

  const input={
    projectId:first.id,title:'任务 A',description:'说明 A',status:'backlog',labels:['codex-squad'],
    sourceType:'codex-squad',sourceRef:'squad:v2:thread:parent:implementer:req-a',
  };
  const created=(await store.operate('work.create',input)).task;
  assert.equal(created.projectId,first.id);
  assert.equal(created.title,'任务 A');
  assert.equal(created.description,'说明 A');
  assert.equal(created.status,'backlog');
  assert.equal(created.version,1);
  assert.equal(created.harness.sourceType,'codex-squad');
  assert.equal(created.harness.sourceRef,input.sourceRef);
  assert.equal(created.harness.activeGeneration,0);
  assert.equal(created.harness.activeSessionId,null);
  assert.equal(created.harness.worktreePath,resolve(env.workspace));
  assert.equal(created.harness.blocker,null);

  const duplicate=(await store.operate('work.create',{...input,title:'不应覆盖'})).task;
  assert.equal(duplicate.id,created.id);
  assert.equal(duplicate.title,'任务 A');
  const distinct=(await store.operate('work.create',{...input,sourceRef:'ref-distinct'})).task;
  assert.notEqual(distinct.id,created.id);

  const updated=(await store.operate('work.update',{workId:created.id,expectedVersion:1,status:'todo'})).task;
  assert.equal(updated.status,'todo');
  assert.equal(updated.version,2);
  await assert.rejects(
    store.operate('work.update',{workId:created.id,expectedVersion:1,status:'in_review'}),
    error=>error.code==='TASK_VERSION_CONFLICT',
  );
  const read=(await store.operate('work.get',{workId:created.id})).task;
  assert.equal(read.status,'todo');
  assert.equal(read.version,2);
  const agent=(await store.operate('work.agent.save',{workId:created.id,executor:'qoder',model:'DeepSeek-Flash',approvalMode:'auto'})).task;
  assert.equal(agent.id,created.id);
  const found=(await store.operate('work.find',{sourceType:input.sourceType,sourceRef:input.sourceRef})).task;
  assert.equal(found.id,created.id);
  assert.equal(found.version,read.version);
  assert.equal((await store.operate('work.find',{sourceType:input.sourceType,sourceRef:'ref-missing'})).task,null);
  await assert.rejects(store.operate('work.find',{sourceType:'',sourceRef:input.sourceRef}),error=>error.code==='LOCAL_INPUT_INVALID');
  await assert.rejects(store.operate('work.get',{workId:'missing'}),error=>error.code==='TASK_NOT_FOUND');
});

test('work.create resolves the working copy from resolver, default workspace or a constructed directory',async t=>{
  const env=environment(t);
  const store=env.open();
  const project=await seedProject(store);
  const alternate=join(env.root,'alternate');
  const fallback=join(env.root,'fallback');
  mkdirSync(alternate,{recursive:true});
  mkdirSync(fallback,{recursive:true});
  const resolved=(await store.operate('work.create',{
    projectId:project.id,title:'resolver',sourceType:'codex-squad',sourceRef:'ref-resolver',
  },{resolveWorkingCopyPath:async()=>alternate})).task;
  assert.equal(resolved.harness.worktreePath,resolve(alternate));
  const defaulted=(await store.operate('work.create',{
    projectId:project.id,title:'default',sourceType:'codex-squad',sourceRef:'ref-default',
  },{defaultWorkspace:fallback})).task;
  assert.equal(defaulted.harness.worktreePath,resolve(fallback));
  await assert.rejects(store.operate('work.create',{
    projectId:project.id,title:'missing',sourceType:'codex-squad',sourceRef:'ref-missing',
  },{defaultWorkspace:join(env.root,'not-there')}),error=>error.code==='LOCAL_WORKSPACE_MISSING');

  const constructedHome=join(env.root,'constructed-data');
  const constructed=createLocalStore({home:constructedHome});
  t.after(()=>constructed.close());
  const constructedProject=await seedProject(constructed);
  const task=(await constructed.operate('work.create',{
    projectId:constructedProject.id,title:'constructed',sourceType:'codex-squad',sourceRef:'ref-constructed',
  })).task;
  assert.equal(task.harness.worktreePath,join(constructedHome,'workspace'));
  assert.equal(statSync(join(constructedHome,'workspace')).isDirectory(),true);
});

test('scheduler claims increment generations once and expired generations cannot write or finalize',async t=>{
  const env=environment(t);
  const store=env.open();
  const task=await seedTask(store);
  const first=(await store.reserveExecution({manual:true,cardId:task.id,projectId:task.projectId})).claims[0];
  assert.equal(first.claimKey,`${task.id}:1`);
  const dispatched=await store.startExecution(first.claimKey,{});
  assert.equal(dispatched.context.version,1);
  assert.match(dispatched.context.storeInstanceId,/^local-/);
  assert.equal(dispatched.context.generation,1);
  assert.equal(dispatched.context.cardId,task.id);
  assert.equal(dispatched.context.worktreePath,resolve(env.workspace));
  const again=await store.startExecution(first.claimKey,{});
  assert.equal(again.duplicate,true);
  assert.deepEqual(again.context,dispatched.context);
  const active=(await store.operate('work.get',{workId:task.id})).task;
  assert.equal(active.status,'in_progress');
  assert.equal(active.harness.activeGeneration,1);
  assert.equal(active.harness.activeSessionId,dispatched.context.activeSessionId);
  const skipped=await store.reserveExecution({manual:true,cardId:task.id});
  assert.equal(skipped.claims.length,0);
  assert.equal(skipped.skipped[0].reason,'not_ready');

  const sessionId=dispatched.context.activeSessionId;
  await appendEvent(store,{taskId:task.id,generation:1,sessionId,sequence:1,
    event:executionEvent(sessionId,1,{attemptId:'att-1',kind:'message',text:'完成'})});
  const applied=await store.applyExecutionOutcome(dispatched.context,{
    version:1,sessionId,eventSequence:2,eventKind:'idle_success',occurredAt:'2026-01-01T00:00:01.000Z',
  });
  assert.equal(applied.applied,true);
  const reviewed=(await store.operate('work.get',{workId:task.id})).task;
  assert.equal(reviewed.status,'in_review');
  const versionAfterFinalize=reviewed.version;
  const duplicate=await store.applyExecutionOutcome(dispatched.context,{
    version:1,sessionId,eventSequence:2,eventKind:'idle_success',occurredAt:'2026-01-01T00:00:02.000Z',
  });
  assert.equal(duplicate.duplicate,true);
  assert.equal((await store.operate('work.get',{workId:task.id})).task.version,versionAfterFinalize);
  await assert.rejects(store.applyExecutionOutcome(dispatched.context,{
    version:1,sessionId,eventSequence:2,eventKind:'failed',errorSummary:'不同终态',
  }),error=>error.code==='EXECUTION_TERMINAL_CONFLICT');

  const moved=await store.operate('work.update',{workId:task.id,expectedVersion:versionAfterFinalize,status:'todo'});
  const second=(await store.reserveExecution({manual:true,cardId:task.id})).claims[0];
  assert.equal(second.claimKey,`${task.id}:2`);
  const secondContext=(await store.startExecution(second.claimKey,{})).context;
  assert.equal(secondContext.generation,2);
  await assert.rejects(appendEvent(store,{taskId:task.id,generation:1,sessionId,sequence:99,
    event:executionEvent(sessionId,99,{attemptId:'att-1',kind:'message',text:'过期写入'})}),
  error=>error.code==='EXECUTION_GENERATION_STALE');
  await assert.rejects(store.applyExecutionOutcome(dispatched.context,{
    version:1,sessionId,eventSequence:3,eventKind:'failed',errorSummary:'过期终态',
  }),error=>error.code==='EXECUTION_GENERATION_STALE');
  const oldExecution=await store.operate('work.execution.get',{workId:task.id,generation:1});
  assert.equal(oldExecution.events.length,1);
  assert.equal(oldExecution.highWaterSequence,1);
  await assert.rejects(store.operate('work.execution.get',{workId:task.id,generation:3}),
    error=>error.code==='EXECUTION_GENERATION_STALE');
  const secondAppend=await appendEvent(store,{taskId:task.id,generation:2,sessionId:secondContext.activeSessionId,sequence:1,
    event:executionEvent(secondContext.activeSessionId,1,{attemptId:'att-2',kind:'message',text:'续接完成'})});
  assert.equal(secondAppend.accepted,true);

  const staleFail=await store.failExecution(first.claimKey,'迟到的失败');
  assert.equal(staleFail.stale,true);
  const current=(await store.operate('work.get',{workId:task.id})).task;
  assert.equal(current.status,'in_progress');
  assert.equal(current.harness.activeGeneration,2);
  assert.equal(current.harness.blocker,null);
  assert.equal(moved.task.status,'todo');
});

test('event pagination, high water and idempotency reject different content under the same id or sequence',async t=>{
  const env=environment(t);
  const store=env.open();
  const task=await seedTask(store);
  const {context}=await startGeneration(store,task.id);
  const sessionId=context.activeSessionId;
  for(let sequence=1;sequence<=5;sequence+=1){
    await appendEvent(store,{taskId:task.id,generation:1,sessionId,sequence,
      event:executionEvent(sessionId,sequence,{attemptId:'att-1',kind:'progress',text:`步骤 ${sequence}`})});
  }
  const all=await store.operate('work.execution.get',{workId:task.id,generation:1});
  assert.equal(all.highWaterSequence,5);
  assert.deepEqual(all.events.map(event=>event.sequence),[1,2,3,4,5]);
  assert.equal(all.activeSessionId,sessionId);
  const firstPage=await store.operate('work.execution.get',{workId:task.id,generation:1,limit:2});
  assert.deepEqual(firstPage.events.map(event=>event.sequence),[1,2]);
  assert.equal(firstPage.highWaterSequence,5);
  const secondPage=await store.operate('work.execution.get',{workId:task.id,generation:1,limit:2,afterSequence:2});
  assert.deepEqual(secondPage.events.map(event=>event.sequence),[3,4]);
  const lastPage=await store.operate('work.execution.get',{workId:task.id,generation:1,limit:2,afterSequence:4});
  assert.deepEqual(lastPage.events.map(event=>event.sequence),[5]);
  const emptyPage=await store.operate('work.execution.get',{workId:task.id,generation:1,afterSequence:5});
  assert.deepEqual(emptyPage.events,[]);

  const duplicate=await appendEvent(store,{taskId:task.id,generation:1,sessionId,sequence:1,
    event:executionEvent(sessionId,1,{attemptId:'att-1',kind:'progress',text:'步骤 1'},{occurredAt:'2026-01-02T00:00:00.000Z'})});
  assert.equal(duplicate.duplicate,true);
  await assert.rejects(appendEvent(store,{taskId:task.id,generation:1,sessionId,sequence:1,
    event:executionEvent(sessionId,1,{attemptId:'att-1',kind:'progress',text:'被篡改'})}),
  error=>error.code==='EXECUTION_EVENT_CONFLICT');
  await assert.rejects(appendEvent(store,{taskId:task.id,generation:1,sessionId,sequence:6,
    event:executionEvent(sessionId,6,{attemptId:'att-1',kind:'progress',text:'复用标识'},{eventId:'event-1'})}),
  error=>error.code==='EXECUTION_EVENT_CONFLICT');
  const after=await store.operate('work.execution.get',{workId:task.id,generation:1});
  assert.equal(after.events.length,5);
  assert.equal(after.highWaterSequence,5);
  assert.equal(after.events[0].payload.text,'步骤 1');
});

test('a failed claim blocks only its own generation and does not touch newer work',async t=>{
  const env=environment(t);
  const store=env.open();
  const task=await seedTask(store);
  const {context}=await startGeneration(store,task.id);
  const failed=await store.failExecution(`${task.id}:1`,'执行器不可用');
  assert.equal(failed.ok,true);
  const blocked=(await store.operate('work.get',{workId:task.id})).task;
  assert.equal(blocked.status,'blocked');
  assert.deepEqual(blocked.harness.blocker,{summary:'执行器不可用'});
  assert.equal((await store.failExecution(`${task.id}:1`,'重复')).duplicate,true);
  assert.equal((await store.failExecution('unknown-claim','x')).ignored,true);
  assert.equal(context.generation,1);
});

test('separate store connections and concurrent subprocesses keep every event',{timeout:30000},async t=>{
  const env=environment(t);
  const store=env.open();
  const task=await seedTask(store);
  const {context}=await startGeneration(store,task.id);
  const sessionId=context.activeSessionId;
  const second=env.open();
  await appendEvent(store,{taskId:task.id,generation:1,sessionId,sequence:1,
    event:executionEvent(sessionId,1,{attemptId:'att-1',kind:'progress',text:'连接一'})});
  await appendEvent(second,{taskId:task.id,generation:1,sessionId,sequence:2,
    event:executionEvent(sessionId,2,{attemptId:'att-1',kind:'progress',text:'连接二'})});
  const shared=await second.operate('work.execution.get',{workId:task.id,generation:1});
  assert.deepEqual(shared.events.map(event=>event.sequence),[1,2]);
  assert.equal((statSync(join(env.home,'local-store.sqlite')).mode&0o777).toString(8),'600');
  assert.equal((statSync(env.home).mode&0o777).toString(8),'700');

  const children=[];
  for(const start of [100,200,300]){
    const script=`
import {createLocalStore} from ${JSON.stringify(storeUrl)};
const store=createLocalStore({home:${JSON.stringify(env.home)}});
const sessionId=${JSON.stringify(sessionId)};
for(let index=0;index<20;index+=1){
  const sequence=${start}+index;
  await store.appendExecutionEvent(${JSON.stringify(task.id)},{
    generation:1,sequence,sessionId,createdAt:'2026-01-01T00:00:00.000Z',
    event:{schemaVersion:'agent-bridge.conversation/v1',eventId:'child-${start}-'+sequence,sessionId,
      runId:sessionId+':1',sequence,entityId:'child-'+sequence,entityRevision:1,
      type:'SQUAD_ATTEMPT_EVENT',operation:'APPEND',occurredAt:'2026-01-01T00:00:00.000Z',
      origin:{providerId:'codex-squad'},payload:{attemptId:'att-1',kind:'progress',text:'child '+sequence}}
  });
}
`;
    children.push(runChild(script));
  }
  await Promise.all(children);
  const all=await store.operate('work.execution.get',{workId:task.id,generation:1,limit:5000});
  assert.equal(all.highWaterSequence,319);
  assert.equal(all.events.length,62);
  const sequences=new Set(all.events.map(event=>event.sequence));
  for(let sequence=1;sequence<=2;sequence+=1)assert.equal(sequences.has(sequence),true);
  for(const start of [100,200,300])for(let index=0;index<20;index+=1)assert.equal(sequences.has(start+index),true);
  assert.equal(new Set(all.events.map(event=>event.eventId)).size,62);
});

test('snapshot import preserves public history, keeps running attempts unknown and never overwrites conflicts',async t=>{
  const env=environment(t);
  const store=env.open();
  const snapshot=publicSnapshot(env.workspace);
  const first=await store.importSnapshot(snapshot);
  assert.equal(first.projects,1);
  assert.equal(first.tasks,3);
  assert.deepEqual(first.conflicts,[]);
  const repeated=await store.importSnapshot(snapshot);
  assert.equal(repeated.projects,0);
  assert.equal(repeated.tasks,0);
  assert.equal(repeated.events,0);
  assert.equal(repeated.duplicates,first.events);
  assert.deepEqual(repeated.conflicts,[]);

  const parent=(await store.operate('work.get',{workId:'task-parent'})).task;
  assert.equal(parent.projectId,'project-legacy');
  assert.equal(parent.harness.sourceRef,`squad:v2:${snapshot.binding.threadId}:parent`);

  const task=(await store.operate('work.get',{workId:'task-legacy'})).task;
  assert.equal(task.projectId,'project-legacy');
  assert.equal(task.parentId,'task-parent');
  assert.equal(task.title,'历史成员任务');
  assert.equal(task.status,'in_review');
  assert.equal(task.harness.activeGeneration,2);
  assert.equal(task.harness.activeSessionId,'native-2');
  assert.match(task.harness.sourceRef,/^squad:v2:11111111-1111-1111-1111-111111111111:task-parent:implementer:legacy-/);

  const generationOne=await store.operate('work.execution.get',{workId:'task-legacy',generation:1});
  assert.deepEqual(generationOne.events.map(event=>event.type),[
    'SQUAD_ATTEMPT_STARTED','SQUAD_ATTEMPT_SESSION','SQUAD_ATTEMPT_EVENT','SQUAD_ATTEMPT_EVENT','SQUAD_ATTEMPT_COMPLETED',
  ]);
  const startedOne=generationOne.events[0].payload;
  assert.equal(startedOne.attemptId,'att-1');
  assert.equal(startedOne.index,1);
  assert.equal(startedOne.resumedFrom,null);
  assert.equal(startedOne.startedAt,'2026-01-01T00:00:00.000Z');
  assert.equal(generationOne.events[1].payload.sessionId,'native-1');
  const legacyMessage=generationOne.events[2].payload;
  assert.equal(legacyMessage.kind,'message');
  assert.equal(legacyMessage.role,'assistant');
  assert.equal(legacyMessage.text,'首轮完成');
  assert.equal(legacyMessage.status,'completed');
  assert.equal(legacyMessage.revision,2);
  const legacyTool=generationOne.events[3].payload;
  assert.equal(legacyTool.kind,'tool');
  assert.equal(legacyTool.toolName,'Bash');
  assert.equal(legacyTool.text,'npm test');
  const completedOne=generationOne.events[4].payload;
  assert.equal(completedOne.status,'completed');
  assert.deepEqual(completedOne.usage,{inputTokens:10,outputTokens:2,cachedInputTokens:4,totalTokens:12});
  assert.equal(completedOne.result,'首轮完成');
  assert.equal(completedOne.nativeSessionId,'native-1');

  const generationTwo=await store.operate('work.execution.get',{workId:'task-legacy',generation:2});
  assert.equal(generationTwo.events[0].payload.resumedFrom,'att-1');
  assert.equal(generationTwo.events[0].payload.index,2);
  assert.equal(generationTwo.events.at(-1).type,'SQUAD_ACCEPTANCE');
  assert.equal(generationTwo.events.at(-1).payload.attemptId,'att-2');
  assert.equal(generationTwo.events.at(-1).payload.fingerprint,'fp-legacy');
  assert.equal(generationTwo.events.at(-1).payload.note,'负责人已核对');
  assert.deepEqual(generationTwo.events.at(-1).payload.files,['src/a.ts']);

  const running=(await store.operate('work.get',{workId:'task-running'})).task;
  assert.equal(running.status,'in_progress');
  assert.equal(running.harness.activeGeneration,1);
  const runningExecution=await store.operate('work.execution.get',{workId:'task-running',generation:1});
  assert.deepEqual(runningExecution.events.map(event=>event.type),[
    'SQUAD_ATTEMPT_STARTED','SQUAD_ATTEMPT_SESSION','SQUAD_ATTEMPT_EVENT',
  ]);
  assert.equal(runningExecution.events.some(event=>event.type==='SQUAD_ATTEMPT_COMPLETED'),false);

  const altered=structuredClone(snapshot);
  altered.tasks[0].attempts[0].events[0].text='篡改后的文本';
  const eventConflict=await store.importSnapshot(altered);
  assert.equal(eventConflict.conflicts.some(conflict=>conflict.kind==='event'&&conflict.reason==='content_mismatch'),true);
  const unchanged=await store.operate('work.execution.get',{workId:'task-legacy',generation:1});
  assert.equal(unchanged.events[2].payload.text,'首轮完成');

  const renamed=structuredClone(snapshot);
  renamed.tasks[0].title='篡改后的任务';
  const taskConflict=await store.importSnapshot(renamed);
  assert.equal(taskConflict.conflicts.some(conflict=>conflict.kind==='task'&&conflict.id==='task-legacy'),true);
  const stillOriginal=(await store.operate('work.get',{workId:'task-legacy'})).task;
  assert.equal(stillOriginal.title,'历史成员任务');
  assert.equal(stillOriginal.status,'in_review');
});

function runChild(script){
  return new Promise((resolvePromise,reject)=>{
    const child=spawn(process.execPath,['--input-type=module','-e',script],{stdio:['ignore','pipe','pipe']});
    let stderr='';
    let settled=false;
    const timer=setTimeout(()=>{
      if(settled)return;
      settled=true;
      child.kill('SIGKILL');
      reject(new Error(`子进程未在限制时间内退出：${stderr}`));
    },15000);
    child.stderr.on('data',chunk=>{stderr+=chunk;});
    child.on('error',error=>{
      if(settled)return;
      settled=true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit',(code,signal)=>{
      if(settled)return;
      settled=true;
      clearTimeout(timer);
      if(code===0)resolvePromise();
      else reject(new Error(`子进程退出 ${code}/${signal}：${stderr}`));
    });
  });
}

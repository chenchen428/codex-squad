import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createLocalStore} from '../cli/lib/local-store.mjs';
import {appendSquadEvent,finalizeAttempt} from '../cli/lib/runtime.mjs';
import {buildFailureReceipt} from '../cli/lib/handover.mjs';
import {inboxView,taskDetails,waitForTasks} from '../cli/lib/task-read.mjs';

const quietSleep=async()=>{};

async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'squad-task-read-'));
  const workspace=join(root,'workspace');
  await mkdir(workspace,{recursive:true});
  const store=createLocalStore({home:join(root,'data'),workspace});
  t.after(async()=>{
    try{store.close();}catch{}
    await rm(root,{recursive:true,force:true,maxRetries:3,retryDelay:50});
  });
  const project=(await store.operate('project.create',{name:'任务读取'})).project;
  const threadId=randomUUID();
  const parentWorkId='parent-work';
  const binding={
    schemaVersion:1,threadId,workspace,projectId:project.id,parentWorkId,title:'读取会话',
    tasks:[],attempts:{},workers:{},reviews:{},retirements:{},createdAt:'',updatedAt:'',
  };
  async function createTask(requestId,{title='任务'}={}){
    const task=(await store.operate('work.create',{
      projectId:project.id,title,status:'todo',sourceType:'codex-squad',
      sourceRef:`squad:v2:${threadId}:${encodeURIComponent(parentWorkId)}:implementer:${requestId}`,
    })).task;
    binding.tasks.push(task.id);
    return task;
  }
  async function start(task,requestId){
    const scan=await store.reserveExecution({cardId:task.id});
    const {context}=await store.startExecution(scan.claims[0].claimKey);
    const attemptId=`attempt-${requestId}-${context.generation}`;
    let sequence=0;
    const append=async(type,payload)=>{
      const result=await appendSquadEvent(store,{
        taskId:task.id,generation:context.generation,sessionId:context.activeSessionId,
        sequence:sequence+1,type,attemptId,payload:{attemptId,...payload},
      });
      sequence+=1;
      return result;
    };
    const startedAt=new Date(Date.parse('2026-10-27T00:00:00.000Z')+context.generation*1000).toISOString();
    await append('SQUAD_ATTEMPT_STARTED',{
      index:context.generation,requestId,startedAt,
      handoff:{title:'任务',goal:'目标',scope:['.'],criteria:['测试通过'],context:''},
    });
    const ref={attemptId,index:context.generation,generation:context.generation,requestId,startedAt,nativeSessionId:null,writePaths:['.']};
    binding.attempts[task.id]=[...(binding.attempts[task.id]||[]),ref];
    binding.workers[task.id]={pid:9000+context.generation,nonce:`nonce-${attemptId}`};
    return {
      task,attemptId,generation:context.generation,sessionId:context.activeSessionId,ref,
      sequence:()=>sequence,
      append,
      async complete({status='completed',result='完成',error=null,usage=null,nativeSessionId='native-1',endedAt='2026-10-27T00:00:10.000Z',deliveryChecklist=null,checks=[]}={}){
        await append('SQUAD_ATTEMPT_COMPLETED',{status,result,error,usage,nativeSessionId,endedAt,deliveryChecklist,checks});
        await finalizeAttempt(store,{
          taskId:task.id,generation:context.generation,storeInstanceId:store.ready(),executor:'qoder',
          sessionId:context.activeSessionId,eventKind:status==='completed'?'idle_success':'failed',
          eventSequence:sequence,errorSummary:error||undefined,outcomeSummary:status==='completed'?result:undefined,
        });
        ref.nativeSessionId=nativeSessionId;
      },
      async retry(){
        await store.operate('work.update',{workId:task.id,status:'todo'});
        return start(task,`${requestId}-next`);
      },
    };
  }
  return {root,workspace,store,project,threadId,parentWorkId,binding,createTask,start};
}

function counted(client){
  const counts=new Map();
  return {
    counts,
    client:new Proxy(client,{
      get(target,property){
        if(property==='operate')return async(operation,input,...rest)=>{
          if(['work.get','work.execution.digest','work.execution.get'].includes(operation)){
            const key=`${operation}:${input?.workId}`;
            counts.set(key,(counts.get(key)||0)+1);
          }
          return target.operate(operation,input,...rest);
        };
        const value=target[property];
        return typeof value==='function'?value.bind(target):value;
      },
    }),
  };
}

function decoded(value){
  return JSON.parse(Buffer.from(String(value).slice('squad-wait-v1.'.length),'base64url').toString('utf8'));
}

function cursorFor(threadId,ids,signatures={}){
  return `squad-wait-v1.${Buffer.from(JSON.stringify({threadId,ids,signatures})).toString('base64url')}`;
}

test('wait reads only the requested tasks and wakes on a terminal fact, not on tool progress',async t=>{
  const env=await fixture(t);
  const task=await env.createTask('req-wait');
  const run=await env.start(task,'req-wait');
  const other=await env.createTask('req-other');
  await env.start(other,'req-other');

  const {client,counts}=counted(env.store);
  const options={client,defaultWorkspace:env.workspace,isWorkerProcess:()=>true};
  const baseline=await waitForTasks(env.binding,{taskIds:[task.id],seconds:0},options);
  assert.equal(baseline.snapshot,true);
  assert.equal(baseline.changed,false);
  assert.deepEqual(baseline.tasks.map(item=>item.id),[task.id]);
  assert.equal(baseline.tasks[0].status,'starting');
  assert.deepEqual(
    [...counts.keys()].filter(key=>key.endsWith(other.id)),
    [],
    'a specified task must not hydrate the other task conversations',
  );
  counts.clear();

  await run.append('SQUAD_ATTEMPT_SESSION',{sessionId:'native-wait',turnId:null});
  await run.append('SQUAD_ATTEMPT_EVENT',{eventId:'tool-1',kind:'tool',text:'running tests',time:'2026-10-27T00:00:02.000Z'});
  await run.append('SQUAD_ATTEMPT_EVENT',{eventId:'progress-1',kind:'progress',text:'50%',time:'2026-10-27T00:00:03.000Z'});
  const quiet=await waitForTasks(env.binding,{taskIds:[task.id],seconds:1,after:baseline.cursor},{client,defaultWorkspace:env.workspace,isWorkerProcess:()=>true,sleep:quietSleep});
  assert.equal(quiet.changed,false,'session and tool activity never count as a wake-up');
  assert.equal(quiet.tasks[0].status,'running');
  assert.deepEqual([...counts.keys()].filter(key=>key.endsWith(other.id)),[]);

  const pending=waitForTasks(env.binding,{taskIds:[task.id],seconds:5,after:baseline.cursor},{
    client,defaultWorkspace:env.workspace,isWorkerProcess:()=>true,
    sleep:async()=>{await run.complete({result:'修复完成',usage:{inputTokens:9,outputTokens:3,totalTokens:12}});},
  });
  const changed=await pending;
  assert.equal(changed.changed,true);
  assert.equal(changed.tasks[0].status,'waiting_review');
  assert.equal(changed.tasks[0].latest.result,'修复完成');
  assert.equal(changed.tasks[0].latest.usage.totalTokens,12);
  assert.equal(changed.tasks[0].latest.sessionId,'native-1');

  const after=await waitForTasks(env.binding,{taskIds:[task.id],seconds:0},{client,defaultWorkspace:env.workspace,isWorkerProcess:()=>true});
  assert.equal(after.changed,false);
  assert.equal(JSON.stringify(after).includes('running tests'),false,'compact state never returns raw tool text');
});

test('wait returns when any watched task reaches a terminal state and keeps the rest compact',async t=>{
  const env=await fixture(t);
  const first=await env.createTask('req-first');
  const second=await env.createTask('req-second');
  await env.start(first,'req-first');
  const secondRun=await env.start(second,'req-second');
  const {client}=counted(env.store);
  const options={client,defaultWorkspace:env.workspace,isWorkerProcess:()=>true};
  const baseline=await waitForTasks(env.binding,{taskIds:[first.id,second.id],seconds:0},options);
  assert.equal(baseline.tasks.length,2);
  const ids=decoded(baseline.cursor).ids;
  assert.deepEqual(ids,[first.id,second.id]);

  let sleeps=0;
  const view=await waitForTasks(env.binding,{taskIds:[first.id,second.id],seconds:5,after:baseline.cursor},{
    ...options,
    sleep:async()=>{
      sleeps+=1;
      if(sleeps===1)await secondRun.complete({status:'failed',error:'模型拒绝执行'});
    },
  });
  assert.equal(view.changed,true);
  assert.equal(view.tasks.find(item=>item.id===second.id).status,'failed');
  assert.equal(view.tasks.find(item=>item.id===second.id).latest.error,'模型拒绝执行');
  assert.equal(view.tasks.find(item=>item.id===first.id).status,'starting');
});

test('wait rejects foreign cursors and tasks instead of reading another session',async t=>{
  const env=await fixture(t);
  const task=await env.createTask('req-guard');
  await env.start(task,'req-guard');
  const {client}=counted(env.store);
  const options={client,defaultWorkspace:env.workspace,isWorkerProcess:()=>true};

  await assert.rejects(
    waitForTasks(env.binding,{taskIds:[task.id],seconds:0,after:'f'.repeat(64)},options),
    error=>error.code==='SQUAD_WAIT_CURSOR_INVALID',
  );
  await assert.rejects(
    waitForTasks(env.binding,{taskIds:[task.id],seconds:0,after:cursorFor('00000000-0000-4000-8000-000000000000',[task.id])},options),
    error=>error.code==='SQUAD_WAIT_CURSOR_MISMATCH',
  );
  await assert.rejects(
    waitForTasks(env.binding,{taskIds:['task-foreign'],seconds:0},options),
    error=>error.code==='SQUAD_BINDING_TASK_MISMATCH',
  );
  const otherCursor=cursorFor(env.threadId,['task-foreign']);
  await assert.rejects(
    waitForTasks(env.binding,{taskIds:[task.id],seconds:0,after:otherCursor},options),
    error=>error.code==='SQUAD_WAIT_TASK_MISMATCH',
  );
  await assert.rejects(
    waitForTasks(env.binding,{taskIds:[],seconds:0},options),
    error=>error.code==='SQUAD_INPUT_INVALID',
  );
});

test('inbox reuses the same task facts and only hydrates returned tasks',async t=>{
  const env=await fixture(t);
  const done=await env.createTask('req-inbox-done');
  const run=await env.start(done,'req-inbox-done');
  const running=await env.createTask('req-inbox-running');
  await env.start(running,'req-inbox-running');
  const checklist={
    schemaVersion:1,source:'member_reported',available:true,conclusion:'修复完成',artifacts:['src/a.ts'],
    checks:[{name:'tests',status:'passed',source:'member_reported',evidence:'ok'}],remaining:['未验证浏览器'],
    program:{source:'program_checked',artifacts:[{path:'src/a.ts',exists:true,inScope:true,sha256:'a'.repeat(64)}],fingerprint:'f'.repeat(64),missing:[],outOfScope:[],unreadable:[]},
    gaps:['检查未通过：浏览器（not_run）'],
  };
  await run.complete({deliveryChecklist:checklist,usage:{inputTokens:4,outputTokens:2,totalTokens:6}});

  const {client,counts}=counted(env.store);
  const inbox=await inboxView(env.binding,{client,defaultWorkspace:env.workspace,isWorkerProcess:()=>true});
  assert.equal(inbox.schemaVersion,1);
  assert.equal(inbox.count,1);
  assert.equal(inbox.pending[0].taskId,done.id);
  assert.equal(inbox.pending[0].phase,'waiting');
  assert.equal(inbox.pending[0].sessionId,'native-1');
  assert.equal(inbox.pending[0].deliveryChecklist.available,true);
  assert.equal(inbox.pending[0].deliveryChecklist.conclusion,'修复完成');
  assert.deepEqual(inbox.pending[0].deliveryChecklist.checks,{passed:1});
  assert.equal(inbox.pending[0].deliveryChecklist.artifacts,1);
  assert.equal(inbox.pending[0].deliveryChecklist.remaining,1);
  assert.equal(inbox.cursor.startsWith('squad-wait-v1.'),true);

  assert.equal(counts.get(`work.get:${done.id}`),1);
  assert.equal(counts.get(`work.get:${running.id}`),1);
  assert.equal(counts.get(`work.execution.digest:${done.id}`),1);
  assert.equal(counts.get(`work.execution.digest:${running.id}`)||0,0,'running tasks need no conversation digest for inbox');

  const after=await inboxView(env.binding,{client,defaultWorkspace:env.workspace,isWorkerProcess:()=>true});
  assert.deepEqual(after.schemaVersion,inbox.schemaVersion);
  assert.equal(after.count,inbox.count);
});

test('registered verification is visible in inbox and details only for the current attempt',async t=>{
  const env=await fixture(t);
  const task=await env.createTask('req-verified');
  const first=await env.start(task,'req-verified');
  await first.complete();
  env.binding.reviews[task.id]={[first.attemptId]:{attemptId:first.attemptId,startedAt:'2026-10-27T00:00:12.000Z'}};
  const options={client:env.store,defaultWorkspace:env.workspace,isWorkerProcess:()=>false};
  const inbox=await inboxView(env.binding,options);
  assert.equal(inbox.verifying.length,1);
  assert.equal(inbox.verifying[0].taskId,task.id);
  assert.equal(inbox.pending.length,0);
  const details=await taskDetails(env.binding,{taskId:task.id},options);
  assert.equal(details.verification.attemptId,first.attemptId);
  const second=await first.retry();
  await second.complete();
  const next=await inboxView(env.binding,options);
  assert.equal(next.verifying.length,0);
  assert.equal(next.pending.length,1);
  assert.equal(next.pending[0].attemptId,second.attemptId);
});

test('details defaults to the current round, exposes the delivery checklist and paginates public process',async t=>{
  const env=await fixture(t);
  const task=await env.createTask('req-details');
  const first=await env.start(task,'req-details');
  await first.append('SQUAD_ATTEMPT_EVENT',{eventId:'tool-a',kind:'tool',text:'npm test',time:'2026-10-27T00:00:02.000Z'});
  const checklist={
    schemaVersion:1,source:'member_reported',available:true,conclusion:'第一轮完成',artifacts:['src/a.ts'],
    checks:[{name:'tests',status:'passed',source:'member_reported',evidence:'3 passed'}],remaining:[],
    program:{source:'program_checked',artifacts:[{path:'src/a.ts',exists:true,inScope:true,sha256:'b'.repeat(64)}],fingerprint:'c'.repeat(64),missing:[],outOfScope:[],unreadable:[]},
    gaps:['本轮已返回，尚未登记负责人核验。'],
  };
  await first.complete({result:'第一轮完成',deliveryChecklist:checklist,usage:{inputTokens:5,outputTokens:5,totalTokens:10}});
  const second=await first.retry();
  await second.append('SQUAD_ATTEMPT_EVENT',{eventId:'tool-b',kind:'tool',text:'retest',time:'2026-10-27T00:00:20.000Z'});
  await second.append('SQUAD_ATTEMPT_EVENT',{eventId:'tool-c',kind:'tool',text:'retest again',time:'2026-10-27T00:00:21.000Z'});
  await second.complete({result:'第二轮完成',usage:{inputTokens:2,outputTokens:1,totalTokens:3}});

  const {client,counts}=counted(env.store);
  const details=await taskDetails(env.binding,{taskId:task.id},{client,defaultWorkspace:env.workspace,isWorkerProcess:()=>true});
  assert.equal(details.schemaVersion,1);
  assert.equal(details.id,task.id);
  assert.equal(details.status,'waiting_review');
  assert.equal(details.generation,2);
  assert.equal(details.round.attemptId,second.attemptId);
  assert.equal(details.round.generation,2);
  assert.equal(details.round.usage.totalTokens,3);
  assert.equal(details.deliveryChecklist,null);
  assert.equal(details.attempts.length,2);
  assert.equal(details.attempts[0].deliveryChecklist.conclusion,'第一轮完成');
  assert.equal(details.attempts[1].deliveryChecklist,null);
  for(const attempt of details.attempts){
    assert.equal('handoff' in attempt,false,'default details must not rehydrate every round handoff');
    assert.equal('result' in attempt,false,'default details must not rehydrate every round reply');
    assert.equal(attempt.hasResult,true);
    assert.ok(attempt.resultChars>0);
  }
  assert.equal(details.round.result,'第二轮完成');
  assert.equal(details.round.resultTruncated,false);
  assert.match(details.gaps.join(' '),/本轮没有保存结构化交付清单/);
  assert.match(details.gaps.join(' '),/尚未登记负责人核验/);
  assert.equal(details.process,undefined);
  assert.equal(
    [...counts.keys()].filter(key=>!key.endsWith(task.id)).length,
    0,
    'details must not recover attempts from other tasks',
  );

  const page=await taskDetails(env.binding,{taskId:task.id,process:true,limit:2},{client,defaultWorkspace:env.workspace,isWorkerProcess:()=>true});
  assert.equal(page.process.generation,2);
  assert.equal(page.process.limit,2);
  assert.equal(page.process.afterSequence,0);
  assert.ok(page.process.events.length<=2);
  assert.equal(page.process.hasMore,true);
  assert.ok(page.process.nextSequence>0);

  const next=await taskDetails(env.binding,{taskId:task.id,process:true,after:page.process.nextSequence,limit:2},{client,defaultWorkspace:env.workspace,isWorkerProcess:()=>true});
  assert.equal(next.process.afterSequence,page.process.nextSequence);
  assert.equal(next.process.hasMore,false);
  assert.ok(next.process.events.some(event=>event.text==='retest again'));

  const firstRound=await taskDetails(env.binding,{taskId:task.id,attemptId:first.attemptId},{client,defaultWorkspace:env.workspace,isWorkerProcess:()=>true});
  assert.equal(firstRound.round.attemptId,first.attemptId);
  assert.equal(firstRound.deliveryChecklist.conclusion,'第一轮完成');
  assert.equal(firstRound.attempts.length,1);
  await assert.rejects(
    taskDetails(env.binding,{taskId:task.id,attemptId:'missing'},{client,defaultWorkspace:env.workspace,isWorkerProcess:()=>true}),
    error=>error.code==='SQUAD_ATTEMPT_MISSING',
  );
});

test('default details stays bounded when rounds carry long replies',async t=>{
  const env=await fixture(t);
  const task=await env.createTask('req-large-details');
  let run=await env.start(task,'req-large-details');
  const big='大段结论内容'.repeat(3000);
  await run.complete({result:big});
  for(let index=0;index<3;index+=1){run=await run.retry();await run.complete({result:big})}
  const {client}=counted(env.store);
  const details=await taskDetails(env.binding,{taskId:task.id},{client,defaultWorkspace:env.workspace,isWorkerProcess:()=>true});
  assert.equal(details.attempts.length,4);
  assert.equal(details.round.result.length,4000);
  assert.equal(details.round.resultTruncated,true);
  assert.equal(JSON.stringify(details).includes(big),false,'historical replies never leak into default details');
  assert.ok(Buffer.byteLength(JSON.stringify(details))<40000,'default details must stay small');
});

test('a failed round stays failed and carries the recorded failure receipt without retrying',async t=>{
  const env=await fixture(t);
  const task=await env.createTask('req-failed');
  const run=await env.start(task,'req-failed');
  const checklist={
    schemaVersion:1,source:'member_reported',available:true,conclusion:'' ,artifacts:[],checks:[],remaining:[],
    program:{source:'program_checked',artifacts:[],fingerprint:'d'.repeat(64),missing:[],outOfScope:[],unreadable:[]},
    gaps:[],
  };
  checklist.failure=buildFailureReceipt({checklist,status:'failed',error:'执行器未返回完成回执。',nativeSessionId:'native-failed'});
  await run.complete({status:'failed',error:'执行器未返回完成回执。',deliveryChecklist:checklist});

  const {client}=counted(env.store);
  const details=await taskDetails(env.binding,{taskId:task.id},{client,defaultWorkspace:env.workspace,isWorkerProcess:()=>true});
  assert.equal(details.status,'failed');
  assert.equal(details.round.status,'failed');
  assert.equal(details.failure.phase,'unconfirmed');
  assert.equal(details.failure.phaseConfirmed,false);
  assert.equal(details.failure.retryable,false);
  assert.equal(details.failure.autoRetry,false);
  assert.equal(details.failure.nativeSessionId,'native-failed');

  const before=await env.store.operate('work.execution.get',{workId:task.id,generation:1,limit:100});
  await waitForTasks(env.binding,{taskIds:[task.id],seconds:0},{client,defaultWorkspace:env.workspace,isWorkerProcess:()=>true});
  await taskDetails(env.binding,{taskId:task.id,process:true},{client,defaultWorkspace:env.workspace,isWorkerProcess:()=>true});
  const after=await env.store.operate('work.execution.get',{workId:task.id,generation:1,limit:100});
  assert.equal(after.highWaterSequence,before.highWaterSequence,'reads must never execute, verify or accept');
  assert.equal((await env.store.operate('work.get',{workId:task.id})).task.status,'blocked');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {createLocalStore} from '../cli/lib/local-store.mjs';
import {appendSquadEvent,finalizeAttempt,snapshot} from '../cli/lib/runtime.mjs';
import {inboxView,taskDetails,waitForTasks} from '../cli/lib/task-read.mjs';

const MESSAGE='报表筛选在空值边界下回退到了默认视图，已按范围修复并补充聚焦验证。'.repeat(8);

function metered(client){
  const counts={total:0,byOperation:{},byTask:{}};
  const bump=(operation,workId)=>{
    counts.total+=1;
    counts.byOperation[operation]=(counts.byOperation[operation]||0)+1;
    if(workId)counts.byTask[workId]=(counts.byTask[workId]||0)+1;
  };
  const proxy=new Proxy(client,{
    get(target,property){
      if(property==='operate')return async(operation,input,...rest)=>{
        bump(operation,input?.workId);
        return target.operate(operation,input,...rest);
      };
      const value=target[property];
      return typeof value==='function'?value.bind(target):value;
    },
  });
  return {counts,client:proxy};
}

async function buildFixture(t,{historyTasks=40,batchesPerRound=12,messagesPerBatch=4}={}){
  const root=await mkdtemp(join(tmpdir(),'squad-efficiency-'));
  const dataRoot=join(root,'data');
  const codexHome=join(root,'codex-home');
  const workspace=join(root,'workspace');
  await mkdir(workspace,{recursive:true});
  await mkdir(codexHome,{recursive:true});
  const store=createLocalStore({home:dataRoot,workspace});
  t.after(async()=>{
    try{store.close();}catch{}
    await rm(root,{recursive:true,force:true,maxRetries:3,retryDelay:50});
  });
  const project=(await store.operate('project.create',{name:'效率基线'})).project;
  const threadId=randomUUID();
  const parent=(await store.operate('work.create',{
    projectId:project.id,title:'效率基线父任务',status:'backlog',
    sourceType:'codex-squad',sourceRef:`squad:v2:${threadId}:parent`,
  })).task;
  const binding={schemaVersion:1,threadId,workspace,projectId:project.id,parentWorkId:parent.id,title:'效率基线',
    tasks:[],attempts:{},workers:{},reviews:{},retirements:{},createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
  const stats={attempts:0,batches:0};

  async function createTask(requestId,title='历史任务'){
    const task=(await store.operate('work.create',{
      projectId:project.id,title,status:'todo',sourceType:'codex-squad',
      sourceRef:`squad:v2:${threadId}:${encodeURIComponent(parent.id)}:implementer:${requestId}`,
    })).task;
    binding.tasks.push(task.id);
    return task;
  }
  async function begin(task,requestId){
    const scan=await store.reserveExecution({cardId:task.id});
    const {context}=await store.startExecution(scan.claims[0].claimKey);
    const attemptId=`att-${requestId}-${context.generation}`;
    let sequence=0;
    const append=async(type,payload)=>{
      await appendSquadEvent(store,{
        taskId:task.id,generation:context.generation,sessionId:context.activeSessionId,
        sequence:sequence+1,type,attemptId,payload:{attemptId,...payload},
      });
      sequence+=1;
    };
    const startedAt=new Date(Date.UTC(2026,0,1,0,0,context.generation)).toISOString();
    await append('SQUAD_ATTEMPT_STARTED',{
      index:context.generation,requestId,startedAt,
      handoff:{title:task.title,goal:'修复报表筛选',scope:['.'],criteria:['测试通过'],context:''},
    });
    const ref={attemptId,index:context.generation,generation:context.generation,requestId,startedAt,nativeSessionId:null};
    binding.attempts[task.id]=[...(binding.attempts[task.id]||[]),ref];
    stats.attempts+=1;
    return {
      task,attemptId,generation:context.generation,sequence:()=>sequence,append,
      async batches(count,label){
        for(let batch=0;batch<count;batch+=1){
          const events=[];
          for(let index=0;index<messagesPerBatch;index+=1){
            events.push({
              schemaVersion:'agent-bridge.conversation/v1',
              type:'MESSAGE_APPEND',operation:'APPEND',
              entityId:`${label}-${batch}-${index}`,entityRevision:1,
              occurredAt:new Date(Date.UTC(2026,0,1,0,batch,index)).toISOString(),
              payload:{content:MESSAGE,role:'assistant'},
            });
          }
          stats.batches+=1;
          await append('SQUAD_CONVERSATION_BATCH',{events});
        }
      },
      async complete(){
        await this.batches(batchesPerRound,attemptId);
        await append('SQUAD_ATTEMPT_COMPLETED',{
          status:'completed',endedAt:'2026-01-01T00:10:00.000Z',nativeSessionId:'native-1',
          usage:{inputTokens:10,outputTokens:5,totalTokens:15},result:'本轮完成',
        });
        await finalizeAttempt(store,{
          taskId:task.id,generation:context.generation,storeInstanceId:store.ready(),executor:'qoder',
          sessionId:context.activeSessionId,eventKind:'idle_success',eventSequence:sequence,
          outcomeSummary:'本轮完成',
        });
      },
    };
  }

  const historical=[];
  for(let index=0;index<historyTasks;index+=1){
    const task=await createTask(`history-${index}`,`历史任务 ${index}`);
    const run=await begin(task,`history-${index}`);
    await run.complete();
    historical.push(task);
  }
  const target=await createTask('target','目标任务');
  const first=await begin(target,'target');
  await first.complete();
  await store.operate('work.update',{workId:target.id,status:'todo'});
  const second=await begin(target,'target-next');
  await second.batches(4,'target-second');
  await second.complete();
  const running=await createTask('churn','运行中的无关任务');
  const churn=await begin(running,'churn');
  await churn.batches(2,'churn');

  await mkdir(join(dataRoot,'bindings'),{recursive:true,mode:0o700});
  await writeFile(join(dataRoot,'bindings',`${threadId}.json`),JSON.stringify(binding));
  const options={
    client:store,env:{...process.env,PLUGIN_DATA:dataRoot},codexHome,
    defaultWorkspace:workspace,isWorkerProcess:()=>false,
  };
  return {root,dataRoot,workspace,store,threadId,binding,options,target,historical,running,churn,stats,startedAt:performance.now()};
}

function bytes(value){return Buffer.byteLength(JSON.stringify(value));}
function idsNot(counts,allowed){return Object.keys(counts.byTask).filter(id=>id!==allowed);}

test('large history reads: old snapshot vs terminal wait, details and inbox',async t=>{
  const env=await buildFixture(t);
  const beforeMeter=metered(env.store);
  const beforeStart=performance.now();
  const before=await snapshot(env.binding,{...env.options,client:beforeMeter.client});
  const beforeMs=performance.now()-beforeStart;
  const beforeBytes=bytes(before);
  assert.equal(before.tasks.length,env.binding.tasks.length);
  assert.ok(beforeBytes>200000,`expected a large historical payload, got ${beforeBytes}`);
  assert.equal(beforeMeter.counts.byOperation['work.execution.get'],env.binding.tasks.length+1);
  assert.equal(beforeMeter.counts.byOperation['work.execution.digest']||0,0);

  const waitMeter=metered(env.store);
  const waitStart=performance.now();
  const waited=await waitForTasks(env.binding,{taskIds:[env.target.id],seconds:0},{...env.options,client:waitMeter.client});
  const waitMs=performance.now()-waitStart;
  const waitBytes=bytes(waited);
  assert.deepEqual(waited.tasks.map(item=>item.id),[env.target.id]);
  assert.equal(waitMeter.counts.byOperation['work.execution.get']||0,0,'wait never reads a full conversation');
  assert.equal(waitMeter.counts.byOperation['work.execution.digest'],1);
  assert.deepEqual(idsNot(waitMeter.counts,env.target.id),[],'target wait must not read other tasks');

  const detailsMeter=metered(env.store);
  const detailsStart=performance.now();
  const details=await taskDetails(env.binding,{taskId:env.target.id},{...env.options,client:detailsMeter.client});
  const detailsMs=performance.now()-detailsStart;
  const detailsBytes=bytes(details);
  assert.equal(details.round.attemptId,env.binding.attempts[env.target.id].at(-1).attemptId);
  assert.equal(details.round.result,'本轮完成');
  assert.equal(details.attempts.length,2);
  assert.ok(details.attempts.every(item=>!('handoff' in item)&&!('result' in item)),'default details never rehydrate every round handoff or reply');
  assert.ok(detailsBytes<20000,`default details ${detailsBytes} must stay small`);
  assert.equal(detailsMeter.counts.byOperation['work.execution.get']||0,0);
  assert.equal(detailsMeter.counts.byOperation['work.execution.digest'],2,'only the two target rounds');
  assert.deepEqual(idsNot(detailsMeter.counts,env.target.id),[]);

  const processMeter=metered(env.store);
  const paginated=await taskDetails(env.binding,{taskId:env.target.id,process:true,limit:10},{...env.options,client:processMeter.client});
  assert.equal(processMeter.counts.byOperation['work.execution.get'],1);
  assert.deepEqual(idsNot(processMeter.counts,env.target.id),[]);
  assert.equal(paginated.process.limit,10);
  assert.equal(paginated.process.hasMore,true);
  assert.ok(paginated.process.nextSequence>0);
  assert.ok(bytes(paginated.process)<200000);

  const inboxMeter=metered(env.store);
  const inboxStart=performance.now();
  const inbox=await inboxView(env.binding,{...env.options,client:inboxMeter.client});
  const inboxMs=performance.now()-inboxStart;
  const inboxBytes=bytes(inbox);
  assert.equal(inboxMeter.counts.byOperation['work.execution.get']||0,0,'inbox never hydrates full conversations');
  assert.equal(inbox.count,env.binding.tasks.length-1,'the running task is not a returned item');
  assert.ok(inboxBytes<beforeBytes/4,`inbox ${inboxBytes} should stay far below the full snapshot ${beforeBytes}`);

  const evidence={
    schemaVersion:1,
    command:'SQUAD_EFFICIENCY_ARTIFACT=<path> node --test test/efficiency.test.mjs',
    fixture:{
      tasks:env.binding.tasks.length,
      attempts:env.stats.attempts,
      conversationBatches:env.stats.batches,
      messageChars:MESSAGE.length,
    },
    before:{operation:'runtime snapshot (full read contract)',ms:Number(beforeMs.toFixed(2)),returnedBytes:beforeBytes,
      fullConversationReads:beforeMeter.counts.byOperation['work.execution.get'],reads:beforeMeter.counts.byOperation},
    after:{
      wait:{operation:'waitForTasks target only, seconds=0',ms:Number(waitMs.toFixed(2)),returnedBytes:waitBytes,reads:waitMeter.counts.byOperation},
      details:{operation:'taskDetails current round',ms:Number(detailsMs.toFixed(2)),returnedBytes:detailsBytes,reads:detailsMeter.counts.byOperation},
      inbox:{operation:'inboxView lightweight summary',ms:Number(inboxMs.toFixed(2)),returnedBytes:inboxBytes,reads:inboxMeter.counts.byOperation},
      process:{operation:'taskDetails process page limit=10',returnedBytes:bytes(paginated.process),reads:processMeter.counts.byOperation},
    },
    unrelatedHistoryReads:{wait:idsNot(waitMeter.counts,env.target.id),details:idsNot(detailsMeter.counts,env.target.id),process:idsNot(processMeter.counts,env.target.id)},
    observedAt:new Date().toISOString(),
  };
  if(process.env.SQUAD_EFFICIENCY_ARTIFACT){
    await writeFile(process.env.SQUAD_EFFICIENCY_ARTIFACT,`${JSON.stringify(evidence,null,2)}\n`);
  }
  t.diagnostic(JSON.stringify(evidence,null,2));
});

test('unrelated running-task progress never wakes a target wait and never gets read',async t=>{
  const env=await buildFixture(t,{historyTasks:8,batchesPerRound:4});
  const {counts,client}=metered(env.store);
  const options={...env.options,client};
  const baseline=await waitForTasks(env.binding,{taskIds:[env.target.id],seconds:0},options);
  assert.equal(baseline.changed,false);
  counts.total=0;
  counts.byOperation={};
  counts.byTask={};
  let sleeps=0;
  const view=await waitForTasks(env.binding,{taskIds:[env.target.id],seconds:1,after:baseline.cursor},{
    ...options,
    sleep:async()=>{
      sleeps+=1;
      if(sleeps===1){
        await env.churn.batches(3,'churn-more');
        await env.churn.append('SQUAD_ATTEMPT_EVENT',{eventId:'churn-tool',kind:'tool',text:'churn tool output'});
      }
      await new Promise(resolve=>setTimeout(resolve,25));
    },
  });
  assert.equal(view.changed,false);
  assert.equal(view.tasks[0].id,env.target.id);
  assert.deepEqual(idsNot(counts,env.target.id),[],'the churn task is never hydrated by a scoped wait');
  assert.equal(counts.byOperation['work.execution.get']||0,0);
});

test('waiting for a large history target stays bounded and returns a compact state',async t=>{
  const env=await buildFixture(t,{historyTasks:24,batchesPerRound:10});
  const {client}=metered(env.store);
  const options={...env.options,client};
  const view=await waitForTasks(env.binding,{taskIds:[env.target.id],seconds:0},options);
  const payload=bytes(view);
  assert.ok(payload<30000,`compact task state should stay under 30KB, got ${payload}`);
  assert.equal(view.tasks[0].attempts,2);
  assert.equal(view.tasks[0].latest.status,'completed');
  assert.equal(view.tasks[0].latest.result,'本轮完成');
  assert.equal(view.tasks[0].latest.deliveryChecklist,null);
  assert.equal(JSON.stringify(view).includes(MESSAGE.slice(0,20)),false,'history text never leaks into the wait receipt');
  const details=await taskDetails(env.binding,{taskId:env.target.id},{...options});
  assert.equal(details.round.attemptId,env.binding.attempts[env.target.id].at(-1).attemptId);
  assert.match(details.gaps.join(' '),/本轮没有保存结构化交付清单/);
});

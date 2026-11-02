import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm,writeFile,unlink} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {
  acceptTask,appendSquadEvent,bindCurrent,continueTask,dispatch,finalizeAttempt,
  readBinding,removeWorkspaceWrite,retireTask,snapshot,updateBinding,verifyTask,
} from '../cli/lib/runtime.mjs';
import {HISTORY_LANE,countCards,filterCards,taskCard} from '../cli/ui/board-model.mjs';

function clone(value){return structuredClone(value);}
function fakeStore(workspace){
  const state={projects:new Map(),tasks:new Map(),executions:new Map(),claims:new Map(),sequences:new Set(),instanceId:'instance-test'};
  let nextTask=0;
  const execution=(taskId,generation)=>{
    const key=`${taskId}:${generation}`;
    if(!state.executions.has(key))state.executions.set(key,{generation,events:[],highWaterSequence:0,activeSessionId:null});
    return state.executions.get(key);
  };
  const bump=task=>{task.version=Number(task.version||0)+1;};
  const taskOf=id=>{
    const task=state.tasks.get(id);
    if(!task)throw Object.assign(new Error(`Task '${id}' not found`),{code:'TASK_NOT_FOUND'});
    return task;
  };
  return {
    state,
    async operate(operation,input={}){
      if(operation==='project.create'){
        if(!state.projects.has('project-1'))state.projects.set('project-1',{id:'project-1',name:input.name});
        return {project:clone(state.projects.get('project-1'))};
      }
      if(operation==='work.create'){
        const existing=[...state.tasks.values()].find(task=>task.harness.sourceType===input.sourceType&&task.harness.sourceRef===input.sourceRef);
        if(existing)return {task:clone(existing)};
        const id=`task-${++nextTask}`;
        const task={
          id,projectId:input.projectId,title:input.title,description:input.description,status:input.status||'backlog',version:1,
          harness:{sourceType:input.sourceType,sourceRef:input.sourceRef,activeGeneration:0,activeSessionId:null,worktreePath:workspace,blocker:null},
        };
        state.tasks.set(id,task);
        return {task:clone(task)};
      }
      if(operation==='work.get')return {task:clone(taskOf(input.workId))};
      if(operation==='work.find'){
        const task=[...state.tasks.values()].find(item=>item.harness.sourceType===input.sourceType&&item.harness.sourceRef===input.sourceRef);
        return {task:task?clone(task):null};
      }
      if(operation==='work.update'){
        const task=taskOf(input.workId);
        if(input.expectedVersion!==undefined&&Number(input.expectedVersion)!==task.version)throw Object.assign(new Error('conflict'),{code:'TASK_VERSION_CONFLICT'});
        if(input.status)task.status=input.status;
        bump(task);
        return {task:clone(task)};
      }
      if(operation==='work.agent.save')return {task:clone(taskOf(input.workId))};
      if(operation==='work.execution.get'||operation==='work.execution.digest'){
        const task=taskOf(input.workId);
        if(Number(input.generation)>Number(task.harness.activeGeneration))throw Object.assign(new Error('stale generation'),{code:'EXECUTION_GENERATION_STALE'});
        const found=execution(input.workId,Number(input.generation));
        const events=clone(found.events);
        return {events:operation==='work.execution.digest'?events.map((event,index)=>({sequence:index+1,event})):events,highWaterSequence:found.highWaterSequence,activeSessionId:found.activeSessionId,generation:found.generation};
      }
      throw new Error(`unexpected operation ${operation}`);
    },
    async reserveExecution(input={}){
      const task=state.tasks.get(input.cardId);
      if(!task||task.status!=='todo')return {claims:[],skipped:[{cardId:input.cardId,reason:'not_ready'}]};
      const generation=Number(task.harness.activeGeneration)+1;
      const claimKey=`${task.id}:${generation}`;
      state.claims.set(claimKey,{cardId:task.id,generation});
      return {claims:[{claimKey,cardId:task.id}]};
    },
    async startExecution(claimKey){
      const claim=state.claims.get(claimKey);
      if(!claim)throw new Error('unknown claim');
      const task=taskOf(claim.cardId);
      task.status='in_progress';
      task.harness.activeGeneration=claim.generation;
      task.harness.activeSessionId=task.harness.activeSessionId||`session-${task.id}-1`;
      bump(task);
      const found=execution(task.id,claim.generation);
      found.activeSessionId=task.harness.activeSessionId;
      return {context:{version:1,storeInstanceId:state.instanceId,cardId:task.id,generation:claim.generation,activeSessionId:found.activeSessionId,worktreePath:workspace}};
    },
    async failExecution(claimKey,error){
      const claim=state.claims.get(claimKey);
      const task=claim?state.tasks.get(claim.cardId):null;
      if(task){task.status='blocked';task.harness.blocker={summary:String(error||'failed')};bump(task);}
      return {ok:true};
    },
    async appendExecutionEvent(taskId,input={}){
      const task=taskOf(taskId);
      if(Number(input.generation)!==task.harness.activeGeneration)throw Object.assign(new Error('stale generation'),{code:'EXECUTION_GENERATION_STALE'});
      const found=execution(taskId,Number(input.generation));
      const identity=`${input.sessionId}:${input.sequence}`;
      if(state.sequences.has(identity))return {accepted:true,eventId:input.event.eventId};
      state.sequences.add(identity);
      found.events.push(clone(input.event));
      found.highWaterSequence=Math.max(found.highWaterSequence,Number(input.sequence));
      found.activeSessionId=input.sessionId;
      task.harness.activeSessionId=input.sessionId;
      if(input.nativeSessionId)task.harness.nativeSessionId=input.nativeSessionId;
      bump(task);
      return {accepted:true,eventId:input.event.eventId};
    },
    async applyExecutionOutcome(context,event={}){
      const task=taskOf(context.cardId);
      if(Number(context.generation)!==task.harness.activeGeneration)throw Object.assign(new Error('stale generation'),{code:'EXECUTION_GENERATION_STALE'});
      if(event.eventKind==='idle_success')task.status='in_review';
      else{task.status='blocked';task.harness.blocker={summary:event.errorSummary||'failed'};}
      bump(task);
      return {applied:true};
    },
  };
}

async function makeSquad(t){
  const dir=await mkdtemp(join(tmpdir(),'codex-squad-closeout-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const ws=join(dir,'workspace');
  await mkdir(ws,{recursive:true});
  const client=fakeStore(ws);
  const live=new Set(),jobs=[],workerPids=new Map();
  let nextPid=6200;
  const threadId=randomUUID();
  const env={...process.env,CODEX_THREAD_ID:threadId,PLUGIN_DATA:dir};
  const options={
    env,client,machineFingerprint:'machine-test',
    verifyHost:async()=>({}),verifyModel:async()=>({modelId:'verified'}),
    startWorker:async job=>{jobs.push(job);const pid=nextPid++;live.add(pid);workerPids.set(job.taskId,pid);return {pid};},
    isWorkerProcess:pid=>live.has(Number(pid)),
    terminate:pid=>{live.delete(Number(pid));},
    sleep:async()=>{await new Promise(resolve=>setTimeout(resolve,0));},
    stopTimeoutMs:1000,
  };
  const binding=await bindCurrent({...options,cwd:ws});
  return {dir,ws,client,live,jobs,workerPids,threadId,env,options,binding};
}

function handoff(requestId,overrides={}){
  return {
    requestId,memberId:'implementer',title:'核验闭环任务',goal:'完成候选并给出证据',
    scope:['src/feature.ts','只处理当前问题'],criteria:['npm test 通过','给出实际输出'],
    context:'已确认目标与范围。',...overrides,
  };
}

async function finish(squad,result,{status='completed',usage=null,nativeSessionId=null,text=null,error=null}={}){
  const task=squad.client.state.tasks.get(result.taskId);
  const generation=Number(task.harness.activeGeneration);
  const found=squad.client.state.executions.get(`${result.taskId}:${generation}`);
  const sequence=found.highWaterSequence+1;
  await appendSquadEvent(squad.client,{
    taskId:result.taskId,generation,sessionId:found.activeSessionId,sequence,type:'SQUAD_ATTEMPT_COMPLETED',attemptId:result.attemptId,
    payload:{attemptId:result.attemptId,status,endedAt:new Date().toISOString(),nativeSessionId,usage,result:status==='completed'?text:null,error,actualModel:null},
  });
  await finalizeAttempt(squad.client,{
    taskId:result.taskId,generation,storeInstanceId:'instance-test',executor:'qoder',sessionId:found.activeSessionId,
    eventKind:status==='completed'?'idle_success':'failed',eventSequence:sequence,errorSummary:error||undefined,
  });
  const pid=squad.workerPids.get(result.taskId);
  if(pid)squad.live.delete(pid);
  await removeWorkspaceWrite({workspace:squad.ws,threadId:squad.threadId,taskId:result.taskId,attemptId:result.attemptId},{env:squad.env});
}

async function cardOf(squad,id,connected=true){
  const view=await snapshot(squad.binding,squad.options);
  const index=view.tasks.findIndex(task=>task.id===id);
  assert.notEqual(index,-1);
  return {view,card:taskCard(view.tasks[index],index,connected)};
}

test('verified work keeps its historical acceptance after the candidate changes',async t=>{
  const squad=await makeSquad(t);
  await writeFile(join(squad.ws,'candidate.ts'),'version-one');
  const result=await dispatch(handoff('closeout-accept'),squad.options);
  await finish(squad,result,{nativeSessionId:'native-closeout',text:'候选已完成'});

  let {view,card}=await cardOf(squad,result.taskId);
  assert.equal(card.lane,'col-review');
  assert.equal(card.status,'waiting');
  assert.equal(card.progress,'待核验');
  assert.equal(view.inbox.pending[0].taskId,result.taskId);

  await verifyTask({taskId:result.taskId},squad.options);
  ({card}=await cardOf(squad,result.taskId));
  assert.equal(card.lane,'col-review');
  assert.equal(card.status,'verifying');
  assert.equal(card.progress,'Codex核验中');

  const accepted=await acceptTask({taskId:result.taskId,files:['candidate.ts'],note:'负责人已运行测试并核对产物'},squad.options);
  ({view,card}=await cardOf(squad,result.taskId));
  assert.equal(card.lane,'col-completed');
  assert.equal(card.status,'accepted');
  assert.equal(card.progress,'已完成');
  assert.equal(view.tasks[0].acceptance.changedSinceVerification,false);
  assert.equal(view.inbox.count,0);

  await writeFile(join(squad.ws,'candidate.ts'),'version-two');
  ({view,card}=await cardOf(squad,result.taskId));
  assert.equal(card.lane,'col-completed','a later change never moves verified work back to review');
  assert.equal(card.status,'accepted');
  assert.equal(card.progress,'已完成 · 核验后已有变更');
  assert.equal(view.tasks[0].acceptance.changedSinceVerification,true);
  assert.equal(view.tasks[0].acceptance.fingerprint,accepted.acceptance.fingerprint);
  assert.equal(view.tasks[0].verification.attemptId,result.attemptId);
  assert.equal(countCards([card])['col-completed'],1);

  await unlink(join(squad.ws,'candidate.ts'));
  ({card}=await cardOf(squad,result.taskId));
  assert.equal(card.lane,'col-completed');
  assert.equal(card.progress,'已完成 · 核验后已有变更');
});

test('a rework waits for verification again without losing the previous round records',async t=>{
  const squad=await makeSquad(t);
  await writeFile(join(squad.ws,'candidate.ts'),'round-one');
  const first=await dispatch(handoff('closeout-round-one'),squad.options);
  await finish(squad,first,{nativeSessionId:'native-round',text:'首轮完成'});
  await verifyTask({taskId:first.taskId},squad.options);
  const firstAcceptance=await acceptTask({taskId:first.taskId,files:['candidate.ts'],note:'首轮已核对'},squad.options);

  const second=await continueTask({taskId:first.taskId,requestId:'closeout-round-two',goal:'处理评审意见',scope:['src/feature.ts'],criteria:['回归通过']},squad.options);
  let {view,card}=await cardOf(squad,first.taskId);
  assert.equal(card.lane,'col-running');
  assert.equal(view.tasks[0].acceptance,null);
  assert.equal(view.tasks[0].attempts[0].acceptance.fingerprint,firstAcceptance.acceptance.fingerprint);
  assert.equal(view.inbox.count,0);

  await finish(squad,second,{nativeSessionId:'native-round',text:'返工完成'});
  ({view,card}=await cardOf(squad,first.taskId));
  assert.equal(card.lane,'col-review');
  assert.equal(card.status,'waiting');
  assert.equal(view.inbox.pending[0].attemptId,second.attemptId);
  assert.equal(view.tasks[0].attempts[0].acceptance.note,'首轮已核对');
  assert.equal(view.tasks[0].attempts[0].verification.at!==undefined,true);
  assert.equal(view.tasks[0].attempts[1].verification,undefined);

  await verifyTask({taskId:first.taskId},squad.options);
  const secondAcceptance=await acceptTask({taskId:first.taskId,files:['candidate.ts'],note:'返工已核对'},squad.options);
  ({view,card}=await cardOf(squad,first.taskId));
  assert.equal(card.lane,'col-completed');
  assert.equal(view.tasks[0].attempts[0].acceptance.fingerprint,firstAcceptance.acceptance.fingerprint);
  assert.equal(view.tasks[0].attempts[1].acceptance.fingerprint,secondAcceptance.acceptance.fingerprint);
  assert.equal(view.tasks[0].attempts[0].acceptance.attemptId,first.attemptId);
  assert.equal(view.tasks[0].attempts[1].acceptance.attemptId,second.attemptId);
  assert.equal(view.tasks[0].attempts[0].acceptance.note,'首轮已核对');
  assert.equal(view.tasks[0].attempts[1].acceptance.note,'返工已核对');
  assert.equal(second.taskId,first.taskId);
});

test('stop then retire moves work into searchable history instead of completed',async t=>{
  const squad=await makeSquad(t);
  const running=await dispatch(handoff('closeout-cancel'),squad.options);
  await assert.rejects(retireTask({taskId:running.taskId,outcome:'cancelled',reason:'需求撤回'},squad.options),error=>error.code==='SQUAD_TASK_RUNNING');
  await finish(squad,running,{status:'stopped',error:'已按请求停止。'});
  await retireTask({taskId:running.taskId,outcome:'cancelled',reason:'用户撤回需求'},squad.options);

  let {view,card}=await cardOf(squad,running.taskId);
  assert.equal(card.lane,HISTORY_LANE);
  assert.equal(card.history,true);
  assert.equal(card.live,false);
  assert.equal(card.progress,'已取消 · 用户撤回需求');
  assert.deepEqual(filterCards([card],'用户撤回需求').map(item=>item.task.id),[running.taskId]);
  assert.equal(countCards([card])['col-completed'],0);

  const replace=await dispatch(handoff('closeout-supersede',{writePaths:['src/replaced.ts']}),squad.options);
  await finish(squad,replace,{status:'failed',error:'实现方向不可行'});
  await retireTask({taskId:replace.taskId,outcome:'superseded',reason:'范围调整',replacedBy:'方案 B'},squad.options);
  ({view,card}=await cardOf(squad,replace.taskId));
  assert.equal(card.lane,HISTORY_LANE);
  assert.equal(card.status,'superseded');
  assert.equal(card.progress,'已被替代 · 方案 B');
  assert.deepEqual(filterCards([card],'方案 B').map(item=>item.task.id),[replace.taskId]);
  assert.equal(view.inbox.count,0);
});

test('a legacy done state without records waits for review instead of being guessed accepted',async t=>{
  const squad=await makeSquad(t);
  const legacyId='task-legacy';
  squad.client.state.tasks.set(legacyId,{
    id:legacyId,projectId:squad.binding.projectId,title:'历史完成但无记录',status:'done',version:1,
    harness:{
      sourceType:'codex-squad',
      sourceRef:`squad:v2:${squad.threadId}:${encodeURIComponent(squad.binding.parentWorkId)}:implementer:legacy-record`,
      activeGeneration:0,activeSessionId:null,worktreePath:squad.ws,blocker:null,
    },
  });
  await updateBinding(squad.threadId,binding=>{binding.tasks.push(legacyId)},squad.options);

  const {view,card}=await cardOf(squad,legacyId);
  assert.equal(card.lane,'col-review');
  assert.equal(card.status,'awaiting_record');
  assert.equal(card.progress,'待核对');
  assert.equal(view.inbox.pending[0].taskId,legacyId);
  assert.equal(view.inbox.pending[0].recordMissing,true);
  assert.equal(view.tasks[0].acceptance,null);
  assert.equal(view.tasks[0].verification,null);
  await assert.rejects(verifyTask({taskId:legacyId},squad.options),error=>error.code==='SQUAD_VERIFICATION_NOT_READY');
  await assert.rejects(acceptTask({taskId:legacyId,files:['candidate.ts']},squad.options),error=>error.code==='SQUAD_ACCEPTANCE_NOT_READY');

  const acceptedId='task-legacy-accepted';
  squad.client.state.tasks.set(acceptedId,{
    ...structuredClone(squad.client.state.tasks.get(legacyId)),
    id:acceptedId,status:'accepted',
    harness:{...structuredClone(squad.client.state.tasks.get(legacyId).harness),sourceRef:`squad:v2:${squad.threadId}:${encodeURIComponent(squad.binding.parentWorkId)}:implementer:legacy-accepted`},
  });
  await updateBinding(squad.threadId,binding=>{binding.tasks.push(acceptedId)},squad.options);
  const acceptedCard=(await cardOf(squad,acceptedId)).card;
  assert.equal(acceptedCard.lane,'col-review');
  assert.equal(acceptedCard.status,'awaiting_record');
});

test('a disconnected read keeps the confirmed round and only real receipts move it',async t=>{
  const squad=await makeSquad(t);
  const result=await dispatch(handoff('closeout-disconnect'),squad.options);
  await finish(squad,result,{nativeSessionId:'native-disconnect',text:'已完成'});
  const view=await snapshot(squad.binding,squad.options);
  const task=view.tasks[0];
  const offline=taskCard(task,0,false);
  assert.equal(offline.lane,'col-review');
  assert.equal(offline.status,'waiting');
  assert.equal(offline.active,false);
  assert.doesNotMatch(offline.progress,/恢复中|暂未更新/);

  await verifyTask({taskId:result.taskId},squad.options);
  const online=taskCard((await snapshot(squad.binding,squad.options)).tasks[0],0,true);
  assert.equal(online.status,'verifying');
  assert.equal(online.lane,'col-review');
  const offlineAfterVerify=taskCard((await snapshot(squad.binding,squad.options)).tasks[0],0,false);
  assert.equal(offlineAfterVerify.status,'verifying');
  assert.doesNotMatch(offlineAfterVerify.progress,/恢复中/);
});

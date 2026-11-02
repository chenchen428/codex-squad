import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {
  acceptanceFrom,attemptView,memberFromTask,ownedTask,refFromEvents,stopView,taskStatusView,workerAlive,
} from './runtime.mjs';
import {inboxOf} from './task-lifecycle.mjs';
import {inspectAcceptance} from './evidence.mjs';
import {buildFailureReceipt} from './handover.mjs';

const terminalAttemptStatuses=new Set(['completed','failed','stopped','interrupted']);
const terminalTaskStatuses=new Set(['failed','stopped','interrupted','blocked','accepted','done']);
const reviewStatuses=new Set(['in_review','completed','done','accepted','waiting_review']);
const CURSOR_PREFIX='squad-wait-v1.';

function digest(value){return createHash('sha256').update(String(value)).digest('hex');}
function text(value){return typeof value==='string'?value.trim():'';}
function clip(value,max){const current=String(value??'');return current.length>max?current.slice(0,max):current;}
function requestError(code,message,details){return Object.assign(new Error(message),{code,...(details||{})});}
function eventsOf(digestValue){return (digestValue?.events||[]).map(item=>item?.event||item).filter(Boolean);}
function byAttempt(left,right){return (Number(left.index)||0)-(Number(right.index)||0)||(Number(left.generation)||0)-(Number(right.generation)||0)}
function normalizeRefs(binding,taskId){
  return (binding.attempts?.[taskId]||[]).filter(ref=>ref?.attemptId).slice().sort(byAttempt);
}
function hostTurnOf(worker){
  return worker?.hostTurn?{state:worker.hostTurn.state||'unverified',turnId:worker.hostTurn.turnId||null,watch:worker.hostWatch||null}:null;
}
function latestDigestEvent(digestValue,type,attemptId){
  return [...eventsOf(digestValue)].reverse().find(event=>event?.type===type&&(!attemptId||String(event.payload?.attemptId||'')===attemptId))||null;
}

function completionChecklist(digestValue,attemptId){
  const completed=latestDigestEvent(digestValue,'SQUAD_ATTEMPT_COMPLETED',attemptId);
  return completed?.payload?.deliveryChecklist||null;
}

export async function readTaskDigest(client,taskId,generation,options={}){
  if(!Number.isSafeInteger(Number(generation))||Number(generation)<1)return null;
  return client.operate('work.execution.digest',{workId:taskId,generation:Number(generation)},{actor:options.actor,defaultWorkspace:options.defaultWorkspace});
}

export async function readTaskFacts(binding,taskId,client,options={}){
  const task=options.task||await ownedTask(binding,taskId,client,options);
  const generation=Number(task.harness?.activeGeneration||0);
  const readDigest=options.digest!==false;
  const digestValue=readDigest?await readTaskDigest(client,taskId,generation,options):null;
  const events=eventsOf(digestValue);
  const refs=normalizeRefs(binding,taskId);
  let latest=refs.at(-1)||null;
  const recovered=refFromEvents(events,generation);
  if(recovered&&(!latest||Number(recovered.index)>=Number(latest.index))){
    latest={...recovered,...(latest&&latest.attemptId===recovered.attemptId?{worker:latest.worker}:{})};
  }
  if(latest&&!refs.some(ref=>ref.attemptId===latest.attemptId))refs.push(latest);
  refs.sort(byAttempt);
  const member=memberFromTask(binding,task)?.member||null;
  const worker=binding.workers?.[taskId]||latest?.worker||null;
  const alive=worker?await workerAlive(worker,options):false;
  const attempt=latest?attemptView(latest,{events},task,member,worker,alive,true,{publicEvents:[]}):null;
  if(attempt)attempt.deliveryChecklist=completionChecklist(digestValue,attempt.id);
  const acceptance=latest?acceptanceFrom({events}):null;
  const verification=binding.reviews?.[taskId]?.[latest?.attemptId]||null;
  const retirement=binding.retirements?.[taskId]||null;
  const status=taskStatusView(task,attempt?[attempt]:[],worker,alive);
  return {
    task,generation,digest:digestValue,events,refs,attempt,worker,alive,status,acceptance,verification,retirement,
    stop:stopView(worker,attempt?.status||null),hostTurn:hostTurnOf(worker),
    memberId:member?.id||'implementer',reason:text(task.harness?.blocker?.summary)||text(task.harness?.blocker?.title)||null,
  };
}

function wakeKey(facts){
  if(facts.retirement)return `retirement:${facts.retirement.outcome||'retired'}:${facts.retirement.at||''}`;
  const latest=facts.attempt;
  if(latest&&terminalAttemptStatuses.has(latest.status))return `terminal:${latest.id}:${latest.status}:${latest.endedAt||''}`;
  if(terminalTaskStatuses.has(facts.status))return `task:${facts.status}`;
  return null;
}

function encodeCursor(threadId,taskIds,signatures){
  return `${CURSOR_PREFIX}${Buffer.from(JSON.stringify({threadId,ids:taskIds,signatures})).toString('base64url')}`;
}
function decodeCursor(value){
  const raw=String(value||'');
  if(!raw)return null;
  if(!raw.startsWith(CURSOR_PREFIX))throw requestError('SQUAD_WAIT_CURSOR_INVALID','wait 的 after 只接受 wait 自身返回的游标。');
  try{
    const parsed=JSON.parse(Buffer.from(raw.slice(CURSOR_PREFIX.length),'base64url').toString('utf8'));
    if(!parsed||typeof parsed.threadId!=='string'||!Array.isArray(parsed.ids)||!parsed.signatures||typeof parsed.signatures!=='object')throw new Error('shape');
    return parsed;
  }catch{
    throw requestError('SQUAD_WAIT_CURSOR_INVALID','wait 游标无法解析。');
  }
}
function normalizeTaskIds(binding,value,cursor){
  if(value!==undefined&&(!Array.isArray(value)||value.length===0||value.length>100||value.some(item=>typeof item!=='string'||!item.trim()))){
    throw requestError('SQUAD_INPUT_INVALID','taskIds 必须是非空任务 ID 数组（最多 100 项）。');
  }
  const requested=value===undefined?null:value.map(item=>item.trim());
  if(cursor&&requested){
    const left=[...new Set(requested)].sort(),right=[...new Set(cursor.ids)].sort();
    if(left.length!==right.length||left.some((item,index)=>item!==right[index]))throw requestError('SQUAD_WAIT_TASK_MISMATCH','after 游标属于另一组任务，不能混用。');
  }
  const taskIds=requested||cursor?.ids||binding.tasks.slice();
  for(const taskId of taskIds)if(!binding.tasks.includes(taskId))throw requestError('SQUAD_BINDING_TASK_MISMATCH','等待的任务不属于当前会话的小队。');
  return taskIds;
}

function checklistCounts(checks){
  return (checks||[]).reduce((counts,check)=>{counts[check.status]=(counts[check.status]||0)+1;return counts;},{});
}
function checklistSummary(checklist){
  if(!checklist)return null;
  return {
    available:Boolean(checklist.available),
    ...(checklist.reason?{reason:checklist.reason}:{}),
    conclusion:typeof checklist.conclusion==='string'?clip(checklist.conclusion,500):null,
    artifacts:(checklist.program?.artifacts||[]).length,
    checks:checklistCounts(checklist.checks),
    remaining:(checklist.remaining||[]).length,
    gaps:(checklist.gaps||[]).slice(0,10),
    missing:(checklist.program?.missing||[]).slice(0,10),
    checksWithoutEvidence:(checklist.checksWithoutEvidence||[]).slice(0,10).map(item=>item?.name??String(item)),
  };
}
function attemptSummary(attempt,ref){
  return {
    id:attempt.id,index:attempt.index,generation:Number(ref.generation),requestId:ref.requestId||null,
    status:attempt.status,startedAt:attempt.startedAt,endedAt:attempt.endedAt,sessionId:attempt.sessionId,
    model:attempt.model,actualModel:attempt.actualModel,usage:attempt.usage,error:attempt.error,
    resumedFrom:ref.resumedFrom||attempt.resumedFrom||null,
    deliveryChecklist:attempt.deliveryChecklist||null,
    hasResult:typeof attempt.result==='string'&&attempt.result.length>0,
    resultChars:typeof attempt.result==='string'?attempt.result.length:0,
    ...(attempt.verification?{verification:attempt.verification}:{}),
    ...(attempt.acceptance?{acceptance:attempt.acceptance}:{}),
  };
}

function compactFacts(facts){
  const latest=facts.attempt;
  const result=typeof latest?.result==='string'?latest.result:null;
  return {
    id:facts.task.id,title:String(facts.task.title||''),memberId:facts.memberId,status:facts.status,reason:facts.reason,
    attempts:facts.refs.length,acceptance:facts.acceptance,verification:facts.verification,retirement:facts.retirement,
    stop:facts.stop,hostTurn:facts.hostTurn,
    latest:latest?{
      id:latest.id,index:latest.index,status:latest.status,sessionId:latest.sessionId,model:latest.model,actualModel:latest.actualModel,
      startedAt:latest.startedAt,endedAt:latest.endedAt,usage:latest.usage,error:latest.error,
      result:result===null?null:clip(result,1000),resultTruncated:result!==null&&result.length>1000,
      deliveryChecklist:checklistSummary(latest.deliveryChecklist),acceptance:facts.acceptance,verification:facts.verification,
    }:null,
  };
}

function compactInbox(inbox,factsById){
  const enrich=entry=>{
    const checklist=factsById.get(entry.taskId)?.attempt?.deliveryChecklist||null;
    return {...entry,deliveryChecklist:checklistSummary(checklist)};
  };
  return {...inbox,pending:inbox.pending.map(enrich),verifying:inbox.verifying.map(enrich)};
}

/**
 * wait only wakes for a terminal/failed/real-stop fact of the watched tasks.
 * Tool progress and conversation churn are intentionally absent from the signature.
 */
export async function waitForTasks(binding,{taskIds,seconds=30,after=''}={},options={}){
  const client=options.client||await options.loadClient(binding);
  if(!client)throw requestError('SQUAD_LOCAL_CLIENT_UNAVAILABLE','无法加载小队本地记录。');
  const cursor=decodeCursor(after);
  if(cursor&&cursor.threadId!==binding.threadId)throw requestError('SQUAD_WAIT_CURSOR_MISMATCH','after 游标属于其他会话，不能混用。');
  const ids=normalizeTaskIds(binding,taskIds,cursor);
  const limit=Math.max(0,Math.min(30,Number(seconds)||0));
  const observe=async()=>{
    const facts=[];
    for(const taskId of ids)facts.push(await readTaskFacts(binding,taskId,client,options));
    const signatures=Object.fromEntries(facts.map(item=>[item.task.id,wakeKey(item)]));
    return {facts,signatures,cursor:encodeCursor(binding.threadId,ids,signatures)};
  };
  const changedAgainst=(current)=>{
    if(!cursor)return false;
    return ids.some(taskId=>{
      const next=current.signatures[taskId];
      return Boolean(next)&&next!==cursor.signatures[taskId];
    });
  };
  const view=(current,extra={})=>({
    schemaVersion:1,changed:false,cursor:current.cursor,observedAt:new Date().toISOString(),
    seconds:limit,binding:{threadId:binding.threadId,workspace:binding.workspace},
    tasks:current.facts.map(compactFacts),...extra,
  });
  let current=await observe();
  if(limit===0)return view(current,{snapshot:true});
  if(changedAgainst(current))return view(current,{changed:true});
  const deadline=Date.now()+limit*1000;
  while(Date.now()<deadline){
    await (options.sleep||delay)(Math.min(1000,Math.max(1,deadline-Date.now()))).catch(()=>{});
    current=await observe();
    if(changedAgainst(current))return view(current,{changed:true});
  }
  return view(current,{changed:false});
}

export async function inboxView(binding,options={}){
  const client=options.client||await options.loadClient(binding);
  if(!client)throw requestError('SQUAD_LOCAL_CLIENT_UNAVAILABLE','无法加载小队本地记录。');
  const facts=[];
  for(const taskId of binding.tasks){
    const task=await ownedTask(binding,taskId,client,options);
    const factsValue=await readTaskFacts(binding,taskId,client,{...options,task,digest:reviewStatuses.has(String(task.status||'').toLowerCase())});
    facts.push(factsValue);
  }
  const tasks=facts.map(item=>({
    id:item.task.id,title:String(item.task.title||''),status:item.status,
    attempts:item.attempt?[{...item.attempt,acceptance:item.acceptance,verification:item.verification}]:[],
    acceptance:item.acceptance,verification:item.verification,retirement:item.retirement,
  }));
  const factsById=new Map(facts.map(item=>[item.task.id,item]));
  const inbox=compactInbox(inboxOf(tasks),factsById);
  const signatures=Object.fromEntries(facts.map(item=>[item.task.id,wakeKey(item)]));
  return {
    ...inbox,observedAt:new Date().toISOString(),
    cursor:encodeCursor(binding.threadId,binding.tasks.slice(),signatures),
    binding:{threadId:binding.threadId,workspace:binding.workspace},
  };
}

function detailsGaps(facts){
  const gaps=[];
  const round=facts.attempt;
  if(!round)return ['任务还没有可读取的执行轮次。'];
  const checklist=round.deliveryChecklist;
  if(!checklist){
    if(terminalAttemptStatuses.has(round.status))gaps.push('本轮没有保存结构化交付清单。');
  }else{
    gaps.push(...(checklist.gaps||[]));
    for(const check of (checklist.checks||[]))if((check.status==='passed'||check.status==='failed')&&!check.evidence)gaps.push(`检查缺少可核验证据：${check.name}（${check.status}，仅成员声称）`);
  }
  if(round.status==='completed'&&!facts.verification)gaps.push('本轮已返回，尚未登记负责人核验。');
  if(round.status==='completed'&&!facts.acceptance)gaps.push('本轮已返回，尚未记录验收。');
  return [...new Set(gaps)];
}

async function attemptPayload(binding,taskId,client,options={}){
  const task=await ownedTask(binding,taskId,client,options);
  const activeGeneration=Number(task.harness?.activeGeneration||0);
  const refs=normalizeRefs(binding,taskId);
  const generations=new Set(refs.map(ref=>Number(ref.generation)).filter(Boolean));
  const digests=new Map();
  const read=async generation=>{
    if(!Number.isSafeInteger(generation)||generation<1||generation>activeGeneration)return null;
    if(!digests.has(generation))digests.set(generation,await readTaskDigest(client,taskId,generation,options));
    return digests.get(generation);
  };
  if(activeGeneration>0)await read(activeGeneration);
  for(const generation of [...generations])await read(generation);
  if(!refs.length)for(let generation=1;generation<=Math.min(activeGeneration,100);generation+=1){
    const digestValue=await read(generation);
    const recovered=refFromEvents(eventsOf(digestValue),generation);
    if(recovered&&!refs.some(ref=>ref.attemptId===recovered.attemptId))refs.push(recovered);
  }
  refs.sort(byAttempt);
  const member=memberFromTask(binding,task)?.member||null;
  const worker=binding.workers?.[taskId]||refs.at(-1)?.worker||null;
  const alive=worker?await workerAlive(worker,options):false;
  const attempts=[];
  for(const [index,ref] of refs.entries()){
    const digestValue=digests.get(Number(ref.generation))||null;
    const latest=index===refs.length-1;
    const attempt=attemptView(ref,{events:eventsOf(digestValue)},task,member,worker,alive,latest,{publicEvents:[]});
    if(!latest)delete attempt.delivery;
    attempt.deliveryChecklist=completionChecklist(digestValue,attempt.id);
    const verification=binding.reviews?.[taskId]?.[attempt.id];
    if(verification)attempt.verification=verification;
    const rawAcceptance=acceptanceFrom({events:eventsOf(digestValue)});
    if(rawAcceptance&&rawAcceptance.attemptId===attempt.id)attempt.acceptance=rawAcceptance;
    attempts.push({attempt,ref,digest:digestValue});
  }
  const latest=attempts.at(-1)||null;
  const current=attempts.find(item=>Number(item.ref.generation)===activeGeneration)||latest;
  const status=taskStatusView(task,attempts.map(item=>item.attempt),worker,alive);
  return {task,activeGeneration,refs,attempts,latest,current,worker,alive,status,memberId:member?.id||'implementer'};
}

export async function taskDetails(binding,{taskId,attemptId=null,process:withProcess=false,after=0,limit=50}={},options={}){
  const client=options.client||await options.loadClient(binding);
  if(!client)throw requestError('SQUAD_LOCAL_CLIENT_UNAVAILABLE','无法加载小队本地记录。');
  const payload=await attemptPayload(binding,taskId,client,options);
  const {task,latest,current}=payload;
  if(attemptId&&!payload.attempts.some(item=>item.attempt.id===attemptId))throw requestError('SQUAD_ATTEMPT_MISSING','该任务没有指定尝试。');
  const selected=attemptId?payload.attempts.find(item=>item.attempt.id===attemptId):current;
  const latestAcceptance=latest?acceptanceFrom({events:eventsOf(latest.digest)}):null;
  const acceptance=latestAcceptance&&latestAcceptance.attemptId===latest.attempt.id
    ?await inspectAcceptance(binding.workspace,latestAcceptance):null;
  if(acceptance&&latest)latest.attempt.acceptance=acceptance;
  const checklist=selected?.attempt.deliveryChecklist||null;
  const verification=selected?binding.reviews?.[taskId]?.[selected.attempt.id]||null:null;
  const facts={task,attempt:selected?.attempt||null,verification,acceptance};
  const gaps=detailsGaps(facts);
  const failure=checklist?.failure||(selected?.attempt.status==='failed'
    ?buildFailureReceipt({checklist:null,status:'failed',error:selected.attempt.error,nativeSessionId:selected.attempt.sessionId,diagnostic:null,persistenceError:null}):null);
  const attempts=(attemptId?payload.attempts.filter(item=>item.attempt.id===attemptId):payload.attempts).map(item=>attemptSummary(item.attempt,item.ref));
  const taskAttempts=attempts.length?attempts:[];
  const baseAttempt=selected?.attempt||null;
  const baseResult=typeof baseAttempt?.result==='string'?baseAttempt.result:null;
  const view={
    schemaVersion:1,id:task.id,title:String(task.title||''),memberId:payload.memberId,status:payload.status,
    reason:text(task.harness?.blocker?.summary)||text(task.harness?.blocker?.title)||null,
    generation:payload.activeGeneration,
    round:baseAttempt?{
      generation:selected?Number(selected.ref.generation):null,attemptId:baseAttempt.id,index:baseAttempt.index,
      status:baseAttempt.status,startedAt:baseAttempt.startedAt,endedAt:baseAttempt.endedAt,sessionId:baseAttempt.sessionId,
      model:baseAttempt.model,actualModel:baseAttempt.actualModel,usage:baseAttempt.usage,error:baseAttempt.error,
      result:baseResult===null?null:clip(baseResult,4000),resultTruncated:baseResult!==null&&baseResult.length>4000,
      delivery:baseAttempt.delivery,deliveryChecklist:checklistSummary(baseAttempt.deliveryChecklist),
    }:null,
    deliveryChecklist:baseAttempt?.deliveryChecklist||null,
    failure,
    gaps,
    attempts:taskAttempts,
    acceptance,verification,retirement:binding.retirements?.[taskId]||null,
    stop:stopView(payload.worker,baseAttempt?.status||null),hostTurn:hostTurnOf(payload.worker),
  };
  if(withProcess){
    const generation=selected?Number(selected.ref.generation):payload.activeGeneration;
    if(!Number.isSafeInteger(generation)||generation<1)throw requestError('SQUAD_PROCESS_UNAVAILABLE','任务没有可读取的公开执行过程。');
    const afterSequence=Number.isSafeInteger(Number(after))&&Number(after)>0?Number(after):0;
    const pageLimit=Math.max(1,Math.min(200,Number(limit)||50));
    const page=await client.operate('work.execution.get',{workId:taskId,generation,afterSequence,limit:pageLimit},{
      actor:options.actor,defaultWorkspace:options.defaultWorkspace,
    });
    const projection=attemptView(selected.ref,{events:page.events||[]},task,memberFromTask(binding,task)?.member||null,payload.worker,payload.alive,false,{publicEvents:null});
    const events=projection.events;
    const nextSequence=Number(events.at(-1)?.sequence??(page.events||[]).at(-1)?.sequence??afterSequence);
    const highWaterSequence=Number(page.highWaterSequence||0);
    view.process={generation,afterSequence,limit:pageLimit,highWaterSequence,nextSequence,hasMore:nextSequence<highWaterSequence,events};
  }
  return view;
}

import {entryUsage} from './codex-usage.mjs';
import {buildSquadBenefits,groupViewThreads} from './squad-benefits.mjs';

export const BENEFIT_SOURCE_VERSION=1;
export const BENEFIT_SPEED_WINDOW_DAYS=30;
const DAY_MS=86400000;
const MAX_DELIVERY_CANDIDATES=32;
const MAX_BASELINE_CANDIDATES=40;
const MAX_SPEED_SAMPLES=240;
const MAX_SPEED_PER_MODEL=60;
const MAX_TITLE=160;
const MAX_TEXT=800;
const MAX_ACCEPTANCE=400;
const MAX_TASK_ROWS=8;
const MAX_MESSAGES=4;
const MAX_PUBLIC_GOALS=3;
const ACTIVE_TASK_STATUSES=new Set(['starting','running','stopping','in_progress','queued','pending','backlog','todo','blocked','idle']);
const FAILED_TASK_STATUSES=new Set(['failed','error']);
const STOPPED_TASK_STATUSES=new Set(['stopped','interrupted','canceled','cancelled']);
const SQUAD_PROMPT=/你是\s*Codex\s*小队中的/;

function isRecord(value){return value!==null&&typeof value==='object'&&!Array.isArray(value)}
function nonEmpty(value){return typeof value==='string'&&value.trim()?value.trim():null}
function lower(value){return typeof value==='string'?value.trim().toLowerCase():''}
function timeOf(value){
  if(value instanceof Date)return Number.isFinite(value.getTime())?value.getTime():null;
  if(typeof value==='number')return Number.isFinite(value)?value:null;
  if(typeof value!=='string'||!value.trim())return null;
  const parsed=Date.parse(value);
  return Number.isFinite(parsed)?parsed:null;
}
function iso(value){return value===null?null:new Date(value).toISOString()}
function cleanText(value,limit=MAX_TEXT){
  if(typeof value!=='string')return '';
  return value
    .replace(/\b(?:https?|file):\/\/\S+/gi,'[链接]')
    .replace(/(?:^|[\s(（])(?:~?\/|[A-Za-z]:[\\/])[^\s，。；、,;'"`<>]{2,}/g,' [路径]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|AKIA[A-Z0-9]{12,}|xox[baprs]-[A-Za-z0-9-]{8,}|Bearer\s+[A-Za-z0-9._~+/=-]{8,})/g,'[敏感值]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,' ')
    .replace(/\s+/g,' ')
    .trim()
    .slice(0,limit);
}
function cleanTitle(value){return cleanText(value,MAX_TITLE)||null}
function publicGoalRows(goals){
  const list=Array.isArray(goals)?goals.filter(isRecord):[];
  const picked=list.length<=MAX_PUBLIC_GOALS?list:[...list.slice(0,2),list[list.length-1]];
  const rows=[],seen=new Set();
  for(const goal of picked){
    const text=cleanText(goal.text);
    if(!text||seen.has(text))continue;
    seen.add(text);
    const at=timeOf(goal.at);
    rows.push({text,turn:nonEmpty(goal.turn),at:at===null?null:iso(at),sourceThreadId:nonEmpty(goal.sourceThreadId)});
  }
  return rows;
}
function policyText(value){
  const text=nonEmpty(value);
  return text?text.replace(/\s+/g,' '):null;
}
function emptyCoverage(){
  return {
    available:false,reason:'NO_NATIVE_INVENTORY',
    threads:0,readableThreads:0,attemptedDeliveries:0,completeDeliveries:0,excludedDeliveries:0,
    baselineCandidates:0,omittedBaselineCandidates:0,omittedDeliveryCandidates:0,
    speedSamples:0,excluded:[],
  };
}
function countReason(map,code,detail=null){
  let row=map.get(code);
  if(!row){row={code,count:0,examples:[]};map.set(code,row)}
  row.count+=1;
  if(detail&&row.examples.length<8)row.examples.push(detail);
}
function publicReasons(map){
  return [...map.values()].sort((left,right)=>
    right.count-left.count
    ||left.code.localeCompare(right.code)
    ||JSON.stringify(left.detail??null).localeCompare(JSON.stringify(right.detail??null)));
}

function inventoryMaps(inventory){
  const threads=new Map(),entries=new Map();
  const readable=inventory?.readable instanceof Set?inventory.readable:new Set(Array.isArray(inventory?.readable)?inventory.readable:[]);
  if(inventory?.available===true){
    for(const thread of Array.isArray(inventory.threads)?inventory.threads:[]){
      const id=nonEmpty(thread?.threadId);
      if(!id)continue;
      threads.set(id,thread);
      if(thread.rolloutPath&&isRecord(inventory.index?.files))entries.set(thread.rolloutPath,inventory.index.files[thread.rolloutPath]||null);
    }
  }
  return {threads,entries,readable,available:inventory?.available===true,reason:inventory?.reason||null};
}
function childrenMap(threads){
  const children=new Map();
  for(const [id,thread] of threads){
    const parent=nonEmpty(thread.parentThreadId);
    if(!parent)continue;
    if(!children.has(parent))children.set(parent,[]);
    children.get(parent).push(id);
  }
  return children;
}
function descendants(roots,children){
  const all=new Set(),queue=[...roots];
  while(queue.length){
    const id=queue.shift();
    if(all.has(id))continue;
    all.add(id);
    for(const child of children.get(id)||[])if(!all.has(child))queue.push(child);
  }
  return all;
}
function threadCoverage(id,{threads,entries,readable},nowMs){
  const thread=threads.get(id);
  const path=nonEmpty(thread?.rolloutPath);
  const entry=path?entries.get(path)||null:null;
  if(!thread)return {id,complete:false,reason:'thread-missing'};
  if(!path||!entry)return {id,complete:false,reason:'rollout-missing',thread};
  if(!readable.has(path))return {id,complete:false,reason:'rollout-unreadable',thread,entry};
  const usage=entryUsage(entry,{toMs:nowMs});
  const lifecycle=isRecord(entry.lifecycle)?entry.lifecycle:{};
  const lastCompleteAt=Number.isFinite(lifecycle.lastCompleteAt)?lifecycle.lastCompleteAt:null;
  const usageTurns=new Set(usage.turns.map(turn=>turn.turnId));
  const starts=Object.keys(isRecord(lifecycle.starts)?lifecycle.starts:{});
  const missingUsageTurns=starts.filter(turn=>!usageTurns.has(turn));
  let reason=null;
  if(lifecycle.lastKind!=='complete')reason='thread-active';
  else if(lastCompleteAt===null||lastCompleteAt>nowMs)reason='thread-not-ended';
  else if(!usage.records.length)reason='usage-missing';
  else if(usage.undatedRecords)reason='usage-undated';
  else if(missingUsageTurns.length)reason='turn-usage-missing';
  return {id,complete:reason===null,reason,thread,entry,usage,lifecycle,lastCompleteAt,missingUsageTurns};
}
function sumCoverage(coverages){
  const groups=new Map();
  let records=0,undatedRecords=0,unknownModelRecords=0,firstAt=null,lastAt=null;
  for(const coverage of coverages){
    const usage=coverage.usage;
    records+=usage.records.length;
    undatedRecords+=usage.undatedRecords;
    unknownModelRecords+=usage.unknownModelRecords;
    for(const model of usage.models){
      const key=model.model??'';
      let group=groups.get(key);
      if(!group){
        group={model:model.model??null,inputTokens:0,outputTokens:0,cachedInputTokens:0,records:0};
        groups.set(key,group);
      }
      group.inputTokens+=model.inputTokens;
      group.outputTokens+=model.outputTokens;
      group.cachedInputTokens+=model.cachedInputTokens;
      group.records+=model.records;
    }
    for(const turn of usage.turns){
      if(turn.firstAt!==null&&(firstAt===null||turn.firstAt<firstAt))firstAt=turn.firstAt;
      if(turn.lastAt!==null&&(lastAt===null||turn.lastAt>lastAt))lastAt=turn.lastAt;
    }
  }
  const models=[...groups.values()]
    .map(group=>({model:group.model,source:'actual',inputTokens:group.inputTokens,outputTokens:group.outputTokens,cachedInputTokens:group.cachedInputTokens}))
    .sort((left,right)=>
      (right.inputTokens+right.outputTokens)-(left.inputTokens+left.outputTokens)
      ||String(left.model??'').localeCompare(String(right.model??'')));
  const totals=models.reduce((sum,model)=>{
    sum.inputTokens+=model.inputTokens;
    sum.outputTokens+=model.outputTokens;
    sum.cachedInputTokens+=model.cachedInputTokens;
    sum.totalTokens+=model.inputTokens+model.outputTokens;
    return sum;
  },{inputTokens:0,outputTokens:0,cachedInputTokens:0,totalTokens:0});
  const knownModels=[...new Set(models.map(model=>model.model).filter(Boolean))].sort();
  return {models,totals,records,undatedRecords,unknownModelRecords,firstAt,lastAt,knownModels};
}
function recordedConditions(coverage,model){
  const contexts=coverage.usage.turns.map(turn=>coverage.lifecycle.contexts?.[turn.turnId]);
  const values={model:nonEmpty(model)};
  for(const [field,source] of [['reasoning','reasoning'],['tools','sandbox'],['permissions','approval']]){
    const parts=contexts.map(context=>nonEmpty(context?.[source]));
    values[field]=parts.length&&parts.every(Boolean)?[...new Set(parts)].sort().join(' + '):null;
  }
  return {values,complete:Object.values(values).every(Boolean)};
}
function tokenTotals(usage){
  const inputTokens=Number.isFinite(usage?.inputTokens)?usage.inputTokens:null;
  const outputTokens=Number.isFinite(usage?.outputTokens)?usage.outputTokens:null;
  const cachedInputTokens=Number.isFinite(usage?.cachedInputTokens)?usage.cachedInputTokens:null;
  const totalTokens=Number.isFinite(usage?.totalTokens)?usage.totalTokens:null;
  return {
    inputTokens,outputTokens,cachedInputTokens,totalTokens:
      inputTokens!==null&&outputTokens!==null?inputTokens+outputTokens:totalTokens,
    complete:inputTokens!==null&&outputTokens!==null,
  };
}
function qoderSummary(entries){
  const groups=new Map();
  let inputTokens=0,outputTokens=0,cachedInputTokens=0,reportedAttempts=0,complete=entries.length>0;
  for(const entry of entries){
    const attempt=isRecord(entry?.attempt)?entry.attempt:entry;
    const totals=tokenTotals(attempt.usage);
    const endedAt=timeOf(attempt.endedAt);
    if(!totals.complete||endedAt===null)complete=false;
    if(totals.complete){
      reportedAttempts+=1;
      inputTokens+=totals.inputTokens;
      outputTokens+=totals.outputTokens;
      if(totals.cachedInputTokens!==null)cachedInputTokens+=totals.cachedInputTokens;
      const key=nonEmpty(attempt.actualModel)??'';
      let group=groups.get(key);
      if(!group){
        group={model:nonEmpty(attempt.actualModel)??null,source:'actual',inputTokens:0,outputTokens:0,cachedInputTokens:0};
        groups.set(key,group);
      }
      group.inputTokens+=totals.inputTokens;
      group.outputTokens+=totals.outputTokens;
      if(totals.cachedInputTokens!==null)group.cachedInputTokens+=totals.cachedInputTokens;
    }
  }
  const models=[...groups.values()].sort((left,right)=>
    (right.inputTokens+right.outputTokens)-(left.inputTokens+left.outputTokens)
    ||String(left.model??'').localeCompare(String(right.model??'')));
  return {
    used:entries.length>0,
    complete:entries.length===0?true:complete,
    attempts:entries.length,
    reportedAttempts,
    tokens:inputTokens+outputTokens,
    inputTokens,outputTokens,cachedInputTokens,
    models,
  };
}
function acceptedAt(acceptance,nowMs){
  if(!isRecord(acceptance)||acceptance.stale===true)return null;
  const at=timeOf(acceptance.at);
  return at!==null&&at<=nowMs?at:null;
}
function attemptList(thread){
  return thread.tasks.size?[...thread.tasks.values()].flatMap(task=>
    [...task.attempts.values()].map(entry=>({
      ...entry,
      attempt:{
        ...entry.attempt,
        executor:entry.attempt.executor??thread.executors.get(task.memberId)??'unknown',
      },
      task,
    }))
  ): [];
}
function taskRows(tasks,nowMs){
  return tasks.slice(0,MAX_TASK_ROWS).map(task=>{
    const attempts=[...task.attempts.values()].map(entry=>entry.attempt);
    const goal=attempts.map(attempt=>nonEmpty(attempt.handoff?.goal)).find(Boolean)||null;
    const accepted=acceptedAt(task.acceptance,nowMs)!==null;
    return {
      title:cleanTitle(task.title),
      goal:goal?cleanText(goal):null,
      status:nonEmpty(task.status)||'unknown',
      accepted,
      acceptanceNote:accepted?cleanText(task.acceptance.note,MAX_ACCEPTANCE)||null:null,
      attempts:attempts.length,
      failedAttempts:attempts.filter(attempt=>FAILED_TASK_STATUSES.has(lower(attempt.status))).length,
    };
  });
}
function deliveryIdOf(thread){
  return thread.parentWorkId?`${thread.parentWorkId}:${thread.threadId}`:`thread:${thread.threadId}`;
}
function buildDelivery(thread,{threads,entries,readable,analysisThreadIds,nowMs,usedCodexThreads,reasons}){
  const tasks=[...thread.tasks.values()];
  if(!tasks.length){
    countReason(reasons,'delivery-no-tasks',{threadId:thread.threadId});
    return null;
  }
  const acceptanceTimes=tasks.map(task=>acceptedAt(task.acceptance,nowMs));
  if(acceptanceTimes.some(value=>value===null)){
    countReason(reasons,'delivery-unaccepted',{threadId:thread.threadId});
    return null;
  }
  if(tasks.some(task=>FAILED_TASK_STATUSES.has(lower(task.status))||STOPPED_TASK_STATUSES.has(lower(task.status)))){
    countReason(reasons,'delivery-failed-or-stopped',{threadId:thread.threadId});
    return null;
  }
  // A stale active status means work may still be running even if an older
  // acceptance is present; the root parent backlog placeholder is not a task.
  if(tasks.some(task=>ACTIVE_TASK_STATUSES.has(lower(task.status)))){
    countReason(reasons,'delivery-active-task',{threadId:thread.threadId});
    return null;
  }
  const attempts=attemptList(thread);
  if(attempts.some(entry=>['running','starting','stopping'].includes(lower(entry.attempt.status)))){
    countReason(reasons,'delivery-active-attempt',{threadId:thread.threadId});
    return null;
  }
  const executors=new Set(attempts.map(entry=>lower(entry.attempt.executor)));
  if([...executors].some(executor=>!['qoder','codex',''].includes(executor))){
    countReason(reasons,'delivery-unsupported-executor',{threadId:thread.threadId});
    return null;
  }
  const codexAttempts=attempts.filter(entry=>lower(entry.attempt.executor)==='codex');
  const missingCodexSessions=codexAttempts.some(entry=>!nonEmpty(entry.attempt.sessionId));
  if(missingCodexSessions){
    countReason(reasons,'codex-attempt-session-missing',{threadId:thread.threadId});
    return null;
  }
  const roots=[thread.threadId,...codexAttempts.map(entry=>nonEmpty(entry.attempt.sessionId))];
  if(roots.some(id=>analysisThreadIds.has(id))){
    countReason(reasons,'delivery-thread-is-analysis',{threadId:thread.threadId});
    return null;
  }
  const children=childrenMap(threads);
  const ids=[...descendants(roots,children)];
  if(ids.some(id=>usedCodexThreads.has(id))){
    countReason(reasons,'delivery-codex-source-reused',{threadId:thread.threadId});
    return null;
  }
  const coverages=ids.map(id=>threadCoverage(id,{threads,entries,readable},nowMs));
  const missing=coverages.filter(coverage=>!coverage.complete);
  if(missing.length){
    countReason(reasons,'delivery-codex-lifecycle-incomplete',{
      threadId:thread.threadId,
      threads:missing.map(coverage=>({threadId:coverage.id,reason:coverage.reason})).slice(0,8),
    });
    return null;
  }
  const host=coverages.find(coverage=>coverage.id===thread.threadId);
  const hostMeta=host.thread;
  const finalMessage=nonEmpty(host.lifecycle?.lastMessage);
  if(!finalMessage){
    countReason(reasons,'delivery-final-message-missing',{threadId:thread.threadId});
    return null;
  }
  const completedAt=host.lastCompleteAt;
  const latestAcceptance=Math.max(...acceptanceTimes);
  const latestAttemptEnd=Math.max(...attempts.map(entry=>timeOf(entry.attempt.endedAt)??-Infinity));
  const latestChild=Math.max(...coverages.map(coverage=>coverage.lastCompleteAt));
  if(completedAt<latestAcceptance||completedAt<latestAttemptEnd||completedAt<latestChild){
    countReason(reasons,'delivery-not-final-turn',{threadId:thread.threadId});
    return null;
  }
  const usage=sumCoverage(coverages);
  const startedAt=Math.min(
    ...[usage.firstAt,...coverages.flatMap(coverage=>Object.values(coverage.lifecycle.starts||{}).map(start=>start.startedAt)),
      ...attempts.map(entry=>timeOf(entry.attempt.startedAt))].filter(value=>Number.isFinite(value))
  );
  if(!Number.isFinite(startedAt)){
    countReason(reasons,'delivery-start-missing',{threadId:thread.threadId});
    return null;
  }
  const qoder=qoderSummary(attempts.filter(entry=>lower(entry.attempt.executor)==='qoder'));
  if(qoder.used&&!qoder.complete){
    countReason(reasons,'qoder-usage-incomplete',{threadId:thread.threadId});
    return null;
  }
  const hard=recordedConditions(host,usage.unknownModelRecords||!usage.knownModels.length?null:usage.knownModels.join('+'));
  ids.forEach(id=>usedCodexThreads.add(id));
  const deliveryId=deliveryIdOf(thread);
  const title=cleanTitle(thread.title)||cleanTitle(hostMeta?.title)||'本机小队交付';
  const evidence={
    native:true,matchRequired:true,
    deliveryId,threadId:thread.threadId,parentWorkId:thread.parentWorkId,
    title,accepted:true,completedAt:iso(completedAt),
    range:{startedAt:iso(startedAt)},
    hardConditions:hard,
    conditions:null,
    actual:{
      codex:{
        sourceRef:`codex:${thread.threadId}`,
        complete:true,includesMain:true,includesSubagents:true,
        models:usage.models,
        threadCount:ids.length,
      },
      qoder:{
        used:qoder.used,
        sourceRef:qoder.used?`qoder:${thread.threadId}`:null,
        complete:qoder.complete,
        models:qoder.models,
        attempts:qoder.attempts,
        reportedAttempts:qoder.reportedAttempts,
      },
    },
    baseline:null,
    nativeSummary:{
      threads:ids.length,
      tasks:tasks.length,
      turns:coverages.reduce((sum,coverage)=>sum+coverage.usage.turns.length,0),
      records:usage.records,
      unknownModelRecords:usage.unknownModelRecords,
      qoderAttempts:qoder.attempts,
    },
  };
  const candidate={
    ref:`benefit-delivery:${deliveryId}`,
    deliveryId,threadId:thread.threadId,title,
    startedAt:iso(startedAt),completedAt:iso(completedAt),
    taskCount:tasks.length,
    omittedTasks:Math.max(0,tasks.length-MAX_TASK_ROWS),
    tasks:taskRows(tasks,nowMs),
    finalMessage:cleanText(finalMessage),
    publicGoals:publicGoalRows(host.lifecycle?.publicGoals),
    userMessages:Array.isArray(host.lifecycle?.userMessages)
      ?host.lifecycle.userMessages.map(text=>cleanText(text)).filter(Boolean).slice(-MAX_MESSAGES)
      :[],
    codex:{
      totalTokens:usage.totals.totalTokens,
      inputTokens:usage.totals.inputTokens,
      outputTokens:usage.totals.outputTokens,
      models:usage.models.map(model=>({model:model.model,totalTokens:model.inputTokens+model.outputTokens})),
      threads:ids.length,
    },
    qoder:{
      used:qoder.used,totalTokens:qoder.tokens,attempts:qoder.attempts,
      models:qoder.models.map(model=>({model:model.model,totalTokens:model.inputTokens+model.outputTokens})),
    },
    hardConditions:hard.values,
  };
  return {evidence,candidate};
}

function buildBaseline(rootId,{threads,entries,readable,excluded,nowMs,reasons}){
  const children=childrenMap(threads);
  const ids=[...descendants([rootId],children)];
  if(ids.some(id=>excluded.has(id))){
    countReason(reasons,'baseline-overlaps-squad-or-analysis',{threadId:rootId});
    return null;
  }
  const rootMeta=threads.get(rootId);
  if(ids.some(id=>SQUAD_PROMPT.test(threads.get(id)?.title||''))){
    countReason(reasons,'baseline-squad-session',{threadId:rootId});
    return null;
  }
  const coverages=ids.map(id=>threadCoverage(id,{threads,entries,readable},nowMs));
  const missing=coverages.filter(coverage=>!coverage.complete);
  if(missing.length){
    countReason(reasons,'baseline-lifecycle-incomplete',{
      threadId:rootId,
      threads:missing.map(coverage=>({threadId:coverage.id,reason:coverage.reason})).slice(0,8),
    });
    return null;
  }
  const root=coverages.find(coverage=>coverage.id===rootId);
  if(coverages.some(coverage=>coverage.lifecycle.externalExecutors?.length)){
    countReason(reasons,'baseline-external-executor',{threadId:rootId});
    return null;
  }
  const finalMessage=nonEmpty(root.lifecycle?.lastMessage);
  if(!finalMessage){
    countReason(reasons,'baseline-final-message-missing',{threadId:rootId});
    return null;
  }
  if(/Qoder\s*(?:完成|执行|实现|交付)|(?:交给|委派)\s*Qoder/i.test(finalMessage)){
    countReason(reasons,'baseline-external-executor',{threadId:rootId});
    return null;
  }
  const completedAt=root.lastCompleteAt;
  const latestChild=Math.max(...coverages.map(coverage=>coverage.lastCompleteAt));
  if(completedAt<latestChild){
    countReason(reasons,'baseline-not-final-turn',{threadId:rootId});
    return null;
  }
  const usage=sumCoverage(coverages);
  const startedAt=Math.min(...[usage.firstAt,...coverages.flatMap(coverage=>Object.values(coverage.lifecycle.starts||{}).map(start=>start.startedAt))].filter(Number.isFinite));
  if(startedAt===null||usage.unknownModelRecords||!usage.knownModels.length){
    countReason(reasons,'baseline-model-missing',{threadId:rootId});
    return null;
  }
  const hard=recordedConditions(root,usage.knownModels.join('+'));
  if(!hard.complete){
    countReason(reasons,'baseline-hard-conditions-missing',{threadId:rootId});
    return null;
  }
  const baselineId=`codex-session:${rootId}`;
  const title=cleanTitle(rootMeta?.title)||cleanTitle(root.entry?.title)||'历史 Codex 会话';
  const evidence={
    native:true,baselineId,threadId:rootId,sourceRef:`codex:${rootId}`,
    pureCodex:true,complete:true,includesMain:true,includesSubagents:true,
    completedAt:iso(completedAt),startedAt:iso(startedAt),title,
    hardConditions:hard,
    conditions:null,
    models:usage.models,
    nativeSummary:{
      threads:ids.length,
      turns:coverages.reduce((sum,coverage)=>sum+coverage.usage.turns.length,0),
      records:usage.records,
      unknownModelRecords:usage.unknownModelRecords,
    },
  };
  const candidate={
    ref:`benefit-baseline:${baselineId}`,
    baselineId,threadId:rootId,title,
    startedAt:iso(startedAt),completedAt:iso(completedAt),
    totalTokens:usage.totals.totalTokens,
    inputTokens:usage.totals.inputTokens,
    outputTokens:usage.totals.outputTokens,
    models:usage.models.map(model=>({model:model.model,totalTokens:model.inputTokens+model.outputTokens})),
    subagentThreads:ids.length-1,
    turnCount:coverages.reduce((sum,coverage)=>sum+coverage.usage.turns.length,0),
    finalMessage:cleanText(finalMessage),
    publicGoals:publicGoalRows(root.lifecycle?.publicGoals),
    userMessages:Array.isArray(root.lifecycle?.userMessages)
      ?root.lifecycle.userMessages.map(text=>cleanText(text)).filter(Boolean).slice(-MAX_MESSAGES)
      :[],
    hardConditions:hard.values,
  };
  return {evidence,candidate};
}

function collectSpeedSamples({threads,entries,readable},views,{nowMs,speedWindowDays}){
  const fromMs=nowMs-speedWindowDays*DAY_MS;
  const samples=[],seen=new Set();
  for(const thread of threads.values()){
    const path=nonEmpty(thread.rolloutPath);
    const entry=path?entries.get(path):null;
    if(!entry||!readable.has(path))continue;
    const usage=entryUsage(entry,{toMs:nowMs});
    const lifecycle=isRecord(entry.lifecycle)?entry.lifecycle:{};
    const turns=new Map(usage.turns.map(turn=>[turn.turnId,turn]));
    for(const [turnId,complete] of Object.entries(isRecord(lifecycle.completes)?lifecycle.completes:{})){
      const started=lifecycle.starts?.[turnId];
      const endedAt=Number.isFinite(complete?.completedAt)?complete.completedAt:null;
      const startedAt=Number.isFinite(started?.startedAt)?started.startedAt:null;
      if(endedAt===null||startedAt===null||endedAt>nowMs||endedAt<fromMs)continue;
      const turn=turns.get(turnId);
      const model=nonEmpty(lifecycle.turns?.[turnId])||nonEmpty(entry.turns?.[turnId]);
      if(!turn||!model||turn.outputTokens<=0)continue;
      const durationMs=endedAt-startedAt;
      if(durationMs<=0)continue;
      const sourceRef=`codex-turn:${thread.threadId}:${turnId}`;
      if(seen.has(sourceRef))continue;
      seen.add(sourceRef);
      samples.push({
        sourceRef,scope:'run',source:'actual',model,
        outputTokens:turn.outputTokens,durationMs,endedAt:iso(endedAt),
      });
    }
  }
  const qoderSeen=new Set();
  for(const thread of groupViewThreads(views)){
    for(const entry of attemptList(thread)){
      if(lower(entry.attempt.executor)!=='qoder')continue;
      const model=nonEmpty(entry.attempt.actualModel);
      const outputTokens=Number(entry.attempt.usage?.outputTokens);
      const startedAt=timeOf(entry.attempt.startedAt);
      const endedAt=timeOf(entry.attempt.endedAt);
      if(!model||!Number.isFinite(outputTokens)||outputTokens<=0||startedAt===null||endedAt===null)continue;
      if(endedAt>nowMs||endedAt<fromMs||endedAt<=startedAt)continue;
      const sourceRef=`qoder-attempt:${entry.attempt.id}`;
      if(qoderSeen.has(sourceRef)||seen.has(sourceRef))continue;
      qoderSeen.add(sourceRef);seen.add(sourceRef);
      samples.push({
        sourceRef,scope:'run',source:'actual',model,
        outputTokens,durationMs:endedAt-startedAt,endedAt:iso(endedAt),
      });
    }
  }
  samples.sort((left,right)=>String(right.endedAt).localeCompare(String(left.endedAt)));
  const perModel=new Map(),selected=[];
  for(const sample of samples){
    const count=perModel.get(sample.model)||0;
    if(count>=MAX_SPEED_PER_MODEL)continue;
    perModel.set(sample.model,count+1);
    selected.push(sample);
    if(selected.length>=MAX_SPEED_SAMPLES)break;
  }
  return selected;
}

/**
 * Collects native benefit evidence from the shared Codex inventory and frozen
 * squad snapshots. The collector never reads rollout bodies itself: token and
 * lifecycle facts come from the incremental codex-usage index. Missing files,
 * active turns, undated usage and incomplete subagent trees stay excluded.
 */
export function collectBenefitSources({
  views=[],inventory=null,now=new Date(),speedWindowDays=BENEFIT_SPEED_WINDOW_DAYS,
  squadThreadIds=[],analysisThreadIds=[],
}){
  const at=now instanceof Date?new Date(now.getTime()):new Date(now);
  const nowMs=at.getTime();
  if(!Number.isFinite(nowMs))throw new TypeError('now 必须是有效时间。');
  if(!Array.isArray(views))throw new TypeError('views 必须是数组。');
  const maps=inventoryMaps(inventory);
  const coverage=emptyCoverage();
  if(!maps.available){
    coverage.reason=maps.reason||'NO_NATIVE_INVENTORY';
    return {deliveryEvidence:[],baselines:[],speedSamples:[],candidates:{deliveries:[],baselines:[]},coverage};
  }
  coverage.available=true;
  coverage.reason=null;
  coverage.threads=maps.threads.size;
  coverage.readableThreads=maps.readable.size;
  const analysisIds=new Set(analysisThreadIds.map(nonEmpty).filter(Boolean));
  const excludedIds=new Set([...squadThreadIds,...analysisThreadIds].map(nonEmpty).filter(Boolean));
  const reasons=new Map();
  const usedCodexThreads=new Set();
  const deliveries=[],deliveryCandidates=[];
  const grouped=groupViewThreads(views).sort((left,right)=>String(left.threadId).localeCompare(String(right.threadId)));
  // A bound squad session is never a pure-Codex baseline, even when its native lifecycle is complete.
  for(const thread of grouped)excludedIds.add(thread.threadId);
  for(const thread of grouped){
    coverage.attemptedDeliveries+=1;
    const built=buildDelivery(thread,{
      threads:maps.threads,entries:maps.entries,readable:maps.readable,
      analysisThreadIds:analysisIds,nowMs,usedCodexThreads,reasons,
    });
    if(!built)continue;
    deliveries.push(built.evidence);
    deliveryCandidates.push(built.candidate);
  }
  const baselineReasons=new Map();
  const candidates=[];
  for(const thread of maps.threads.values()){
    if(nonEmpty(thread.parentThreadId))continue;
    const built=buildBaseline(thread.threadId,{
      threads:maps.threads,entries:maps.entries,readable:maps.readable,
      excluded:new Set([...excludedIds,...usedCodexThreads]),nowMs,reasons:baselineReasons,
    });
    if(built)candidates.push(built);
  }
  candidates.sort((left,right)=>
    String(right.candidate.completedAt).localeCompare(String(left.candidate.completedAt))
    ||left.candidate.baselineId.localeCompare(right.candidate.baselineId));
  const selectedBaselines=candidates.slice(0,MAX_BASELINE_CANDIDATES);
  const selectedDeliveries=deliveryCandidates
    .sort((left,right)=>
      String(right.completedAt).localeCompare(String(left.completedAt))
      ||left.deliveryId.localeCompare(right.deliveryId))
    .slice(0,MAX_DELIVERY_CANDIDATES);
  const selectedDeliveryIds=new Set(selectedDeliveries.map(candidate=>candidate.deliveryId));
  const speedSamples=collectSpeedSamples(maps,views,{nowMs,speedWindowDays});
  for(const [key,value] of baselineReasons)reasons.set(`baseline:${key}`,value);
  coverage.completeDeliveries=deliveries.length;
  coverage.excludedDeliveries=Math.max(0,coverage.attemptedDeliveries-deliveries.length);
  coverage.baselineCandidates=selectedBaselines.length;
  coverage.omittedBaselineCandidates=Math.max(0,candidates.length-selectedBaselines.length);
  coverage.omittedDeliveryCandidates=Math.max(0,deliveryCandidates.length-selectedDeliveries.length);
  coverage.speedSamples=speedSamples.length;
  coverage.excluded=publicReasons(reasons);
  return {
    version:BENEFIT_SOURCE_VERSION,
    window:{from:iso(nowMs-speedWindowDays*DAY_MS),to:iso(nowMs),days:speedWindowDays},
    deliveryEvidence:deliveries.filter(evidence=>selectedDeliveryIds.has(evidence.deliveryId)),
    baselines:selectedBaselines.map(built=>built.evidence),
    speedSamples,
    candidates:{
      deliveries:selectedDeliveries,
      baselines:selectedBaselines.map(built=>built.candidate),
    },
    coverage,
  };
}

function basisValues(basis,side,field){
  if(!Array.isArray(basis))return null;
  const item=basis.find(entry=>entry.aspect===field);
  return item?nonEmpty(item[`${side}Text`]):null;
}
function combineConditions(hard,semantic){
  if(!hard?.complete||!semantic)return null;
  const workType=nonEmpty(semantic.workType);
  const scale=nonEmpty(semantic.scale);
  const acceptance=nonEmpty(semantic.acceptance);
  if(!workType||!scale||!acceptance)return null;
  return {
    workType,
    scale,
    model:hard.values.model,
    reasoning:hard.values.reasoning,
    acceptance,
    permissions:hard.values.permissions,
    tools:hard.values.tools,
  };
}
function hardMatches(left,right){
  return Boolean(left?.complete&&right?.complete
    &&left.values.model===right.values.model
    &&left.values.reasoning===right.values.reasoning
    &&left.values.tools===right.values.tools
    &&left.values.permissions===right.values.permissions);
}

/**
 * Applies model semantic matches to the frozen native sources and recomputes
 * benefits. Hard conditions and historical order are checked here; the model
 * only supplies the work-type/scale/acceptance basis and source refs.
 */
export function applyBenefitMatches({
  stats,sources,matches=[],now=new Date(),days=null,
}={}){
  if(!isRecord(stats))throw new TypeError('stats 必须是对象。');
  if(!isRecord(sources))throw new TypeError('sources 必须是对象。');
  if(!Array.isArray(matches))throw new TypeError('matches 必须是数组。');
  const deliveryById=new Map((sources.deliveryEvidence||[]).map(evidence=>[evidence.deliveryId,evidence]));
  const baselineById=new Map((sources.baselines||[]).map(evidence=>[evidence.baselineId,evidence]));
  const applied=new Map(),rejected=[];
  for(const match of matches){
    const delivery=deliveryById.get(match.deliveryId);
    const baseline=baselineById.get(match.baselineId);
    if(!delivery||!baseline){rejected.push({code:'match-reference-missing'});continue}
    if(applied.has(match.deliveryId)){rejected.push({code:'duplicate-delivery-match',deliveryId:match.deliveryId});continue}
    if(!hardMatches(delivery.hardConditions,baseline.hardConditions)){
      rejected.push({code:'hard-conditions-mismatch',deliveryId:match.deliveryId,baselineId:match.baselineId});
      continue;
    }
    const deliveryCompleted=timeOf(delivery.completedAt);
    const baselineCompleted=timeOf(baseline.completedAt);
    if(deliveryCompleted===null||baselineCompleted===null||baselineCompleted>=deliveryCompleted){
      rejected.push({code:'baseline-not-historical',deliveryId:match.deliveryId,baselineId:match.baselineId});
      continue;
    }
    const semanticDelivery={
      workType:basisValues(match.basis,'delivery','workType'),
      scale:basisValues(match.basis,'delivery','scale'),
      acceptance:basisValues(match.basis,'delivery','acceptance'),
    };
    const semanticBaseline={
      workType:basisValues(match.basis,'baseline','workType'),
      scale:basisValues(match.basis,'baseline','scale'),
      acceptance:basisValues(match.basis,'baseline','acceptance'),
    };
    const deliveryConditions=combineConditions(delivery.hardConditions,semanticDelivery);
    const baselineConditions=combineConditions(baseline.hardConditions,semanticBaseline);
    if(!deliveryConditions||!baselineConditions){rejected.push({code:'conditions-incomplete'});continue}
    applied.set(match.deliveryId,{
      ...delivery,
      conditions:deliveryConditions,
      semanticConditions:semanticDelivery,
      semanticMatch:{basis:match.basis,source:'model'},
      baseline:{
        ...baseline,
        conditions:baselineConditions,
        semanticConditions:semanticBaseline,
        semanticMatch:{basis:match.basis,source:'model'},
      },
    });
  }
  const evidence=(sources.deliveryEvidence||[]).map(entry=>applied.get(entry.deliveryId)??entry);
  const benefits=buildSquadBenefits({
    views:[],codexUsage:stats.codexUsage??null,now,days,
    deliveryEvidence:evidence,speedSamples:sources.speedSamples||[],
    baseBenefits:stats.benefits??null,
  });
  benefits.coverage.benefitMatches={
    provided:matches.length,applied:applied.size,rejected:rejected.length,
    details:rejected.slice(0,12),
  };
  return {...stats,benefits};
}

export const BENEFITS_STATS_VERSION='squad-benefits-v3';
const DAY_MS=86400000;
const DEFAULT_SPEED_WINDOW_DAYS=30;
const CONDITION_FIELDS=Object.freeze(['workType','scale','model','reasoning','acceptance','tools','permissions']);
const HARD_CONDITION_FIELDS=Object.freeze(['model','reasoning','tools','permissions']);
const ACTIVE_STATUSES=new Set(['starting','running','stopping','in_progress','queued','pending','idle','backlog','todo','blocked']);
const FAILED_STATUSES=new Set(['failed','error']);
const STOPPED_STATUSES=new Set(['stopped','interrupted']);

const NOTE='完整交付按 host threadId 并结合 parentWorkId 归集主控、子 Agent、失败与返工；Token 只计 input+output，缓存输入已包含在 input 中不重复相加；Qoder 用量单列，不与 Codex 等量抵扣；缺失值与负收益原样保留，不按 0 或平均值补齐。';

const REASON_LABELS=Object.freeze({
  'delivery-incomplete':'交付尚未完成或缺少全部任务验收，只展示投入。',
  'delivery-failed':'交付最终失败，只展示投入。',
  'delivery-stopped':'交付已停止，只展示投入。',
  'delivery-unobserved':'没有找到该交付的本机任务记录，无法核对完成边界。',
  'codex-usage-missing':'没有该交付对应的本机 Codex 用量。',
  'codex-attribution-missing':'本机 Codex 用量只按宿主会话窗口记录，未区分主控与子 Agent，也未覆盖交付生命周期。',
  'codex-cross-period':'本机 Codex 用量窗口从交付中途开始，未覆盖完整生命周期。',
  'codex-usage-incomplete':'本机 Codex 用量缺少可核对的模型或 Token 字段。',
  'qoder-not-involved':'本交付没有记录 Qoder 子任务用量。',
  'qoder-usage-incomplete':'Qoder 子任务用量没有完整上报。',
  'baseline-missing':'没有可核对的历史纯 Codex 完整交付基线。',
  'baseline-match-pending':'交付已完成，但尚未确认与历史基线的语义可比性，暂不估算。',
  'baseline-incomplete':'基线交付缺少完整用量、完成边界或匹配条件证据。',
  'baseline-impure':'基线交付不是纯 Codex 交付。',
  'baseline-not-historical':'基线交付不是当前交付之前完成的历史交付。',
  'baseline-conditions-missing':'基线或当前交付缺少匹配条件证据。',
  'baseline-conditions-mismatch':'基线与当前交付的工作类型、规模、模型、推理配置、验收要求或工具权限不一致。',
  'actual-incomplete':'当前交付的 Codex 用量覆盖不完整，未包含主控和子 Agent。',
  'speed-missing-model':'缺少该模型近期有效的实测输出速度。',
  'speed-run-basis':'使用整轮实测速度换算时间，结果仅供参考。',
  'evidence-view-conflict':'结构化证据显示已完成，但本机快照未确认全部验收，暂不估算。'
});

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
function nonNegative(value){
  return typeof value==='number'&&Number.isFinite(value)&&value>=0?Math.trunc(value):null;
}
function positive(value){
  return typeof value==='number'&&Number.isFinite(value)&&value>0?value:null;
}
function round(value,digits){
  const factor=10**digits;
  return Math.round((value+Number.EPSILON)*factor)/factor;
}
function median(values){
  const sorted=[...values].sort((left,right)=>left-right);
  const middle=Math.floor(sorted.length/2);
  return sorted.length%2?sorted[middle]:(sorted[middle-1]+sorted[middle])/2;
}
function pushReason(list,code,detail=null){
  const key=`${code}\u0000${detail?JSON.stringify(detail):''}`;
  if(list.some(item=>item.key===key))return;
  const reason={key,code,label:REASON_LABELS[code]??code};
  if(detail)reason.detail=detail;
  list.push(reason);
}
function publicReasons(list){
  return [...list]
    .sort((left,right)=>left.code.localeCompare(right.code)
      ||JSON.stringify(left.detail??null).localeCompare(JSON.stringify(right.detail??null)))
    .map(({key,...reason})=>reason);
}
function cleanTitle(value){
  const title=nonEmpty(value);
  return title?title.slice(0,200):null;
}

function attemptKey(attempt,position){
  const id=nonEmpty(attempt?.id);
  if(id)return `id:${id}`;
  const index=Number(attempt?.index);
  if(Number.isFinite(index))return `index:${index}`;
  return `position:${position}`;
}
function attemptOrder(left,right){
  const leftIndex=Number(left.attempt?.index),rightIndex=Number(right.attempt?.index);
  const leftDated=Number.isFinite(leftIndex),rightDated=Number.isFinite(rightIndex);
  if(leftDated&&rightDated&&leftIndex!==rightIndex)return leftIndex-rightIndex;
  if(leftDated!==rightDated)return leftDated?-1:1;
  return left.position-right.position;
}
function readConditions(value){
  if(!isRecord(value))return {ok:false,values:null,missing:[...CONDITION_FIELDS]};
  const values={},missing=[];
  for(const field of CONDITION_FIELDS){
    const text=nonEmpty(value[field]);
    if(text)values[field]=text;
    else missing.push(field);
  }
  return {ok:missing.length===0,values:missing.length?null:values,missing};
}
function readHardConditions(value){
  if(!isRecord(value))return {ok:false,values:null,missing:[...HARD_CONDITION_FIELDS]};
  const values={},missing=[];
  for(const field of HARD_CONDITION_FIELDS){
    const text=nonEmpty(value[field]);
    if(text)values[field]=text;
    else missing.push(field);
  }
  return {ok:missing.length===0,values:missing.length?null:values,missing};
}
function readModelList(value,{allowUnknownModel=false}={}){
  if(!Array.isArray(value)||!value.length)return null;
  const seen=new Set(),models=[];
  let unknown=false;
  for(const item of value){
    if(!isRecord(item))return null;
    if(item.source!=='actual')return null;
    const model=nonEmpty(item.model);
    if(model){
      if(seen.has(model))return null;
      seen.add(model);
    }else{
      // Native usage may not attribute a record to a model. At most one explicit
      // null group is kept and it can never be used for speed matching.
      if(!allowUnknownModel||item.model!==null||unknown)return null;
      unknown=true;
    }
    const inputTokens=nonNegative(item.inputTokens);
    const outputTokens=nonNegative(item.outputTokens);
    if(inputTokens===null||outputTokens===null)return null;
    models.push({
      model:model??null,
      inputTokens,
      outputTokens,
      cachedInputTokens:nonNegative(item.cachedInputTokens)
    });
  }
  return models;
}
function sumModels(models){
  let inputTokens=0,outputTokens=0,cachedInputTokens=0,cachedReported=0;
  for(const model of models){
    inputTokens+=model.inputTokens;
    outputTokens+=model.outputTokens;
    if(typeof model.cachedInputTokens==='number'){cachedInputTokens+=model.cachedInputTokens;cachedReported+=1}
  }
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens:cachedReported?cachedInputTokens:null,
    tokens:inputTokens+outputTokens
  };
}
function tokenTotalsFromUsage(usage){
  if(!isRecord(usage))return null;
  const inputTokens=nonNegative(usage.inputTokens);
  const outputTokens=nonNegative(usage.outputTokens);
  const cachedInputTokens=nonNegative(usage.cachedInputTokens);
  const explicitTotal=nonNegative(usage.totalTokens);
  const tokens=inputTokens!==null&&outputTokens!==null
    ?inputTokens+outputTokens
    :explicitTotal;
  return {inputTokens,outputTokens,cachedInputTokens,tokens,complete:inputTokens!==null&&outputTokens!==null};
}
function summarizeViewAttempts(attempts){
  let inputTokens=0,inputReported=0,outputTokens=0,outputReported=0;
  let cachedInputTokens=0,cachedReported=0,tokens=0,tokenReported=0,reportedAttempts=0;
  for(const entry of attempts){
    const totals=tokenTotalsFromUsage(entry.attempt?.usage);
    if(!totals)continue;
    reportedAttempts+=1;
    if(totals.inputTokens!==null){inputTokens+=totals.inputTokens;inputReported+=1}
    if(totals.outputTokens!==null){outputTokens+=totals.outputTokens;outputReported+=1}
    if(totals.cachedInputTokens!==null){cachedInputTokens+=totals.cachedInputTokens;cachedReported+=1}
    if(totals.tokens!==null){tokens+=totals.tokens;tokenReported+=1}
  }
  return {
    inputTokens:inputReported?inputTokens:null,
    outputTokens:outputReported?outputTokens:null,
    cachedInputTokens:cachedReported?cachedInputTokens:null,
    tokens:tokenReported?tokens:null,
    attempts:attempts.length,
    reportedAttempts,
    complete:attempts.length>0
      &&reportedAttempts===attempts.length
      &&inputReported===attempts.length
      &&outputReported===attempts.length
  };
}
function viewQoderModels(attempts){
  const groups=new Map();
  for(const entry of attempts){
    const attempt=entry.attempt;
    const actual=nonEmpty(attempt.actualModel);
    const configured=nonEmpty(attempt.model);
    const model=actual||configured||null;
    const key=model??'';
    let group=groups.get(key);
    if(!group){
      group={model,source:actual?'actual':configured?'configured':'unknown',inputTokens:0,outputTokens:0,cachedInputTokens:0,cachedReported:0,attempts:0,reportedAttempts:0};
      groups.set(key,group);
    }
    group.attempts+=1;
    const totals=tokenTotalsFromUsage(attempt.usage);
    if(!totals)continue;
    group.reportedAttempts+=1;
    if(totals.inputTokens!==null)group.inputTokens+=totals.inputTokens;
    if(totals.outputTokens!==null)group.outputTokens+=totals.outputTokens;
    if(totals.cachedInputTokens!==null){group.cachedInputTokens+=totals.cachedInputTokens;group.cachedReported+=1}
  }
  return [...groups.values()]
    .map(group=>({
      model:group.model,
      source:group.source,
      inputTokens:group.reportedAttempts?group.inputTokens:null,
      outputTokens:group.reportedAttempts?group.outputTokens:null,
      cachedInputTokens:group.cachedReported?group.cachedInputTokens:null,
      attempts:group.attempts,
      reportedAttempts:group.reportedAttempts
    }))
    .sort((left,right)=>right.attempts-left.attempts||String(left.model??'').localeCompare(String(right.model??'')));
}
function acceptanceTime(acceptance){
  if(!isRecord(acceptance)||acceptance.stale===true)return null;
  return timeOf(acceptance.at);
}
function classifyStatus(tasks,completed){
  if(completed)return 'completed';
  if(!tasks.length)return 'unknown';
  const statuses=tasks.map(task=>lower(task.status));
  if(statuses.some(status=>ACTIVE_STATUSES.has(status)))return 'incomplete';
  if(statuses.every(status=>STOPPED_STATUSES.has(status)))return 'stopped';
  if(statuses.every(status=>FAILED_STATUSES.has(status)||STOPPED_STATUSES.has(status))){
    return statuses.some(status=>FAILED_STATUSES.has(status))?'failed':'stopped';
  }
  return 'incomplete';
}

export function groupViewThreads(views){
  const threads=new Map();
  views.forEach((view,index)=>{
    if(!isRecord(view))return;
    if(view.schemaVersion!==undefined&&view.schemaVersion!==1)return;
    const threadId=nonEmpty(view.binding?.threadId);
    if(!threadId)return;
    const rank=timeOf(view.observedAt)??-Infinity;
    let thread=threads.get(threadId);
    if(!thread){
      thread={
        threadId,title:null,titleRank:-Infinity,
        parentWorkId:null,parentWorkRank:-Infinity,
        rank:-Infinity,index:-1,parentStatus:null,parentCompletedAt:null,executors:new Map(),tasks:new Map()
      };
      threads.set(threadId,thread);
    }
    if(rank>thread.rank||(rank===thread.rank&&index>=thread.index)){
      thread.rank=rank;
      thread.index=index;
      thread.parentStatus=lower(view.parent?.status)||null;
      thread.parentCompletedAt=timeOf(view.parent?.completedAt??view.parent?.endedAt);
    }
    const title=cleanTitle(view.binding?.title);
    if(title&&rank>=thread.titleRank){thread.title=title;thread.titleRank=rank}
    const parentWorkId=nonEmpty(view.binding?.parentWorkId);
    if(parentWorkId&&rank>=thread.parentWorkRank){
      thread.parentWorkId=parentWorkId;
      thread.parentWorkRank=rank;
    }
    for(const member of Array.isArray(view.members)?view.members:[]){
      if(!isRecord(member))continue;
      const id=nonEmpty(member.id);
      const executor=nonEmpty(member.executor);
      if(id&&executor)thread.executors.set(id,executor);
    }
    for(const task of Array.isArray(view.tasks)?view.tasks:[]){
      if(!isRecord(task))continue;
      const id=nonEmpty(task.id);
      if(!id)continue;
      let entry=thread.tasks.get(id);
      if(!entry){
        entry={id,title:'',status:'unknown',acceptance:null,memberId:null,rank:-Infinity,attempts:new Map()};
        thread.tasks.set(id,entry);
      }
      if(rank>=entry.rank){
        entry.rank=rank;
        if(typeof task.title==='string')entry.title=task.title;
        entry.status=nonEmpty(task.status)??'unknown';
        entry.memberId=nonEmpty(task.memberId);
        if(task.acceptance!==undefined)entry.acceptance=task.acceptance;
      }
      (Array.isArray(task.attempts)?task.attempts:[]).forEach((attempt,position)=>{
        if(!isRecord(attempt))return;
        const key=attemptKey(attempt,position);
        const current=entry.attempts.get(key);
        if(current&&rank<current.rank)return;
        entry.attempts.set(key,{
          rank,
          position,
          attempt:{
            ...attempt,
            executor:nonEmpty(attempt.executor)
          }
        });
      });
    }
  });
  return [...threads.values()];
}

function sessionFor(codexUsage,threadId){
  if(!isRecord(codexUsage)||codexUsage.available!==true)return null;
  for(const session of Array.isArray(codexUsage.sessions)?codexUsage.sessions:[]){
    if(isRecord(session)&&nonEmpty(session.threadId)===threadId)return session;
  }
  return null;
}
function sessionTokens(session){
  const inputTokens=nonNegative(session?.inputTokens);
  const outputTokens=nonNegative(session?.outputTokens);
  const explicitTotal=nonNegative(session?.totalTokens);
  const tokens=inputTokens!==null&&outputTokens!==null?inputTokens+outputTokens:explicitTotal;
  return {inputTokens,outputTokens,tokens};
}
function sessionModels(session){
  const models=[];
  for(const model of Array.isArray(session?.models)?session.models:[]){
    if(!isRecord(model))continue;
    models.push({
      model:nonEmpty(model.model),
      source:'measured',
      inputTokens:nonNegative(model.inputTokens),
      outputTokens:nonNegative(model.outputTokens),
      cachedInputTokens:nonNegative(model.cachedInputTokens)
    });
  }
  return models;
}

function buildViewDelivery(thread,codexUsage,nowMs,fromMs){
  const tasks=[...thread.tasks.values()];
  const attempts=tasks.flatMap(task=>
    [...task.attempts.values()].map(entry=>({
      ...entry,
      attempt:{
        ...entry.attempt,
        executor:entry.attempt.executor??thread.executors.get(task.memberId)??'unknown'
      }
    }))
  ).sort(attemptOrder);
  const qoderAttempts=attempts.filter(entry=>lower(entry.attempt.executor)==='qoder');
  const qoder=summarizeViewAttempts(qoderAttempts);
  const acceptanceTimes=tasks.map(task=>acceptanceTime(task.acceptance));
  const parentEnded=thread.parentCompletedAt;
  const completed=['done','completed','accepted','succeeded'].includes(thread.parentStatus)
    &&parentEnded!==null&&parentEnded<=nowMs&&tasks.length>0
    &&acceptanceTimes.every(value=>value!==null&&value<=parentEnded);
  const completedAt=completed?parentEnded:null;
  const startedTimes=attempts.map(entry=>timeOf(entry.attempt.startedAt)).filter(value=>value!==null);
  const endedTimes=attempts.map(entry=>timeOf(entry.attempt.endedAt)).filter(value=>value!==null);
  const startedAt=startedTimes.length?Math.min(...startedTimes):null;
  const endedAt=endedTimes.length?Math.max(...endedTimes):null;
  const observedAt=Number.isFinite(thread.rank)?thread.rank:null;
  const lastActivityAt=completedAt
    ??endedAt
    ??(startedAt!==null&&startedAt<=nowMs?nowMs:startedAt)
    ??observedAt;
  const status=FAILED_STATUSES.has(thread.parentStatus)?'failed'
    :STOPPED_STATUSES.has(thread.parentStatus)?'stopped':classifyStatus(tasks,completed);
  const reasons=[];
  if(status==='incomplete')pushReason(reasons,'delivery-incomplete');
  else if(status==='failed')pushReason(reasons,'delivery-failed');
  else if(status==='stopped')pushReason(reasons,'delivery-stopped');
  else if(status==='unknown')pushReason(reasons,'delivery-unobserved');

  const session=sessionFor(codexUsage,thread.threadId);
  const codex=sessionTokens(session);
  if(!session)pushReason(reasons,'codex-usage-missing');
  else{
    pushReason(reasons,'codex-attribution-missing');
    if(fromMs!==null&&startedAt!==null&&startedAt<fromMs)pushReason(reasons,'codex-cross-period');
    if(codex.tokens===null)pushReason(reasons,'codex-usage-incomplete');
  }
  if(!qoderAttempts.length)pushReason(reasons,'qoder-not-involved');
  else if(!qoder.complete)pushReason(reasons,'qoder-usage-incomplete');
  if(completed)pushReason(reasons,'baseline-missing');

  const deliveryId=thread.parentWorkId?`${thread.parentWorkId}:${thread.threadId}`:`thread:${thread.threadId}`;
  return {
    deliveryId,
    threadId:thread.threadId,
    parentWorkId:thread.parentWorkId,
    title:thread.title,
    status,
    taskCount:tasks.length,
    evidenceSource:'views',
    observedInViews:true,
    range:{
      startedAt:iso(startedAt),
      completedAt:iso(completedAt),
      endedAt:iso(endedAt),
      lastActivityAt:iso(lastActivityAt)
    },
    actual:{
      codex:{
        tokens:codex.tokens,
        inputTokens:codex.inputTokens,
        outputTokens:codex.outputTokens,
        cachedInputTokens:nonNegative(session?.cachedInputTokens),
        models:sessionModels(session),
        complete:false,
        used:Boolean(session),
        scope:'host-thread-window',
        sourceRef:null
      },
      qoder:{
        tokens:qoder.tokens,
        inputTokens:qoder.inputTokens,
        outputTokens:qoder.outputTokens,
        cachedInputTokens:qoder.cachedInputTokens,
        models:viewQoderModels(qoderAttempts),
        attempts:qoder.attempts,
        reportedAttempts:qoder.reportedAttempts,
        complete:qoder.complete,
        used:qoderAttempts.length>0,
        sourceRef:null
      }
    },
    baseline:null,
    estimate:null,
    excludedReasons:publicReasons(reasons)
  };
}
function buildViewDeliveries(views,codexUsage,nowMs,fromMs){
  return groupViewThreads(views)
    .map(thread=>buildViewDelivery(thread,codexUsage,nowMs,fromMs))
    .filter(delivery=>delivery.taskCount>0||delivery.range.lastActivityAt!==null)
    .sort((left,right)=>String(left.deliveryId).localeCompare(String(right.deliveryId)));
}

function readEvidence(raw){
  if(!isRecord(raw))return null;
  const deliveryId=nonEmpty(raw.deliveryId);
  const threadId=nonEmpty(raw.threadId);
  const completedAt=timeOf(raw.completedAt);
  if(!deliveryId||!threadId||completedAt===null)return null;
  if(raw.accepted!==true)return null;
  const parentWorkId=nonEmpty(raw.parentWorkId);
  const expectedDeliveryId=parentWorkId?`${parentWorkId}:${threadId}`:`thread:${threadId}`;
  if(deliveryId!==expectedDeliveryId)return null;

  const native=raw.native===true;
  const conditions=readConditions(raw.conditions);
  const hardConditions=native
    ?readHardConditions(raw.hardConditions?.values)
    :{ok:false,values:null,missing:[...HARD_CONDITION_FIELDS]};
  // A native record is complete only after native lifecycle proof; when the
  // model has not confirmed a comparable baseline the delivery stays visible
  // as investment instead of being dropped.
  const pendingMatch=native&&raw.matchRequired===true&&!conditions.ok;
  if(native&&!conditions.ok&&!pendingMatch)return null;
  if(native&&conditions.ok){
    if(!hardConditions.ok)return null;
    const inconsistent=HARD_CONDITION_FIELDS.filter(field=>
      conditions.values[field]!==hardConditions.values[field]);
    if(inconsistent.length)return null;
  }

  const codexRaw=raw.actual?.codex;
  if(!isRecord(codexRaw))return null;
  const codexSourceRef=nonEmpty(codexRaw.sourceRef);
  const codexModels=readModelList(codexRaw.models,{allowUnknownModel:native});
  if(!codexSourceRef||!codexModels)return null;

  if(!isRecord(raw.actual?.qoder))return null;
  let qoder;
  if(raw.actual.qoder.used===false){
    qoder={used:false,sourceRef:null,models:[],complete:true,valid:true};
  }else if(raw.actual.qoder.used===true){
    const sourceRef=nonEmpty(raw.actual.qoder.sourceRef);
    const models=readModelList(raw.actual.qoder.models,{allowUnknownModel:native});
    qoder={
      used:true,
      sourceRef,
      models:models??[],
      complete:raw.actual.qoder.complete===true,
      valid:Boolean(sourceRef&&models&&raw.actual.qoder.complete===true)
    };
  }else return null;

  let baseline=null;
  if(raw.baseline!==undefined&&raw.baseline!==null){
    if(!isRecord(raw.baseline)){
      baseline={valid:false,incomplete:true,impure:false,models:null};
    }else{
      const nativeBaseline=raw.baseline.native===true;
      const sourceRef=nonEmpty(raw.baseline.sourceRef);
      const models=readModelList(raw.baseline.models);
      const baselineConditions=readConditions(raw.baseline.conditions);
      const baselineHard=nativeBaseline
        ?readHardConditions(raw.baseline.hardConditions?.values)
        :{ok:false,values:null,missing:[...HARD_CONDITION_FIELDS]};
      const hardConsistent=!nativeBaseline||(baselineHard.ok&&HARD_CONDITION_FIELDS.every(field=>
        baselineConditions.values?.[field]===baselineHard.values[field]));
      const pureCodex=raw.baseline.pureCodex===true
        &&!(isRecord(raw.baseline.qoder)&&raw.baseline.qoder.used===true);
      const complete=raw.baseline.complete===true
        &&raw.baseline.includesMain===true
        &&raw.baseline.includesSubagents===true;
      const baselineCompletedAt=timeOf(raw.baseline.completedAt);
      baseline={
        valid:Boolean(sourceRef&&models&&pureCodex&&complete&&baselineCompletedAt!==null
          &&baselineConditions.ok&&hardConsistent),
        incomplete:!complete||!models||baselineCompletedAt===null,
        impure:!pureCodex,
        native:nativeBaseline,
        sourceRef,
        threadId:nonEmpty(raw.baseline.threadId),
        title:cleanTitle(raw.baseline.title),
        models,
        pureCodex,
        complete,
        completedAt:baselineCompletedAt,
        conditions:baselineConditions,
        hardConditions:baselineHard,
        semanticConditions:isRecord(raw.baseline.semanticConditions)?raw.baseline.semanticConditions:null,
        semanticMatch:isRecord(raw.baseline.semanticMatch)?raw.baseline.semanticMatch:null
      };
    }
  }

  return {
    deliveryId,
    threadId,
    parentWorkId,
    title:cleanTitle(raw.title),
    completedAt,
    startedAt:timeOf(raw.range?.startedAt),
    native,
    pendingMatch,
    conditions,
    hardConditions,
    semanticConditions:isRecord(raw.semanticConditions)?raw.semanticConditions:null,
    semanticMatch:isRecord(raw.semanticMatch)?raw.semanticMatch:null,
    nativeSummary:isRecord(raw.nativeSummary)?raw.nativeSummary:null,
    codex:{
      sourceRef:codexSourceRef,
      models:codexModels,
      complete:codexRaw.complete===true
        &&codexRaw.includesMain===true
        &&codexRaw.includesSubagents===true
    },
    qoder,
    baseline
  };
}
function actualRef(kind,sourceRef){
  return sourceRef.startsWith(`${kind}:`)?sourceRef:`${kind}:${sourceRef}`;
}
function normalizeEvidenceList(deliveryEvidence){
  const entries=new Map(),actualRefs=new Set();
  let invalid=0,duplicate=0,provided=0;
  for(const raw of deliveryEvidence){
    provided+=1;
    const evidence=readEvidence(raw);
    if(!evidence){invalid+=1;continue}
    if(entries.has(evidence.deliveryId)){duplicate+=1;continue}
    const refs=[actualRef('codex',evidence.codex.sourceRef),...(evidence.qoder.used&&evidence.qoder.sourceRef?[actualRef('qoder',evidence.qoder.sourceRef)]:[])];
    if(refs.some(ref=>actualRefs.has(ref))){duplicate+=1;continue}
    refs.forEach(ref=>actualRefs.add(ref));
    entries.set(evidence.deliveryId,evidence);
  }
  return {entries,coverage:{provided,valid:entries.size,invalid,duplicate}};
}

function readSpeedSamples(rawSamples,{nowMs,speedWindowDays}){
  const fromMs=nowMs-speedWindowDays*DAY_MS;
  const seen=new Set(),modelSamples=new Map(),runSamples=new Map();
  let invalid=0,stale=0,duplicate=0;
  for(const raw of rawSamples){
    if(!isRecord(raw)){invalid+=1;continue}
    const sourceRef=nonEmpty(raw.sourceRef),model=nonEmpty(raw.model);
    const outputTokens=positive(raw.outputTokens),durationMs=positive(raw.durationMs),endedAt=timeOf(raw.endedAt);
    const scope=raw.scope==='model'||raw.scope==='run'?raw.scope:null;
    const actual=raw.source==='actual'||raw.modelSource==='actual'||raw.actual===true;
    if(!sourceRef||!model||outputTokens===null||durationMs===null||endedAt===null||!scope||!actual){invalid+=1;continue}
    if(endedAt>nowMs||endedAt<fromMs){stale+=1;continue}
    if(seen.has(sourceRef)){duplicate+=1;continue}
    seen.add(sourceRef);
    const sample={sourceRef,tokensPerSecond:outputTokens/(durationMs/1000)};
    const groups=scope==='model'?modelSamples:runSamples;
    if(!groups.has(model))groups.set(model,[]);
    groups.get(model).push(sample);
  }
  const groups=(input,basis)=>[...input].map(([model,samples])=>({
    model,basis,samples:samples.length,tokensPerSecond:median(samples.map(sample=>sample.tokensPerSecond)),
    rough:basis==='run',window:{from:iso(fromMs),to:iso(nowMs),days:speedWindowDays}
  })).sort((a,b)=>a.model.localeCompare(b.model));
  const models=groups(modelSamples,'model'),runs=groups(runSamples,'run');
  return {
    speeds:[...models,...runs],modelSpeeds:new Map(models.map(speed=>[speed.model,speed])),
    runSpeed:new Map(runs.map(speed=>[speed.model,speed])),
    window:{from:iso(fromMs),to:iso(nowMs),days:speedWindowDays},
    coverage:{samples:[...models,...runs].reduce((sum,speed)=>sum+speed.samples,0),modelSamples:models.length,
      runSamples:runs.reduce((sum,speed)=>sum+speed.samples,0),invalidSamples:invalid,staleSamples:stale,duplicateSamples:duplicate}
  };
}
function speedFor(model,modelSpeeds,runSpeed,unit,missing,usedRunModels){
  if(model===null){
    missing.push({model:null,unit});
    return null;
  }
  const measured=modelSpeeds.get(model);
  if(measured)return {tokensPerSecond:measured.tokensPerSecond,basis:'model',rough:false};
  const coarse=runSpeed.get(model);
  if(coarse){
    usedRunModels.add(model);
    return {tokensPerSecond:coarse.tokensPerSecond,basis:'run',rough:true};
  }
  missing.push({model,unit});
  return null;
}
function timeEstimate({baselineModels,codexModels,qoderModels,modelSpeeds,runSpeed,reasons}){
  const groups=[['baseline',baselineModels],['actual-codex',codexModels],['qoder',qoderModels]];
  const missing=[],usedRunModels=new Set(),parts=[];
  let baselineSeconds=0,squadSeconds=0;
  for(const [unit,models] of groups){
    for(const model of models){
      if(!(model.outputTokens>0))continue;
      const speed=speedFor(model.model,modelSpeeds,runSpeed,unit,missing,usedRunModels);
      if(!speed){parts.push({side:unit,model:model.model,outputTokens:model.outputTokens,tokensPerSecond:null,seconds:null,basis:null});continue;}
      const seconds=model.outputTokens/speed.tokensPerSecond;
      parts.push({side:unit,model:model.model,outputTokens:model.outputTokens,tokensPerSecond:speed.tokensPerSecond,seconds:round(seconds,3),basis:speed.basis});
      if(unit==='baseline')baselineSeconds+=seconds;
      else squadSeconds+=seconds;
    }
  }
  if(missing.length){
    for(const item of missing)pushReason(reasons,'speed-missing-model',item);
    return {baselineSeconds:null,squadSeconds:null,secondsSaved:null,timeSavingRate:null,timeBasis:null,timeRough:false,parts};
  }
  if(usedRunModels.size)pushReason(reasons,'speed-run-basis',{models:[...usedRunModels].sort()});
  const secondsSaved=baselineSeconds-squadSeconds;
  return {
    baselineSeconds:round(baselineSeconds,3),
    squadSeconds:round(squadSeconds,3),
    secondsSaved:round(secondsSaved,3),
    timeSavingRate:baselineSeconds>0?round(secondsSaved/baselineSeconds,6):null,
    timeBasis:usedRunModels.size?'run':'model',
    timeRough:usedRunModels.size>0,
    parts
  };
}

function buildEvidenceDelivery(evidence,view,{modelSpeeds,runSpeed}){
  const reasons=[];
  const codexTotals=sumModels(evidence.codex.models);
  if(!evidence.codex.complete)pushReason(reasons,'actual-incomplete');
  let qoderTotals={inputTokens:0,outputTokens:0,cachedInputTokens:null,tokens:0};
  let qoderComplete=!evidence.qoder.used;
  if(evidence.qoder.used){
    qoderComplete=evidence.qoder.valid;
    if(qoderComplete)qoderTotals=sumModels(evidence.qoder.models);
    else pushReason(reasons,'qoder-usage-incomplete');
  }

  let baseline=null,baselineEligible=false;
  if(!evidence.baseline){
    pushReason(reasons,evidence.pendingMatch?'baseline-match-pending':'baseline-missing');
  }else if(evidence.baseline.valid){
    baselineEligible=true;
  }else if(evidence.baseline.impure){
    pushReason(reasons,'baseline-impure');
  }else if(evidence.baseline.conditions&&!evidence.baseline.conditions.ok){
    pushReason(reasons,'baseline-conditions-missing',{fields:evidence.baseline.conditions.missing});
  }else{
    pushReason(reasons,'baseline-incomplete');
  }
  if(evidence.baseline?.models){
    const totals=sumModels(evidence.baseline.models);
    baseline={
      tokens:totals.tokens,
      inputTokens:totals.inputTokens,
      outputTokens:totals.outputTokens,
      cachedInputTokens:totals.cachedInputTokens,
      models:evidence.baseline.models.map(model=>({model:model.model,inputTokens:model.inputTokens,outputTokens:model.outputTokens})),
      sourceRef:evidence.baseline.sourceRef??null,
      threadId:evidence.baseline.threadId??null,
      sources:evidence.baseline.threadId?[{threadId:evidence.baseline.threadId,title:evidence.baseline.title,sourceRef:evidence.baseline.sourceRef}]:[],
      completedAt:iso(evidence.baseline.completedAt??null),
      pureCodex:Boolean(evidence.baseline.pureCodex),
      complete:Boolean(evidence.baseline.complete),
      native:Boolean(evidence.baseline.native),
      conditions:evidence.baseline.conditions?.values??null,
      semanticConditions:evidence.baseline.semanticConditions??null,
      semanticMatch:evidence.baseline.semanticMatch??null,
      conditionsMatched:false
    };
  }
  if(baselineEligible){
    if(!evidence.conditions.ok){
      baselineEligible=false;
      pushReason(reasons,'baseline-conditions-missing',{fields:evidence.conditions.missing});
    }else{
      // A native pair was semantically matched before it was frozen; the model's
      // cited excerpts differ by side, so only hard conditions must be equal here.
      const comparedFields=evidence.native&&evidence.baseline.native
        &&evidence.semanticMatch&&evidence.baseline.semanticMatch
        ?HARD_CONDITION_FIELDS:CONDITION_FIELDS;
      const mismatched=comparedFields.filter(field=>
        evidence.conditions.values[field]!==evidence.baseline.conditions.values[field]);
      if(mismatched.length){
        baselineEligible=false;
        pushReason(reasons,'baseline-conditions-mismatch',{fields:mismatched});
      }else{
        const historicalPoint=evidence.completedAt;
        if(evidence.baseline.completedAt>=historicalPoint){
          baselineEligible=false;
          pushReason(reasons,'baseline-not-historical');
        }
      }
    }
  }
  if(baseline)baseline.conditionsMatched=baselineEligible;

  let status='completed';
  if(!evidence.native&&view&&view.status!=='completed'){
    // A backlog root in the view is a binding placeholder; native lifecycle
    // evidence is authoritative for native records.
    status=view.status;
    pushReason(reasons,'evidence-view-conflict');
  }
  const tokenEligible=evidence.codex.complete&&qoderComplete&&baselineEligible&&status==='completed';
  let estimate=null;
  if(tokenEligible){
    const baselineTotals=sumModels(evidence.baseline.models);
    const codexTokensSaved=baselineTotals.tokens-codexTotals.tokens;
    const time=timeEstimate({
      baselineModels:evidence.baseline.models,
      codexModels:evidence.codex.models,
      qoderModels:evidence.qoder.used?evidence.qoder.models:[],
      modelSpeeds,
      runSpeed,
      reasons
    });
    estimate={
      codexTokensSaved,
      tokenSavingRate:baselineTotals.tokens>0?round(codexTokensSaved/baselineTotals.tokens,6):null,
      baselineSeconds:time?time.baselineSeconds:null,
      squadSeconds:time?time.squadSeconds:null,
      secondsSaved:time?time.secondsSaved:null,
      timeSavingRate:time?time.timeSavingRate:null,
      timeBasis:time?time.timeBasis:null,
      timeRough:time?time.timeRough:false,
      processing:time?time.parts:[]
    };
  }
  return {
    deliveryId:evidence.deliveryId,
    threadId:evidence.threadId,
    parentWorkId:evidence.parentWorkId??view?.parentWorkId??null,
    title:evidence.title??view?.title??null,
    status,
    taskCount:evidence.nativeSummary?.tasks??view?.taskCount??null,
    evidenceSource:evidence.native?'native-delivery':'delivery-evidence',
    native:evidence.native,
    matchPending:evidence.pendingMatch===true,
    conditions:evidence.conditions.ok?evidence.conditions.values:null,
    hardConditions:evidence.hardConditions.ok?evidence.hardConditions.values:null,
    semanticMatch:evidence.semanticMatch??null,
    nativeSummary:evidence.nativeSummary??null,
    observedInViews:Boolean(view),
    range:{
      startedAt:iso(evidence.startedAt??timeOf(view?.range?.startedAt)),
      completedAt:iso(evidence.completedAt),
      endedAt:iso(evidence.completedAt),
      lastActivityAt:iso(evidence.completedAt)
    },
    actual:{
      codex:{
        tokens:codexTotals.tokens,
        inputTokens:codexTotals.inputTokens,
        outputTokens:codexTotals.outputTokens,
        cachedInputTokens:codexTotals.cachedInputTokens,
        models:evidence.codex.models,
        complete:evidence.codex.complete,
        used:true,
        scope:'delivery-evidence',
        sourceRef:evidence.codex.sourceRef
      },
      qoder:{
        tokens:evidence.qoder.used?qoderTotals.tokens:0,
        inputTokens:evidence.qoder.used?qoderTotals.inputTokens:0,
        outputTokens:evidence.qoder.used?qoderTotals.outputTokens:0,
        cachedInputTokens:evidence.qoder.used?qoderTotals.cachedInputTokens:null,
        models:evidence.qoder.used?evidence.qoder.models:[],
        attempts:null,
        reportedAttempts:null,
        complete:qoderComplete,
        used:evidence.qoder.used,
        sourceRef:evidence.qoder.sourceRef
      }
    },
    baseline,
    estimate,
    excludedReasons:publicReasons(reasons)
  };
}

function periodOf({days,nowMs}){
  return {days,fromMs:days===null?null:nowMs-days*DAY_MS,toMs:nowMs};
}
function inPeriod(delivery,{fromMs,toMs}){
  const point=timeOf(delivery.range.completedAt)??timeOf(delivery.range.lastActivityAt);
  if(point===null)return false;
  return point<=toMs&&(fromMs===null||point>=fromMs);
}
function reasonCounts(deliveries){
  const counts=new Map();
  for(const delivery of deliveries){
    for(const reason of delivery.excludedReasons){
      const key=`${reason.code}\u0000${reason.detail?JSON.stringify(reason.detail):''}`;
      let row=counts.get(key);
      if(!row){
        row={code:reason.code,label:reason.label,count:0};
        if(reason.detail)row.detail=reason.detail;
        counts.set(key,row);
      }
      row.count+=1;
    }
  }
  return [...counts.values()].sort((left,right)=>
    right.count-left.count
    ||left.code.localeCompare(right.code)
    ||JSON.stringify(left.detail??null).localeCompare(JSON.stringify(right.detail??null)));
}
function summarize(deliveries){
  let baselineCodexTokens=0,actualCodexTokens=0,qoderTokens=0,tokenEstimatedDeliveries=0;
  let baselineSeconds=0,squadSeconds=0,timeEstimatedDeliveries=0,timeRough=false;
  for(const delivery of deliveries){
    if(!delivery.estimate)continue;
    tokenEstimatedDeliveries+=1;
    baselineCodexTokens+=delivery.baseline.tokens;
    actualCodexTokens+=delivery.actual.codex.tokens;
    qoderTokens+=delivery.actual.qoder.tokens??0;
    if(delivery.estimate.secondsSaved!==null){
      timeEstimatedDeliveries+=1;
      baselineSeconds+=delivery.estimate.baselineSeconds;
      squadSeconds+=delivery.estimate.squadSeconds;
      timeRough=timeRough||delivery.estimate.timeRough===true;
    }
  }
  if(!tokenEstimatedDeliveries){
    return {
      summary:{
        baselineCodexTokens:null,
        actualCodexTokens:null,
        qoderTokens:null,
        codexTokensSaved:null,
        tokenSavingRate:null,
        baselineSeconds:null,
        squadSeconds:null,
        secondsSaved:null,
        timeSavingRate:null
      },
      tokenEstimatedDeliveries,
      timeEstimatedDeliveries,
      timeRough:false
    };
  }
  const saved=baselineCodexTokens-actualCodexTokens;
  const hasTime=timeEstimatedDeliveries===tokenEstimatedDeliveries;
  const secondsSaved=hasTime?baselineSeconds-squadSeconds:null;
  return {
    summary:{
      baselineCodexTokens,
      actualCodexTokens,
      qoderTokens,
      codexTokensSaved:saved,
      tokenSavingRate:baselineCodexTokens>0?round(saved/baselineCodexTokens,6):null,
      baselineSeconds:hasTime?round(baselineSeconds,3):null,
      squadSeconds:hasTime?round(squadSeconds,3):null,
      secondsSaved:hasTime?round(secondsSaved,3):null,
      timeSavingRate:hasTime&&baselineSeconds>0?round(secondsSaved/baselineSeconds,6):null
    },
    tokenEstimatedDeliveries,
    timeEstimatedDeliveries,
    timeRough
  };
}
function observationOf({summary,coverage}){
  if(coverage.tokenEstimatedDeliveries>0){
    return `本期 ${coverage.tokenEstimatedDeliveries} 个完整交付已有可比较的历史基线；收益据此估算。`;
  }
  if(coverage.pendingMatchDeliveries>0){
    return `本期 ${coverage.pendingMatchDeliveries} 个完整交付已完成，但尚未确认与历史基线的语义可比性，暂无法估算收益。`;
  }
  if(coverage.observedDeliveries===0){
    return '本期没有观察到可归集的完整交付，暂无法估算收益。';
  }
  return `本期观察到 ${coverage.observedDeliveries} 项工作；现有记录尚不足以比较小队收益，暂无法估算。`;
}

/**
 * Delivery-level Codex benefits for one frozen analysis window.
 *
 * The `views` path groups snapshots by host threadId plus the latest binding.parentWorkId,
 * merges tasks and attempts across snapshots, sums the full lifecycle, and reads the
 * host-thread Codex window. It only reports investment and concrete gaps; it never
 * estimates without a baseline.
 *
 * `deliveryEvidence` is the strict optional contract for a future collector. Each entry:
 * {
 *   deliveryId, threadId, parentWorkId|null, accepted:true, completedAt,
 *   title?, range?:{startedAt?},
 *   conditions:{workType,scale,model,reasoning,acceptance,tools,permissions},
 *   actual:{
 *     codex:{sourceRef,complete:true,includesMain:true,includesSubagents:true,
 *       models:[{model,source:'actual',inputTokens,outputTokens,cachedInputTokens?}]},
 *     qoder:{used:true,sourceRef,complete:true,models:[...]} | {used:false}
 *   },
 *   baseline:null | {sourceRef,pureCodex:true,complete:true,includesMain:true,
 *     includesSubagents:true,completedAt,
 *     conditions:{workType,scale,model,reasoning,acceptance,tools,permissions},
 *     models:[{model,source:'actual',inputTokens,outputTokens,cachedInputTokens?}]}
 * }
 * deliveryId must be `${parentWorkId}:${threadId}` or `thread:${threadId}`. Duplicate
 * deliveryIds are ignored after the first; duplicate model names in one list invalidate
 * that record; model `source` must be `actual`; tokens are input+output only and cached
 * input is never added; baseline and delivery conditions must all be present and equal;
 * the baseline must be pure Codex and completed before the delivery.
 *
 * `speedSamples` entries are
 * {sourceRef,scope:'model'|'run',model,source:'actual',outputTokens>0,durationMs>0,endedAt}; configured,
 * stale, malformed and duplicate samples never participate. A `run` sample is only a
 * documented rough fallback when a model has no model-scoped sample.
 */
export function buildSquadBenefits({
  views=[],codexUsage=null,now=new Date(),days=null,
  deliveryEvidence=null,speedSamples=null,speedWindowDays=DEFAULT_SPEED_WINDOW_DAYS,
  baseBenefits=null
}={}){
  if(!Array.isArray(views))throw new TypeError('views 必须是数组。');
  if(!(days===null||days===7||days===30))throw new RangeError('days 只支持 7、30 或 null。');
  const at=now instanceof Date?new Date(now.getTime()):new Date(now);
  if(!Number.isFinite(at.getTime()))throw new TypeError('now 必须是有效时间。');
  if(codexUsage!==null&&codexUsage!==undefined&&!isRecord(codexUsage))throw new TypeError('codexUsage 必须是对象或 null。');
  if(deliveryEvidence!==null&&deliveryEvidence!==undefined&&!Array.isArray(deliveryEvidence))throw new TypeError('deliveryEvidence 必须是数组或 null。');
  if(speedSamples!==null&&speedSamples!==undefined&&!Array.isArray(speedSamples))throw new TypeError('speedSamples 必须是数组或 null。');
  if(baseBenefits!==null&&baseBenefits!==undefined&&!isRecord(baseBenefits))throw new TypeError('baseBenefits 必须是对象或 null。');
  if(typeof speedWindowDays!=='number'||!Number.isFinite(speedWindowDays)||speedWindowDays<=0){
    throw new RangeError('speedWindowDays 必须是正数。');
  }

  const nowMs=at.getTime();
  const period=periodOf({days,nowMs});
  const speedData=readSpeedSamples(Array.isArray(speedSamples)?speedSamples:[],{nowMs,speedWindowDays});
  const evidenceData=normalizeEvidenceList(Array.isArray(deliveryEvidence)?deliveryEvidence:[]);
  const viewDeliveries=buildViewDeliveries(views,codexUsage,nowMs,period.fromMs);
  const viewById=new Map(viewDeliveries.map(delivery=>[delivery.deliveryId,delivery]));
  const structuredIds=new Set(evidenceData.entries.keys());
  const selected=new Map();
  let outsidePeriodDeliveries=0;
  for(const delivery of viewDeliveries){
    if(structuredIds.has(delivery.deliveryId))continue;
    if(!inPeriod(delivery,period)){outsidePeriodDeliveries+=1;continue}
    selected.set(delivery.deliveryId,delivery);
  }
  for(const evidence of evidenceData.entries.values()){
    const delivery=buildEvidenceDelivery(evidence,viewById.get(evidence.deliveryId)??null,{
      modelSpeeds:speedData.modelSpeeds,
      runSpeed:speedData.runSpeed
    });
    if(!inPeriod(delivery,period)){outsidePeriodDeliveries+=1;continue}
    selected.set(delivery.deliveryId,delivery);
  }
  // Matching recomputes benefits from the frozen native sources; view-only
  // deliveries from the same window must survive that pass unchanged.
  const merged=new Map();
  for(const delivery of Array.isArray(baseBenefits?.deliveries)?baseBenefits.deliveries:[]){
    if(!isRecord(delivery))continue;
    const id=nonEmpty(delivery.deliveryId);
    if(!id||selected.has(id)||merged.has(id))continue;
    if(!isRecord(delivery.actual?.codex)||!Array.isArray(delivery.excludedReasons))continue;
    if(!inPeriod(delivery,period)){outsidePeriodDeliveries+=1;continue}
    merged.set(id,delivery);
  }
  for(const [id,delivery] of selected)merged.set(id,delivery);

  const deliveries=[...merged.values()].sort((left,right)=>
    String(right.range.completedAt??right.range.lastActivityAt??'').localeCompare(
      String(left.range.completedAt??left.range.lastActivityAt??'')
    )||left.deliveryId.localeCompare(right.deliveryId)
  );
  const aggregate=summarize(deliveries);
  const coverage={
    observedDeliveries:deliveries.length,
    completedDeliveries:deliveries.filter(delivery=>delivery.status==='completed').length,
    incompleteDeliveries:deliveries.filter(delivery=>delivery.status==='incomplete').length,
    failedDeliveries:deliveries.filter(delivery=>delivery.status==='failed').length,
    stoppedDeliveries:deliveries.filter(delivery=>delivery.status==='stopped').length,
    unknownDeliveries:deliveries.filter(delivery=>delivery.status==='unknown').length,
    viewDeliveries:deliveries.filter(delivery=>delivery.evidenceSource==='views').length,
    structuredDeliveries:deliveries.filter(delivery=>delivery.evidenceSource!=='views').length,
    nativeDeliveries:deliveries.filter(delivery=>delivery.evidenceSource==='native-delivery').length,
    pendingMatchDeliveries:deliveries.filter(delivery=>delivery.matchPending===true).length,
    tokenEstimatedDeliveries:aggregate.tokenEstimatedDeliveries,
    timeEstimatedDeliveries:aggregate.timeEstimatedDeliveries,
    timeRough:aggregate.timeRough,
    outsidePeriodDeliveries,
    codexUsage:{
      available:codexUsage?.available===true,
      sessions:Array.isArray(codexUsage?.sessions)?codexUsage.sessions.length:0,
      note:typeof codexUsage?.note==='string'?codexUsage.note:null
    },
    deliveryEvidence:evidenceData.coverage,
    speeds:speedData.coverage,
    reasons:reasonCounts(deliveries)
  };
  return {
    schemaVersion:1,
    generatedAt:at.toISOString(),
    range:{
      days,
      from:period.fromMs===null?null:new Date(period.fromMs).toISOString(),
      to:at.toISOString()
    },
    summary:aggregate.summary,
    coverage,
    observation:observationOf({summary:aggregate.summary,coverage}),
    deliveries,
    speeds:speedData.speeds,
    speedWindow:speedData.window,
    note:NOTE
  };
}

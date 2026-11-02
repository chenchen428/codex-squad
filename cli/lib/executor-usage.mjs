const TOKEN_KEYS=['inputTokens','cachedInputTokens','outputTokens','totalTokens'];

const NOTE='仅统计 member.executor=qoder 的已记录用量；缺失字段保留 null，缓存输入已包含在 inputTokens 中不重复相加；无开始时间或不在窗口内的执行不计入合计，仅计入覆盖；不换算费用，也不与 Codex Token 作等价比较。';

function lower(value){return typeof value==='string'?value.trim().toLowerCase():''}
function timeOf(value){
  if(value instanceof Date)return Number.isFinite(value.getTime())?value.getTime():null;
  if(typeof value==='number')return Number.isFinite(value)?value:null;
  if(typeof value!=='string'||!value.trim())return null;
  const parsed=Date.parse(value);return Number.isFinite(parsed)?parsed:null;
}
function attemptKey(attempt,position){
  const id=typeof attempt?.id==='string'?attempt.id.trim():'';
  if(id)return `id:${id}`;
  const index=Number(attempt?.index);
  if(Number.isFinite(index))return `index:${index}`;
  return `position:${position}`;
}
function tokenSummary(attempts){
  const sums=Object.fromEntries(TOKEN_KEYS.map(key=>[key,0]));
  const reported=Object.fromEntries(TOKEN_KEYS.map(key=>[key,0]));
  let reportedAttempts=0;
  for(const attempt of attempts){
    let any=false;
    for(const key of TOKEN_KEYS){
      const value=attempt?.usage?.[key];
      if(typeof value==='number'&&Number.isFinite(value)){sums[key]+=value;reported[key]+=1;any=true}
    }
    if(any)reportedAttempts+=1;
  }
  const tokens=Object.fromEntries(TOKEN_KEYS.map(key=>[key,reported[key]?sums[key]:null]));
  const coverage={
    reportedAttempts,
    totalAttempts:attempts.length,
    ...Object.fromEntries(TOKEN_KEYS.map(key=>[key,{reported:reported[key],total:attempts.length}]))
  };
  return {tokens,coverage};
}
function modelOf(attempt){
  const actual=typeof attempt?.actualModel==='string'&&attempt.actualModel.trim()?attempt.actualModel.trim():null;
  if(actual)return {model:actual,source:'actual'};
  const configured=typeof attempt?.model==='string'&&attempt.model.trim()?attempt.model.trim():null;
  if(configured)return {model:configured,source:'configured'};
  return {model:null,source:'unknown'};
}
function modelGroups(attempts){
  const groups=new Map();
  for(const attempt of attempts){
    const {model,source}=modelOf(attempt);
    const key=model??'';
    let group=groups.get(key);
    if(!group){
      group={model,actualAttempts:0,configuredAttempts:0,unknownAttempts:0,attempts:[]};
      groups.set(key,group);
    }
    group.attempts.push(attempt);
    if(source==='actual')group.actualAttempts+=1;
    else if(source==='configured')group.configuredAttempts+=1;
    else group.unknownAttempts+=1;
  }
  return [...groups.values()].map(group=>{
    const summary=tokenSummary(group.attempts);
    const total=group.attempts.length;
    const source=group.actualAttempts===total?'actual'
      :group.configuredAttempts===total?'configured'
      :group.unknownAttempts===total?'unknown':'mixed';
    return {
      model:group.model,
      source,
      attempts:total,
      reportedAttempts:summary.coverage.reportedAttempts,
      actualAttempts:group.actualAttempts,
      configuredAttempts:group.configuredAttempts,
      unknownAttempts:group.unknownAttempts,
      tokens:summary.tokens
    };
  }).sort((left,right)=>
    right.attempts-left.attempts
    ||(right.tokens.totalTokens??-1)-(left.tokens.totalTokens??-1)
    ||String(left.model??'').localeCompare(String(right.model??''))
  );
}
function normalizeThreads(threads){
  const byThread=new Map();
  for(const thread of threads){
    if(!thread||typeof thread!=='object')continue;
    const threadId=typeof thread.threadId==='string'?thread.threadId.trim():'';
    if(!threadId)continue;
    let entry=byThread.get(threadId);
    if(!entry){
      entry={threadId,title:null,tasks:new Map()};
      byThread.set(threadId,entry);
    }
    if(typeof thread.title==='string'&&thread.title.trim())entry.title=thread.title;
    for(const task of Array.isArray(thread.tasks)?thread.tasks:[]){
      if(!task||typeof task!=='object')continue;
      const taskId=typeof task.id==='string'?task.id.trim():'';
      if(!taskId)continue;
      let attempts=entry.tasks.get(taskId);
      if(!attempts){attempts=new Map();entry.tasks.set(taskId,attempts)}
      (Array.isArray(task.attempts)?task.attempts:[]).forEach((attempt,position)=>{
        if(!attempt||typeof attempt!=='object')return;
        // Repeated snapshots carrying the same execution collapse onto one key.
        attempts.set(attemptKey(attempt,position),attempt);
      });
    }
  }
  return [...byThread.values()];
}
/**
 * Same-window token usage for one executor, grouped by the native host threadId.
 * Codex paths never synthesize actualModel and never convert or compare provider tokens.
 */
export function buildExecutorUsage(threads,{executor='qoder',now=new Date(),days=null}={}){
  if(!Array.isArray(threads))throw new TypeError('threads 必须是数组。');
  if(!(days===null||days===7||days===30))throw new RangeError('days 只支持 7、30 或 null。');
  const at=now instanceof Date?new Date(now.getTime()):new Date(now);
  if(!Number.isFinite(at.getTime()))throw new TypeError('now 必须是有效时间。');
  const wanted=lower(executor);
  if(!wanted)throw new TypeError('executor 必须是非空字符串。');
  const nowMs=at.getTime();
  const fromMs=days===null?null:nowMs-days*86400000;
  let executedAttempts=0,undatedAttempts=0,futureAttempts=0,beforeWindowAttempts=0;
  const included=[];
  const sessions=[];
  for(const thread of normalizeThreads(threads)){
    const attempts=[];
    for(const taskAttempts of thread.tasks.values()){
      for(const attempt of taskAttempts.values()){
        if(lower(attempt.executor)!==wanted)continue;
        executedAttempts+=1;
        const started=timeOf(attempt.startedAt);
        if(started===null){undatedAttempts+=1;continue}
        if(started>nowMs){futureAttempts+=1;continue}
        if(fromMs!==null&&started<fromMs){beforeWindowAttempts+=1;continue}
        attempts.push(attempt);
      }
    }
    if(!attempts.length)continue;
    const summary=tokenSummary(attempts);
    sessions.push({
      threadId:thread.threadId,
      title:thread.title,
      tokens:summary.tokens,
      coverage:summary.coverage,
      models:modelGroups(attempts)
    });
    included.push(...attempts);
  }
  const total=tokenSummary(included);
  sessions.sort((left,right)=>
    (right.tokens.totalTokens??-1)-(left.tokens.totalTokens??-1)
    ||right.coverage.totalAttempts-left.coverage.totalAttempts
    ||left.threadId.localeCompare(right.threadId)
  );
  return {
    schemaVersion:1,
    executor:wanted,
    available:total.coverage.totalAttempts>0,
    observedAt:at.toISOString(),
    range:{days,from:fromMs===null?null:new Date(fromMs).toISOString(),to:at.toISOString()},
    totals:total.tokens,
    coverage:{
      ...total.coverage,
      executedAttempts,
      undatedAttempts,
      futureAttempts,
      beforeWindowAttempts
    },
    models:modelGroups(included),
    sessions,
    note:NOTE
  };
}

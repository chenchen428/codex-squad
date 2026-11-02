import {aggregateCliCalls} from './cli-metrics.mjs';
import {buildExecutorUsage} from './executor-usage.mjs';

const TOKEN_KEYS=['inputTokens','outputTokens','cachedInputTokens','totalTokens'];
const ACTIVE_STATUSES=new Set(['starting','running','stopping','in_progress']);
const RETURNED_STATUSES=new Set(['completed','waiting_review','in_review','accepted','done']);
const FAILED_STATUSES=new Set(['failed']);
const STOPPED_STATUSES=new Set(['stopped','interrupted']);
const PENDING_STATUSES=new Set(['idle','backlog','todo','queued']);
const FAILED_ATTEMPT_STATUSES=new Set(['failed','error']);
const TOOL_KINDS=new Set(['tool','tool_use','tool_result']);
const SUCCEEDED_TOOL_STATUSES=new Set(['completed','succeeded','success','ok','done']);
const FAILED_TOOL_STATUSES=new Set(['failed','failure','error']);

function lower(value){return typeof value==='string'?value.trim().toLowerCase():''}
function timeOf(value){
  if(value instanceof Date)return Number.isFinite(value.getTime())?value.getTime():null;
  if(typeof value==='number')return Number.isFinite(value)?value:null;
  if(typeof value!=='string'||!value.trim())return null;
  const parsed=Date.parse(value);return Number.isFinite(parsed)?parsed:null;
}
function validAcceptance(task){return Boolean(task?.acceptance&&typeof task.acceptance==='object'&&!Array.isArray(task.acceptance)&&task.acceptance.stale!==true)}
function taskStatus(task){return typeof task?.status==='string'&&task.status.trim()?task.status.trim():'unknown'}
function categoryOf(status,accepted){
  const value=lower(status);
  if(accepted)return 'returned';
  if(ACTIVE_STATUSES.has(value))return 'running';
  if(RETURNED_STATUSES.has(value))return 'returned';
  if(FAILED_STATUSES.has(value))return 'failed';
  if(STOPPED_STATUSES.has(value))return 'stopped';
  if(value==='blocked')return 'blocked';
  if(PENDING_STATUSES.has(value))return 'pending';
  return 'unknown';
}
function attemptToolOutcome(event){
  const status=lower(event?.status);
  if(SUCCEEDED_TOOL_STATUSES.has(status))return 'succeeded';
  if(FAILED_TOOL_STATUSES.has(status))return 'failed';
  if(event?.ok===true)return 'succeeded';
  if(event?.ok===false)return 'failed';
  return 'unknown';
}
function skillReadName(record){
  const tool=lower(record?.toolName);
  if(tool!=='read'&&tool!=='read_file')return null;
  const raw=typeof record.callText==='string'?record.callText:'';
  const text=raw.trim();
  if(!text||text!==raw||/\s/.test(text))return null;
  if(/[;&|<>'"`$*?{}\[\]()]/.test(text)||text.includes(':'))return null;
  const parts=text.split(/[\\/]+/).filter(Boolean);
  if(parts.length<2||parts.at(-1)!=='SKILL.md')return null;
  const name=parts.at(-2);
  if(!name||name==='.'||name==='..'||name.length>64||!/^[\p{L}\p{N}._@+-]+$/u.test(name))return null;
  return name;
}
function businessText(value,limit=600){
  if(typeof value!=='string')return '';
  const cleaned=value
    .replace(/\b(?:https?|file):\/\/\S+/gi,'[链接]')
    .replace(/(?:^|[\s(（])(?:~?\/|[A-Za-z]:[\\/])[^\s，。；、,;'"`<>]{2,}/g,' [路径]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|AKIA[A-Z0-9]{12,}|xox[baprs]-[A-Za-z0-9-]{8,}|Bearer\s+[A-Za-z0-9._~+/=-]{8,})/g,'[敏感值]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,' ')
    .replace(/\s+/g,' ')
    .trim();
  return cleaned.slice(0,limit);
}
function latestGoal(entries){
  let goal='';
  for(const entry of [...entries].sort(attemptOrder)){
    const value=businessText(entry.attempt?.handoff?.goal,600);
    if(value)goal=value;
  }
  return goal;
}
function taskTools(records){
  const tools=new Map();
  for(const record of records){
    const name=businessText(record.toolName,80)||'unknown';
    let tool=tools.get(name);
    if(!tool){tool={name,calls:0,succeeded:0,failed:0,unknown:0};tools.set(name,tool)}
    tool.calls+=1;
    tool[record.outcome]+=1;
  }
  return [...tools.values()].sort((left,right)=>right.calls-left.calls||left.name.localeCompare(right.name));
}
function taskSkills(records){
  const skills=new Map();
  for(const record of records){
    const name=skillReadName(record);
    if(name)skills.set(name,(skills.get(name)||0)+1);
  }
  return [...skills.entries()].sort((left,right)=>right[1]-left[1]||left[0].localeCompare(right[0])).map(([name,reads])=>({name,reads}));
}
function attemptKey(attempt,position){
  const id=typeof attempt?.id==='string'?attempt.id.trim():'';
  if(id)return `id:${id}`;
  const index=Number(attempt?.index);
  if(Number.isFinite(index))return `index:${index}`;
  return `position:${position}`;
}
function attemptOrder(left,right){
  const leftIndex=Number(left.attempt?.index),rightIndex=Number(right.attempt?.index);
  if(Number.isFinite(leftIndex)&&Number.isFinite(rightIndex)&&leftIndex!==rightIndex)return leftIndex-rightIndex;
  return left.position-right.position;
}
function selectSnapshots(snapshots,scope,currentThreadId){
  const selected=[];
  snapshots.forEach((snapshot,index)=>{
    if(!snapshot||typeof snapshot!=='object')return;
    if(snapshot.schemaVersion!==undefined&&snapshot.schemaVersion!==1)return;
    const threadId=snapshot.binding?.threadId;
    if(typeof threadId!=='string'||!threadId)return;
    if(scope==='session'&&threadId!==currentThreadId)return;
    selected.push({snapshot,threadId,rank:timeOf(snapshot.observedAt)??-Infinity,index});
  });
  return selected;
}
function mergeTasks(target,snapshot,rank){
  for(const task of Array.isArray(snapshot?.tasks)?snapshot.tasks:[]){
    if(!task||typeof task!=='object')continue;
    const id=typeof task.id==='string'?task.id.trim():'';
    if(!id)continue;
    let entry=target.get(id);
    if(!entry){
      entry={id,title:typeof task.title==='string'?task.title:'',status:taskStatus(task),acceptance:task.acceptance,rank,attempts:new Map()};
      target.set(id,entry);
    }else if(rank>=entry.rank){
      entry.title=typeof task.title==='string'?task.title:entry.title;
      entry.status=taskStatus(task);
      if(task.acceptance!==undefined)entry.acceptance=task.acceptance;
      entry.rank=rank;
    }
    const attempts=Array.isArray(task.attempts)?task.attempts:[];
    attempts.forEach((attempt,position)=>{
      if(!attempt||typeof attempt!=='object')return;
      const key=attemptKey(attempt,position);
      const current=entry.attempts.get(key);
      const executor=snapshot.members?.find(member=>member.id===task.memberId)?.executor;
      if(!current||rank>=current.rank)entry.attempts.set(key,{attempt:{...attempt,executor:typeof executor==='string'?executor:null},position,rank});
    });
  }
}
function buildThreads(records){
  const threads=new Map();
  for(const record of records){
    let thread=threads.get(record.threadId);
    if(!thread){
      thread={threadId:record.threadId,title:null,rank:-Infinity,index:-1,tasks:new Map()};
      threads.set(record.threadId,thread);
    }
    if(record.rank>thread.rank||(record.rank===thread.rank&&record.index>=thread.index)){
      if(typeof record.snapshot.binding?.title==='string')thread.title=record.snapshot.binding.title;
      thread.rank=record.rank;
      thread.index=record.index;
    }
    mergeTasks(thread.tasks,record.snapshot,record.rank);
  }
  return [...threads.values()].map(thread=>({threadId:thread.threadId,title:thread.title,tasks:[...thread.tasks.values()]}));
}
function summarizeTokens(attempts){
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
  const values=Object.fromEntries(TOKEN_KEYS.map(key=>[key,reported[key]?sums[key]:null]));
  const coverage=Object.fromEntries(TOKEN_KEYS.map(key=>[key,{reported:reported[key],total:attempts.length}]));
  return {values,coverage,reportedAttempts,totalAttempts:attempts.length};
}
function eventResultText(event){
  const direct=typeof event?.result==='string'?event.result:'';
  if(direct.trim())return direct.slice(0,4000);
  if(event?.kind==='tool_result'){
    const text=typeof event?.text==='string'?event.text:'';
    return text.slice(0,4000);
  }
  return '';
}
function toolRecords(attempts){
  const records=new Map();
  for(const entry of attempts){
    const attempt=entry.attempt;
    const events=Array.isArray(attempt.events)?attempt.events:[];
    // The same callId can legitimately reappear in another attempt (resume/retry),
    // so attempt identity must stay part of the dedupe key.
    const attemptIdentity=attemptKey(attempt,entry.position);
    events.forEach((event,position)=>{
      if(!event||typeof event!=='object'||!TOOL_KINDS.has(event.kind))return;
      const eventId=typeof event.id==='string'&&event.id.trim()?event.id.trim():'';
      const key=eventId?`${attemptIdentity}\u0000id:${eventId}`:`${attemptIdentity}\u0000pos:${position}`;
      const toolName=typeof event.toolName==='string'?event.toolName.trim():'';
      const text=typeof event.text==='string'?event.text:'';
      const resultText=eventResultText(event);
      const outcome=attemptToolOutcome(event);
      const current=records.get(key);
      if(!current){
        records.set(key,{key,id:eventId||null,toolName,callText:event.kind==='tool_result'?'':text,resultText,outcome});
        return;
      }
      if(!current.toolName&&toolName)current.toolName=toolName;
      if(event.kind!=='tool_result'&&text&&!current.callText)current.callText=text;
      if(resultText&&!current.resultText)current.resultText=resultText;
      if(outcome!=='unknown')current.outcome=outcome;
    });
  }
  return [...records.values()];
}
/**
 * Attempt-scoped public tool records for CLI post-processing. `included` mirrors the
 * attempt window used by aggregateAnalytics; callers that read native receipts keep
 * their own record.timestamp window.
 */
export function cliAttemptInputs(views,{now=new Date(),days=null}={}){
  if(!Array.isArray(views))throw new TypeError('views 必须是数组。');
  if(!(days===null||days===7||days===30))throw new RangeError('days 只支持 7、30 或 null。');
  const at=now instanceof Date?new Date(now.getTime()):new Date(now);
  if(!Number.isFinite(at.getTime()))throw new TypeError('now 必须是有效时间。');
  const nowMs=at.getTime();
  const fromMs=days===null?null:nowMs-days*86400000;
  const selected=selectSnapshots(views,'global');
  const workspaceByThread=new Map(selected.map(item=>[item.threadId,item.snapshot.binding.workspace??null]));
  const threads=buildThreads(selected);
  const tasks=[];
  for(const thread of threads){
    for(const task of thread.tasks){
      const attempts=[...task.attempts.values()].sort(attemptOrder).map((entry,position)=>({...entry,position}));
      tasks.push({
        id:task.id,title:task.title,threadId:thread.threadId,threadTitle:thread.title,
        workspace:workspaceByThread.get(thread.threadId)??null,
        attempts:attempts.map(entry=>{
          const started=timeOf(entry.attempt.startedAt);
          return {
            attemptId:typeof entry.attempt.id==='string'?entry.attempt.id:null,
            startedAt:entry.attempt.startedAt??null,
            endedAt:entry.attempt.endedAt??null,
            resumedFrom:entry.attempt.resumedFrom??null,
            sessionId:entry.attempt.sessionId??null,
            executor:entry.attempt.executor??null,
            included:fromMs===null||(started!==null&&started>=fromMs&&started<=nowMs),
            records:toolRecords([entry]),
          };
        }),
      });
    }
  }
  return {tasks,fromMs,nowMs};
}

function projectTask(threadId,task,fromMs,nowMs){
  const fullAttempts=[...task.attempts.values()]
    .sort(attemptOrder)
    .map((entry,position)=>({...entry,continuation:Boolean(entry.attempt.resumedFrom)||position>0}))
    .map((entry,position)=>({...entry,position}));
  const included=fullAttempts.filter(entry=>{
    if(fromMs===null)return true;
    const started=timeOf(entry.attempt.startedAt);
    return started!==null&&started>=fromMs&&started<=nowMs;
  });
  if(fromMs!==null&&!included.length)return null;
  const attempts=included.map(entry=>entry.attempt);
  const summary=summarizeTokens(attempts);
  const records=toolRecords(included);
  const cli=aggregateCliCalls(records);
  const cliMetrics={
    calls:cli.rows.reduce((sum,row)=>sum+row.calls,0),
    unclassifiedCalls:cli.unclassifiedCalls,
    rows:cli.rows.map(({sessions,...row})=>row),
  };
  const status=taskStatus(task);
  const accepted=validAcceptance(task);
  const category=categoryOf(status,accepted);
  const taskActive=category==='running';
  let durationMs=0,runningDurationMs=0,completedDurationMs=0,failedAttempts=0;
  for(const attempt of attempts){
    const started=timeOf(attempt.startedAt),ended=timeOf(attempt.endedAt);
    const attemptStatus=lower(attempt.status);
    if(started!==null&&ended!==null&&ended>=started){
      durationMs+=ended-started;
      if(attemptStatus==='completed')completedDurationMs+=ended-started;
    }else if(taskActive&&ACTIVE_STATUSES.has(attemptStatus)&&started!==null){
      runningDurationMs+=Math.max(0,nowMs-started);
    }
    if(FAILED_ATTEMPT_STATUSES.has(attemptStatus))failedAttempts+=1;
  }
  return {
    id:task.id,
    title:task.title,
    threadId,
    goal:latestGoal(included),
    status,
    attemptCount:attempts.length,
    continuationCount:included.filter(entry=>entry.continuation).length,
    tokens:{...summary.values},
    toolCalls:records.length,
    toolFailures:records.filter(record=>record.outcome==='failed').length,
    tools:taskTools(records),
    cli:cliMetrics,
    skills:taskSkills(records),
    durationMs,
    runningDurationMs,
    category,
    accepted,
    terminal:category==='returned'||category==='failed'||category==='stopped',
    completedOnFirstAttempt:fullAttempts.length===1&&lower(fullAttempts[0].attempt.status)==='completed',
    fullAttemptCount:fullAttempts.length,
    failedAttempts,
    completedDurationMs,
    attempts,
    records
  };
}
function representativeTasks(rows){
  return [...rows].sort((left,right)=>
    (right.tokens.totalTokens??-1)-(left.tokens.totalTokens??-1)
    ||right.attemptCount-left.attemptCount
    ||(right.durationMs+right.runningDurationMs)-(left.durationMs+left.runningDurationMs)
    ||String(left.id).localeCompare(String(right.id))
  ).slice(0,5).map(task=>({id:task.id,title:task.title,goal:task.goal}));
}
function sessionSummary(thread,rows,representative){
  const parts=representative.slice(0,3).map(task=>{
    const title=businessText(task.title,160);
    return task.goal?`${title}：${task.goal}`:title;
  }).filter(Boolean);
  if(parts.length)return businessText(parts.join('；'),600);
  return businessText(thread.title,600)||rows.map(task=>businessText(task.title,160)).filter(Boolean).slice(0,3).join('；');
}
function modelGroups(attempts){
  const groups=new Map();
  for(const attempt of attempts){
    const actual=typeof attempt.actualModel==='string'&&attempt.actualModel.trim()?attempt.actualModel.trim():null;
    const configured=typeof attempt.model==='string'&&attempt.model.trim()?attempt.model.trim():null;
    const model=actual||configured||null;
    const key=model??'';
    let group=groups.get(key);
    if(!group){
      group={model,attempts:[],actualAttempts:0,configuredAttempts:0,unknownAttempts:0};
      groups.set(key,group);
    }
    group.attempts.push(attempt);
    if(actual)group.actualAttempts+=1;
    else if(configured)group.configuredAttempts+=1;
    else group.unknownAttempts+=1;
  }
  return [...groups.values()].map(group=>{
    const summary=summarizeTokens(group.attempts);
    const total=group.attempts.length;
    const source=group.actualAttempts===total?'actual'
      :group.configuredAttempts===total?'configured'
      :group.unknownAttempts===total?'unknown':'mixed';
    return {
      model:group.model,
      source,
      attempts:total,
      reportedAttempts:summary.reportedAttempts,
      actualAttempts:group.actualAttempts,
      configuredAttempts:group.configuredAttempts,
      unknownAttempts:group.unknownAttempts,
      tokens:{...summary.values}
    };
  }).sort((left,right)=>right.attempts-left.attempts||String(left.model??'').localeCompare(String(right.model??'')));
}
export function aggregateAnalytics(snapshots,{scope='session',currentThreadId,now=new Date(),days=null}={}){
  if(!Array.isArray(snapshots))throw new TypeError('snapshots 必须是数组。');
  if(scope!=='session'&&scope!=='global')throw new TypeError('scope 只支持 session 或 global。');
  if(!(days===null||days===7||days===30))throw new RangeError('days 只支持 7、30 或 null。');
  if(scope==='session'&&(typeof currentThreadId!=='string'||!currentThreadId))throw new TypeError('scope=session 需要 currentThreadId。');
  const at=now instanceof Date?new Date(now.getTime()):new Date(now);
  if(!Number.isFinite(at.getTime()))throw new TypeError('now 必须是有效时间。');
  const nowMs=at.getTime();
  const fromMs=days===null?null:nowMs-days*86400000;
  const selected=selectSnapshots(snapshots,scope,currentThreadId);
  const threads=buildThreads(selected);
  const tasks=[];
  const scoped=[];
  for(const thread of threads){
    const projected=[];
    for(const task of thread.tasks){
      const row=projectTask(thread.threadId,task,fromMs,nowMs);
      if(!row)continue;
      projected.push(row);
      tasks.push(row);
    }
    scoped.push({...thread,rows:projected});
  }
  // Executor usage shares the same frozen window but keeps every merged attempt so
  // undated and out-of-window executions stay visible as coverage, not as payload.
  const executorUsage={
    qoder:buildExecutorUsage(scoped.map(thread=>({
      threadId:thread.threadId,
      title:thread.title,
      tasks:[...thread.tasks.values()].map(task=>({
        id:task.id,
        attempts:[...task.attempts.values()].map(entry=>entry.attempt)
      }))
    })),{executor:'qoder',now:at,days})
  };
  const allAttempts=tasks.flatMap(task=>task.attempts);
  const summary=summarizeTokens(allAttempts);
  const attemptCount=allAttempts.length;
  const datedAttempts=allAttempts.filter(attempt=>timeOf(attempt.startedAt)!==null).length;
  const metrics={
    sessionCount:threads.length,
    taskCount:tasks.length,
    attemptCount,
    continuationCount:tasks.reduce((sum,task)=>sum+task.continuationCount,0),
    running:tasks.filter(task=>task.category==='running').length,
    returned:tasks.filter(task=>task.category==='returned').length,
    accepted:tasks.filter(task=>task.accepted).length,
    failed:tasks.filter(task=>task.category==='failed').length,
    stopped:tasks.filter(task=>task.category==='stopped').length,
    unknown:tasks.filter(task=>task.category==='unknown').length,
    blocked:tasks.filter(task=>task.category==='blocked').length,
    pending:tasks.filter(task=>task.category==='pending').length,
    failedAttempts:attemptCount?allAttempts.filter(attempt=>FAILED_ATTEMPT_STATUSES.has(lower(attempt.status))).length:0,
    firstReturn:{numerator:0,denominator:0,rate:null},
    completedDurationMs:tasks.reduce((sum,task)=>sum+task.completedDurationMs,0)
  };
  const terminal=tasks.filter(task=>task.terminal);
  metrics.firstReturn.denominator=terminal.length;
  metrics.firstReturn.numerator=terminal.filter(task=>task.completedOnFirstAttempt).length;
  metrics.firstReturn.rate=terminal.length?metrics.firstReturn.numerator/terminal.length:null;
  const tokens={
    ...summary.values,
    reportedAttempts:summary.reportedAttempts,
    totalAttempts:summary.totalAttempts,
    coverage:summary.coverage,
    models:modelGroups(allAttempts),
    executors:[...new Set(allAttempts.map(attempt=>attempt.executor||'unknown'))].sort().map(executor=>{
      const group=summarizeTokens(allAttempts.filter(attempt=>(attempt.executor||'unknown')===executor));
      return {executor,...group.values,reportedAttempts:group.reportedAttempts,totalAttempts:group.totalAttempts,coverage:group.coverage};
    }),
    mainSession:'unavailable',
    mainSessionNote:'主 Codex 会话未计量，未计入 token 汇总。'
  };
  const trendMap=new Map();
  for(const attempt of allAttempts){
    const started=timeOf(attempt.startedAt);
    if(started===null)continue;
    const date=new Date(started).toISOString().slice(0,10);
    if(!trendMap.has(date))trendMap.set(date,[]);
    trendMap.get(date).push(attempt);
  }
  const trend=[...trendMap.entries()].sort((left,right)=>left[0].localeCompare(right[0])).map(([date,attempts])=>{
    const day=summarizeTokens(attempts);
    return {date,attempts:attempts.length,reportedAttempts:day.reportedAttempts,tokens:{...day.values}};
  });
  const sessions=scoped.map(thread=>{
    const attempts=thread.rows.flatMap(task=>task.attempts);
    const sessionTokens=summarizeTokens(attempts);
    const representative=representativeTasks(thread.rows);
    return {
      threadId:thread.threadId,
      title:thread.title,
      summary:sessionSummary(thread,thread.rows,representative),
      representativeTasks:representative,
      taskCount:thread.rows.length,
      attemptCount:attempts.length,
      continuationCount:thread.rows.reduce((sum,task)=>sum+task.continuationCount,0),
      running:thread.rows.filter(task=>task.category==='running').length,
      returned:thread.rows.filter(task=>task.category==='returned').length,
      accepted:thread.rows.filter(task=>task.accepted).length,
      failed:thread.rows.filter(task=>task.category==='failed').length,
      stopped:thread.rows.filter(task=>task.category==='stopped').length,
      unknown:thread.rows.filter(task=>task.category==='unknown').length,
      tokens:{...sessionTokens.values}
    };
  });
  const calls=new Map();
  for(const task of tasks){
    for(const record of task.records){
      const key=`${task.threadId}\u0000${task.id}\u0000${record.key}`;
      if(calls.has(key))continue;
      calls.set(key,{...record,threadId:task.threadId});
    }
  }
  const tools=new Map();
  const skillReads=new Map();
  for(const record of calls.values()){
    const toolName=record.toolName||'unknown';
    let tool=tools.get(toolName);
    if(!tool){
      tool={toolName,calls:0,succeeded:0,failed:0,unknown:0,sessions:new Set()};
      tools.set(toolName,tool);
    }
    tool.calls+=1;
    tool[record.outcome]+=1;
    tool.sessions.add(record.threadId);
    const skill=skillReadName(record);
    if(skill)skillReads.set(skill,(skillReads.get(skill)||0)+1);
  }
  const threadTitles=new Map(threads.map(thread=>[thread.threadId,thread.title]));
  const cliRecords=[];
  for(const task of tasks){
    for(const record of task.records){
      cliRecords.push({
        toolName:record.toolName,
        callText:record.callText,
        resultText:record.resultText,
        status:record.outcome,
        threadId:task.threadId,
        threadTitle:threadTitles.get(task.threadId)??null,
        taskId:task.id,
        taskTitle:task.title,
      });
    }
  }
  const capabilities={
    tools:[...tools.values()].map(tool=>({
      toolName:tool.toolName,
      calls:tool.calls,
      succeeded:tool.succeeded,
      failed:tool.failed,
      unknown:tool.unknown,
      sessionCount:tool.sessions.size
    })).sort((left,right)=>right.calls-left.calls||left.toolName.localeCompare(right.toolName)),
    cli:aggregateCliCalls(cliRecords),
    skillReads:[...skillReads.entries()].sort((left,right)=>right[1]-left[1]||left[0].localeCompare(right[0])).map(([name,reads])=>({name,reads})),
    activation:null,
    activationNote:'未接入技能激活数据；skillReads 仅统计 Read/read_file 读取技能定义文件，不等同于激活。'
  };
  const insights=[];
  const topTask=tasks.reduce((best,task)=>{
    if(typeof task.tokens.totalTokens!=='number')return best;
    if(!best||task.tokens.totalTokens>best.tokens.totalTokens)return task;
    return best;
  },null);
  if(topTask&&typeof tokens.totalTokens==='number'&&tokens.totalTokens>0){
    const share=topTask.tokens.totalTokens/tokens.totalTokens;
    insights.push({
      id:'top-task-share',
      kind:'top_task_share',
      message:`已报 token 最高的任务占已报总量的 ${(share*100).toFixed(1)}%。`,
      taskId:topTask.id,
      threadId:topTask.threadId,
      evidence:{reportedTokens:topTask.tokens.totalTokens,reportedTotalTokens:tokens.totalTokens,share}
    });
  }
  if(metrics.failedAttempts>0){
    const rate=metrics.failedAttempts/metrics.attemptCount;
    insights.push({
      id:'failed-attempts',
      kind:'failed_attempts',
      message:`失败尝试 ${metrics.failedAttempts} 次，占尝试总数 ${(rate*100).toFixed(1)}%。`,
      evidence:{failedAttempts:metrics.failedAttempts,attemptCount:metrics.attemptCount,failureRate:rate}
    });
  }
  if(metrics.continuationCount>0){
    const tasksWithContinuation=tasks.filter(task=>task.continuationCount>0).length;
    insights.push({
      id:'continuation-boundary',
      kind:'continuation_boundary',
      message:`存在 ${metrics.continuationCount} 次续接尝试，涉及 ${tasksWithContinuation} 个任务；续接仅表示执行尝试次数，不代表质量或因果结论。`,
      evidence:{continuationCount:metrics.continuationCount,tasksWithContinuation}
    });
  }
  if(metrics.attemptCount>0){
    const missing=metrics.attemptCount-summary.reportedAttempts;
    insights.push({
      id:'usage-coverage',
      kind:'usage_coverage',
      message:`已上报用量的尝试为 ${summary.reportedAttempts}/${metrics.attemptCount}；主 Codex 会话未计量（mainSession=unavailable），缺失值未按 0 计入。`,
      evidence:{reportedAttempts:summary.reportedAttempts,totalAttempts:metrics.attemptCount,missingAttempts:missing,mainSession:'unavailable'}
    });
  }
  return {
    schemaVersion:1,
    scope,
    observedAt:at.toISOString(),
    range:{days,from:fromMs===null?null:new Date(fromMs).toISOString(),to:at.toISOString()},
    coverage:{
      snapshots:selected.length,
      sessions:threads.length,
      tasks:tasks.length,
      attempts:attemptCount,
      attemptsWithUsage:summary.reportedAttempts,
      attemptsWithoutUsage:attemptCount-summary.reportedAttempts,
      datedAttempts,
      undatedAttempts:attemptCount-datedAttempts
    },
    metrics,
    tokens,
    executorUsage,
    trend,
    tasks:tasks.map(task=>({
      id:task.id,
      title:task.title,
      threadId:task.threadId,
      goal:task.goal,
      status:task.accepted?'accepted':task.status,
      accepted:task.accepted,
      category:task.category,
      terminal:task.terminal,
      fullAttemptCount:task.fullAttemptCount,
      attemptCount:task.attemptCount,
      continuationCount:task.continuationCount,
      failedAttempts:task.failedAttempts,
      tokens:task.tokens,
      toolCalls:task.toolCalls,
      toolFailures:task.toolFailures,
      tools:task.tools,
      cli:task.cli,
      skills:task.skills,
      durationMs:task.durationMs,
      runningDurationMs:task.runningDurationMs
    })),
    sessions,
    capabilities,
    insights
  };
}

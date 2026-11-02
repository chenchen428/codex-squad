import {statusLabel,durationOf,latestProcess,processHint,usageOf} from './model.mjs';
import {displayStatus} from './board-model.mjs';
import {boundAcceptance,isAccepted,isLive} from '../lib/task-lifecycle.mjs';

export function executionActivityOf(task,{connected=true}={}){
  if(!connected||!task||isAccepted(task))return null;
  if(!isLive(task,{connected:true}))return null;
  return {label:statusLabel(displayStatus(task,true))};
}

const ACTIVE_STATUSES=new Set(['starting','running','stopping','in_progress']);
const WAITING_STATUSES=new Set(['completed','waiting_review','in_review','waiting','verifying','awaiting_record','blocked']);
const STOPPED_STATUSES=new Set(['stopped','cancelled','superseded','interrupted']);
const ICONS={active:'loader',success:'check',waiting:'clock',stopped:'stop',failed:'error',neutral:'dot'};
function statusTone(status,{connected,activity}){
  if(ACTIVE_STATUSES.has(status))return connected&&activity?'active':'neutral';
  if(status==='accepted')return 'success';
  if(status==='failed')return 'failed';
  if(WAITING_STATUSES.has(status))return 'waiting';
  if(STOPPED_STATUSES.has(status))return 'stopped';
  return 'neutral';
}
function statusProjection(task,{connected,activity}){
  const key=task?displayStatus(task,connected):'unknown';
  const tone=statusTone(key,{connected,activity:Boolean(activity)});
  const acceptance=isAccepted(task)?boundAcceptance(task):null;
  return {key,label:statusLabel(key),tone,icon:ICONS[tone],active:Boolean(activity),
    changedSinceVerification:Boolean(acceptance?.changedSinceVerification)};
}
/** Task status is the single projection shared by the detail title and footer. */
export function executionStatusOf(task,{connected=true}={}){
  return statusProjection(task,{connected,activity:executionActivityOf(task,{connected})});
}

/** Only complete attempt windows and reported output usage can produce a wall-clock rate. */
function outputSpeedOf(attempts,tokens){
  if(!attempts.length)return null;
  let milliseconds=0;
  for(const attempt of attempts){
    if(!attempt?.usage||!Number.isFinite(attempt.usage.outputTokens)||attempt.usage.outputTokens<0)return null;
    const start=Date.parse(attempt.startedAt),end=Date.parse(attempt.endedAt);
    if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start)return null;
    milliseconds+=end-start;
  }
  if(milliseconds<=0)return null;
  const outputTokens=tokens.outputTokens??0;
  return {outputTokens,seconds:milliseconds/1000,tokensPerSecond:outputTokens/(milliseconds/1000)};
}

function commandOf(task,{activity,connected,executor,status}){
  if(!connected){
    if(activity)return `${activity.label} · 暂未更新`;
    return statusLabel(status);
  }
  if(!activity)return statusLabel(status);
  const hint=processHint(latestProcess(task));
  if(hint)return hint;
  if(activity.label==='启动中')return `正在启动 ${executor||'成员'}…`;
  if(activity.label==='停止中')return '正在停止…';
  return `${executor||'成员'} 正在执行…`;
}

/**
 * Real metrics for the conversation footer. A disconnected snapshot freezes at
 * observedAt, and average output speed stays unreported unless every attempt has
 * both reported output usage and a complete non-zero wall-clock window.
 * @param {import('./types').Task} task
 * @param {{connected?:boolean,now?:number,observedAt?:string,executor?:string}} [options]
 */
export function executionMetricsOf(task,{connected=true,now=Date.now(),observedAt,executor=''}={}){
  const attempts=Array.isArray(task?.attempts)?task.attempts:[];
  const activity=executionActivityOf(task,{connected});
  const lastActivity=connected?activity:executionActivityOf(task,{connected:true});
  const statusInfo=statusProjection(task,{connected,activity});
  const snapshot=Date.parse(observedAt);
  const effectiveNow=connected?now:Number.isFinite(snapshot)?snapshot:NaN;
  const tokens=usageOf(attempts);
  const latest=attempts.at(-1);
  const duration=task?durationOf(task,effectiveNow):{milliseconds:null,running:false};
  const current=latest?durationOf({status:task.status,attempts:[latest]},effectiveNow):{milliseconds:null,running:false};
  return {
    state:!connected?'disconnected':activity?'running':'idle',
    running:Boolean(activity),
    status:statusInfo,
    label:statusInfo.label,
    command:commandOf(task,{activity:lastActivity,connected,executor,status:statusInfo.key}),
    note:!connected&&lastActivity?'暂未更新':'',
    duration:{...duration,running:connected&&duration.running},
    current:{...current,running:connected&&current.running},
    tokens,
    speed:outputSpeedOf(attempts,tokens)
  };
}

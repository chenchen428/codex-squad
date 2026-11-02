import {active,latestProcess,number,processHint,statusLabel,usageOf} from './model.mjs';
import {
  boardVisible,boundAcceptance,boundVerification,isAccepted,isHistory,isLive,laneOf,latestAttempt,retiredLabel,retiredOutcome,reviewPhase,statusKeyOf,
} from '../lib/task-lifecycle.mjs';

export const BOARD_LANES=['col-running','col-review','col-completed'];
export const HISTORY_LANE='history';
const LANE_KEYS={running:'col-running',review:'col-review',completed:'col-completed'};

function clipped(value,limit=72){
  const text=String(value??'').replace(/\s+/g,' ').trim();
  return text.length>limit?`${text.slice(0,limit-1)}…`:text;
}

export {boardVisible,isAccepted};

/** @param {import('./types').Task} task */
export function displayStatus(task,connected=true){
  return statusKeyOf(task);
}
/** @param {import('./types').Task} task */
export function taskProgress(task,connected=true){
  const status=displayStatus(task,connected);
  if(status==='accepted'){
    const acceptance=boundAcceptance(task);
    return acceptance?.changedSinceVerification?'已完成 · 核验后已有变更':'已完成';
  }
  if(isHistory(task)){
    const outcome=retiredOutcome(task)||'stopped';
    const label=retiredLabel(outcome);
    const replacement=clipped(task.retirement?.replacedBy,32);
    if(outcome==='superseded'&&replacement)return `${label} · ${replacement}`;
    const reason=clipped(task.retirement?.reason);
    return reason?`${label} · ${reason}`:label;
  }
  if(status==='waiting')return '待核验';
  if(status==='verifying')return 'Codex核验中';
  if(status==='awaiting_record')return '待核对';
  const raw=String(task.status||'unknown').toLowerCase();
  if(!connected&&isLive(task,{connected:true}))return `${processHint(latestProcess(task))||statusLabel(raw)} · 暂未更新`;
  if(active(raw))return processHint(latestProcess(task))||statusLabel(status);
  return statusLabel(status);
}
/** @param {import('./types').Task} task */
export function taskLane(task,connected=true){
  const lane=laneOf(task);
  return lane?LANE_KEYS[lane]:HISTORY_LANE;
}
export function taskNumber(index){
  return `#${String(index+1).padStart(2,'0')}`;
}
/** @param {import('./types').Attempt[]} attempts */
export function tokenLabel(attempts){
  const {totalTokens}=usageOf(attempts);
  return typeof totalTokens==='number'?`${number(totalTokens)} tok`:'未上报';
}
/**
 * Stable card projection used by both rendering and search.
 * @param {import('./types').Task} task
 * @param {number} index
 */
export function taskCard(task,index,connected=true){
  const lane=taskLane(task,connected);
  const status=displayStatus(task,connected);
  const progress=taskProgress(task,connected);
  const value=taskNumber(index);
  const history=lane===HISTORY_LANE;
  const acceptance=boundAcceptance(task);
  const search=[
    value,task.id,task.title,progress,statusLabel(status),
    task.reason,task.retirement?.reason,task.retirement?.replacedBy,acceptance?.note,
  ].join('\n').toLowerCase();
  return {
    task,index,lane,history,number:value,status,
    statusText:history?retiredLabel(retiredOutcome(task)||'stopped'):statusLabel(status),
    progress,
    resultSummary:acceptance?clipped(acceptance.note,120):'',
    verifiedAt:acceptance?.at||null,
    live:!history&&isLive(task,{connected:true}),
    active:!history&&isLive(task,{connected}),
    search,
  };
}
export function normalizeQuery(value){
  return String(value??'').trim().toLowerCase();
}
export function filterCards(cards,query){
  const needle=normalizeQuery(query);
  return needle?cards.filter(card=>card.search.includes(needle)):cards.slice();
}
function cardTime(card){
  const current=latestAttempt(card.task);
  const dates=card.lane==='col-completed'?[boundAcceptance(card.task)?.at]
    :card.lane==='col-review'?[boundVerification(card.task)?.at,current?.endedAt]
    :[current?.startedAt];
  for(const date of dates){const value=Date.parse(date);if(Number.isFinite(value))return value}
  return -Infinity;
}
/** @param {Array<ReturnType<typeof taskCard>>} cards */
export function groupCards(cards){
  const groups=Object.fromEntries([...BOARD_LANES,HISTORY_LANE].map(lane=>[lane,[]]));
  for(const card of cards)groups[card.lane].push(card);
  for(const lane of BOARD_LANES)groups[lane].sort((left,right)=>cardTime(right)-cardTime(left)||left.index-right.index);
  return groups;
}
/** @param {Array<ReturnType<typeof taskCard>>} cards */
export function countCards(cards){
  const counts=Object.fromEntries([...BOARD_LANES,HISTORY_LANE].map(lane=>[lane,0]));
  for(const card of cards)counts[card.lane]++;
  return counts;
}
export {reviewPhase};

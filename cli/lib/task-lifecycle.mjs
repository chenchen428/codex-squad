// Current-lane, verification and retirement facts shared by the CLI and the read-only UI.
// Keep this module free of Node and browser globals so both sides use one rule set.
export const CURRENT_LANES=Object.freeze(['running','review','completed']);
export const RETIREMENT_OUTCOMES=Object.freeze(['cancelled','superseded']);
export const HISTORY_STATUSES=Object.freeze(['stopped','cancelled','superseded']);

const ACTIVE_STATUSES=new Set(['starting','running','stopping','in_progress']);
const REVIEW_STATUSES=new Set(['completed','waiting_review','in_review']);
const LEGACY_ACCEPTED_STATUSES=new Set(['done','accepted']);
const RETIRED_LABELS=Object.freeze({cancelled:'已取消',superseded:'已被替代',stopped:'已停止'});

function attemptsOf(task){return Array.isArray(task?.attempts)?task.attempts:[]}
function statusOf(task){return String(task?.status||'unknown').toLowerCase()}

export function latestAttempt(task){return attemptsOf(task).at(-1)||null}

export function isRetired(task){
  return Boolean(task?.retirement&&RETIREMENT_OUTCOMES.includes(task.retirement.outcome));
}

export function retiredOutcome(task){
  if(task?.retirement&&RETIREMENT_OUTCOMES.includes(task.retirement.outcome))return task.retirement.outcome;
  const status=statusOf(task);
  return HISTORY_STATUSES.includes(status)?status:null;
}

export function isHistory(task){return retiredOutcome(task)!==null}

export function retiredLabel(outcome){return RETIRED_LABELS[outcome]||'已结束'}

/** Only an acceptance bound to the latest attempt counts; a bare legacy status never does. */
export function boundAcceptance(task){
  const latest=latestAttempt(task);
  if(!latest)return null;
  const direct=latest.acceptance;
  if(direct&&direct.attemptId===latest.id)return direct;
  const top=task?.acceptance;
  return top&&top.attemptId===latest.id?top:null;
}

export function boundVerification(task){
  const latest=latestAttempt(task);
  if(!latest)return null;
  const direct=latest.verification;
  if(direct&&direct.attemptId===latest.id)return direct;
  const top=task?.verification;
  return top&&top.attemptId===latest.id?top:null;
}

export function isAccepted(task){return !isRetired(task)&&Boolean(boundAcceptance(task))}

/**
 * reviewPhase separates the returned work that still needs the main Codex from a
 * recorded verification and from a completed acceptance. Legacy accepted/done
 * states without a real record stay awaiting_record instead of being guessed.
 */
export function reviewPhase(task){
  if(!task||isHistory(task))return null;
  if(boundAcceptance(task))return 'accepted';
  const latest=latestAttempt(task);
  const verification=boundVerification(task);
  if(latest&&latest.status==='completed'&&latest.endedAt){
    return verification?'verifying':'waiting';
  }
  const status=statusOf(task);
  if(LEGACY_ACCEPTED_STATUSES.has(status)||REVIEW_STATUSES.has(status))return 'awaiting_record';
  return null;
}

export function laneOf(task){
  if(!task||isHistory(task))return null;
  const phase=reviewPhase(task);
  if(phase==='accepted')return 'completed';
  if(phase)return 'review';
  return 'running';
}

/** Visibility does not change task facts or the owner intake queue. */
export function boardVisible(task){
  const lane=laneOf(task);
  return lane==='review'||lane==='completed'||lane==='running'&&isLive(task,{connected:true});
}

/** Connection loss never invents a new task state; it only stops live animation. */
export function statusKeyOf(task){
  if(!task)return 'unknown';
  if(isHistory(task))return retiredOutcome(task)||'stopped';
  const phase=reviewPhase(task);
  if(phase)return phase;
  const status=statusOf(task);
  return ACTIVE_STATUSES.has(status)||status==='failed'||status==='blocked'||status==='interrupted'||status==='unknown'||status==='queued'||status==='todo'||status==='backlog'||status==='idle'
    ?status:'unknown';
}

export function isLive(task,{connected=true}={}){
  if(!connected||!task||isHistory(task)||isAccepted(task))return false;
  const status=statusOf(task);
  if(!ACTIVE_STATUSES.has(status))return false;
  const latest=latestAttempt(task);
  if(!latest)return status==='starting';
  if(latest.endedAt||!ACTIVE_STATUSES.has(String(latest.status||'').toLowerCase()))return false;
  return true;
}

/**
 * The main-Codex intake queue is derived from the same snapshot facts the board
 * reads. It never scans historical conversation and never needs a second service.
 */
export function inboxOf(tasks){
  const pending=[],verifying=[];
  for(const task of Array.isArray(tasks)?tasks:[]){
    const phase=reviewPhase(task);
    if(phase!=='waiting'&&phase!=='verifying'&&phase!=='awaiting_record')continue;
    const latest=latestAttempt(task);
    const verification=boundVerification(task);
    const entry={
      taskId:task.id,title:String(task.title||''),phase,
      attemptId:latest?.id||null,attemptIndex:latest?.index??null,
      returnedAt:latest?.endedAt||null,sessionId:latest?.sessionId||task.sessionId||null,
      recordMissing:phase==='awaiting_record',
      ...(verification?{verification:{attemptId:verification.attemptId,at:verification.at,generation:verification.generation}}:{}),
    };
    (phase==='verifying'?verifying:pending).push(entry);
  }
  return {schemaVersion:1,count:pending.length+verifying.length,pending,verifying};
}

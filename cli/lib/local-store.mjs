import {chmodSync,existsSync,mkdirSync,statSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {join,resolve} from 'node:path';

let DatabaseSync;
try{
  ({DatabaseSync}=await import('node:sqlite'));
}catch(error){
  throw Object.assign(
    new Error('本地存储需要 Node.js 22.5 及以上版本提供的 node:sqlite 模块。',{cause:error}),
    {code:'LOCAL_SQLITE_UNAVAILABLE'},
  );
}

// Node 22.5 get() returns a null-filled row on misses; all()[0] preserves empty results.
const terminalStatuses=new Set(['completed','failed','stopped','interrupted']);
const schema=`
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS projects(
  id TEXT PRIMARY KEY,
  client_request_id TEXT UNIQUE,
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks(
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  parent_id TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  version INTEGER NOT NULL,
  source_type TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  active_generation INTEGER NOT NULL DEFAULT 0,
  active_session_id TEXT,
  worktree_path TEXT NOT NULL,
  blocker_json TEXT,
  labels_json TEXT NOT NULL DEFAULT '[]',
  agent_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(source_type,source_ref)
);
CREATE TABLE IF NOT EXISTS executions(
  task_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  high_water_sequence INTEGER NOT NULL DEFAULT 0,
  active_session_id TEXT,
  terminal_json TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(task_id,generation)
);
CREATE TABLE IF NOT EXISTS events(
  task_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  sequence INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  body_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(task_id,generation,sequence),
  UNIQUE(task_id,generation,event_id)
);
CREATE TABLE IF NOT EXISTS claims(
  claim_key TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  status TEXT NOT NULL,
  context_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

function storeError(code,message,cause){return Object.assign(new Error(message,cause?{cause}:undefined),{code});}
function isRecord(value){return value!==null&&typeof value==='object'&&!Array.isArray(value);}
function text(value){return typeof value==='string'?value.trim():'';}
function nowIso(){return new Date().toISOString();}
function digest(value){return createHash('sha256').update(String(value)).digest('hex');}
function parseJson(value,fallback){
  if(typeof value!=='string'||!value)return fallback;
  return JSON.parse(value);
}
function canonical(value){
  if(Array.isArray(value))return `[${value.map(item=>canonical(item===undefined?null:item)).join(',')}]`;
  if(value!==null&&typeof value==='object'){
    const entries=Object.keys(value).filter(key=>value[key]!==undefined).sort()
      .map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  const encoded=JSON.stringify(value);
  return encoded===undefined?'null':encoded;
}
function requiredText(value,field,max=4000){
  const candidate=text(value);
  if(!candidate)throw storeError('LOCAL_INPUT_INVALID',`${field}不能为空。`);
  if(candidate.length>max)throw storeError('LOCAL_INPUT_INVALID',`${field}不能超过 ${max} 个字符。`);
  return candidate;
}
function positiveInteger(value,field){
  const number=Number(value);
  if(!Number.isSafeInteger(number)||number<1)throw storeError('LOCAL_INPUT_INVALID',`${field}必须是正整数。`);
  return number;
}
function clone(value){return value===undefined?undefined:JSON.parse(JSON.stringify(value));}
function stableEvent(event){
  return {
    schemaVersion:event.schemaVersion??null,eventId:event.eventId??null,sessionId:event.sessionId??null,
    runId:event.runId??null,sequence:Number(event.sequence),entityId:event.entityId??null,
    entityRevision:event.entityRevision??null,type:event.type??null,operation:event.operation??null,
    origin:event.origin??null,payload:event.payload??null,
  };
}
function stableTerminal(event){
  return {
    eventKind:event.eventKind??null,eventSequence:Number(event.eventSequence??0),sessionId:event.sessionId??null,
    errorSummary:event.errorSummary??null,outcomeSummary:event.outcomeSummary??null,
    nativeSessionId:event.nativeSessionId??null,turnId:event.turnId??null,
  };
}
function taskView(row){
  return {
    id:row.id,projectId:row.project_id,parentId:row.parent_id||null,
    title:row.title,description:row.description,status:row.status,version:Number(row.version),
    labels:parseJson(row.labels_json,[]),
    harness:{
      sourceType:row.source_type,sourceRef:row.source_ref,
      activeGeneration:Number(row.active_generation),activeSessionId:row.active_session_id||null,
      worktreePath:row.worktree_path,blocker:parseJson(row.blocker_json,null),
    },
    createdAt:row.created_at,updatedAt:row.updated_at,
  };
}
function projectView(row){
  return {id:row.id,name:row.name,version:Number(row.version),createdAt:row.created_at,updatedAt:row.updated_at};
}

export function createLocalStore(options={}){
  const home=requiredText(options.home,'home',4000);
  const root=resolve(home);
  const fallbackWorkspace=text(options.workspace)?resolve(options.workspace):null;
  const databasePath=join(root,'local-store.sqlite');
  let database=null;

  function db(){
    if(database)return database;
    mkdirSync(root,{recursive:true,mode:0o700});
    const connection=new DatabaseSync(databasePath);
    try{
      connection.exec('PRAGMA busy_timeout = 5000');
      connection.exec('PRAGMA journal_mode = WAL');
      connection.exec('PRAGMA synchronous = NORMAL');
      connection.exec(schema);
    }catch(error){
      try{connection.close();}catch{}
      throw error;
    }
    chmodSync(databasePath,0o600);
    for(const suffix of ['-wal','-shm']){
      const file=`${databasePath}${suffix}`;
      if(existsSync(file))try{chmodSync(file,0o600);}catch{}
    }
    connection.exec("CREATE INDEX IF NOT EXISTS events_by_type ON events(task_id,generation,json_extract(body_json,'$.type'),sequence)");
    database=connection;
    if(!readMeta('store_instance_id')){
      connection.prepare('INSERT OR IGNORE INTO meta(key,value) VALUES(?,?)').run('store_instance_id',`local-${randomUUID()}`);
      connection.prepare('INSERT OR IGNORE INTO meta(key,value) VALUES(?,?)').run('schema_version','1');
    }
    return database;
  }
  function readMeta(key){
    const row=db().prepare('SELECT value FROM meta WHERE key=?').all(key)[0];
    return row?.value??null;
  }
  function instanceId(){return readMeta('store_instance_id');}
  function transact(fn){
    const connection=db();
    connection.exec('BEGIN IMMEDIATE');
    try{
      const value=fn(connection);
      connection.exec('COMMIT');
      return value;
    }catch(error){
      try{connection.exec('ROLLBACK');}catch{}
      throw error;
    }
  }
  function taskRow(connection,id){
    return connection.prepare('SELECT * FROM tasks WHERE id=?').all(id)[0]||null;
  }
  function requireTask(connection,id){
    const task=taskRow(connection,id);
    if(!task)throw storeError('TASK_NOT_FOUND',`任务 ${id} 不存在。`);
    return task;
  }
  function executionRow(connection,taskId,generation){
    return connection.prepare('SELECT * FROM executions WHERE task_id=? AND generation=?').all(taskId,generation)[0]||null;
  }
  function ensureExecution(connection,taskId,generation,sessionId=null){
    connection.prepare('INSERT OR IGNORE INTO executions(task_id,generation,high_water_sequence,active_session_id,terminal_json,updated_at) VALUES(?,?,0,?,NULL,?)')
      .run(taskId,generation,sessionId,nowIso());
    if(sessionId)connection.prepare('UPDATE executions SET active_session_id=?,updated_at=? WHERE task_id=? AND generation=?')
      .run(sessionId,nowIso(),taskId,generation);
  }
  function touchTask(connection,taskId,{status,activeGeneration,activeSessionId,blocker,version=true}={}){
    const current=requireTask(connection,taskId);
    const nextStatus=status===undefined?current.status:status;
    const nextGeneration=activeGeneration===undefined?Number(current.active_generation):Number(activeGeneration);
    const nextSession=activeSessionId===undefined?current.active_session_id:activeSessionId;
    const nextBlocker=blocker===undefined?current.blocker_json:blocker===null?null:JSON.stringify(blocker);
    connection.prepare('UPDATE tasks SET status=?,active_generation=?,active_session_id=?,blocker_json=?,version=?,updated_at=? WHERE id=?')
      .run(nextStatus,nextGeneration,nextSession??null,nextBlocker,Number(current.version)+(version?1:0),nowIso(),taskId);
    return requireTask(connection,taskId);
  }
  async function resolveTaskWorkspace(input,clientOptions={}){
    let candidate=null;
    const resolver=clientOptions.resolveWorkingCopyPath;
    if(typeof resolver==='function')candidate=await resolver();
    else if(typeof resolver==='string')candidate=resolver;
    if(!candidate)candidate=text(clientOptions.defaultWorkspace)||'';
    if(!candidate)candidate=fallbackWorkspace||'';
    if(candidate){
      const target=resolve(String(candidate));
      let found;
      try{found=statSync(target);}
      catch(error){
        if(error.code==='ENOENT')throw storeError('LOCAL_WORKSPACE_MISSING',`工作目录 ${target} 不存在。`);
        throw error;
      }
      if(!found.isDirectory())throw storeError('LOCAL_WORKSPACE_MISSING',`工作目录 ${target} 不是目录。`);
      return target;
    }
    const constructed=join(root,'workspace');
    mkdirSync(constructed,{recursive:true,mode:0o700});
    return constructed;
  }
  function projectCreate(input={}){
    const name=requiredText(input.name,'name',200);
    const requestId=text(input.clientRequestId)||null;
    return transact(connection=>{
      if(requestId){
        const existing=connection.prepare('SELECT * FROM projects WHERE client_request_id=?').all(requestId)[0];
        if(existing)return {project:projectView(existing)};
      }
      const at=nowIso();
      const id=`project-${randomUUID()}`;
      connection.prepare('INSERT INTO projects(id,client_request_id,name,version,created_at,updated_at) VALUES(?,?,?,?,?,?)')
        .run(id,requestId,name,1,at,at);
      return {project:projectView(connection.prepare('SELECT * FROM projects WHERE id=?').all(id)[0])};
    });
  }
  async function workCreate(input={},clientOptions={}){
    const projectId=requiredText(input.projectId,'projectId',200);
    const title=requiredText(input.title,'title',4000);
    const sourceType=requiredText(input.sourceType,'sourceType',200);
    const sourceRef=requiredText(input.sourceRef,'sourceRef',2000);
    const description=typeof input.description==='string'?input.description:'';
    const status=text(input.status)||'backlog';
    const labels=Array.isArray(input.labels)?input.labels.filter(item=>typeof item==='string'):[];
    const parentId=text(input.parentId)||null;
    const worktreePath=await resolveTaskWorkspace(input,clientOptions);
    return transact(connection=>{
      const existing=connection.prepare('SELECT * FROM tasks WHERE source_type=? AND source_ref=?').all(sourceType,sourceRef)[0];
      if(existing)return {task:taskView(existing)};
      const project=connection.prepare('SELECT id FROM projects WHERE id=?').all(projectId)[0];
      if(!project)throw storeError('LOCAL_PROJECT_NOT_FOUND',`项目 ${projectId} 不存在。`);
      const at=nowIso();
      const id=`task-${randomUUID()}`;
      connection.prepare(`INSERT INTO tasks(id,project_id,parent_id,title,description,status,version,source_type,source_ref,active_generation,active_session_id,worktree_path,blocker_json,labels_json,agent_json,created_at,updated_at)
        VALUES(?,?,?,?,?,?,1,?,?,0,NULL,?,NULL,?,NULL,?,?)`)
        .run(id,projectId,parentId,title,description,status,sourceType,sourceRef,worktreePath,JSON.stringify(labels),at,at);
      return {task:taskView(requireTask(connection,id))};
    });
  }
  function workGet(input={}){
    const id=requiredText(input.workId,'workId',200);
    return {task:taskView(requireTask(db(),id))};
  }
  function workFind(input={}){
    const sourceType=requiredText(input.sourceType,'sourceType',200);
    const sourceRef=requiredText(input.sourceRef,'sourceRef',2000);
    const row=db().prepare('SELECT * FROM tasks WHERE source_type=? AND source_ref=?').all(sourceType,sourceRef)[0];
    return {task:row?taskView(row):null};
  }
  function workUpdate(input={}){
    const id=requiredText(input.workId,'workId',200);
    return transact(connection=>{
      const current=requireTask(connection,id);
      if(input.expectedVersion!==undefined&&Number(input.expectedVersion)!==Number(current.version)){
        throw storeError('TASK_VERSION_CONFLICT',`任务 ${id} 版本已变化，当前版本为 ${current.version}。`);
      }
      const status=input.status===undefined?current.status:requiredText(input.status,'status',80);
      const title=input.title===undefined?current.title:requiredText(input.title,'title',4000);
      const description=input.description===undefined?current.description:String(input.description);
      connection.prepare('UPDATE tasks SET status=?,title=?,description=?,version=?,updated_at=? WHERE id=?')
        .run(status,title,description,Number(current.version)+1,nowIso(),id);
      return {task:taskView(requireTask(connection,id))};
    });
  }
  function workAgentSave(input={}){
    const id=requiredText(input.workId,'workId',200);
    return transact(connection=>{
      const task=requireTask(connection,id);
      const agent={...input};
      delete agent.workId;
      connection.prepare('UPDATE tasks SET agent_json=?,updated_at=? WHERE id=?').run(JSON.stringify(agent),nowIso(),id);
      return {task:taskView(task)};
    });
  }
  function workExecutionGet(input={}){
    const id=requiredText(input.workId,'workId',200);
    const generation=positiveInteger(input.generation,'generation');
    const task=requireTask(db(),id);
    if(generation>Number(task.active_generation)){
      throw storeError('EXECUTION_GENERATION_STALE',`执行代次 ${generation} 尚未开始或已过期。`);
    }
    const execution=executionRow(db(),id,generation);
    const after=Number.isSafeInteger(Number(input.afterSequence))&&Number(input.afterSequence)>0?Number(input.afterSequence):0;
    const rawLimit=Number(input.limit);
    const limit=Number.isSafeInteger(rawLimit)&&rawLimit>0?Math.min(rawLimit,5000):1000;
    const rows=db().prepare('SELECT body_json FROM events WHERE task_id=? AND generation=? AND sequence>? ORDER BY sequence ASC LIMIT ?')
      .all(id,generation,after,limit);
    return {
      events:rows.map(row=>parseJson(row.body_json,{})),
      highWaterSequence:Number(execution?.high_water_sequence||0),
      activeSessionId:execution?.active_session_id||null,
      generation,
    };
  }
  function workExecutionWatermark(input={}){
    const id=requiredText(input.workId,'workId',200),generation=positiveInteger(input.generation,'generation');
    const task=requireTask(db(),id);
    if(generation>Number(task.active_generation))throw storeError('EXECUTION_GENERATION_STALE','执行代次尚未开始。');
    const row=executionRow(db(),id,generation);
    return {highWaterSequence:Number(row?.high_water_sequence||0),activeSessionId:row?.active_session_id||null,generation};
  }
  const digestCache=new Map();
  function workExecutionDigest(input={}){
    const meta=workExecutionWatermark(input),id=String(input.workId),generation=meta.generation,key=`${id}:${generation}`;
    const hit=digestCache.get(key);
    if(hit?.highWaterSequence===meta.highWaterSequence)return hit;
    const rows=db().prepare(`SELECT sequence,body_json FROM events WHERE task_id=? AND generation=?
      AND json_extract(body_json,'$.type') IN ('SQUAD_ATTEMPT_STARTED','SQUAD_ATTEMPT_COMPLETED','SQUAD_ATTEMPT_SESSION','SQUAD_PROMPT_SUBMITTED','SQUAD_USAGE_REPORTED','SQUAD_ACCEPTANCE')
      ORDER BY sequence`).all(id,generation);
    const recent=db().prepare(`SELECT sequence,body_json FROM events WHERE task_id=? AND generation=?
      AND json_extract(body_json,'$.type') IN ('SQUAD_CONVERSATION_BATCH','SQUAD_ATTEMPT_EVENT')
      ORDER BY sequence DESC LIMIT 4`).all(id,generation);
    let latestActivity=null;
    for(const row of recent){
      const event=parseJson(row.body_json,{});
      if(event.type==='SQUAD_ATTEMPT_EVENT'&&['tool','tool_use','tool_result','progress'].includes(event.payload?.kind)){latestActivity={sequence:row.sequence,event};break}
      const item=[...(event.payload?.events||[])].reverse().find(e=>e.type?.startsWith('TOOL_')||e.type==='PROGRESS_UPDATED');
      if(item){latestActivity={sequence:row.sequence,event:item};break}
    }
    const value={...meta,events:rows.map(row=>({sequence:Number(row.sequence),event:parseJson(row.body_json,{})})),latestActivity};
    digestCache.delete(key);digestCache.set(key,value);if(digestCache.size>512)digestCache.delete(digestCache.keys().next().value);
    return value;
  }

  async function appendEvent(taskId,input={}){
    const id=requiredText(taskId,'taskId',200);
    const generation=positiveInteger(input.generation,'generation');
    const sequence=positiveInteger(input.sequence,'sequence');
    const sessionId=requiredText(input.sessionId,'sessionId',256);
    const event=input.event;
    if(!isRecord(event))throw storeError('LOCAL_INPUT_INVALID','event 必须是 JSON 对象。');
    const eventId=requiredText(event.eventId,'event.eventId',500);
    if(event.sessionId!==sessionId||Number(event.sequence)!==sequence){
      throw storeError('LOCAL_INPUT_INVALID','事件标识与写入参数不一致。');
    }
    return transact(connection=>{
      const task=requireTask(connection,id);
      if(generation!==Number(task.active_generation)){
        throw storeError('EXECUTION_GENERATION_STALE',`执行代次 ${generation} 不是任务 ${id} 的当前代次。`);
      }
      ensureExecution(connection,id,generation,sessionId);
      const body=JSON.stringify(event);
      const existing=connection.prepare('SELECT body_json FROM events WHERE task_id=? AND generation=? AND sequence=?')
        .all(id,generation,sequence)[0];
      if(existing){
        if(canonical(stableEvent(parseJson(existing.body_json,{})))===canonical(stableEvent(event))){
          return {accepted:true,eventId,duplicate:true};
        }
        throw storeError('EXECUTION_EVENT_CONFLICT',`执行代次 ${generation} 的序号 ${sequence} 已写入不同内容。`);
      }
      const sameId=connection.prepare('SELECT sequence,body_json FROM events WHERE task_id=? AND generation=? AND event_id=?')
        .all(id,generation,eventId)[0];
      if(sameId){
        if(Number(sameId.sequence)===sequence&&canonical(stableEvent(parseJson(sameId.body_json,{})))===canonical(stableEvent(event))){
          return {accepted:true,eventId,duplicate:true};
        }
        throw storeError('EXECUTION_EVENT_CONFLICT',`事件 ${eventId} 已以不同内容或序号写入。`);
      }
      connection.prepare('INSERT INTO events(task_id,generation,sequence,session_id,event_id,body_json,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(id,generation,sequence,sessionId,eventId,body,text(input.createdAt)||nowIso());
      connection.prepare('UPDATE executions SET high_water_sequence=MAX(high_water_sequence,?),active_session_id=?,updated_at=? WHERE task_id=? AND generation=?')
        .run(sequence,sessionId,nowIso(),id,generation);
      touchTask(connection,id,{activeSessionId:sessionId});
      return {accepted:true,eventId};
    });
  }

  async function applySessionEvent(context={},event={}){
    if(!isRecord(context)||!isRecord(event))throw storeError('LOCAL_INPUT_INVALID','执行上下文和会话事件必须是 JSON 对象。');
    const id=requiredText(context.cardId,'cardId',200);
    const generation=positiveInteger(context.generation,'generation');
    if(text(context.storeInstanceId)!==instanceId()){
      throw storeError('LOCAL_INSTANCE_MISMATCH','会话事件属于其他存储实例。');
    }
    return transact(connection=>{
      const task=requireTask(connection,id);
      if(generation!==Number(task.active_generation)){
        throw storeError('EXECUTION_GENERATION_STALE',`执行代次 ${generation} 不是任务 ${id} 的当前代次。`);
      }
      ensureExecution(connection,id,generation,text(event.sessionId)||null);
      const execution=executionRow(connection,id,generation);
      const current=parseJson(execution?.terminal_json,null);
      if(current){
        if(canonical(stableTerminal(current))===canonical(stableTerminal(event)))return {applied:true,duplicate:true};
        throw storeError('EXECUTION_TERMINAL_CONFLICT',`执行代次 ${generation} 已写入不同的终态。`);
      }
      const success=event.eventKind==='idle_success';
      connection.prepare('UPDATE executions SET terminal_json=?,updated_at=? WHERE task_id=? AND generation=?')
        .run(JSON.stringify(event),nowIso(),id,generation);
      touchTask(connection,id,{
        status:success?'in_review':'blocked',
        blocker:success?undefined:{summary:String(event.errorSummary||'failed')},
      });
      return {applied:true,duplicate:false};
    });
  }

  async function scanScheduler(input={}){
    return transact(connection=>{
      const cardId=text(input.cardId);
      const projectFilter=text(input.projectId)||null;
      if(cardId){
        const task=taskRow(connection,cardId);
        if(!task)return {claims:[],skipped:[{cardId,reason:'not_found'}]};
        if(projectFilter&&projectFilter!==task.project_id)return {claims:[],skipped:[{cardId,reason:'project_mismatch'}]};
        if(task.status!=='todo')return {claims:[],skipped:[{cardId,reason:'not_ready'}]};
        const generation=Number(task.active_generation)+1;
        const claimKey=`${task.id}:${generation}`;
        connection.prepare('INSERT OR IGNORE INTO claims(claim_key,task_id,generation,status,context_json,error,created_at,updated_at) VALUES(?,?,?,?,NULL,NULL,?,?)')
          .run(claimKey,task.id,generation,'pending',nowIso(),nowIso());
        return {claims:[{claimKey,cardId:task.id}],skipped:[]};
      }
      const rows=projectFilter
        ?connection.prepare("SELECT * FROM tasks WHERE status='todo' AND project_id=? ORDER BY created_at,id").all(projectFilter)
        :connection.prepare("SELECT * FROM tasks WHERE status='todo' ORDER BY created_at,id").all();
      const claims=[];
      for(const task of rows){
        const generation=Number(task.active_generation)+1;
        const claimKey=`${task.id}:${generation}`;
        connection.prepare('INSERT OR IGNORE INTO claims(claim_key,task_id,generation,status,context_json,error,created_at,updated_at) VALUES(?,?,?,?,NULL,NULL,?,?)')
          .run(claimKey,task.id,generation,'pending',nowIso(),nowIso());
        claims.push({claimKey,cardId:task.id});
      }
      return {claims,skipped:[]};
    });
  }
  async function dispatchClaim(claimKey){
    const key=requiredText(claimKey,'claimKey',500);
    return transact(connection=>{
      const claim=connection.prepare('SELECT * FROM claims WHERE claim_key=?').all(key)[0];
      if(!claim)throw storeError('SCHEDULER_CLAIM_NOT_FOUND',`调度占用 ${key} 不存在。`);
      if(claim.status==='failed')throw storeError('SCHEDULER_CLAIM_FAILED',`调度占用 ${key} 已失败。`);
      const task=requireTask(connection,claim.task_id);
      const generation=Number(claim.generation);
      if(claim.status==='dispatched'&&claim.context_json){
        if(generation!==Number(task.active_generation)){
          throw storeError('SCHEDULER_CLAIM_STALE',`调度占用 ${key} 的执行代次已过期。`);
        }
        return {context:parseJson(claim.context_json,null),duplicate:true};
      }
      if(task.status!=='todo')throw storeError('SCHEDULER_TASK_NOT_READY',`任务 ${task.id} 当前状态为 ${task.status}，不能开始执行。`);
      if(generation!==Number(task.active_generation)+1){
        throw storeError('SCHEDULER_CLAIM_STALE',`调度占用 ${key} 的执行代次已过期。`);
      }
      const activeSessionId=`squad-run-${task.id}-${generation}`;
      ensureExecution(connection,task.id,generation,activeSessionId);
      touchTask(connection,task.id,{status:'in_progress',activeGeneration:generation,activeSessionId,blocker:null});
      const context={
        version:1,storeInstanceId:instanceId(),cardId:task.id,generation,
        activeSessionId,worktreePath:task.worktree_path,
      };
      connection.prepare('UPDATE claims SET status=?,context_json=?,updated_at=? WHERE claim_key=?')
        .run('dispatched',JSON.stringify(context),nowIso(),key);
      return {context};
    });
  }
  async function failClaim(claimKey,error){
    const key=requiredText(claimKey,'claimKey',500);
    return transact(connection=>{
      const claim=connection.prepare('SELECT * FROM claims WHERE claim_key=?').all(key)[0];
      if(!claim)return {ok:true,ignored:true};
      if(claim.status==='failed')return {ok:true,duplicate:true};
      const task=taskRow(connection,claim.task_id);
      let stale=false;
      if(task){
        const generation=Number(claim.generation);
        const current=Number(task.active_generation);
        const applies=generation===current||(current===0&&generation===1);
        if(applies&&(task.status==='todo'||task.status==='in_progress')){
          touchTask(connection,task.id,{status:'blocked',blocker:{summary:String(error||'failed')}});
        }else{
          stale=true;
        }
      }else{
        stale=true;
      }
      connection.prepare('UPDATE claims SET status=?,error=?,updated_at=? WHERE claim_key=?')
        .run('failed',String(error||''),nowIso(),key);
      return stale?{ok:true,stale:true}:{ok:true};
    });
  }

  async function operate(operation,input={},clientOptions={}){
    switch(operation){
      case 'project.create':return projectCreate(input);
      case 'work.create':return workCreate(input,clientOptions);
      case 'work.get':return workGet(input);
      case 'work.find':return workFind(input);
      case 'work.update':return workUpdate(input);
      case 'work.agent.save':return workAgentSave(input);
      case 'work.execution.get':return workExecutionGet(input);
      case 'work.execution.digest':return workExecutionDigest(input);
      case 'work.execution.watermark':return workExecutionWatermark(input);
      default:throw storeError('LOCAL_OPERATION_UNSUPPORTED',`不支持的本地操作：${operation}`);
    }
  }

  async function importSnapshot(snapshot){
    if(!isRecord(snapshot))throw storeError('LOCAL_SNAPSHOT_INVALID','迁移快照必须是 JSON 对象。');
    const binding=isRecord(snapshot.binding)?snapshot.binding:null;
    if(!binding||!text(binding.projectId)||!text(binding.parentWorkId)||!text(binding.threadId)){
      throw storeError('LOCAL_SNAPSHOT_INVALID','迁移快照缺少 binding.projectId、binding.parentWorkId 或 binding.threadId。');
    }
    const projectId=String(binding.projectId);
    const parentId=String(binding.parentWorkId);
    const threadId=String(binding.threadId);
    const bindingWorkspace=text(binding.workspace)||fallbackWorkspace||join(root,'workspace');
    const tasks=Array.isArray(snapshot.tasks)?snapshot.tasks:[];
    return transact(connection=>{
      const summary={projects:0,tasks:0,executions:0,events:0,duplicates:0,conflicts:[]};
      const conflict=(kind,detail)=>summary.conflicts.push({kind,...detail});
      const insertTask=({id,project,taskParentId,title,description,status,version,sourceType,sourceRef,activeGeneration,activeSessionId,worktreePath,blocker,labels,createdAt,updatedAt})=>{
        connection.prepare(`INSERT INTO tasks(id,project_id,parent_id,title,description,status,version,source_type,source_ref,active_generation,active_session_id,worktree_path,blocker_json,labels_json,agent_json,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?)`)
          .run(id,project,taskParentId,title,description,status,version,sourceType,sourceRef,activeGeneration,
            activeSessionId,worktreePath,blocker===null?null:JSON.stringify(blocker),JSON.stringify(labels),createdAt,updatedAt);
      };

      const project=connection.prepare('SELECT * FROM projects WHERE id=?').all(projectId)[0];
      if(!project){
        const legacyRequestId=`codex-squad:legacy:${threadId}`;
        const occupied=connection.prepare('SELECT id FROM projects WHERE client_request_id=?').all(legacyRequestId)[0];
        if(occupied){
          conflict('project',{id:projectId,reason:'client_request_id_conflict'});
        }else{
          const at=nowIso();
          connection.prepare('INSERT INTO projects(id,client_request_id,name,version,created_at,updated_at) VALUES(?,?,?,?,?,?)')
            .run(projectId,legacyRequestId,text(binding.title)||'Codex 小队历史项目',1,at,at);
          summary.projects+=1;
        }
      }

      const parentSnapshot=isRecord(snapshot.parent)?snapshot.parent:{};
      const existingParent=taskRow(connection,parentId);
      const parentSourceRef=`squad:v2:${threadId}:parent`;
      if(!existingParent){
        const at=nowIso();
        insertTask({
          id:parentId,project:projectId,taskParentId:null,title:text(parentSnapshot.title)||text(binding.title)||'Codex 小队',
          description:typeof parentSnapshot.description==='string'?parentSnapshot.description:'',
          status:text(parentSnapshot.status)||'backlog',version:1,sourceType:'codex-squad',sourceRef:parentSourceRef,
          activeGeneration:0,activeSessionId:null,worktreePath:bindingWorkspace,blocker:null,
          labels:['codex-squad','codex-squad-parent'],createdAt:at,updatedAt:at,
        });
        summary.tasks+=1;
      }else if(existingParent.project_id!==projectId||existingParent.source_ref!==parentSourceRef){
        conflict('task',{id:parentId,reason:'record_mismatch'});
      }

      for(const raw of tasks){
        if(!isRecord(raw)||!text(raw.id)){
          conflict('task',{id:null,reason:'invalid_task'});
          continue;
        }
        const taskId=String(raw.id);
        const harness=isRecord(raw.harness)?raw.harness:{};
        const memberId=text(raw.memberId)||'implementer';
        const taskParentId=text(raw.parentId)||parentId;
        const sourceType=text(harness.sourceType)||'codex-squad';
        const sourceRef=text(harness.sourceRef)
          ||`squad:v2:${threadId}:${encodeURIComponent(taskParentId)}:${memberId}:legacy-${digest(taskId).slice(0,16)}`;
        const rawAttempts=Array.isArray(raw.attempts)?raw.attempts.filter(isRecord):[];
        const attempts=[];
        const seenAttempts=new Set();
        for(const [position,attempt] of rawAttempts.entries()){
          const attemptId=text(attempt.id);
          if(!attemptId||seenAttempts.has(attemptId))continue;
          seenAttempts.add(attemptId);
          attempts.push({...attempt,id:attemptId,index:Number(attempt.index)||position+1,
            generation:Number(attempt.generation)||Number(attempt.index)||position+1});
        }
        attempts.sort((left,right)=>left.generation-right.generation||left.index-right.index);
        const maxAttemptGeneration=attempts.reduce((max,attempt)=>Math.max(max,attempt.generation),0);
        const activeGeneration=Math.max(Number(harness.activeGeneration)||0,maxAttemptGeneration);
        const latest=attempts.at(-1)||null;
        const hasLiveAttempt=attempts.some(attempt=>!terminalStatuses.has(String(attempt.status||'').toLowerCase()));
        const rawStatus=text(raw.status);
        const status=hasLiveAttempt||rawStatus==='unknown'?'in_progress'
          :rawStatus==='waiting_review'?'in_review'
          :rawStatus||'backlog';
        const reason=text(raw.reason);
        const blocker=reason?{summary:reason}:(harness.blocker??null);
        const existing=taskRow(connection,taskId);
        if(!existing){
          insertTask({
            id:taskId,project:projectId,taskParentId,title:text(raw.title)||'历史任务',
            description:typeof raw.description==='string'?raw.description:'',status,
            version:Number(raw.version)||1,sourceType,sourceRef,activeGeneration,
            activeSessionId:text(harness.activeSessionId)||latest?.sessionId||null,
            worktreePath:text(harness.worktreePath)||bindingWorkspace,blocker,
            labels:Array.isArray(raw.labels)?raw.labels.filter(item=>typeof item==='string'):['codex-squad',`codex-squad-${memberId}`],
            createdAt:text(attempts[0]?.startedAt)||nowIso(),updatedAt:nowIso(),
          });
          summary.tasks+=1;
        }else if(existing.project_id!==projectId||existing.source_type!==sourceType||existing.source_ref!==sourceRef
          ||existing.title!==(text(raw.title)||'历史任务')){
          conflict('task',{id:taskId,reason:'record_mismatch'});
          continue;
        }

        const acceptance=isRecord(raw.acceptance)?raw.acceptance:null;
        const acceptanceAttemptId=text(acceptance?.attemptId);
        const acceptanceTarget=acceptance
          ?(attempts.find(attempt=>attempt.id===acceptanceAttemptId)||(acceptanceAttemptId?null:latest))
          :null;
        let acceptanceEmitted=false;
        const groups=new Map();
        for(const attempt of attempts){
          if(!groups.has(attempt.generation))groups.set(attempt.generation,[]);
          groups.get(attempt.generation).push(attempt);
        }
        for(const [generation,group] of [...groups.entries()].sort((left,right)=>left[0]-right[0])){
          if(!Number.isSafeInteger(generation)||generation<1)continue;
          if(!executionRow(connection,taskId,generation))summary.executions+=1;
          ensureExecution(connection,taskId,generation,null);
          let sequence=1;
          const emit=(type,payload,occurredAt)=>{
            const currentSequence=sequence++;
            const sessionId=text(payload.sessionId)||text(group[0]?.sessionId)||`squad-run-${taskId}-${generation}`;
            const event={
              schemaVersion:'agent-bridge.conversation/v1',
              eventId:`legacy:${type.toLowerCase()}:${taskId}:${text(payload.attemptId)||'task'}:${currentSequence}`,
              sessionId,runId:`${sessionId}:${generation}`,sequence:currentSequence,
              entityId:`legacy:${text(payload.attemptId)||taskId}:${currentSequence}`,entityRevision:1,
              type,operation:'APPEND',occurredAt:text(occurredAt)||nowIso(),origin:{providerId:'codex-squad'},payload,
            };
            insertImportedEvent(connection,taskId,generation,sessionId,event,summary,conflict);
          };
          for(const attempt of group){
            const attemptId=attempt.id;
            const sessionId=text(attempt.sessionId)||`squad-run-${taskId}-${generation}`;
            const startedAt=text(attempt.startedAt)||null;
            emit('SQUAD_ATTEMPT_STARTED',{
              attemptId,index:attempt.index,requestId:text(attempt.requestId),memberId,
              model:text(attempt.model)||null,resumedFrom:attempt.resumedFrom||null,startedAt,
              ...(text(attempt.sessionId)?{nativeSessionId:text(attempt.sessionId)}:{}),
              ...(isRecord(attempt.handoff)?{handoff:attempt.handoff}:{}),
            },startedAt);
            if(text(attempt.sessionId))emit('SQUAD_ATTEMPT_SESSION',{
              attemptId,sessionId:text(attempt.sessionId),turnId:text(attempt.turnId)||null,
            },startedAt);
            for(const publicEvent of Array.isArray(attempt.events)?attempt.events:[]){
              if(!isRecord(publicEvent))continue;
              emit('SQUAD_ATTEMPT_EVENT',{
                ...publicEvent,eventId:publicEvent.id??publicEvent.eventId??null,
                time:publicEvent.time??publicEvent.occurredAt??null,
              },publicEvent.time??startedAt);
            }
            const reportedStatus=String(attempt.status||'').toLowerCase();
            if(terminalStatuses.has(reportedStatus)){
              emit('SQUAD_ATTEMPT_COMPLETED',{
                attemptId,status:reportedStatus,endedAt:text(attempt.endedAt)||null,
                nativeSessionId:text(attempt.sessionId)||null,actualModel:attempt.actualModel??null,
                usage:attempt.usage??null,result:attempt.result??null,error:attempt.error??null,
              },attempt.endedAt||startedAt);
            }
            if(acceptanceTarget&&!acceptanceEmitted&&acceptanceTarget.id===attemptId){
              acceptanceEmitted=true;
              emit('SQUAD_ACCEPTANCE',{
                attemptId,index:attempt.index,
                fingerprint:text(acceptance.fingerprint),note:typeof acceptance.note==='string'?acceptance.note:'',
                at:text(acceptance.at)||text(attempt.endedAt)||null,
                files:Array.isArray(acceptance.files)?acceptance.files:[],
              },acceptance.at||attempt.endedAt);
            }
          }
        }
        if(acceptance&&!acceptanceEmitted&&latest){
          conflict('acceptance',{id:taskId,reason:'attempt_not_found'});
        }
      }
      return summary;
    });
  }

  function insertImportedEvent(connection,taskId,generation,sessionId,event,summary,conflict){
    const existing=connection.prepare('SELECT body_json FROM events WHERE task_id=? AND generation=? AND sequence=?')
      .all(taskId,generation,event.sequence)[0];
    if(existing){
      if(canonical(stableEvent(parseJson(existing.body_json,{})))===canonical(stableEvent(event))){
        summary.duplicates+=1;
      }else{
        conflict('event',{id:taskId,generation,sequence:event.sequence,reason:'content_mismatch'});
      }
      return;
    }
    const sameId=connection.prepare('SELECT sequence FROM events WHERE task_id=? AND generation=? AND event_id=?')
      .all(taskId,generation,event.eventId)[0];
    if(sameId){
      conflict('event',{id:taskId,generation,sequence:event.sequence,reason:'event_id_conflict'});
      return;
    }
    connection.prepare('INSERT INTO events(task_id,generation,sequence,session_id,event_id,body_json,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(taskId,generation,event.sequence,sessionId,event.eventId,JSON.stringify(event),text(event.occurredAt)||nowIso());
    connection.prepare('UPDATE executions SET high_water_sequence=MAX(high_water_sequence,?),active_session_id=COALESCE(active_session_id,?),updated_at=? WHERE task_id=? AND generation=?')
      .run(event.sequence,sessionId,nowIso(),taskId,generation);
    summary.events+=1;
  }

  function close(){
    if(!database)return;
    const connection=database;
    database=null;
    connection.close();
  }

  return {
    home:root,
    workspace:fallbackWorkspace,
    databasePath,
    ready:()=>instanceId(),
    operate,
    reserveExecution:scanScheduler,
    startExecution:dispatchClaim,
    failExecution:failClaim,
    appendExecutionEvent:appendEvent,
    applyExecutionOutcome:applySessionEvent,
    importSnapshot,
    close,
  };
}

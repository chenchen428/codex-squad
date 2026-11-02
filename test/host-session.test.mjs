import test from 'node:test';
import assert from 'node:assert/strict';
import {appendFile,mkdtemp,mkdir,rename,stat,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {verifyHostSession,readHostTurn,readHostTurnAbort,watchHostTurn} from '../cli/lib/host-session.mjs';

const unverified={code:'SQUAD_HOST_THREAD_UNVERIFIED'};
const identity=(id,cwd,extra={})=>JSON.stringify({type:'session_meta',payload:{id,cwd,...extra}});
const tail='private subsequent conversation need not be parsed';

async function fixture(t){
  const home=await mkdtemp(join(tmpdir(),'squad-host-'));t.after(()=>rm(home,{recursive:true,force:true}));
  const sessions=join(home,'sessions'),day=join(sessions,'2026','10','27'),workspace=join(home,'workspace');
  await mkdir(day,{recursive:true});await mkdir(workspace);
  return {home,sessions,day,workspace};
}
async function rollout(day,name,content){
  const file=join(day,name);await writeFile(file,content);return file;
}
const verify=(threadId,workspace,sessions)=>verifyHostSession({threadId,cwd:workspace,options:{sessionsDir:sessions}});

test('binding verifies only the exact host session identity and working directory',async t=>{
  const {home,sessions,day,workspace}=await fixture(t);
  const id=randomUUID();
  const file=await rollout(day,`rollout-2026-10-27T09-48-17-${id}.jsonl`,identity(id,workspace)+'\n'+tail);
  assert.equal((await verify(id,workspace,sessions)).rolloutPath,file);
  await assert.rejects(verify(randomUUID(),workspace,sessions),unverified);
  await assert.rejects(verify(id,home,sessions),unverified);
  await rollout(day,`rollout-2026-10-27T09-48-17-${id}.jsonl`,identity(randomUUID(),workspace)+'\n');
  await assert.rejects(verify(id,workspace,sessions),unverified);
});

test('binding accepts a continuation rollout file for the same thread',async t=>{
  const {sessions,day,workspace}=await fixture(t);
  const id=randomUUID(),continuation=randomUUID();
  const file=await rollout(day,`rollout-2026-10-27T10-31-54-${id}_${continuation}.jsonl`,identity(id,workspace)+'\n'+tail);
  assert.equal((await verify(id,workspace,sessions)).rolloutPath,file);
  await rollout(day,`rollout-2026-10-27T10-31-54-${id}_${continuation}.jsonl`,identity(randomUUID(),workspace)+'\n');
  await assert.rejects(verify(id,workspace,sessions),unverified);
});

test('binding skips invalid candidates before the real record',async t=>{
  const {sessions,day,workspace}=await fixture(t);
  const id=randomUUID(),other=randomUUID();
  await rollout(day,`rollout-2026-10-27T09-10-00-${id}.jsonl`,identity(other,workspace)+'\n');
  await rollout(day,`rollout-2026-10-27T09-20-00-${id}_corrupt.jsonl`,'{"type":"session_meta","payload":');
  await rollout(day,`rollout-2026-10-27T09-30-00-${id}_elsewhere.jsonl`,identity(id,join(workspace,'missing'))+'\n');
  await rollout(day,`rollout-2026-10-27T09-40-00-${id}_notmeta.jsonl`,JSON.stringify({type:'other',payload:{id,cwd:workspace}})+'\n');
  await rollout(day,`rollout-2026-10-27T09-50-00-${id}_nocwd.jsonl`,identity(id,42)+'\n');
  const valid=await rollout(day,`rollout-2026-10-27T09-00-00-${id}.jsonl`,identity(id,workspace)+'\n'+tail);
  assert.equal((await verify(id,workspace,sessions)).rolloutPath,valid);
});

test('binding rejects similar identifiers and unrelated files',async t=>{
  const {sessions,day,workspace}=await fixture(t);
  const id=randomUUID();
  await rollout(day,`rollout-2026-10-27T09-00-00-${id}-decoy.jsonl`,identity(id,workspace)+'\n');
  await rollout(day,`rollout-2026-10-27T09-10-00-${id}0.jsonl`,identity(id,workspace)+'\n');
  await rollout(day,`rollout-2026-10-27T09-20-00-x${id}.jsonl`,identity(id,workspace)+'\n');
  await assert.rejects(verify(id,workspace,sessions),unverified);
});

test('binding rejects missing and unusable session records',async t=>{
  const {home,sessions,day,workspace}=await fixture(t);
  const id=randomUUID();
  await assert.rejects(verify(id,workspace,sessions),unverified);
  const empty=join(home,'empty-sessions');await mkdir(empty);
  await assert.rejects(verify(id,workspace,empty),unverified);
  await rollout(day,`rollout-2026-10-27T09-00-00-${id}.jsonl`,'');
  await assert.rejects(verify(id,workspace,sessions),unverified);
  await rollout(day,`rollout-2026-10-27T09-00-00-${id}.jsonl`,identity(id,join(workspace,'missing'))+'\n');
  await assert.rejects(verify(id,workspace,sessions),unverified);
});

test('binding surfaces unrelated session-store I/O errors',async t=>{
  const {home,workspace}=await fixture(t);
  const sessions=join(home,'sessions-as-file');await writeFile(sessions,'not a directory');
  await assert.rejects(verifyHostSession({threadId:randomUUID(),cwd:workspace,options:{sessionsDir:sessions}}),{code:'ENOTDIR'});
});

const line=value=>`${typeof value==='string'?value:JSON.stringify(value)}\n`;
const lifecycle=(type,turnId,extra={})=>line({type:'event_msg',payload:{type,turn_id:turnId,...extra}});
const started=turnId=>lifecycle('task_started',turnId);
const completed=turnId=>lifecycle('task_complete',turnId);
const aborted=(turnId,reason='interrupted')=>lifecycle('turn_aborted',turnId,{reason});
const activity=turnId=>line({type:'token_usage_record',payload:{turn_id:turnId,total_tokens:1}});
async function hostFile(t,content){
  const {day}=await fixture(t);
  const file=join(day,`rollout-2026-10-27T10-00-00-${randomUUID()}.jsonl`);
  await writeFile(file,content);return file;
}
async function waitFor(check,timeout=2000){
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){if(await check())return true;await new Promise(resolve=>setTimeout(resolve,10));}
  return false;
}

test('current host turn is the latest lifecycle marker, ignoring passthrough turn ids',async t=>{
  const first=randomUUID(),second=randomUUID(),foreign=randomUUID();
  const passthrough=line({type:'response_item',payload:{type:'message',internal_chat_message_metadata_passthrough:{turn_id:foreign}}});
  const file=await hostFile(t,started(first)+activity(first)+passthrough);
  let turn=await readHostTurn({rolloutPath:file});
  assert.equal(turn.state,'active');
  assert.equal(turn.turnId,first);
  assert.equal(turn.evidence,'started');

  await appendFile(file,completed(first)+started(second)+activity(second));
  turn=await readHostTurn({rolloutPath:file});
  assert.equal(turn.state,'active');
  assert.equal(turn.turnId,second);

  await appendFile(file,completed(second));
  turn=await readHostTurn({rolloutPath:file});
  assert.equal(turn.state,'ended');
  assert.equal(turn.turnId,second);
  assert.equal(turn.evidence,'completed');
});

test('current host turn stays unknown without turn lifecycle metadata',async t=>{
  const foreign=randomUUID();
  const file=await hostFile(t,line({type:'session_meta',payload:{id:randomUUID(),cwd:'/tmp'}})+line({type:'response_item',payload:{internal_chat_message_metadata_passthrough:{turn_id:foreign}}}));
  const turn=await readHostTurn({rolloutPath:file});
  assert.equal(turn.state,'unknown');
  assert.equal(turn.turnId,null);

  const legacy=await hostFile(t,aborted(null));
  assert.equal((await readHostTurn({rolloutPath:legacy})).state,'unknown');
  await assert.rejects(readHostTurn({}),{code:'SQUAD_HOST_ROLLOUT_MISSING'});
});

test('a late activity record never revives an ended host turn',async t=>{
  const ended=randomUUID();
  const file=await hostFile(t,started(ended)+activity(ended)+completed(ended)+activity(ended));
  const turn=await readHostTurn({rolloutPath:file});
  assert.equal(turn.state,'ended');
  assert.equal(turn.turnId,ended);
  assert.equal(turn.evidence,'completed');

  const onlyActivity=randomUUID();
  const tailOnly=await hostFile(t,activity(onlyActivity));
  const fallback=await readHostTurn({rolloutPath:tailOnly});
  assert.equal(fallback.state,'active');
  assert.equal(fallback.turnId,onlyActivity);
  assert.equal(fallback.evidence,'activity');
});

test('turn abort is matched only against the exact host turn id',async t=>{
  const target=randomUUID(),other=randomUUID();
  const file=await hostFile(t,started(target)+activity(target)+aborted(other,'interrupted')+completed(target));
  let result=await readHostTurnAbort({rolloutPath:file,turnId:target});
  assert.equal(result.aborted,false);
  assert.equal(result.turnId,target);
  assert.equal((await readHostTurnAbort({rolloutPath:file,turnId:randomUUID()})).aborted,false);

  await appendFile(file,aborted(target,'interrupted'));
  result=await readHostTurnAbort({rolloutPath:file,turnId:target});
  assert.equal(result.aborted,true);
  assert.equal(result.reason,'interrupted');
  assert.equal(result.turnId,target);
  assert.equal((await readHostTurnAbort({rolloutPath:file,turnId:other})).aborted,true);
  assert.equal((await readHostTurnAbort({rolloutPath:file,turnId:randomUUID()})).aborted,false);
  await assert.rejects(readHostTurnAbort({rolloutPath:file,turnId:'not-a-turn'}),{code:'SQUAD_HOST_TURN_INVALID'});
});

test('legacy turn abort without a turn id never matches',async t=>{
  const target=randomUUID();
  const file=await hostFile(t,started(target)+aborted(null)+aborted(''));
  assert.equal((await readHostTurnAbort({rolloutPath:file,turnId:target})).aborted,false);
});

test('abort detection waits until the record is persisted completely',async t=>{
  const target=randomUUID();
  const file=await hostFile(t,started(target)+activity(target));
  const record=aborted(target,'interrupted');
  const cut=Math.floor(record.length/2);
  await appendFile(file,record.slice(0,cut));
  assert.equal((await readHostTurnAbort({rolloutPath:file,turnId:target})).aborted,false);

  await appendFile(file,record.slice(cut));
  const result=await readHostTurnAbort({rolloutPath:file,turnId:target});
  assert.equal(result.aborted,true);
  assert.equal(result.reason,'interrupted');
});

test('a tail window starting exactly on a line keeps its first complete record',async t=>{
  const target=randomUUID();
  const head=aborted(target,'interrupted');
  const filler=blob=>line({type:'item_completed',payload:{turn_id:target,blob}});
  const padding=1024-head.length-filler('').length;
  const suffix=head+filler('y'.repeat(padding));
  assert.equal(suffix.length,1024);
  const file=await hostFile(t,'prefix\n'+suffix);
  const result=await readHostTurnAbort({rolloutPath:file,turnId:target,options:{tailChunkBytes:1024,tailMaxBytes:2048}});
  assert.equal(result.aborted,true);
  assert.equal(result.reason,'interrupted');
});

test('tail reading grows past large records and stays bounded when nothing complete fits',async t=>{
  const target=randomUUID();
  const padding='x'.repeat(300*1024);
  const large=line({type:'item_completed',payload:{type:'item_completed',turn_id:target,blob:padding}});
  const file=await hostFile(t,started(target)+large+aborted(target,'interrupted'));
  const result=await readHostTurnAbort({rolloutPath:file,turnId:target,options:{tailChunkBytes:1024,tailMaxBytes:1024*1024}});
  assert.equal(result.aborted,true);
  assert.equal(result.bytes,started(target).length+large.length+aborted(target,'interrupted').length);

  const pending=await hostFile(t,padding);
  const bounded=await readHostTurn({rolloutPath:pending,options:{tailChunkBytes:1024,tailMaxBytes:4096}});
  assert.equal(bounded.state,'unknown');
  assert.equal(bounded.bytes,padding.length);
  assert.equal((await readHostTurnAbort({rolloutPath:pending,turnId:target,options:{tailChunkBytes:1024,tailMaxBytes:4096}})).aborted,false);
});

test('host turn watcher fires once for the linked turn abort only',async t=>{
  const target=randomUUID(),other=randomUUID();
  const file=await hostFile(t,started(target)+activity(target));
  const events=[];let unconfirmed=0;
  const close=watchHostTurn({rolloutPath:file,turnId:target,intervalMs:25,onAbort:value=>events.push(value),onUnconfirmed:()=>{unconfirmed++}});
  t.after(close);

  await appendFile(file,completed(target));
  assert.equal(await waitFor(()=>events.length>0,150),false,'task_complete must not stop the member');

  await appendFile(file,started(other)+aborted(other,'interrupted'));
  assert.equal(await waitFor(()=>events.length>0,150),false,'another turn abort must not stop the member');
  assert.equal(unconfirmed,0);

  await appendFile(file,aborted(target,'interrupted'));
  assert.equal(await waitFor(()=>events.length>0),true);
  assert.equal(events.length,1);
  assert.equal(events[0].turnId,target);
  assert.equal(events[0].reason,'interrupted');

  await appendFile(file,aborted(target,'interrupted'));
  assert.equal(await waitFor(()=>events.length>1,150),false);
  close();
});

test('host turn watcher reports unreadable records once without aborting',async t=>{
  const {day}=await fixture(t);
  const missing=join(day,`rollout-2026-10-27T10-00-00-${randomUUID()}.jsonl`);
  let unconfirmed=0,aborts=0;
  const close=watchHostTurn({rolloutPath:missing,turnId:randomUUID(),intervalMs:25,onAbort:()=>{aborts++},onUnconfirmed:()=>{unconfirmed++}});
  assert.equal(await waitFor(()=>unconfirmed>0),true);
  await new Promise(resolve=>setTimeout(resolve,120));
  assert.equal(unconfirmed,1);
  assert.equal(aborts,0);
  close();
});

test('a large single log line cannot delay an associated stop by one interval per chunk',async t=>{
  const target=randomUUID(),file=await hostFile(t,started(target));
  const offset=(await stat(file)).size;
  await appendFile(file,JSON.stringify({type:'response_item',payload:{text:'普通日志'.repeat(500000)}})+'\n'+aborted(target));
  const events=[];
  const close=watchHostTurn({rolloutPath:file,turnId:target,offset,intervalMs:500,onAbort:value=>events.push(value)});
  t.after(close);
  assert.equal(await waitFor(()=>events.length===1,2500),true);
  assert.equal(events[0].turnId,target);
});

const agentLogs=(turnId,count,size)=>Array.from({length:count},(_,index)=>line({type:'event_msg',payload:{type:'agent_message',turn_id:turnId,message:`${index}:${'x'.repeat(size)}`}})).join('');

test('an appended host abort survives more than 280KiB of later logs before the next poll',async t=>{
  const target=randomUUID();
  const file=await hostFile(t,started(target));
  const offset=(await stat(file)).size;
  const events=[];
  const close=watchHostTurn({rolloutPath:file,turnId:target,offset,intervalMs:25,onAbort:value=>events.push(value)});
  t.after(close);
  const appended=aborted(target,'interrupted')+agentLogs(target,140,2048);
  assert.ok(Buffer.byteLength(appended)>280*1024);
  await appendFile(file,appended);
  assert.equal(await waitFor(()=>events.length>0),true);
  assert.equal(events.length,1);
  assert.equal(events[0].turnId,target);
  assert.equal(events[0].reason,'interrupted');
});

test('a host abort persisted before the watcher starts is still detected from the dispatch offset',async t=>{
  const target=randomUUID(),other=randomUUID();
  const file=await hostFile(t,started(target)+completed(target));
  const offset=(await stat(file)).size;
  await appendFile(file,started(other)+aborted(other,'interrupted')+aborted(target,'interrupted')+agentLogs(target,20,2048));
  const events=[];
  const close=watchHostTurn({rolloutPath:file,turnId:target,offset,intervalMs:25,onAbort:value=>events.push(value)});
  t.after(close);
  assert.equal(await waitFor(()=>events.length>0),true);
  assert.equal(events.length,1);
  assert.equal(events[0].reason,'interrupted');
});

test('bounded polls catch up across long utf8 lines and a chunk-split abort record',async t=>{
  const target=randomUUID();
  const file=await hostFile(t,started(target));
  const offset=(await stat(file)).size;
  const events=[];
  const close=watchHostTurn({rolloutPath:file,turnId:target,offset,intervalMs:25,maxBytesPerPoll:1024,onAbort:value=>events.push(value)});
  t.after(close);
  const longLine=line({type:'event_msg',payload:{type:'agent_message',turn_id:target,message:'中文日志'.repeat(2000)}});
  const record=aborted(target,'interrupted');
  await appendFile(file,longLine+record.slice(0,40));
  await new Promise(resolve=>setTimeout(resolve,120));
  assert.equal(events.length,0,'an incomplete abort record must not fire');
  await appendFile(file,record.slice(40));
  assert.equal(await waitFor(()=>events.length>0),true);
  assert.equal(events.length,1);
});

test('truncated or replaced host logs report unconfirmed without a stop',async t=>{
  const target=randomUUID();
  const file=await hostFile(t,started(target));
  const offset=(await stat(file)).size;
  let unconfirmed=0,aborts=0;
  const close=watchHostTurn({rolloutPath:file,turnId:target,offset,intervalMs:25,onAbort:()=>{aborts++},onUnconfirmed:()=>{unconfirmed++}});
  t.after(close);
  await writeFile(file,'');
  assert.equal(await waitFor(()=>unconfirmed>0),true);
  assert.equal(aborts,0);

  const replaced=await hostFile(t,started(target));
  const replacedOffset=(await stat(replaced)).size;
  let replacedUnconfirmed=0,replacedAborts=0;
  const closeReplaced=watchHostTurn({rolloutPath:replaced,turnId:target,offset:replacedOffset,intervalMs:25,onAbort:()=>{replacedAborts++},onUnconfirmed:()=>{replacedUnconfirmed++}});
  t.after(closeReplaced);
  await new Promise(resolve=>setTimeout(resolve,80));
  const replacement=`${replaced}.next`;
  await writeFile(replacement,started(target)+aborted(target,'interrupted'));
  await rename(replacement,replaced);
  assert.equal(await waitFor(()=>replacedUnconfirmed>0),true);
  await new Promise(resolve=>setTimeout(resolve,80));
  assert.equal(replacedAborts,0,'a replaced log must not fabricate a stop');
});

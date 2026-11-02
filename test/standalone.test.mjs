import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,symlink} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';

const cli=fileURLToPath(new URL('../cli/index.mjs',import.meta.url));
const peer=String.raw`
import {createInterface} from 'node:readline';
import {appendFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
let current=null,pending=null;
const models={currentModelId:'flash',availableModels:[{modelId:'flash',name:'DeepSeek-Flash'}]};
const commentary='SQUAD_DELIVERY: '+JSON.stringify({schemaVersion:1,conclusion:'COMMENTARY-DELIVERY',artifacts:['commentary-only.txt'],checks:[],remaining:[]});
const finalDelivery='SQUAD_DELIVERY: '+JSON.stringify({schemaVersion:1,conclusion:'FINAL-DELIVERY',artifacts:[],checks:[{name:'protocol',status:'passed',evidence:'fixture reply'}],remaining:[]});
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
const respond=(id,result)=>send({jsonrpc:'2.0',id,result});
const update=value=>send({jsonrpc:'2.0',method:'session/update',params:{sessionId:current,update:value}});
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line),p=m.params||{};
 if(m.method==='initialize')return respond(m.id,{protocolVersion:1,agentCapabilities:{loadSession:true,sessionCapabilities:{resume:true,close:true}}});
 if(m.method==='session/new'||m.method==='session/resume'){
  current=p.sessionId||randomUUID();appendFileSync(process.env.QODER_FIXTURE_LOG,JSON.stringify({method:m.method,sessionId:current})+'\n');
  return respond(m.id,{sessionId:current,models});
 }
 if(m.method==='session/prompt'){
  update({sessionUpdate:'agent_message_chunk',messageId:'reply',content:{type:'text',text:'## Synthetic peer\n\n'+commentary+'\n'}});
  update({sessionUpdate:'agent_message_chunk',messageId:'progress',content:{type:'text',text:'继续执行中，尚未形成最终交付。\n'}});
  if(p.prompt[0].text.includes('TEST_STOP_HOLD')){pending=m.id;return}
  update({sessionUpdate:'tool_call',toolCallId:'tool',kind:'execute',status:'pending',title:'Synthetic tool'});
  update({sessionUpdate:'tool_call_update',toolCallId:'tool',status:'completed'});
  update({sessionUpdate:'agent_message_chunk',messageId:'final',content:{type:'text',text:'Node-only process check complete.\n\n'+finalDelivery+'\n'}});
  return respond(m.id,{stopReason:'end_turn',usage:{inputTokens:3,outputTokens:2,totalTokens:5}});
 }
 if(m.method==='session/cancel'){if(pending)respond(pending,{stopReason:'cancelled'});pending=null;return}
 if(m.id!==undefined)respond(m.id,{});
});
`;

test('Node-only CLI persists, resumes and stops real worker processes without Bridge or Taskboard',async t=>{
 const home=await mkdtemp(join(tmpdir(),'squad-independent-'));t.after(async()=>{
  const receipt=await readFile(join(home,'data/service/receipt.json'),'utf8').then(JSON.parse).catch(()=>null);
  if(receipt?.pid)try{process.kill(receipt.pid,'SIGTERM')}catch(error){if(error.code!=='ESRCH')throw error}
  if(receipt?.pid)for(let n=0;n<100;n++){let alive=true;try{process.kill(receipt.pid,0)}catch{alive=false}if(!alive)break;await new Promise(resolve=>setTimeout(resolve,25))}
  await rm(home,{recursive:true,force:true,maxRetries:3,retryDelay:100});
 });
 const workspace=join(home,'workspace'),bin=join(home,'bin'),sessions=join(home,'codex/sessions/2026/10/23'),id=randomUUID();
 await Promise.all([mkdir(workspace),mkdir(bin),mkdir(sessions,{recursive:true})]);
 const reservation=createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
 await mkdir(join(home,'data/service'),{recursive:true});await writeFile(join(home,'data/service/receipt.json'),JSON.stringify({pid:null,port,origin:`http://127.0.0.1:${port}`}));
 const executable=join(bin,'qoder-peer.mjs');await writeFile(executable,`#!${process.execPath}\n${peer}`,{mode:0o700});await symlink(executable,join(bin,'qodercli'));
 await writeFile(join(sessions,`rollout-fixture-${id}.jsonl`),JSON.stringify({type:'session_meta',payload:{id,cwd:workspace}})+'\n');
 const env={...process.env,PATH:bin,CODEX_HOME:join(home,'codex'),CODEX_THREAD_ID:id,PLUGIN_DATA:join(home,'data'),QODER_FIXTURE_LOG:join(home,'peer.jsonl'),AGENT_BRIDGE_CLI_ROOT:join(home,'absent-bridge'),HARNESS_TASKBOARD_ORIGIN:'http://127.0.0.1:1/absent'};
 const invoke=async(command,input)=>{
  const result=await new Promise((ok,fail)=>{const child=execFile(process.execPath,[cli,command],{env,cwd:workspace,timeout:30000},(error,stdout,stderr)=>error?fail(Object.assign(error,{message:`${command}: ${error.message}; ${stderr}`,stderr})):ok(JSON.parse(stdout)));child.stdin.end(input?JSON.stringify(input):'')});
  return result;
 };
 const terminal=async taskId=>{
  for(let n=0;n<12;n++){
   const detail=await invoke('details',{taskId});if(['completed','failed','stopped'].includes(detail.attempts.at(-1)?.status))return detail;
   await invoke('wait',{seconds:1});
  }
  throw Error('worker did not reach a terminal state');
 };
 await invoke('bind');
 const handoff={requestId:'node-only-first',memberId:'implementer',title:'Synthetic ACP integration',goal:'Verify own local execution',scope:['Only the temporary fixture workspace'],writePaths:['result.txt'],criteria:['Return real protocol receipts']};
 const first=await invoke('dispatch',handoff),done=await terminal(first.taskId);assert.equal(done.attempts[0].status,'completed');assert.equal(done.attempts[0].usage.totalTokens,5);
 assert.equal(done.deliveryChecklist.conclusion,'FINAL-DELIVERY','only the final public reply becomes the delivery checklist');
 assert.deepEqual(done.deliveryChecklist.artifacts,[]);
 assert.equal(done.attempts[0].hasResult,true);
 assert.equal('handoff' in done.attempts[0],false,'default details never rehydrate the attempt handoff');
 assert.equal('result' in done.attempts[0],false,'default details never rehydrate the full attempt reply');
 assert.ok(first.progressUrl,JSON.stringify(first.pageError));assert.equal(new URL(first.progressUrl).hash,`#session/${first.taskId}`);
 const linked=await fetch(first.progressUrl.split('#')[0]+'api/snapshot');assert.equal((await linked.json()).tasks[0].id,first.taskId);
 assert.equal((await invoke('dispatch',handoff)).duplicate,true);
 await invoke('continue',{taskId:first.taskId,requestId:'node-only-continue',goal:'Resume the same native session',scope:handoff.scope,criteria:handoff.criteria});
 const continued=await terminal(first.taskId);assert.equal(continued.attempts.length,2);assert.equal(continued.attempts[1].sessionId,continued.attempts[0].sessionId);assert.equal(continued.attempts[1].resumedFrom,continued.attempts[0].id);
 assert.equal(continued.deliveryChecklist.conclusion,'FINAL-DELIVERY');
 await writeFile(join(workspace,'result.txt'),'fixture result');
 assert.equal((await invoke('inbox')).count,1);
 await invoke('verify',{taskId:first.taskId});
 await invoke('accept',{taskId:first.taskId,files:['result.txt'],note:'Synthetic peer integration only'});
 const accepted=await invoke('details',{taskId:first.taskId});
 assert.equal(accepted.acceptance.changedSinceVerification,false);
 assert.equal((await invoke('inbox')).count,0);
 await writeFile(join(workspace,'result.txt'),'normal later edit');
 const changed=await invoke('details',{taskId:first.taskId});
 assert.equal(changed.acceptance.changedSinceVerification,true);
 assert.equal(changed.acceptance.at,accepted.acceptance.at);
 assert.equal((await invoke('inbox')).count,0);
 await invoke('continue',{taskId:first.taskId,requestId:'node-only-stop',goal:'TEST_STOP_HOLD',scope:handoff.scope,criteria:handoff.criteria});
 const stopped=await invoke('stop',{taskId:first.taskId,reason:'Synthetic cancellation check'});assert.equal(stopped.stopped,true);assert.equal(stopped.status,'stopped');
 const stoppedDetails=await invoke('details',{taskId:first.taskId});
 assert.equal(stoppedDetails.attempts.length,3);
 assert.equal(stoppedDetails.round.status,'stopped');
 assert.equal(stoppedDetails.deliveryChecklist.available,false,'earlier commentary is never promoted to the final delivery checklist');
 assert.equal(stoppedDetails.deliveryChecklist.reason,'missing');
 assert.doesNotMatch(JSON.stringify(stoppedDetails.deliveryChecklist),/COMMENTARY-DELIVERY/);
 const snapshot=await invoke('snapshot');assert.equal(snapshot.tasks.length,1);assert.equal(snapshot.tasks[0].attempts,3);
 const requests=(await readFile(env.QODER_FIXTURE_LOG,'utf8')).trim().split('\n').map(JSON.parse);assert.equal(requests.filter(r=>r.method==='session/resume').length,2);
 assert.equal(requests.filter(r=>r.method==='session/new').length,2,'only the first CLI process probes the upstream model catalog');
 assert.equal((await readdir(join(home,'data/model-catalog'))).length,1,'the catalog metadata is reused by later CLI processes');
 assert.ok((await readFile(join(home,'data/local-store.sqlite'))).length>0);
});

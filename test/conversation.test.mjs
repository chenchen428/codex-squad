import test from 'node:test';
import assert from 'node:assert/strict';
import {createConversationRecorder,projectConversation} from '../cli/lib/conversation.mjs';
import {dialogue,processOf} from '../cli/ui/model.mjs';

function fixture(interval=5){
  const envelopes=[];
  const job={attemptId:'attempt-1',sessionId:'envelope-1',taskId:'task-1',executor:'qoder'};
  const recorder=createConversationRecorder(job,async(type,payload)=>envelopes.push({type,payload}),{interval});
  const message=(content,state='streaming',id='message-1')=>recorder.frame({kind:'session.assistant_message',payload:{content,persistedMessageId:id,metadata:{streamState:state,turnId:'turn-1'}}});
  return {recorder,envelopes,message,items:()=>projectConversation(envelopes)};
}
test('Qoder cumulative streaming snapshots update one message before completion and tool boundaries keep distinct replies',async()=>{
  const f=fixture();f.message('正在');f.message('正在检查');
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(f.items().filter(e=>e.kind==='message').length,1);assert.equal(f.items()[0].text,'正在检查');assert.equal(f.items()[0].status,'streaming');
  f.message('正在检查','completed');
  f.recorder.frame({kind:'session.tool_use',payload:{toolName:'Bash',input:{command:'npm test'},metadata:{itemId:'call-1'}}});
  f.recorder.frame({kind:'session.tool_result',payload:{toolName:'Bash',content:'3 tests passed',metadata:{itemId:'call-1'}}});
  f.message('验证通过','completed','message-2');await f.recorder.finish('completed');
  const task={attempts:[{id:'attempt-1',events:f.items(),result:'正在检查验证通过'}]};
  assert.deepEqual(dialogue(task).map(m=>m.text),['正在检查','验证通过']);
  assert.equal(processOf(task)[0].text,'npm test');assert.equal(processOf(task)[0].result,'');assert.equal(processOf(task)[0].status,'SUCCEEDED');
  assert.ok(f.envelopes.length<=2,'deltas are batched rather than one taskboard write per token');
});
test('Codex-style item identities use the same projection; snapshots replace content, duplicate and stale revisions do not append twice',async()=>{
  const f=fixture();
  for(const [content,streamState] of [['初稿','streaming'],['修订','streaming'],['修订完成','completed']])f.recorder.frame({kind:'session.assistant_message',payload:{content,metadata:{itemId:'item-1',threadId:'native-1',turnId:'turn-1',streamState}}});
  await f.recorder.finish('completed');
  const item=f.items()[0];assert.equal(item.text,'修订完成');assert.equal(item.status,'completed');assert.deepEqual(projectConversation([...f.envelopes,...f.envelopes]),f.items());
});
test('private reasoning becomes a generic progress signal and public credential fragments are redacted across deltas',async()=>{
  const f=fixture();f.recorder.frame({kind:'session.reasoning',payload:{content:'hidden private reasoning'}});
  f.message('Authorization: Bearer ');f.message('Authorization: Bearer super-secret-value','completed');await f.recorder.finish('failed');
  const stored=JSON.stringify(f.envelopes);assert.equal(stored.includes('hidden private reasoning'),false);assert.equal(JSON.stringify(f.items()).includes('super-secret-value'),false);
  assert.ok(f.items().some(item=>item.kind==='progress'&&item.text==='Agent 正在分析任务'));
});
test('a rejected live batch is surfaced when draining so the worker cannot claim a clean transcript',async()=>{
  const recorder=createConversationRecorder({attemptId:'a',sessionId:'s',taskId:'t',executor:'qoder'},async()=>{throw new Error('storage unavailable')},{interval:1});
  recorder.frame({kind:'session.assistant_message',payload:{content:'partial',metadata:{streamState:'streaming'}}});
  await new Promise(resolve=>setTimeout(resolve,10));await assert.rejects(recorder.finish('failed'),/storage unavailable/);
});

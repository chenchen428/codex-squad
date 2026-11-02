import test from 'node:test';import assert from 'node:assert/strict';
import{mkdtemp,mkdir,rm}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';
import{createLocalStore}from'../cli/lib/local-store.mjs';import{createViewerData}from'../cli/lib/viewer-data.mjs';import{createViewer}from'../cli/lib/viewer.mjs';
async function setup(t){
 const home=await mkdtemp(join(tmpdir(),'squad-pages-')),workspace=join(home,'workspace');await mkdir(workspace);
 const binding={schemaVersion:1,threadId:'11111111-1111-1111-1111-111111111111',workspace,projectId:'p',parentWorkId:'parent',title:'QA',tasks:['task-a','task-b'],attempts:{},workers:{}};
 const store=createLocalStore({home,workspace});t.after(async()=>{store.close();await rm(home,{recursive:true,force:true})});
 const messages=Array.from({length:450},(_,i)=>({id:'m-'+i,kind:'message',role:'assistant',text:'消息 '+i+'\n\n'+'公开记录。'.repeat(50),revision:1,status:'completed'}));
 const huge='```js\n'+('const x = 1;\n'.repeat(12000))+'```\n最后一段';
 const tasks=[{id:'task-a',events:messages},{id:'task-b',events:[{id:'huge',kind:'message',role:'assistant',text:huge,revision:1,status:'completed'}]}].map(x=>({id:x.id,title:x.id,memberId:'implementer',status:'stopped',attempts:[{id:x.id+'-attempt',index:1,status:'stopped',startedAt:'2026-10-25T10:00:00Z',endedAt:'2026-10-25T10:01:00Z',handoff:{goal:'goal'},events:x.events,usage:null}]}));
 await store.importSnapshot({binding,tasks});const calls=[];const client={home:store.home,databasePath:store.databasePath,async operate(name,input){calls.push([name,input.workId]);return store.operate(name,input)}};
 const reader=createViewerData({client});return{binding,store,reader,calls,huge};
}
test('host title changes appear in both board and task details without requiring task activity',async t=>{
 const{binding,reader}=await setup(t);
 const before=await reader.board(binding),detailBefore=await reader.task(binding,new URLSearchParams({id:'task-a'}));
 binding.title='用户刚刚修改的 Codex 会话名';
 const after=await reader.board(binding),detailAfter=await reader.task(binding,new URLSearchParams({id:'task-a'}));
 assert.equal(after.binding.title,binding.title);assert.equal(detailAfter.binding.title,binding.title);
 assert.notEqual(before.cursor,after.cursor);assert.notEqual(detailBefore.cursor,detailAfter.cursor);
});
test('task pages keep all history, bound bytes, page both ways and never read another task',async t=>{
 const{binding,reader,calls}=await setup(t);let response=await reader.task(binding,new URLSearchParams({id:'task-a'}));
 assert.ok(Buffer.byteLength(JSON.stringify(response))<131072);assert.equal(response.conversation.items.length,20);assert.equal(calls.some(([,id])=>id==='task-b'),false);
 const missed=await reader.task(binding,new URLSearchParams({id:'task-a',after:'0'}));assert.equal(missed.conversation.reset,true);assert.ok(missed.conversation.items.length<=20);
 const newest=response.conversation.items.map(x=>x.id);let ids=[...newest],previous;
 while(response.conversation.hasMore){previous=response;response=await reader.task(binding,new URLSearchParams({id:'task-a',before:response.conversation.before}));ids.unshift(...response.conversation.items.map(x=>x.id));}
 assert.equal(ids.length,451);assert.equal(new Set(ids).size,451);assert.equal(ids[1],'m-0');assert.equal(ids.at(-1),'m-449');
 const forward=await reader.task(binding,new URLSearchParams({id:'task-a',newer:response.conversation.newer}));assert.equal(forward.conversation.items[0].id,previous.conversation.items[0].id);
 calls.length=0;const stable=await reader.task(binding,new URLSearchParams({id:'task-a',after:String(response.conversation.revision)}));assert.equal(stable.conversation.items.length,0);assert.equal(calls.some(([name])=>name==='work.execution.get'),false);
});
test('large reply segments round trip exactly and carry fenced-code context',async t=>{
 const{binding,reader,huge}=await setup(t),page=await reader.task(binding,new URLSearchParams({id:'task-b'})),message=page.conversation.items.find(x=>x.id==='huge');
 assert.ok(message.segments.length>1);assert.ok(message.textOffset>0);let text='';
 for(const segment of message.segments){const result=await reader.task(binding,new URLSearchParams({id:'task-b',item:'huge',offset:String(segment.from)}));assert.equal(result.chunk.next,segment.to);if(segment.from>0&&segment.to<huge.length)assert.match(result.chunk.fence,/```/);text+=result.chunk.text;}
 assert.equal(text,huge);
});
test('stream revisions replace a public entity and missed bursts reset to a bounded page',async t=>{
 const{binding,store,reader}=await setup(t);const base=await reader.task(binding,new URLSearchParams({id:'task-a'}));
 let seq=(await store.operate('work.execution.watermark',{workId:'task-a',generation:1})).highWaterSequence;
 async function append(revision,content){seq++;await store.appendExecutionEvent('task-a',{generation:1,sequence:seq,sessionId:'session',event:{eventId:'batch-'+seq,sequence:seq,sessionId:'session',type:'SQUAD_CONVERSATION_BATCH',payload:{events:[{schemaVersion:'agent-bridge.conversation/v1',entityId:'live',entityRevision:revision,occurredAt:'2026-10-25T10:02:00Z',type:'MESSAGE_UPDATED',operation:'REPLACE',payload:{role:'assistant',content}}]}}});}
 await append(1,'first');const first=await reader.task(binding,new URLSearchParams({id:'task-a',after:String(base.conversation.revision)}));assert.equal(first.conversation.items.find(x=>x.id==='live').text,'first');
 await append(2,'updated');const next=await reader.task(binding,new URLSearchParams({id:'task-a',after:String(first.conversation.revision)}));assert.equal(next.conversation.items.find(x=>x.id==='live').text,'updated');assert.equal(next.conversation.items.filter(x=>x.id==='live').length,1);
 await assert.rejects(()=>reader.task(binding,new URLSearchParams({id:'task-a',before:'invalid'})));
 await assert.rejects(()=>reader.task(binding,new URLSearchParams({id:'task-b',before:base.conversation.before})));
});
test('paged HTTP routes enforce scope, method and bounded input',async t=>{
 const{binding,reader}=await setup(t),token='a'.repeat(48),view=await createViewer({snapshot:async()=>({binding}),board:reader.board,task:reader.task,loadScope:async key=>key===token?{binding}:null});t.after(()=>view.close());const url=view.origin+'/'+token+'/api/task';
 assert.equal((await fetch(url+'?id=task-a')).status,200);
 for(const query of ['?id=foreign','?id=task-a&threadId=another','?id=task-a&limit=10000','?id=task-a&before=invalid'])assert.equal((await fetch(url+query)).status,400,query);
 assert.equal((await fetch(url+'?id=task-a',{method:'POST'})).status,405);assert.equal((await fetch(url+'?id=task-a',{headers:{Origin:'https://other.example'}})).status,403);
 const head=await fetch(url+'?id=task-a',{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');
});

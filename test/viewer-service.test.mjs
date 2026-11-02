import assert from 'node:assert/strict';
import test from 'node:test';
import {execFile} from 'node:child_process';
import {mkdtemp,mkdir,readFile,writeFile,rm,utimes} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
const cli=fileURLToPath(new URL('../cli/index.mjs',import.meta.url));
const ids=['01a162b5-bd96-7440-90a3-e422ae74d358','01a16481-1434-7501-b11e-c671c476ed8e','01a163e0-bc25-70e0-9c36-c690ba42ca3f'];
test('concurrent opens share a process across chats, survive restart on the same port, and refuse port conflicts',async()=>{
 const home=await mkdtemp(join(tmpdir(),'squad-service-'));await mkdir(join(home,'bindings'));
 for(const threadId of ids)await writeFile(join(home,'bindings',`${threadId}.json`),JSON.stringify({schemaVersion:1,threadId,workspace:home,projectId:'p',parentWorkId:'parent',tasks:[],attempts:{},workers:{}}));
 await mkdir(join(home,'service'));await writeFile(join(home,'service/open.lock'),'');const stale=new Date(Date.now()-61000);await utimes(join(home,'service/open.lock'),stale,stale);
 const reservation=createServer();await new Promise(ok=>reservation.listen(0,'127.0.0.1',ok));const port=reservation.address().port;await new Promise(ok=>reservation.close(ok));await writeFile(join(home,'service/receipt.json'),JSON.stringify({pid:null,port,origin:`http://127.0.0.1:${port}`}));
 const invoke=(id,args=['open'],input)=>new Promise((ok,fail)=>{const child=execFile(process.execPath,[cli,...args],{env:{...process.env,PLUGIN_DATA:home,CODEX_THREAD_ID:id},timeout:30000},(error,stdout,stderr)=>error?fail(Object.assign(error,{stderr})):ok(JSON.parse(stdout)));child.stdin.end(input===undefined?'':JSON.stringify(input))});
 const receipt=async()=>JSON.parse(await readFile(join(home,'service/receipt.json'),'utf8'));
 const stop=async()=>{const r=await receipt().catch(()=>null);if(!r?.pid)return;process.kill(r.pid,'SIGTERM');for(let n=0;n<100;n++){if(!(await receipt()).pid)return;await delay(30)}throw new Error('test service failed to stop')};
 let blocker;
 try{
  const [a,b,c]=await Promise.all([invoke(ids[0]),invoke(ids[1]),invoke(ids[0],['summary','open'])]);
  assert.equal(a.pid,b.pid);assert.equal(a.pid,c.pid);assert.equal(a.origin,b.origin);assert.equal(a.origin,c.origin);assert.notEqual(a.url,b.url);assert.equal(c.url,a.url+'summary/');const intro=await invoke(ids[0],['intro','open']);assert.equal(intro.url,'https://chenchen428.github.io/codex-squad/');assert.equal(new URL(intro.url).hostname,'chenchen428.github.io');assert.equal(new URL(intro.url).pathname,'/codex-squad/');assert.equal((await receipt()).pid,a.pid);
  assert.equal((await (await fetch(a.url+'api/health')).json()).threadId,ids[0]);assert.equal((await (await fetch(b.url+'api/health')).json()).threadId,ids[1]);
  const reused=await invoke(ids[1]);assert.equal(reused.reused,true);assert.equal(reused.pid,a.pid);
  const code=`import {readBinding} from ${JSON.stringify(new URL('../cli/lib/runtime.mjs',import.meta.url).href)};import {openViewer} from ${JSON.stringify(new URL('../cli/lib/viewer.mjs',import.meta.url).href)};const b=await readBinding(${JSON.stringify(ids[2])});console.log(JSON.stringify(await Promise.all([openViewer(b),openViewer(b,{page:'summary'})])));`;const sameProcess=await new Promise((ok,fail)=>execFile(process.execPath,['--input-type=module','-e',code],{env:{...process.env,PLUGIN_DATA:home}},(error,stdout)=>error?fail(error):ok(JSON.parse(stdout))));assert.equal(sameProcess[0].pid,a.pid);assert.equal(sameProcess[1].url,sameProcess[0].url+'summary/');
  const saved=await invoke(ids[0],['summary','write'],{title:'阶段一',content:'# 目标\n仅供Agent恢复；<script>literal</script>'});assert.equal(saved.pid,a.pid);assert.equal(saved.revision,1);assert.equal('content' in saved,false);assert.equal('history' in saved,false);assert.equal(saved.url,a.url+'summary/');
  assert.equal((await invoke(ids[0],['summary','read'])).content,'# 目标\n仅供Agent恢复；<script>literal</script>');assert.equal(await invoke(ids[1],['summary','read']),null);
  await invoke(ids[0],['summary','write'],{title:'阶段二',content:'已验证'});const resumed=await invoke(ids[0],['summary','read']);assert.equal(resumed.revision,2);assert.equal(resumed.content,'已验证');assert.equal(resumed.history.length,1);assert.equal('content' in resumed.history[0],false);
  const review=join(home,'review');await mkdir(review);await writeFile(join(review,'index.html'),'<h1>本轮评审</h1>');const mounted=await invoke(ids[0],['review','open'],{directory:review});assert.equal(mounted.pid,a.pid);assert.equal(mounted.origin,a.origin);assert.match(await (await fetch(mounted.url)).text(),/本轮评审/);assert.equal((await fetch(b.url+'review/')).status,404);
  await stop();const restarted=await invoke(ids[0]);assert.equal(restarted.origin,a.origin);assert.equal(restarted.url,a.url);assert.notEqual(restarted.pid,a.pid);
  await stop();blocker=createServer((req,res)=>res.end('unrelated'));await new Promise((ok,fail)=>{blocker.once('error',fail);blocker.listen(Number(new URL(a.origin).port),'127.0.0.1',ok)});
  await assert.rejects(invoke(ids[0]),/启动失败/);assert.equal(await (await fetch(a.origin)).text(),'unrelated');assert.equal((await receipt()).origin,a.origin);
 }catch(error){error.serviceLog=await readFile(join(home,'service/server.log'),'utf8').catch(()=>'(no service log)');throw error}finally{if(blocker)await new Promise(ok=>blocker.close(ok));await stop();await rm(home,{recursive:true,force:true})}
});

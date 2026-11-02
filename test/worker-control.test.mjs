import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {registerWorker,registerSpawnedWorker,isWorkerAlive,requestWorkerStop,watchWorker} from '../cli/lib/worker-control.mjs';

test('failed worker registration closes only the newly spawned worker before returning',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'squad-register-failure-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const home=join(directory,'not-a-directory');await writeFile(home,'fixture');
  const child=spawn(process.execPath,['-e','process.stdin.resume();setTimeout(()=>process.exit(0),10000).unref()'],{stdio:['pipe','ignore','ignore']});
  t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL')});
  await assert.rejects(registerSpawnedWorker(child,randomUUID(),{home}));
  assert.ok(child.exitCode!==null||child.signalCode!==null);
});

test('worker control verifies its receipt and acknowledges stop without external process tools',async t=>{
 const home=await mkdtemp(join(tmpdir(),'squad-control-'));t.after(()=>rm(home,{recursive:true,force:true}));
 const nonce=randomUUID(),controller=new AbortController();
 const close=await watchWorker(nonce,controller,{home});t.after(close);
 assert.equal(await isWorkerAlive(process.pid,nonce,{home}),true);
 assert.equal(await isWorkerAlive(process.pid+1,nonce,{home}),false);
 assert.equal(await isWorkerAlive(process.pid,randomUUID(),{home}),false);
 const stopped=new Promise((ok,fail)=>{const timeout=setTimeout(()=>fail(Error('stop not acknowledged')),2000);controller.signal.addEventListener('abort',()=>{clearTimeout(timeout);ok()},{once:true})});
 await requestWorkerStop(nonce,{home});await stopped;assert.equal(controller.signal.aborted,true);
 await close();assert.equal(await isWorkerAlive(process.pid,nonce,{home}),false);
});

test('worker stop accepts only the stop request carrying its own nonce',async t=>{
 const home=await mkdtemp(join(tmpdir(),'squad-control-nonce-'));
 const nonce=randomUUID(),foreign=randomUUID(),controller=new AbortController();
 const close=await watchWorker(nonce,controller,{home});
 t.after(async()=>{await close();await rm(home,{recursive:true,force:true})});
 await requestWorkerStop(foreign,{home});
 await new Promise(resolve=>setTimeout(resolve,450));
 assert.equal(controller.signal.aborted,false);
 await requestWorkerStop(nonce,{home});
 assert.equal(await new Promise(resolve=>{const timer=setTimeout(()=>resolve(false),2000);controller.signal.addEventListener('abort',()=>{clearTimeout(timer);resolve(true)},{once:true})}),true);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {activeWorkerCount,createRuntimeInfo} from '../cli/lib/runtime-info.mjs';
import {registerWorker} from '../cli/lib/worker-control.mjs';

test('runtime info returns the local version view plus a cached worker count',async()=>{
  let worker=0;
  const service=createRuntimeInfo({
    updates:async()=>({localVersion:'0.12.0',entry:{url:'https://github.com/chenchen428/codex-squad/releases',mode:'manual'},autoUpdate:false}),
    countWorkers:async()=>{worker+=1;return worker},
  });
  try{
    const first=await service.read();
    assert.deepEqual(first,{
      schemaVersion:1,
      updates:{localVersion:'0.12.0',entry:{url:'https://github.com/chenchen428/codex-squad/releases',mode:'manual'},autoUpdate:false},
      activeTasks:null,
    });
    assert.equal(first.quota,undefined);
    assert.equal(first.updateAction,undefined);
    const second=await service.read();
    assert.equal(second.activeTasks,1);
    assert.equal(worker,1);
  }finally{service.close()}
});

test('updates read receives no refresh option and stays local',async()=>{
  const calls=[];
  const service=createRuntimeInfo({
    updates:async value=>{calls.push(value);return {localVersion:'0.12.0'}},
    countWorkers:async()=>0,
  });
  try{
    const value=await service.read();
    assert.equal(value.updates.localVersion,'0.12.0');
    assert.deepEqual(calls,[{}]);
  }finally{service.close()}
});

test('worker polling stays bounded and reports only live tasks',async()=>{
  let calls=0;
  const service=createRuntimeInfo({
    updates:async()=>({}),
    countWorkers:async()=>{calls+=1;return 3},
  });
  try{
    await service.read();
    await service.read();
    assert.equal(calls,1);
    await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal((await service.read()).activeTasks,3);
  }finally{service.close()}
});

test('running task guard uses live nonce receipts rather than completed tasks',async()=>{
  const home=await mkdtemp(join(tmpdir(),'squad-worker-guard-'));
  try{
    assert.equal(await activeWorkerCount({home}),0);
    await registerWorker(process.pid,randomUUID(),{home});
    assert.equal(await activeWorkerCount({home}),1);
  }finally{await rm(home,{recursive:true,force:true})}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';

const compiled=await build({entryPoints:[fileURLToPath(new URL('../cli/ui/runtime-info.ts',import.meta.url))],bundle:true,platform:'node',format:'esm',write:false});
const {createRuntimeInfoReader}=await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const response=value=>({ok:true,status:200,json:async()=>value});
function info(localVersion='0.12.0'){
  return {
    schemaVersion:1,
    updates:{localVersion,entry:{url:'https://github.com/chenchen428/codex-squad/releases',mode:'manual'},autoUpdate:false},
    activeTasks:0,
  };
}

test('the reader only GETs ./api/runtime-info and never asks for a refresh',async()=>{
  const calls=[];let current=info('0.12.0');
  const reader=createRuntimeInfoReader({request:async(url,init)=>{calls.push({url,method:init?.method,cache:init?.cache});return response(current)},onUpdate:()=>{}});
  try{
    const first=await reader.start();
    assert.equal(first.updates.localVersion,'0.12.0');
    current=info('0.12.1');
    const next=await reader.read();
    assert.equal(next.updates.localVersion,'0.12.1');
    assert.deepEqual(calls.map(call=>call.method),['GET','GET']);
    assert.ok(calls.every(call=>call.url==='./api/runtime-info'));
    assert.ok(calls.every(call=>call.cache==='no-store'));
    assert.ok(calls.every(call=>!call.url.includes('refresh')));
  }finally{reader.close()}
});

test('a failed read preserves the last successful version and marks it stale',async()=>{
  const views=[];let fail=false;
  const reader=createRuntimeInfoReader({request:async()=>{if(fail)throw Error('temporarily unavailable');return response(info())},onUpdate:value=>views.push(value)});
  try{
    await reader.start();fail=true;await reader.read();
    const latest=views.at(-1);
    assert.equal(latest.updates.localVersion,'0.12.0');
    assert.equal(latest.updates.stale,true);
    assert.equal(latest.updates.error.code,'SQUAD_RUNTIME_INFO_UNAVAILABLE');
    assert.equal(latest.updateAction,undefined);
  }finally{reader.close()}
});

test('a failed first read reports an unavailable local version without inventing one',async()=>{
  const reader=createRuntimeInfoReader({request:async()=>{throw Error('offline')},onUpdate:()=>{}});
  try{
    const value=await reader.read();
    assert.equal(value.updates.localVersion,null);
    assert.equal(value.updates.error.code,'SQUAD_RUNTIME_INFO_UNAVAILABLE');
    assert.equal(value.updates.autoUpdate,false);
    assert.equal(value.activeTasks,null);
  }finally{reader.close()}
});

test('an unrecognized payload is rejected instead of trusted',async()=>{
  const reader=createRuntimeInfoReader({request:async()=>response({schemaVersion:2,updates:{localVersion:'9.9.9'}}),onUpdate:()=>{}});
  try{
    const value=await reader.read();
    assert.equal(value.updates.localVersion,null);
    assert.equal(value.updates.error.code,'SQUAD_RUNTIME_INFO_UNAVAILABLE');
  }finally{reader.close()}
});

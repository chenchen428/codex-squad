import test from 'node:test';
import assert from 'node:assert/strict';
import {request as httpRequest} from 'node:http';
import {createViewer} from '../cli/lib/viewer.mjs';

const TOKEN='a'.repeat(48);
const OTHER_TOKEN='b'.repeat(48);
const THREAD='11111111-1111-4111-8111-111111111111';
const OTHER_THREAD='22222222-2222-4222-8222-222222222222';
const BINDING={threadId:THREAD,workspace:'/Users/private/work-one'};
const OTHER_BINDING={threadId:OTHER_THREAD,workspace:'/Users/private/work-two'};
const RUN_ID='33333333-3333-4333-8333-333333333333';

async function startViewer(overrides={}){
  const calls={analytics:[],start:[],list:[],detail:[],snapshot:0,board:0,task:0};
  const state={startResult:null,startError:null,detailResult:undefined,...overrides};
  const view=await createViewer({
    snapshot:async()=>{calls.snapshot+=1;throw new Error('snapshot 不应被调用')},
    board:async()=>{calls.board+=1;throw new Error('board 不应被调用')},
    task:async()=>{calls.task+=1;throw new Error('task 不应被调用')},
    analytics:async(binding,range,context)=>{
      calls.analytics.push({binding,range,context});
      return {schemaVersion:1,scope:range.scope,days:range.days};
    },
    analysisRuns:{
      start:async(binding,input,context)=>{
        calls.start.push({binding,input,context});
        if(state.startError)throw state.startError;
        return state.startResult||{skipped:false,run:{runId:RUN_ID,status:'running'},reused:false};
      },
      list:async(binding,context)=>{
        calls.list.push({binding,context});
        return {schemaVersion:1,current:null,lastSuccessful:null,history:[],schedule:{enabled:false}};
      },
      detail:async(binding,runId,context)=>{
        calls.detail.push({binding,runId,context});
        if(state.detailResult!==undefined)return state.detailResult;
        return {schemaVersion:1,run:{runId,status:'succeeded'},report:null};
      },
    },
    runtimeInfo:state.runtimeInfo,
    assets:'/nonexistent-viewer-assets',
    loadScope:async token=>token===TOKEN?{binding:BINDING}:token===OTHER_TOKEN?{binding:OTHER_BINDING}:null,
    readSummary:async()=>({schemaVersion:1}),
    port:0,
  });
  return {view,calls,state,origin:view.origin};
}

async function call(origin,path,{method='GET',headers={},body}={}){
  const response=await fetch(`${origin}${path}`,{method,headers,body,signal:AbortSignal.timeout(5000)});
  const text=await response.text();
  let json=null;
  try{json=text?JSON.parse(text):null}catch{}
  return {status:response.status,text,json,headers:response.headers};
}
function raw(origin,path,{method='GET',headers={},body=null}={}){
  return new Promise((resolve,reject)=>{
    const url=new URL(origin);
    const req=httpRequest({host:url.hostname,port:url.port,path,method,headers},response=>{
      const chunks=[];
      response.on('data',chunk=>chunks.push(chunk));
      response.on('end',()=>resolve({status:response.statusCode,headers:response.headers,text:Buffer.concat(chunks).toString('utf8')}));
    });
    req.on('error',reject);
    if(body!==null)req.write(body);
    req.end();
  });
}
function post(origin,path,body,{originHeader=origin,contentType='application/json'}={}){
  const headers={};
  if(originHeader!==null)headers.origin=originHeader;
  if(contentType!==null)headers['content-type']=contentType;
  return call(origin,path,{method:'POST',headers,body:typeof body==='string'?body:JSON.stringify(body)});
}

test('runtime information requires scope, takes no query and never starts analysis',async()=>{
  const requests=[];
  const info={
    schemaVersion:1,
    updates:{localVersion:'0.12.0',entry:{url:'https://github.com/chenchen428/codex-squad/releases',mode:'manual'},autoUpdate:false},
    activeTasks:1,
  };
  const {view,calls,origin}=await startViewer({runtimeInfo:async options=>{requests.push(options);return info}});
  try{
    const result=await call(origin,`/${TOKEN}/api/runtime-info`);
    assert.equal(result.status,200);assert.deepEqual(result.json,info);
    assert.deepEqual(requests,[undefined]);
    assert.equal((await call(origin,`/${TOKEN}/api/runtime-info?refresh=1`)).status,400);
    assert.equal((await call(origin,`/${TOKEN}/api/runtime-info?refresh=bad`)).status,400);
    assert.equal((await call(origin,`/${'c'.repeat(48)}/api/runtime-info`)).status,404);
    assert.equal((await post(origin,`/${TOKEN}/api/runtime-info`,{})).status,405);
    assert.equal((await post(origin,`/${TOKEN}/api/updates/install`,{version:'0.12.1'})).status,405);
    assert.equal(calls.analytics.length+calls.start.length+calls.snapshot,0);
  }finally{await view.close()}
});

test('runtime information unavailable without a provider',async()=>{
  const {view,origin}=await startViewer();
  try{
    const result=await call(origin,`/${TOKEN}/api/runtime-info`);
    assert.equal(result.status,503);
    assert.equal(result.json.errorCode,'SQUAD_RUNTIME_INFO_UNAVAILABLE');
  }finally{await view.close()}
});

test('GET analytics forwards scope and days without touching live data',async()=>{
  const {view,calls,origin}=await startViewer();
  try{
    const response=await call(origin,`/${TOKEN}/api/analytics?scope=global&days=7`);
    assert.equal(response.status,200);
    assert.deepEqual(response.json,{schemaVersion:1,scope:'global',days:7});
    assert.equal(calls.analytics.length,1);
    assert.deepEqual(calls.analytics[0].binding,BINDING);
    assert.deepEqual(calls.analytics[0].range,{scope:'global',days:7});
    assert.deepEqual(calls.analytics[0].context,{origin});
    assert.equal(calls.snapshot+calls.board+calls.task,0);

    const all=await call(origin,`/${TOKEN}/api/analytics`);
    assert.equal(all.status,200);
    assert.deepEqual(all.json,{schemaVersion:1,scope:'global',days:null});

    for(const query of ['?days=14','?scope=team','?scope=global&extra=1']){
      const invalid=await call(origin,`/${TOKEN}/api/analytics${query}`);
      assert.equal(invalid.status,400,query);
      assert.equal(invalid.json.connected,false);
    }
    assert.equal(calls.analytics.length,2);

    const session=await call(origin,`/${TOKEN}/api/analytics?scope=session`);
    assert.equal(session.status,200);
    assert.deepEqual(session.json,{schemaVersion:1,scope:'session',days:null});
  }finally{await view.close()}
});

test('GET analysis runs list and detail stay scoped to the token binding',async()=>{
  const {view,calls,state,origin}=await startViewer();
  try{
    const list=await call(origin,`/${TOKEN}/api/analysis/runs`);
    assert.equal(list.status,200);
    assert.equal(list.json.schemaVersion,1);
    assert.deepEqual(calls.list[0].binding,BINDING);
    assert.deepEqual(calls.list[0].context,{origin});

    const invalidQuery=await call(origin,`/${TOKEN}/api/analysis/runs?days=7`);
    assert.equal(invalidQuery.status,400);
    assert.equal(calls.list.length,1);

    const detail=await call(origin,`/${TOKEN}/api/analysis/runs/${RUN_ID}`);
    assert.equal(detail.status,200);
    assert.equal(detail.json.run.runId,RUN_ID);
    assert.deepEqual(calls.detail[0],{binding:BINDING,runId:RUN_ID,context:{origin}});

    const invalidId=await call(origin,`/${TOKEN}/api/analysis/runs/not-a-run-id`);
    assert.equal(invalidId.status,404);
    assert.equal(calls.detail.length,1);

    state.detailResult=null;
    const missing=await call(origin,`/${TOKEN}/api/analysis/runs/${RUN_ID}`);
    assert.equal(missing.status,404);
    assert.equal(calls.detail.length,2);

    state.detailResult=undefined;
    const other=await call(origin,`/${OTHER_TOKEN}/api/analysis/runs/${RUN_ID}`);
    assert.equal(other.status,200);
    assert.deepEqual(calls.detail[2].binding,OTHER_BINDING);

    const anonymous=await call(origin,`/api/analysis/runs`);
    assert.equal(anonymous.status,404);
    assert.equal((await call(origin,`/${'f'.repeat(48)}/api/analysis/runs`)).status,404);
    assert.equal(calls.list.length,1);
  }finally{await view.close()}
});

test('POST analysis runs accepts only the fixed same-origin JSON contract',async()=>{
  const {view,calls,state,origin}=await startViewer();
  try{
    const created=await post(origin,`/${TOKEN}/api/analysis/runs`,{requestId:'request-0001',days:7});
    assert.equal(created.status,202);
    assert.deepEqual(created.json,{
      schemaVersion:1,skipped:false,reason:null,reused:false,run:{runId:RUN_ID,status:'running'},
    });
    assert.deepEqual(calls.start[0],{
      binding:BINDING,input:{requestId:'request-0001',days:7},context:{origin},
    });

    state.startResult={skipped:true,reason:'NO_NEW_RECORDS',run:{runId:RUN_ID,status:'succeeded'},reused:true};
    const skipped=await post(origin,`/${TOKEN}/api/analysis/runs`,{requestId:'request-0002',days:null});
    assert.equal(skipped.status,200);
    assert.equal(skipped.json.skipped,true);
    assert.equal(skipped.json.reason,'NO_NEW_RECORDS');
    assert.deepEqual(calls.start[1].input,{requestId:'request-0002',days:null});

    const before=calls.start.length;
    assert.equal((await post(origin,`/${TOKEN}/api/analysis/runs`,{requestId:'request-0003'},{originHeader:null})).status,403);
    assert.equal((await post(origin,`/${TOKEN}/api/analysis/runs`,{requestId:'request-0003'},{originHeader:'http://evil.example'})).status,403);
    assert.equal((await post(origin,`/${TOKEN}/api/analysis/runs`,{requestId:'request-0003'},{contentType:null})).status,415);
    assert.equal((await post(origin,`/${TOKEN}/api/analysis/runs`,{requestId:'request-0003'},{contentType:'text/plain'})).status,415);
    assert.equal(calls.start.length,before);

    const unknown=await post(origin,`/${TOKEN}/api/analysis/runs`,{requestId:'request-0003',prompt:'x'});
    assert.equal(unknown.status,400);
    assert.equal(unknown.json.ok,false);
    assert.equal(unknown.json.error.code,'SQUAD_ANALYSIS_FIELD_UNKNOWN');
    for(const body of [
      {requestId:'short',days:7},
      {requestId:'request-0004',days:14},
      {requestId:'request-0004',days:'7'},
      {requestId:'request-0004',model:'x'},
      [],
      'not-json',
    ]){
      const invalid=await post(origin,`/${TOKEN}/api/analysis/runs`,body);
      assert.equal(invalid.status,400,JSON.stringify(body));
      assert.equal(invalid.json.ok,false,JSON.stringify(body));
    }

    const oversized=await post(origin,`/${TOKEN}/api/analysis/runs`,JSON.stringify({requestId:'request-0005',pad:'x'.repeat(8300)}));
    assert.equal(oversized.status,413);
    assert.equal(oversized.json.error.code,'SQUAD_ANALYSIS_BODY_TOO_LARGE');

    state.startError=Object.assign(new Error('另一轮小队分析正在执行，请稍后重试。'),{code:'SQUAD_ANALYSIS_BUSY'});
    const busy=await post(origin,`/${TOKEN}/api/analysis/runs`,{requestId:'request-0006'});
    assert.equal(busy.status,409);
    assert.deepEqual(busy.json,{ok:false,error:{code:'SQUAD_ANALYSIS_BUSY',message:'另一轮小队分析正在执行，请稍后重试。'}});
  }finally{await view.close()}
});

test('non-GET writes stay closed and host/origin gates reject cross-origin requests',async()=>{
  const {view,calls,origin}=await startViewer();
  try{
    for(const [method,path] of [
      ['POST','api/analytics'],
      ['PUT','api/analysis/runs'],
      ['DELETE','api/analysis/runs'],
      ['PATCH',`api/analysis/runs/${RUN_ID}`],
    ]){
      const response=await call(origin,`/${TOKEN}/${path}`,{method});
      assert.equal(response.status,405,`${method} ${path}`);
      assert.equal(response.headers.get('allow'),'GET, HEAD, POST');
    }
    assert.equal(calls.start.length,0);

    const badHost=await raw(origin,`/${TOKEN}/api/analysis/runs`,{headers:{host:'evil.example'}});
    assert.equal(badHost.status,403);
    const badOrigin=await call(origin,`/${TOKEN}/api/analysis/runs`,{headers:{origin:'http://evil.example'}});
    assert.equal(badOrigin.status,403);
    assert.equal(calls.list.length,0);

    const anonymous=await post(origin,`/${'f'.repeat(48)}/api/analysis/runs`,{requestId:'request-0001'});
    assert.equal(anonymous.status,404);
    assert.equal(calls.start.length,0);
  }finally{await view.close()}
});

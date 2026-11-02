import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {startPolling,syncStatusOf} from '../cli/ui/polling.mjs';
import {durationOf,durationLabel} from '../cli/ui/model.mjs';

test('scheduled polling reads changing HTTP facts and recovers after a failed response',async()=>{
  let requests=0,finish;
  const seen=[],errors=[],done=new Promise(resolve=>finish=resolve);
  const server=createServer((req,res)=>{requests++;res.setHeader('Content-Type','application/json');if(requests===2){res.writeHead(503);res.end('{}');return}res.end(JSON.stringify({revision:requests,status:requests===1?'running':'completed',text:requests===1?'正在执行':'执行结束'}))});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${server.address().port}/snapshot`;
  const polling=startPolling({interval:10,read:async signal=>{const response=await fetch(url,{signal});if(!response.ok)throw Error(`HTTP ${response.status}`);return response.json()},onData(value){seen.push(value);if(value.revision===3)finish()},onError(error){errors.push(error.message)}});
  try{
    await done;polling.close();const count=requests;await new Promise(resolve=>setTimeout(resolve,35));
    assert.equal(requests,count);assert.deepEqual(seen.map(x=>[x.revision,x.status,x.text]),[[1,'running','正在执行'],[3,'completed','执行结束']]);assert.deepEqual(errors,['HTTP 503']);
  }finally{polling.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
});

test('polling exposes message revisions, progress and terminal status without overlapping requests',async()=>{
  let release,finish,reads=0,inFlight=0,maximum=0;
  const seen=[],done=new Promise(resolve=>finish=resolve);
  const polling=startPolling({interval:5,read:async()=>{
    maximum=Math.max(maximum,++inFlight);const revision=++reads;
    await new Promise(resolve=>release=resolve);inFlight--;
    return {revision,text:revision===1?'正在检查':'检查完成',status:revision===1?'running':'completed',tokens:revision*100};
  },onData(value){seen.push(value);if(seen.length===2)finish()},onError(error){throw error}});
  const first=polling.refresh();release();await first;
  const second=polling.refresh();release();await second;await done;polling.close();
  assert.equal(maximum,1);assert.equal(reads,2);
  assert.deepEqual(seen.map(x=>[x.revision,x.text,x.status,x.tokens]),[[1,'正在检查','running',100],[2,'检查完成','completed',200]]);
});

test('a failure recovers on the same loop; closing aborts pending reads and suppresses late changes',async()=>{
  let count=0,latest,error,signal,release;
  const polling=startPolling({interval:10000,read:async s=>{signal=s;if(++count===1)throw Error('offline');if(count===3)await new Promise(resolve=>release=resolve);return count},onData:value=>latest=value,onError:value=>error=value.message});
  await polling.refresh();assert.equal(error,'offline');
  await polling.refresh();assert.equal(latest,2);
  const pending=polling.refresh();polling.close();assert.equal(signal.aborted,true);release();await pending;
  assert.equal(latest,2);await polling.refresh();assert.equal(count,3);
});

test('a timed-out snapshot read retries automatically and restores the fresh sync state',async()=>{
  let reads=0,finish;
  const failures=[],seen=[],done=new Promise(resolve=>finish=resolve);
  const polling=startPolling({interval:5,read:async()=>{
    if(++reads===1)throw new DOMException('signal timed out','TimeoutError');
    return {revision:reads};
  },onData(value){seen.push(value);finish()},onError(error){failures.push(error.name)}});
  try{
    await done;polling.close();
    assert.equal(reads,2);
    assert.deepEqual(failures,['TimeoutError']);
    assert.deepEqual(seen,[{revision:2}]);
    assert.deepEqual(syncStatusOf({connected:true,observedAt:'2026-10-25T08:05:00.000Z'}),{label:'实时同步',detail:'3秒自动同步',recovering:false});
  }finally{polling.close()}
});

test('recovering sync chrome stays quiet and keeps the previous sync time',()=>{
  const stale=syncStatusOf({connected:false,observedAt:'2026-10-25T08:00:00.000Z'});
  assert.equal(stale.label,'正在恢复同步');
  assert.match(stale.detail,/^上次同步 \d{2}:\d{2}$/);
  assert.equal(stale.recovering,true);
  assert.doesNotMatch(`${stale.label}${stale.detail}`,/连接中断|timed out|重试/);
  assert.deepEqual(syncStatusOf({connected:false,observedAt:''}),{label:'等待首次同步',detail:'正在连接',recovering:true});
});

test('execution clock advances without new events, stops at end time and never runs unknown tasks',()=>{
  const start=Date.parse('2026-10-23T08:00:00Z');
  const task={status:'running',attempts:[{status:'completed',startedAt:'2026-10-23T07:00:00Z',endedAt:'2026-10-23T07:02:00Z'},{status:'running',startedAt:new Date(start).toISOString()}]};
  assert.deepEqual(durationOf(task,start+15000),{milliseconds:135000,running:true});
  assert.equal(durationLabel(durationOf(task,start+16000).milliseconds),'2:16');
  task.status='unknown';assert.deepEqual(durationOf(task,start+100000),{milliseconds:120000,running:false});
  task.status='waiting_review';task.attempts[1].status='completed';task.attempts[1].endedAt=new Date(start+20000).toISOString();
  assert.deepEqual(durationOf(task,start+100000),{milliseconds:140000,running:false});
  assert.equal(durationLabel(null),'耗时未记录');assert.equal(durationLabel(0),'0:00');
});

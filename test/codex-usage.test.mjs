import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {appendFile,mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  codexMetadataStamp,collectCodexInventory,emptyCodexUsage,loadCodexUsage,resolveCodexHome,
} from '../cli/lib/codex-usage.mjs';

const NOW=new Date('2026-10-27T12:00:00.000Z');
const SQUAD='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ANALYSIS='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const UNASSIGNED='cccccccc-cccc-4ccc-8ccc-cccccccccccc';

async function workspace(){
  const root=await mkdtemp(join(tmpdir(),'squad-codex-usage-'));
  const codexHome=join(root,'codex');
  const home=join(root,'data');
  await mkdir(codexHome,{recursive:true});
  return {root,codexHome,home,cleanup:()=>rm(root,{recursive:true,force:true})};
}

function event(type,payload,{timestamp,ordinal}={}){
  const value={};
  if(timestamp!==undefined)value.timestamp=timestamp;
  if(ordinal!==undefined)value.ordinal=ordinal;
  value.type=type;
  value.payload=payload;
  return `${JSON.stringify(value)}\n`;
}

function usage(input,cached,output){
  return {
    input_tokens:input,cached_input_tokens:cached,cache_write_input_tokens:0,
    output_tokens:output,reasoning_output_tokens:0,total_tokens:input+output,
  };
}

function usageRecord({turnId='t1',responseId,usage:value,timestamp,ordinal,threadId=SQUAD,threadUsage=null}){
  const payload={
    thread_id:threadId,turn_id:turnId,session_id:threadId,root_turn_id:turnId,response_id:responseId,
    usage:value,turn_token_usage:value,
  };
  if(threadUsage)payload.thread_token_usage=threadUsage;
  return event('token_usage_record',payload,{timestamp,ordinal});
}

function tokenCount(total,{timestamp,ordinal,turnId='t1'}={}){
  return event('event_msg',{
    type:'token_count',
    info:{
      total_token_usage:{
        input_tokens:total.input,cached_input_tokens:total.cached,
        output_tokens:total.output,total_tokens:total.input+total.output,
      },
      last_token_usage:{input_tokens:888888,cached_input_tokens:888888,output_tokens:888888,total_tokens:2666664},
      model_context_window:1000,
    },
    ...(turnId?{turn_id:turnId}:{}),
  },{timestamp,ordinal});
}

function writeThreads(codexHome,rows){
  const db=new DatabaseSync(join(codexHome,'state_5.sqlite'));
  try{
    db.exec(`CREATE TABLE threads(
      id TEXT PRIMARY KEY,title TEXT,name TEXT,tokens_used INTEGER,model TEXT,
      rollout_path TEXT,updated_at INTEGER,updated_at_ms INTEGER,archived INTEGER
    )`);
    const insert=db.prepare('INSERT INTO threads(id,title,name,tokens_used,model,rollout_path,updated_at,updated_at_ms,archived) VALUES(?,?,?,?,?,?,?,?,?)');
    for(const row of rows){
      insert.run(row.id,row.title??null,row.name??null,row.tokensUsed??0,row.model??null,row.rolloutPath??null,row.updatedAt??0,row.updatedAtMs??0,row.archived?1:0);
    }
  }finally{db.close();}
}

test('modern usage is canonical per response, deduped, and never sums cumulative thread usage',async()=>{
  const ws=await workspace();
  try{
    const rollout=join(ws.codexHome,'modern.jsonl');
    await writeFile(rollout,[
      event('turn_context',{turn_id:'t1',model:'gpt-test'},{timestamp:'2026-10-26T10:00:00.000Z',ordinal:1}),
      usageRecord({responseId:'r1',usage:usage(100,40,20),threadUsage:{input_tokens:100,cached_input_tokens:40,output_tokens:20,total_tokens:120},timestamp:'2026-10-26T10:00:01.000Z',ordinal:3}),
      usageRecord({responseId:'r1',usage:usage(999,999,999),threadUsage:{input_tokens:999,cached_input_tokens:999,output_tokens:999,total_tokens:2997},timestamp:'2026-10-26T10:00:02.000Z',ordinal:4}),
      usageRecord({turnId:'t2',responseId:'r2',usage:usage(50,10,5),threadUsage:{input_tokens:150,cached_input_tokens:50,output_tokens:25,total_tokens:175},timestamp:'2026-10-26T10:00:03.000Z',ordinal:5}),
      tokenCount({input:150,cached:50,output:25},{timestamp:'2026-10-26T10:00:04.000Z',ordinal:6}),
      event('response_item',{type:'message',content:[{type:'text',text:'{"type":"token_usage_record","payload":{"usage":{"input_tokens":999999}}}'}]},{timestamp:'2026-10-26T10:00:05.000Z',ordinal:7}),
    ].join(''));
    writeThreads(ws.codexHome,[{
      id:SQUAD,title:'原始标题',name:'原生名称',rolloutPath:rollout,tokensUsed:175,model:'gpt-test',
    }]);

    const value=await loadCodexUsage({home:ws.home,codexHome:ws.codexHome,days:30,now:NOW});
    assert.equal(value.available,true);
    assert.equal(value.scope,'local');
    assert.deepEqual(value.totals,{inputTokens:150,cachedInputTokens:50,outputTokens:25,totalTokens:175});
    assert.equal(value.sessions.length,1);
    assert.equal(value.sessions[0].threadId,SQUAD);
    assert.equal(value.sessions[0].title,'原生名称');
    assert.equal(value.sessions[0].kind,'unassigned');
    assert.equal(value.sessions[0].squadThreadId,null);
    assert.equal(value.sessions[0].turnCount,2);
    assert.deepEqual(value.sessions[0].models.map(model=>model.model),['gpt-test','未上报']);
    const reported=value.sessions[0].models.find(model=>model.model==='gpt-test');
    assert.deepEqual(reported,{model:'gpt-test',inputTokens:100,cachedInputTokens:40,outputTokens:20,totalTokens:120});
    assert.equal(value.coverage.unattributedModelRecords,1);
    assert.equal(value.coverage.readableThreads,1);
    assert.equal(value.coverage.missingThreads,0);
    assert.equal(value.coverage.usageThreads,1);
    assert.equal(value.coverage.unreportedThreads,0);
    assert.equal(value.coverage.undatedRecords,0);
  }finally{await ws.cleanup();}
});

test('legacy token_count uses cumulative positive deltas, handles reset, and ignores last_token_usage',async()=>{
  const ws=await workspace();
  try{
    const rollout=join(ws.codexHome,'legacy.jsonl');
    await writeFile(rollout,[
      event('turn_context',{turn_id:'t1',model:'legacy-model'},{timestamp:'2026-10-26T09:00:00.000Z',ordinal:1}),
      tokenCount({input:100,cached:20,output:40},{timestamp:'2026-10-26T09:00:01.000Z',ordinal:2}),
      tokenCount({input:100,cached:20,output:40},{timestamp:'2026-10-26T09:00:02.000Z',ordinal:3}),
      tokenCount({input:150,cached:30,output:60},{timestamp:'2026-10-26T09:00:03.000Z',ordinal:4}),
      tokenCount({input:20,cached:5,output:8},{timestamp:'2026-10-26T09:00:04.000Z',ordinal:5}),
    ].join(''));
    writeThreads(ws.codexHome,[{id:SQUAD,title:'legacy',rolloutPath:rollout}]);

    const value=await loadCodexUsage({home:ws.home,codexHome:ws.codexHome,days:null,now:NOW});
    assert.equal(value.available,true);
    assert.deepEqual(value.totals,{inputTokens:170,cachedInputTokens:35,outputTokens:68,totalTokens:238});
    assert.equal(value.sessions[0].turnCount,1);
    assert.equal(value.sessions[0].models[0].model,'legacy-model');
    assert.equal(value.coverage.unattributedModelRecords,0);
  }finally{await ws.cleanup();}
});

test('incremental scan skips partial lines, resumes at the cursor, and resets on truncation or replacement',async()=>{
  const ws=await workspace();
  try{
    const rollout=join(ws.codexHome,'incremental.jsonl');
    const first=usageRecord({responseId:'r1',usage:usage(10,2,3),threadUsage:{input_tokens:10,cached_input_tokens:2,output_tokens:3,total_tokens:13},timestamp:'2026-10-26T08:00:00.000Z',ordinal:1});
    const second=usageRecord({responseId:'r2',usage:usage(20,5,7),threadUsage:{input_tokens:30,cached_input_tokens:7,output_tokens:10,total_tokens:40},timestamp:'2026-10-26T08:00:01.000Z',ordinal:2});
    await writeFile(rollout,`${first}${second.slice(0,-8)}`);
    writeThreads(ws.codexHome,[{id:SQUAD,title:'incremental',rolloutPath:rollout}]);

    let value=await loadCodexUsage({home:ws.home,codexHome:ws.codexHome,days:null,now:NOW});
    assert.deepEqual(value.totals,{inputTokens:10,cachedInputTokens:2,outputTokens:3,totalTokens:13});

    await appendFile(rollout,second.slice(-8));
    value=await loadCodexUsage({home:ws.home,codexHome:ws.codexHome,days:null,now:NOW});
    assert.deepEqual(value.totals,{inputTokens:30,cachedInputTokens:7,outputTokens:10,totalTokens:40});

    await appendFile(rollout,first);
    value=await loadCodexUsage({home:ws.home,codexHome:ws.codexHome,days:null,now:NOW});
    assert.deepEqual(value.totals,{inputTokens:30,cachedInputTokens:7,outputTokens:10,totalTokens:40});

    const replacement=usageRecord({responseId:'r3',usage:usage(70,10,20),timestamp:'2026-10-26T08:00:02.000Z',ordinal:3});
    await writeFile(rollout,replacement);
    value=await loadCodexUsage({home:ws.home,codexHome:ws.codexHome,days:null,now:NOW});
    assert.deepEqual(value.totals,{inputTokens:70,cachedInputTokens:10,outputTokens:20,totalTokens:90});
    assert.equal(value.sessions[0].turnCount,1);

    const longer=usageRecord({responseId:'r4',usage:usage(1234,0,5678),timestamp:'2026-10-26T08:00:03.000Z',ordinal:4});
    await writeFile(rollout,longer);
    value=await loadCodexUsage({home:ws.home,codexHome:ws.codexHome,days:null,now:NOW});
    assert.deepEqual(value.totals,{inputTokens:1234,cachedInputTokens:0,outputTokens:5678,totalTokens:6912});
  }finally{await ws.cleanup();}
});

test('every window obeys the cutoff and undated records stay out of totals',async()=>{
  const ws=await workspace();
  try{
    const rollout=join(ws.codexHome,'windows.jsonl');
    await writeFile(rollout,[
      usageRecord({responseId:'w1',usage:usage(10,0,0),threadUsage:{input_tokens:10,output_tokens:0,total_tokens:10},timestamp:'2026-10-26T12:00:00.000Z',ordinal:1}),
      usageRecord({responseId:'w2',usage:usage(20,0,0),threadUsage:{input_tokens:30,output_tokens:0,total_tokens:30},timestamp:'2026-10-17T12:00:00.000Z',ordinal:2}),
      usageRecord({responseId:'w3',usage:usage(30,0,0),threadUsage:{input_tokens:60,output_tokens:0,total_tokens:60},timestamp:'2026-09-17T12:00:00.000Z',ordinal:3}),
      usageRecord({responseId:'w4',usage:usage(40,0,0),threadUsage:{input_tokens:100,output_tokens:0,total_tokens:100},timestamp:undefined,ordinal:4}),
      usageRecord({responseId:'w5',usage:usage(50,0,0),threadUsage:{input_tokens:150,output_tokens:0,total_tokens:150},timestamp:'2026-10-28T12:00:00.000Z',ordinal:5}),
    ].join(''));
    writeThreads(ws.codexHome,[{id:SQUAD,title:'windows',rolloutPath:rollout}]);

    const seven=await loadCodexUsage({home:ws.home,codexHome:ws.codexHome,days:7,now:NOW});
    const thirty=await loadCodexUsage({home:ws.home,codexHome:ws.codexHome,days:30,now:NOW});
    const all=await loadCodexUsage({home:ws.home,codexHome:ws.codexHome,days:null,now:NOW});
    assert.equal(seven.totals.inputTokens,10);
    assert.equal(thirty.totals.inputTokens,30);
    assert.equal(all.totals.inputTokens,60);
    assert.equal(all.range,undefined);
    assert.equal(all.coverage.undatedRecords,1);
    assert.equal(all.coverage.usageThreads,1);
    assert.equal(all.coverage.unreportedThreads,0);
  }finally{await ws.cleanup();}
});

test('mixed legacy and modern records keep the old segment and count the modern response once',async()=>{
  const ws=await workspace();
  try{
    const rollout=join(ws.codexHome,'mixed.jsonl');
    await writeFile(rollout,[
      event('turn_context',{turn_id:'t1',model:'gpt-mixed'},{timestamp:'2026-10-26T09:00:00.000Z',ordinal:1}),
      tokenCount({input:10000,cached:0,output:0},{timestamp:'2026-10-26T09:00:01.000Z',ordinal:2}),
      usageRecord({responseId:'r1',usage:usage(50,0,0),threadUsage:{input_tokens:10050,cached_input_tokens:0,output_tokens:0,total_tokens:10050},timestamp:'2026-10-26T09:00:02.000Z',ordinal:3}),
      tokenCount({input:10050,cached:0,output:0},{timestamp:'2026-10-26T09:00:03.000Z',ordinal:4}),
    ].join(''));
    writeThreads(ws.codexHome,[{id:SQUAD,title:'mixed',rolloutPath:rollout,model:'db-final-model'}]);

    const value=await loadCodexUsage({home:ws.home,codexHome:ws.codexHome,days:null,now:NOW});
    assert.deepEqual(value.totals,{inputTokens:10050,cachedInputTokens:0,outputTokens:0,totalTokens:10050});
    assert.equal(value.sessions[0].turnCount,1);
    assert.deepEqual(value.sessions[0].models.map(model=>model.model),['gpt-mixed']);
    assert.equal(value.coverage.usageThreads,1);
    assert.equal(value.coverage.unattributedModelRecords,0);
  }finally{await ws.cleanup();}
});

test('a paired legacy line that arrives before its modern record is not counted twice',async()=>{
  const ws=await workspace();
  try{
    const rollout=join(ws.codexHome,'paired-first.jsonl');
    await writeFile(rollout,[
      event('turn_context',{turn_id:'t1',model:'gpt-paired'},{timestamp:'2026-10-26T09:00:00.000Z',ordinal:1}),
      tokenCount({input:10000,cached:0,output:0},{timestamp:'2026-10-26T09:00:01.000Z',ordinal:2}),
      tokenCount({input:10050,cached:0,output:0},{timestamp:'2026-10-26T09:00:02.000Z',ordinal:3}),
      usageRecord({responseId:'r1',usage:usage(50,0,0),threadUsage:{input_tokens:10050,cached_input_tokens:0,output_tokens:0,total_tokens:10050},timestamp:'2026-10-26T09:00:03.000Z',ordinal:4}),
    ].join(''));
    writeThreads(ws.codexHome,[{id:SQUAD,title:'paired-first',rolloutPath:rollout}]);

    const value=await loadCodexUsage({home:ws.home,codexHome:ws.codexHome,days:null,now:NOW});
    assert.deepEqual(value.totals,{inputTokens:10050,cachedInputTokens:0,outputTokens:0,totalTokens:10050});
    assert.deepEqual(value.sessions[0].models.map(model=>model.model),['gpt-paired']);
    assert.equal(value.coverage.usageThreads,1);
  }finally{await ws.cleanup();}
});

test('appending mixed records after a saved cursor keeps the old prefix without double counting',async()=>{
  const ws=await workspace();
  try{
    const rollout=join(ws.codexHome,'append.jsonl');
    await writeFile(rollout,[
      event('turn_context',{turn_id:'t1',model:'gpt-append'},{timestamp:'2026-10-26T09:00:00.000Z',ordinal:1}),
      tokenCount({input:10000,cached:0,output:0},{timestamp:'2026-10-26T09:00:01.000Z',ordinal:2}),
    ].join(''));
    writeThreads(ws.codexHome,[{id:SQUAD,title:'append',rolloutPath:rollout}]);

    let value=await loadCodexUsage({home:ws.home,codexHome:ws.codexHome,days:null,now:NOW});
    assert.equal(value.totals.inputTokens,10000);

    await appendFile(rollout,[
      usageRecord({responseId:'r1',usage:usage(50,0,0),threadUsage:{input_tokens:10050,output_tokens:0,total_tokens:10050},timestamp:'2026-10-26T09:00:02.000Z',ordinal:3}),
      tokenCount({input:10050,cached:0,output:0},{timestamp:'2026-10-26T09:00:03.000Z',ordinal:4}),
    ].join(''));
    value=await loadCodexUsage({home:ws.home,codexHome:ws.codexHome,days:null,now:NOW});
    assert.equal(value.totals.inputTokens,10050);

    await appendFile(rollout,[
      usageRecord({responseId:'r2',usage:usage(25,0,0),threadUsage:{input_tokens:10075,output_tokens:0,total_tokens:10075},timestamp:'2026-10-26T09:00:04.000Z',ordinal:5}),
      tokenCount({input:10075,cached:0,output:0},{timestamp:'2026-10-26T09:00:05.000Z',ordinal:6}),
    ].join(''));
    value=await loadCodexUsage({home:ws.home,codexHome:ws.codexHome,days:null,now:NOW});
    assert.equal(value.totals.inputTokens,10075);
  }finally{await ws.cleanup();}
});

test('legacy records without turn_id use the stream-order turn_context model, never the final database model',async()=>{
  const ws=await workspace();
  try{
    const withContext=join(ws.codexHome,'with-context.jsonl');
    await writeFile(withContext,[
      event('turn_context',{turn_id:'t1',model:'gpt6sol'},{timestamp:'2026-10-26T09:00:00.000Z',ordinal:1}),
      tokenCount({input:100,cached:0,output:0},{timestamp:'2026-10-26T09:00:01.000Z',ordinal:2,turnId:null}),
    ].join(''));
    const withoutContext=join(ws.codexHome,'without-context.jsonl');
    await writeFile(withoutContext,[
      tokenCount({input:200,cached:0,output:0},{timestamp:'2026-10-26T09:00:02.000Z',ordinal:1,turnId:null}),
    ].join(''));
    writeThreads(ws.codexHome,[
      {id:SQUAD,title:'with context',rolloutPath:withContext,model:'db-final-model'},
      {id:UNASSIGNED,title:'without context',rolloutPath:withoutContext,model:'db-final-model'},
    ]);

    const value=await loadCodexUsage({home:ws.home,codexHome:ws.codexHome,days:null,now:NOW});
    const reported=value.sessions.find(session=>session.threadId===SQUAD);
    const unreported=value.sessions.find(session=>session.threadId===UNASSIGNED);
    assert.deepEqual(reported.models.map(model=>model.model),['gpt6sol']);
    assert.deepEqual(unreported.models.map(model=>model.model),['未上报']);
    assert.equal(value.coverage.unattributedModelRecords,1);
  }finally{await ws.cleanup();}
});

test('sessions split squad, analysis and unassigned without merging the analysis thread',async()=>{
  const ws=await workspace();
  try{
    const rows=[];
    const records={[SQUAD]:100,[ANALYSIS]:200,[UNASSIGNED]:300};
    for(const [threadId,input] of Object.entries(records)){
      const rollout=join(ws.codexHome,`${threadId}.jsonl`);
      await writeFile(rollout,usageRecord({threadId,responseId:`r-${threadId}`,usage:usage(input,0,1),timestamp:'2026-10-26T10:00:00.000Z',ordinal:1}));
      rows.push({id:threadId,rolloutPath:rollout});
    }
    rows.find(row=>row.id===SQUAD).title='小队原始标题';
    rows.find(row=>row.id===SQUAD).name='小队原生名称';
    rows.find(row=>row.id===ANALYSIS).title='分析原始标题';
    writeThreads(ws.codexHome,rows);

    const value=await loadCodexUsage({
      home:ws.home,codexHome:ws.codexHome,days:null,now:NOW,
      squadThreadIds:[SQUAD],
      analysisThreads:[{realCodexThreadId:ANALYSIS,requestedByThreadId:SQUAD}],
    });
    assert.equal(value.sessions.length,3);
    const squad=value.sessions.find(session=>session.threadId===SQUAD);
    const analysis=value.sessions.find(session=>session.threadId===ANALYSIS);
    const unassigned=value.sessions.find(session=>session.threadId===UNASSIGNED);
    assert.equal(squad.kind,'squad');
    assert.equal(squad.squadThreadId,SQUAD);
    assert.equal(squad.title,'小队原生名称');
    assert.equal(squad.inputTokens,100);
    assert.equal(analysis.kind,'analysis');
    assert.equal(analysis.squadThreadId,SQUAD);
    assert.equal(analysis.title,'分析原始标题');
    assert.equal(analysis.inputTokens,200);
    assert.equal(unassigned.kind,'unassigned');
    assert.equal(unassigned.squadThreadId,null);
    assert.equal(unassigned.title,null);
    assert.equal(value.totals.inputTokens,600);
  }finally{await ws.cleanup();}
});

test('missing host metadata and missing rollout files stay honest and never fabricate usage',async()=>{
  const ws=await workspace();
  try{
    const unavailable=await loadCodexUsage({home:ws.home,codexHome:join(ws.root,'missing-codex'),days:7,now:NOW});
    assert.equal(unavailable.available,false);
    assert.equal(unavailable.scope,'local');
    assert.equal(unavailable.observedAt,NOW.toISOString());
    assert.deepEqual(unavailable.totals,{inputTokens:0,cachedInputTokens:0,outputTokens:0,totalTokens:0});
    assert.equal(unavailable.sessions.length,0);
    assert.match(unavailable.note,/未找到/);

    writeThreads(ws.codexHome,[
      {id:SQUAD,title:'deleted rollout',rolloutPath:join(ws.codexHome,'gone.jsonl')},
      {id:ANALYSIS,title:'readable but uncounted',tokensUsed:999,rolloutPath:join(ws.codexHome,'empty.jsonl')},
    ]);
    await writeFile(join(ws.codexHome,'empty.jsonl'),'');
    const missing=await loadCodexUsage({home:ws.home,codexHome:ws.codexHome,days:null,now:NOW});
    assert.equal(missing.available,true);
    assert.deepEqual(missing.totals,{inputTokens:0,cachedInputTokens:0,outputTokens:0,totalTokens:0});
    assert.equal(missing.coverage.threads,2);
    assert.equal(missing.coverage.readableThreads,1);
    assert.equal(missing.coverage.missingThreads,1);
    assert.equal(missing.coverage.usageThreads,0);
    assert.equal(missing.coverage.unreportedThreads,1);
    assert.equal(missing.coverage.unreportedWithTokens,1);
    assert.equal(missing.sessions.length,0);
    // The database tokens_used value is never promoted to recorded usage.
    assert.equal(missing.totals.totalTokens,0);
    assert.equal(/rollout|token_count|tokens_used|thread_token_usage|sqlite/i.test(missing.note),false);

    const empty=emptyCodexUsage({now:NOW});
    assert.equal(empty.available,false);
    assert.equal(empty.note.length>0,true);
    assert.equal(resolveCodexHome({codexHome:'/tmp/explicit',env:{CODEX_HOME:'/tmp/env'}}),'/tmp/explicit');
    assert.equal(resolveCodexHome({env:{CODEX_HOME:'/tmp/env'}}),'/tmp/env');
  }finally{await ws.cleanup();}
});

test('metadata stamp is cheap but changes when Codex thread usage changes',async()=>{
  const ws=await workspace();
  try{
    assert.equal((await codexMetadataStamp({codexHome:ws.codexHome})).database,null);
    writeThreads(ws.codexHome,[{id:SQUAD,tokensUsed:10,updatedAtMs:1},{id:ANALYSIS,tokensUsed:20,updatedAtMs:2}]);
    const first=await codexMetadataStamp({codexHome:ws.codexHome});
    assert.equal(first.database,'state_5.sqlite');
    assert.equal(first.rowCount,2);
    assert.equal(first.totalTokensUsed,30);
    assert.equal(first.readable,true);

    const db=new DatabaseSync(join(ws.codexHome,'state_5.sqlite'));
    try{db.prepare('UPDATE threads SET tokens_used=?,updated_at_ms=? WHERE id=?').run(50,3,SQUAD);}
    finally{db.close();}
    const second=await codexMetadataStamp({codexHome:ws.codexHome});
    assert.equal(second.totalTokensUsed,70);
    assert.notDeepEqual(first,second);
  }finally{await ws.cleanup();}
});

test('inventory exposes bounded public lifecycle and never stores hidden reasoning',async()=>{
  const ws=await workspace();
  try{
    const rollout=join(ws.codexHome,'lifecycle.jsonl');
    await writeFile(rollout,[
      event('turn_context',{turn_id:'t1',model:'gpt-life',effort:'xhigh',sandbox_policy:{type:'danger-full-access'},approval_policy:'never'},{timestamp:'2026-10-26T09:00:00.000Z',ordinal:1}),
      event('event_msg',{
        type:'task_started',turn_id:'t1',started_at:Date.parse('2026-10-26T09:00:00.000Z')/1000,
      },{timestamp:'2026-10-26T09:00:00.000Z',ordinal:2}),
      event('event_msg',{
        type:'item_completed',turn_id:'t1',
        item:{type:'UserMessage',content:[{type:'text',text:'请实现登录功能'},{type:'text',text:'并通过测试'}]},
      },{timestamp:'2026-10-26T09:00:01.000Z',ordinal:3}),
      event('event_msg',{
        type:'item_completed',turn_id:'t1',
        item:{type:'FunctionCallOutput',id:'dup',namespace:'codex_app',name:'send_message_to_thread',
          output:'<codex_delegation><source_thread_id>sub-1</source_thread_id><input>请实现登录功能 并通过测试</input></codex_delegation>'},
      },{timestamp:'2026-10-26T09:00:02.000Z',ordinal:4}),
      event('event_msg',{
        type:'item_completed',turn_id:'t1',
        item:{type:'FunctionCallOutput',id:'goal',namespace:'codex_app',name:'create_thread',
          output:'<codex_delegation><source_thread_id>sub-2</source_thread_id><input>正式需求：实现登录并补齐聚焦测试 &amp; 浏览器检查</input></codex_delegation>'},
      },{timestamp:'2026-10-26T09:00:03.000Z',ordinal:5}),
      event('event_msg',{
        type:'item_completed',turn_id:'t1',
        item:{type:'FunctionCallOutput',id:'entity',namespace:'codex_app',name:'send_message_to_thread',
          output:'<codex_delegation><input>异常实体 &#99999999; 保留</input></codex_delegation>'},
      },{timestamp:'2026-10-26T09:00:04.000Z',ordinal:6}),
      event('event_msg',{
        type:'item_completed',turn_id:'t1',
        item:{type:'FunctionCallOutput',id:'wrong-ns',namespace:'other_app',name:'send_message_to_thread',
          output:'<codex_delegation><input>不应采集的命名空间</input></codex_delegation>'},
      },{timestamp:'2026-10-26T09:00:05.000Z',ordinal:7}),
      event('event_msg',{
        type:'item_completed',turn_id:'t1',
        item:{type:'FunctionCallOutput',id:'wrong-name',namespace:'codex_app',name:'exec_command',
          output:'<codex_delegation><input>不应采集的工具</input></codex_delegation>'},
      },{timestamp:'2026-10-26T09:00:05.000Z',ordinal:7}),
      event('event_msg',{
        type:'item_completed',turn_id:'t1',
        item:{type:'FunctionCallOutput',id:'plain',namespace:'codex_app',name:'send_message_to_thread',
          output:'普通工具输出，不含委派结构'},
      },{timestamp:'2026-10-26T09:00:06.000Z',ordinal:8}),
      event('response_item',{
        type:'function_call_output',call_id:'call-1',
        output:'<codex_delegation><source_thread_id>sub-3</source_thread_id><input>不应采集的响应项</input></codex_delegation>',
      },{timestamp:'2026-10-26T09:00:07.000Z',ordinal:9}),
      usageRecord({responseId:'r1',usage:usage(10,2,5),timestamp:'2026-10-26T09:00:10.000Z',ordinal:10}),
      event('response_item',{
        type:'reasoning',summary:[{type:'summary_text',text:'HIDDEN-REASONING'}],
      },{timestamp:'2026-10-26T09:00:11.000Z',ordinal:5}),
      event('response_item',{type:'function_call',name:'functions.exec_command',arguments:JSON.stringify({cmd:'qodercli -p "implement login"'})},
        {timestamp:'2026-10-26T09:00:12.000Z',ordinal:6}),
      event('event_msg',{
        type:'task_complete',turn_id:'t1',
        completed_at:Date.parse('2026-10-26T09:05:00.000Z')/1000,
        duration_ms:300000,last_agent_message:'登录功能已交付。',
      },{timestamp:'2026-10-26T09:05:00.000Z',ordinal:6}),
    ].join(''));
    writeThreads(ws.codexHome,[{id:SQUAD,title:'lifecycle',rolloutPath:rollout}]);

    const inventory=await collectCodexInventory({home:ws.home,codexHome:ws.codexHome});
    assert.equal(inventory.available,true);
    assert.equal(inventory.readable.has(rollout),true);
    const entry=inventory.index.files[rollout];
    assert.ok(entry);
    assert.equal(entry.lifecycle.lastKind,'complete');
    assert.equal(entry.lifecycle.lastMessage,'登录功能已交付。');
    assert.deepEqual(entry.lifecycle.userMessages,['请实现登录功能 并通过测试'],'普通用户消息与同文委派去重');
    assert.deepEqual(entry.lifecycle.publicGoals,[
      {
        text:'正式需求：实现登录并补齐聚焦测试 & 浏览器检查',
        turn:'t1',at:Date.parse('2026-10-26T09:00:03.000Z'),sourceThreadId:'sub-2',
      },
      {
        text:'异常实体 &#99999999; 保留',
        turn:'t1',at:Date.parse('2026-10-26T09:00:04.000Z'),sourceThreadId:null,
      },
    ]);
    assert.equal(entry.lifecycle.turns.t1,'gpt-life');
    assert.deepEqual(entry.lifecycle.contexts.t1,{reasoning:'xhigh',sandbox:'{"type":"danger-full-access"}',approval:'never'});
    assert.deepEqual(entry.lifecycle.externalExecutors,['qoder'],'真实外部执行必须能阻止伪纯Codex基线');
    assert.equal(entry.lifecycle.starts.t1.startedAt,Date.parse('2026-10-26T09:00:00.000Z'));
    assert.equal(entry.lifecycle.completes.t1.completedAt,Date.parse('2026-10-26T09:05:00.000Z'));
    assert.equal(entry.lifecycle.completes.t1.durationMs,300000);
    assert.ok(!JSON.stringify(entry).includes('HIDDEN-REASONING'),'隐藏推理不进入共享索引');
    assert.ok(!JSON.stringify(entry).includes('不应采集'),'非委派命名空间、工具和响应项均不采集');
  }finally{await ws.cleanup();}
});

test('public goals stay bounded while keeping the first requirements and latest append',async()=>{
  const ws=await workspace();
  try{
    const rollout=join(ws.codexHome,'goals.jsonl');
    const lines=[
      event('turn_context',{turn_id:'t1',model:'gpt-goal'},{timestamp:'2026-10-26T09:00:00.000Z',ordinal:1}),
    ];
    for(let index=0;index<10;index+=1){
      const at=`2026-10-26T09:00:${String(10+index).padStart(2,'0')}.000Z`;
      lines.push(event('event_msg',{
        type:'item_completed',turn_id:'t1',
        item:{type:'FunctionCallOutput',id:`goal-${index}`,namespace:'codex_app',
          name:index%2?'send_message_to_thread':'create_thread',
          output:`<codex_delegation><source_thread_id>sub-${index}</source_thread_id><input>需求 ${index}</input></codex_delegation>`},
      },{timestamp:at,ordinal:index+2}));
    }
    await writeFile(rollout,lines.join(''));
    writeThreads(ws.codexHome,[{id:SQUAD,title:'goals',rolloutPath:rollout}]);

    const inventory=await collectCodexInventory({home:ws.home,codexHome:ws.codexHome});
    const goals=inventory.index.files[rollout].lifecycle.publicGoals;
    assert.equal(goals.length,8);
    assert.deepEqual(goals.slice(0,4).map(goal=>goal.text),['需求 0','需求 1','需求 2','需求 3']);
    assert.deepEqual(goals.slice(-2).map(goal=>goal.text),['需求 8','需求 9']);
  }finally{await ws.cleanup();}
});

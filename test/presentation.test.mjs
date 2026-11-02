import test from 'node:test';
import assert from 'node:assert/strict';
import {dialogue,deliveryFromEvents,deliveryLabel,handoffRoleLabel,latestProcess,number,processOf,processSummary,processHint,tokenLabel,tokenParts,usageOf} from '../cli/ui/model.mjs';
test('public dialogue excludes tools and reasoning, keeps handoff/replies in order, deduplicates terminal result',()=>{
 const task={attempts:[{id:'a',startedAt:'1',handoff:{goal:'fix input'},events:[{id:'t',kind:'tool_result',role:'tool',text:'secret command'},{id:'r',kind:'reasoning',role:'assistant',text:'private chain'},{id:'m',kind:'message',role:'assistant',text:'public reply',time:'2'}],result:'public reply'}]};
 const rows=dialogue(task);
 assert.deepEqual(rows.map(m=>[m.role,m.text]),[['user','第1轮 · 首次交办\n\n目标\nfix input'],['assistant','public reply']]);
 assert.equal(rows[0].kind,'handoff');assert.equal(rows[0].handoff.kind,'initial');assert.equal(rows[0].handoff.attemptIndex,1);
 assert.equal(rows[0].handoff.delivery.state,'received');assert.equal(handoffRoleLabel(rows[0].handoff),'Codex · 首次交办');
 assert.equal(rows[1].kind,'message');assert.equal(rows[1].handoff,undefined);
});
test('all rounds show the full transferred handoff and keep earlier goals in history',()=>{
 const task={attempts:[
  {id:'a1',index:1,startedAt:'1',handoff:{goal:'首轮目标',context:'首轮背景',scope:['src/report.ts'],criteria:['npm test 通过']},events:[{id:'m1',kind:'message',role:'assistant',text:'首轮回复',time:'2'}]},
  {id:'a2',index:2,startedAt:'3',handoff:{goal:'补充目标',context:'只处理空值边界',scope:['src/report.ts'],writePaths:['src/report.ts'],criteria:['回归通过'],reason:'用户补充'},events:[{id:'m2',kind:'message',role:'assistant',text:'补充回复',time:'4'}]},
  {id:'a3',index:3,startedAt:'5',handoff:{goal:'第三个目标',context:'继续检查草稿恢复'},events:[{id:'u3',kind:'message',role:'user',text:'普通补充消息',time:'5.5'},{id:'m3',kind:'message',role:'assistant',text:'第三轮回复',time:'6'}]},
 ]};
 const rows=dialogue(task);
 assert.deepEqual(rows.map(m=>m.kind),['handoff','message','handoff','message','handoff','message','message']);
 const handoffs=rows.filter(m=>m.kind==='handoff');
 assert.deepEqual(handoffs.map(m=>handoffRoleLabel(m.handoff)),['Codex · 首次交办','Codex · 补充交办','Codex · 补充交办']);
 assert.deepEqual(handoffs.map(m=>m.handoff.attemptIndex),[1,2,3]);
 assert.match(handoffs[0].text,/目标\n首轮目标/);assert.match(handoffs[0].text,/补充背景\n首轮背景/);
 assert.match(handoffs[1].text,/补充背景\n只处理空值边界/);assert.match(handoffs[1].text,/必要写入路径\n- src\/report\.ts/);
 assert.match(handoffs[1].text,/验收要求\n- 回归通过/);assert.match(handoffs[1].text,/检查原因\n用户补充/);
 assert.match(handoffs[2].text,/目标\n第三个目标/);
 assert.ok(rows.some(m=>m.text==='首轮回复'));assert.ok(rows.some(m=>m.text==='补充回复'));
 const ordinary=rows.find(m=>m.text==='普通补充消息');
 assert.equal(ordinary.kind,'message');assert.equal(ordinary.handoff,undefined);assert.equal(ordinary.role,'user');
});
test('public handoff redaction removes credentials but keeps business context',()=>{
 const context=['需要保留的业务背景。','Authorization: Bearer abcdefghijklmnop','password=hunter2','AKIAABCDEFGHIJKLMNOP','-----BEGIN RSA PRIVATE KEY-----','MIIEprivate','-----END RSA PRIVATE KEY-----'].join('\n');
 const [handoff]=dialogue({attempts:[{id:'a',index:1,handoff:{goal:'保留目标',context}}]});
 for(const secret of ['abcdefghijklmnop','hunter2','AKIAABCDEFGHIJKLMNOP','MIIEprivate'])assert.equal(handoff.text.includes(secret),false,secret);
 assert.ok(handoff.text.includes('需要保留的业务背景。'));assert.ok(handoff.text.includes('保留目标'));assert.ok(handoff.text.includes('[secret]'));
});
test('delivery only claims receipt with public protocol evidence',()=>{
 const receipt={type:'SQUAD_PROMPT_SUBMITTED',occurredAt:'2026-10-20T09:00:01.000Z'};
 const started={type:'SQUAD_ATTEMPT_STARTED',occurredAt:'2026-10-20T09:00:00.000Z'};
 const reply={kind:'message',role:'assistant',text:'公开回复',time:'2026-10-20T09:00:02.000Z'};
 const tool={kind:'tool',toolName:'Bash',text:'npm test',time:'2026-10-20T09:00:02.000Z'};
 const legacyReply={type:'SQUAD_ATTEMPT_EVENT',occurredAt:'2026-10-20T09:00:02.000Z',payload:{kind:'message',role:'assistant',text:'旧记录公开回复',time:'2026-10-20T09:00:02.000Z'}};
 const progress={type:'SQUAD_ATTEMPT_EVENT',occurredAt:'2026-10-20T09:00:02.000Z',payload:{kind:'progress',text:'内部进度'}};
 assert.deepEqual(deliveryFromEvents([],{activeAttempt:true}),{state:'pending',terminal:false,submittedAt:null,respondedAt:null});
 assert.equal(deliveryFromEvents([{type:'SQUAD_ATTEMPT_STARTED'},{type:'SQUAD_ATTEMPT_SESSION'}],{status:'running',activeAttempt:true}).state,'pending');
 assert.equal(deliveryFromEvents([receipt],{status:'running',activeAttempt:true}).state,'sent');
 assert.deepEqual(deliveryFromEvents([receipt,reply],{status:'running',activeAttempt:true}),{state:'received',terminal:false,submittedAt:'2026-10-20T09:00:01.000Z',respondedAt:'2026-10-20T09:00:02.000Z'});
 assert.equal(deliveryFromEvents([started,tool],{status:'running',activeAttempt:true}).state,'received');
 assert.equal(deliveryFromEvents([started,legacyReply],{status:'running',activeAttempt:true}).state,'received');
 assert.equal(deliveryFromEvents([receipt],{status:'completed',endedAt:'2026-10-20T09:00:03.000Z',result:'执行完成。'}).state,'sent');
 assert.equal(deliveryFromEvents([started],{status:'completed',endedAt:'2026-10-20T09:00:03.000Z',result:'执行器报错：连接中断'}).state,'unconfirmed');
 assert.equal(deliveryFromEvents([receipt,progress],{status:'completed',endedAt:'2026-10-20T09:00:03.000Z'}).state,'sent');
 assert.deepEqual(deliveryFromEvents([],{status:'failed',endedAt:'2026-10-20T09:00:03.000Z'}),{state:'unconfirmed',terminal:true,submittedAt:null,respondedAt:null});
 assert.equal(deliveryFromEvents([receipt],{status:'failed'}).state,'sent');
 assert.equal(deliveryFromEvents([],{status:'unknown'}).state,'unconfirmed');
 assert.equal(deliveryFromEvents([],{status:'unknown',activeAttempt:true}).state,'pending');
 assert.deepEqual(['received','sent','pending','unconfirmed','other'].map(state=>deliveryLabel({state})),['已收到','已发送','送达待确认','未确认送达','送达待确认']);
});
test('unknown and partial attempts retain reported usage without zero filling or cache double counting',()=>{
 assert.equal(usageOf([]).totalTokens,null);
 const u=usageOf([{usage:{inputTokens:80,outputTokens:20,cachedInputTokens:50,totalTokens:100}},{usage:null}]);
 assert.equal(u.totalTokens,100);assert.equal(u.cachedInputTokens,50);assert.equal(u.partial,true);assert.equal(u.reported,1);
 assert.equal(usageOf([{usage:{inputTokens:0,outputTokens:0,totalTokens:0}}]).totalTokens,0);
});

test('a terminal result completes its truncated public reply without repeating the prefix',()=>{const result='公开回复'.repeat(1500);const rows=dialogue({attempts:[{id:'a',events:[{id:'msg',kind:'message',role:'assistant',text:result.slice(0,4000)}],result}]});assert.equal(rows.length,1);assert.equal(rows[0].id,'msg');assert.equal(rows[0].text,result)});

test('runner aggregate result is not repeated after its public replies',()=>{
 const events=[{id:'u',kind:'message',role:'user',text:'keep input'},{id:'p',kind:'message',role:'assistant',text:'检查完成。'},{id:'f',kind:'message',role:'assistant',text:'已保留草稿。'}];
 const task={attempts:[{id:'a',events,result:'检查完成。已保留草稿。'}]};
 assert.deepEqual(dialogue(task).map(m=>m.text),['keep input','检查完成。','已保留草稿。']);
 task.attempts[0].result='另有独立结论。';
 assert.equal(dialogue(task).at(-1).text,'另有独立结论。');
});

test('long public replies remain separate when the terminal result is their aggregate',()=>{
 const first='a'.repeat(4000),last='后续公开回复。';
 const task={attempts:[{id:'a',events:[{id:'p',kind:'message',role:'assistant',text:first},{id:'f',kind:'message',role:'assistant',text:last}],result:first+last}]};
 assert.deepEqual(dialogue(task).map(m=>[m.id,m.text]),[['p',first],['f',last]]);
});

test('a completed protocol reply is not repeated by a result redacted differently',()=>{
 const text='已更新 plugins[local-path]odex-squad 的说明。';
 const task={attempts:[{id:'a',events:[{id:'msg',kind:'message',role:'assistant',text,time:'2',revision:3,status:'completed'}],result:'已更新 plugins/codex-squad 的说明。'}]};
 assert.deepEqual(dialogue(task).map(m=>[m.id,m.text]),[['msg',text]]);
});

test('a terminal result remains when the attempt has no public reply',()=>{
 const task={attempts:[{id:'a',events:[{id:'t',kind:'tool_result',role:'tool',text:'ok',status:'SUCCEEDED'}],result:'执行完成。'}]};
 assert.deepEqual(dialogue(task).map(m=>[m.id,m.text]),[['a:result','执行完成。']]);
});


test('long completed protocol replies remain unchanged when the runner aggregate has a shared prefix',()=>{
 const first='公开进度。'.repeat(1000),last='已修改 plugins[local-path]odex-squad。';
 const events=[{id:'long',kind:'message',role:'assistant',text:first,revision:2,status:'completed'},{id:'last',kind:'message',role:'assistant',text:last,revision:3,status:'completed'}];
 const task={attempts:[{id:'a',events,result:first+'已修改 plugins/codex-squad。'}]};
 assert.deepEqual(dialogue(task).map(m=>[m.id,m.text]),events.map(e=>[e.id,e.text]));
});

test('execution process lists only real tool records and keeps repeated commands as separate calls',()=>{
 const task={attempts:[{id:'a',events:[
  {id:'t1',kind:'tool',toolName:'Bash',text:'npm test',status:'SUCCEEDED'},
  {id:'p1',kind:'progress',text:'Agent 正在分析任务',status:'RUNNING'},
  {id:'t2',kind:'tool',toolName:'Bash',text:'npm test',status:'RUNNING'},
  {id:'u1',kind:'tool_use',toolName:'execute',text:'node --test',status:'RUNNING'},
  {id:'r1',kind:'tool_result',toolName:'execute',text:'tests passed',status:'SUCCEEDED'},
  {id:'m1',kind:'message',role:'assistant',text:'public reply'}
 ]}]};
 assert.deepEqual(processOf(task).map(event=>event.id),['t1','t2','u1','r1']);
});

test('execution summaries keep the first real line and drop heredoc bodies and output redirects',()=>{
 const action=event=>processSummary(event).action;
 assert.equal(action({kind:'tool',toolName:'Bash',text:'npm test'}),'Bash · npm test');
 assert.equal(action({kind:'tool',toolName:'Bash',text:'\r\n\r\n  npm test\r\nsecond line'}),'Bash · npm test');
 assert.equal(action({kind:'tool',toolName:'Bash',text:"node <<'EOF'\nconst answer = 42;\nconsole.log(answer);\nEOF"}),'Bash · node');
 assert.equal(action({kind:'tool',toolName:'Bash',text:'npm test > /tmp/test.log 2>&1'}),'Bash · npm test');
});

test('long single-line commands stay bounded to one line',()=>{
 const {action}=processSummary({kind:'tool',toolName:'Bash',text:`git commit -m "${'长参数'.repeat(80)}"`});
 assert.ok(action.length<=120);
 assert.ok(action.endsWith('…'));
 assert.equal(action.includes('\n'),false);
});

test('tool name alone and tool results with output never invent or expose a command',()=>{
 assert.deepEqual(processSummary({kind:'tool',toolName:'Read',status:'RUNNING'}),{action:'Read',state:'running',status:'执行中'});
 const result=processSummary({kind:'tool_result',toolName:'Bash',text:'AssertionError: secret output',status:'FAILED'});
 assert.deepEqual(result,{action:'Bash',state:'failed',status:'失败'});
 assert.equal(processSummary({kind:'tool'}).action,'未记录操作');
});

test('running hints reuse the short summary and keep progress out of the command list',()=>{
 const task={attempts:[{id:'a',events:[
  {id:'p1',kind:'progress',text:'Agent 正在分析任务',status:'RUNNING',time:'1'},
  {id:'t1',kind:'tool',toolName:'Bash',text:"node <<'EOF'\nconsole.log(1);\nEOF",status:'RUNNING',time:'2'}
 ]}]};
 assert.deepEqual(processOf(task).map(event=>event.id),['t1']);
 assert.equal(processHint(latestProcess(task)),'Bash · node · 执行中');
 assert.equal(processHint({kind:'progress',text:'Agent 正在分析任务',status:'RUNNING'}),'Agent 正在分析任务');
 assert.equal(processHint({kind:'tool_result',toolName:'Bash',text:'tests passed',status:'FAILED'}),'Bash · 失败');
});

test('one decimal K/M/B formatter promotes after rounding and never invents unreported values',()=>{
 assert.deepEqual([999,1000,1500,999999].map(tokenLabel),['999','1.0K','1.5K','1.00M']);
 assert.deepEqual([999950,1e6,1234567].map(tokenLabel),['1.00M','1.00M','1.23M']);
 assert.deepEqual([999999999,1e9,1234567890].map(tokenLabel),['1.00B','1.00B','1.23B']);
 assert.equal(tokenLabel(0),'0');
 for(const missing of [null,undefined,NaN,Infinity,-Infinity])assert.equal(tokenLabel(missing),'未上报',String(missing));
 assert.deepEqual(tokenParts(1500),{value:'1.5',unit:'K'});
 assert.deepEqual(tokenParts(undefined),{value:'未上报',unit:''});
 assert.equal(number,tokenLabel);
});

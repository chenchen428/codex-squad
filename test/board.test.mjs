import test from 'node:test';
import assert from 'node:assert/strict';
import {BOARD_LANES,HISTORY_LANE,boardVisible,countCards,displayStatus,filterCards,groupCards,isAccepted,taskCard,taskLane,taskNumber,taskProgress,tokenLabel} from '../cli/ui/board-model.mjs';
import {relativeTimeLabel} from '../cli/ui/model.mjs';

test('verification time stays relative within 24 hours and falls back to the recorded date',()=>{
  const verified=new Date(2026,9,27,14,35,0).getTime();
  const at=new Date(verified).toISOString();
  assert.equal(relativeTimeLabel(at,verified),'刚刚');
  assert.equal(relativeTimeLabel(at,verified+59_000),'刚刚');
  assert.equal(relativeTimeLabel(at,verified+60_000),'1分钟前');
  assert.equal(relativeTimeLabel(at,verified+59*60_000),'59分钟前');
  assert.equal(relativeTimeLabel(at,verified+60*60_000),'1小时前');
  assert.equal(relativeTimeLabel(at,verified+23*3600_000+59*60_000),'23小时前');
  assert.equal(relativeTimeLabel(at,verified+24*3600_000),'10/27 14:35');
  assert.equal(relativeTimeLabel(at,verified+30*24*3600_000),'10/27 14:35');
  for(const invalid of [null,undefined,'','not-a-date'])assert.equal(relativeTimeLabel(invalid,verified),'',String(invalid));
  assert.equal(relativeTimeLabel(at,NaN),'');
});

test('completed cards expose the recorded verification summary and time',()=>{
  const a=attempt({acceptance:{attemptId:null,at:'2026-01-10T00:03:00.000Z',note:'原文与证据核对通过'}});
  a.acceptance.attemptId=a.id;
  const card=taskCard(task('summary','completed',{attempts:[a]}),0);
  assert.equal(card.resultSummary,'原文与证据核对通过');
  assert.equal(card.verifiedAt,a.acceptance.at);
  const missing=taskCard(task('no-record','done'),0);
  assert.equal(missing.resultSummary,'');
  assert.equal(missing.verifiedAt,null);
});

let sequence=0;
function attempt(overrides={}){
  return {
    id:`attempt-${++sequence}`,
    index:1,
    generation:1,
    status:'completed',
    startedAt:'2026-01-10T00:00:00.000Z',
    endedAt:'2026-01-10T00:01:00.000Z',
    sessionId:null,
    model:'configured-model',
    actualModel:null,
    usage:null,
    handoff:null,
    events:[],
    result:null,
    error:null,
    acceptance:null,
    verification:null,
    ...overrides
  };
}
function task(id,status,overrides={}){
  return {id,title:`任务 ${id}`,memberId:'member-1',status,attempts:[],acceptance:null,verification:null,retirement:null,stop:null,...overrides};
}
function cardsOf(tasks,connected=true){
  return tasks.map((item,index)=>taskCard(item,index,connected));
}

function acceptedTask(id,at,endedAt='2026-01-10T00:01:00.000Z'){
  const current=attempt({endedAt});
  current.acceptance={attemptId:current.id,at};
  return task(id,'completed',{attempts:[current]});
}

test('completed cards sort by current verification time, retaining their original numbers',()=>{
  const cards=cardsOf([
    acceptedTask('older','2026-01-10T00:04:00.000Z','2026-01-10T00:03:00.000Z'),
    acceptedTask('newer','2026-01-10T00:08:00.000Z'),
  ]);
  const before=cards.slice();
  const sorted=groupCards(cards)['col-completed'];
  assert.deepEqual(sorted.map(c=>c.task.id),['newer','older']);
  assert.deepEqual(sorted.map(c=>c.number),['#02','#01']);
  assert.deepEqual(cards,before);
});

test('review uses current bound verification or return time and ignores previous attempts',()=>{
  const verifying=attempt({endedAt:'2026-01-10T00:02:00.000Z'});
  verifying.verification={attemptId:verifying.id,at:'2026-01-10T00:09:00.000Z'};
  const stale=attempt();
  stale.verification={attemptId:stale.id,at:'2026-01-11T00:00:00.000Z'};
  const cards=cardsOf([
    task('returned','completed',{attempts:[attempt({endedAt:'2026-01-10T00:07:00.000Z'})]}),
    task('reworked','completed',{attempts:[stale,attempt({endedAt:'2026-01-10T00:06:00.000Z'})],verification:stale.verification}),
    task('verifying','completed',{attempts:[verifying]}),
  ]);
  assert.deepEqual(groupCards(cards)['col-review'].map(c=>c.task.id),['verifying','returned','reworked']);
});

test('running cards use the current attempt start instead of historical attempt time',()=>{
  const cards=cardsOf([
    task('older','running',{attempts:[attempt({status:'running',startedAt:'2026-01-10T00:03:00.000Z',endedAt:undefined})]}),
    task('newer','running',{attempts:[attempt(),attempt({status:'running',startedAt:'2026-01-10T00:12:00.000Z',endedAt:undefined})]}),
  ]);
  assert.deepEqual(groupCards(cards)['col-running'].map(c=>c.task.id),['newer','older']);
});

test('missing or invalid dates sort last and equal dates retain stable task order after search',()=>{
  const cards=cardsOf([
    acceptedTask('same-a','2026-01-10T00:04:00.000Z'),
    acceptedTask('missing',undefined),
    acceptedTask('newest','2026-01-10T00:08:00.000Z'),
    acceptedTask('same-b','2026-01-10T00:04:00.000Z'),
    acceptedTask('invalid','not-a-date'),
  ]);
  const grouped=groupCards(cards)['col-completed'];
  assert.deepEqual(grouped.map(c=>c.task.id),['newest','same-a','same-b','missing','invalid']);
  const searched=groupCards(filterCards(cards,'same'))['col-completed'];
  assert.deepEqual(searched.map(c=>c.number),['#01','#04']);
});

test('the board keeps exactly the three current lanes and moves retired work to history',()=>{
  assert.deepEqual(BOARD_LANES,['col-running','col-review','col-completed']);
  const running=attempt({status:'running',endedAt:undefined});
  const returned=attempt();
  const cases=[
    [task('idle','idle'),'col-running'],
    [task('todo','todo'),'col-running'],
    [task('queued','queued'),'col-running'],
    [task('starting','starting',{attempts:[attempt({status:'running',endedAt:undefined})]}),'col-running'],
    [task('running','running',{attempts:[running]}),'col-running'],
    [task('stopping','stopping',{attempts:[attempt({status:'running',endedAt:undefined})]}),'col-running'],
    [task('failed','failed',{attempts:[attempt({status:'failed'})]}),'col-running'],
    [task('blocked','blocked'),'col-running'],
    [task('unknown','unknown'),'col-running'],
    [task('completed','completed',{attempts:[returned]}),'col-review'],
    [task('waiting_review','waiting_review',{attempts:[returned]}),'col-review'],
    [task('accepted-without-record','accepted'),'col-review'],
    [task('done-without-record','done'),'col-review'],
    [task('stopped','stopped'),HISTORY_LANE],
    [task('cancelled','cancelled'),HISTORY_LANE],
    [task('superseded','superseded'),HISTORY_LANE],
    [task('retired','failed',{retirement:{outcome:'cancelled',reason:'不再需要'}}),HISTORY_LANE]
  ];
  for(const [item,lane] of cases)assert.equal(taskLane(item,true),lane,item.id);
});

test('work that still needs the main Codex stays in review instead of counting as completed',()=>{
  const waiting=task('waiting','completed',{attempts:[attempt()]});
  assert.equal(displayStatus(waiting,true),'waiting');
  assert.equal(taskProgress(waiting,true),'待核验');
  assert.equal(taskLane(waiting,true),'col-review');

  const verifyingAttempt=attempt({verification:{attemptId:null,at:'2026-01-10T00:02:00.000Z'}});
  verifyingAttempt.verification.attemptId=verifyingAttempt.id;
  const verifying=task('verifying','completed',{attempts:[verifyingAttempt]});
  assert.equal(displayStatus(verifying,true),'verifying');
  assert.equal(taskProgress(verifying,true),'Codex核验中');
  assert.equal(taskLane(verifying,true),'col-review');

  const acceptedAttempt=attempt({acceptance:{attemptId:null,at:'2026-01-10T00:03:00.000Z',fingerprint:'abc'}});
  acceptedAttempt.acceptance.attemptId=acceptedAttempt.id;
  const accepted=task('accepted','completed',{attempts:[acceptedAttempt]});
  assert.equal(isAccepted(accepted),true);
  assert.equal(taskLane(accepted,true),'col-completed');
  assert.equal(taskProgress(accepted,true),'已完成');
  assert.equal(taskProgress(task('legacy','done'),true),'待核对');
  assert.equal(taskLane(task('legacy','done'),true),'col-review');
});

test('an acceptance bound to an older attempt never completes the current round',()=>{
  const older=attempt({acceptance:null});
  const olderAcceptance={attemptId:older.id,at:'2026-01-10T00:02:00.000Z',fingerprint:'old'};
  const current=attempt();
  const item=task('reworked','completed',{attempts:[older,current],acceptance:olderAcceptance});
  assert.equal(isAccepted(item),false);
  assert.equal(taskLane(item,true),'col-review');
  assert.equal(displayStatus(item,true),'waiting');

  const replaced=task('replacement','completed',{attempts:[older,current]});
  replaced.attempts[0].acceptance=olderAcceptance;
  assert.equal(isAccepted(replaced),false);
  assert.deepEqual(taskCard(replaced,0,true).search.includes('old'),false);
});

test('a later file change keeps the completed lane and reports the historical verification fact',()=>{
  const verified=attempt({acceptance:{attemptId:null,at:'2026-01-10T00:03:00.000Z',changedSinceVerification:true,currentFingerprint:'changed'}});
  verified.acceptance.attemptId=verified.id;
  const item=task('changed','completed',{attempts:[verified]});
  assert.equal(taskLane(item,true),'col-completed');
  assert.equal(displayStatus(item,true),'accepted');
  assert.equal(taskProgress(item,true),'已完成 · 核验后已有变更');
  const card=taskCard(item,0,true);
  assert.equal(card.lane,'col-completed');
  assert.equal(card.progress,'已完成 · 核验后已有变更');
  assert.equal(card.statusText,'已完成');
});

test('failed, blocked, interrupted and unknown work stays in the running lane instead of disappearing',()=>{
  const cases={
    failed:'执行失败',
    blocked:'等待处理',
    interrupted:'已中断',
    unknown:'状态待核实'
  };
  for(const [status,label] of Object.entries(cases)){
    const item=task(`exception-${status}`,status);
    const card=taskCard(item,0,true);
    assert.equal(card.lane,'col-running',status);
    assert.equal(card.status,status,status);
    assert.equal(card.statusText,label,status);
    assert.equal(card.progress,label,status);
    assert.equal(card.live,false,status);
  }
});

test('only tasks with a real active attempt animate; returned and blocked work does not',()=>{
  const active=task('active','running',{attempts:[attempt({status:'running',endedAt:undefined})]});
  const starting=task('starting','starting',{attempts:[]});
  const returned=task('returned','completed',{attempts:[attempt()]});
  const blocked=task('blocked','blocked',{attempts:[attempt({status:'running',endedAt:undefined})]});
  const staleAttempt=task('stale','running',{attempts:[attempt({status:'completed'})]});
  assert.equal(taskCard(active,0,true).live,true);
  assert.equal(taskCard(active,0,true).active,true);
  assert.equal(taskCard(starting,0,true).live,true);
  assert.equal(taskCard(returned,0,true).live,false);
  assert.equal(taskCard(blocked,0,true).live,false);
  assert.equal(taskCard(staleAttempt,0,true).live,false);
  assert.equal(taskCard(active,0,false).live,true);
  assert.equal(taskCard(active,0,false).active,false);
});

test('a disconnected snapshot keeps the last confirmed lane and status while freezing progress',()=>{
  const running=task('running','running',{attempts:[attempt({
    status:'running',
    endedAt:undefined,
    events:[{id:'tool-1',kind:'tool',toolName:'Bash',text:'pnpm secret-command',status:'RUNNING'}]
  })]});
  const card=taskCard(running,0,false);
  assert.equal(card.lane,'col-running');
  assert.equal(card.status,'running');
  assert.equal(card.live,true);
  assert.equal(card.active,false);
  assert.match(card.progress,/Bash · pnpm secret-command/);
  assert.match(card.progress,/暂未更新/);
  assert.equal(filterCards([card],'暂未更新').length,1);

  const unknown=taskCard(task('unknown','unknown'),0,false);
  assert.equal(unknown.lane,'col-running');
  assert.equal(unknown.status,'unknown');
  assert.equal(unknown.progress,'状态待核实');

  const failed=taskCard(task('failed','failed'),0,false);
  assert.equal(failed.lane,'col-running');
  assert.equal(failed.progress,'执行失败');
});

test('retired work is searchable history and never counts as completed',()=>{
  const cancelled=task('cancelled-task','failed',{
    title:'取消的构建',
    retirement:{outcome:'cancelled',reason:'需求撤回',replacedBy:null,at:'2026-01-10T00:04:00.000Z'}
  });
  const superseded=task('old-task','failed',{
    title:'旧方案',
    retirement:{outcome:'superseded',reason:'范围调整',replacedBy:'新方案 B'}
  });
  const acceptedAttempt=attempt({acceptance:{attemptId:null,at:'2026-01-10T00:03:00.000Z'}});
  acceptedAttempt.acceptance.attemptId=acceptedAttempt.id;
  const accepted=task('accepted-task','completed',{title:'完成的构建',attempts:[acceptedAttempt]});
  const cards=cardsOf([cancelled,superseded,accepted]);
  const groups=groupCards(cards);
  assert.equal(groups[HISTORY_LANE].length,2);
  assert.equal(groups['col-completed'].length,1);
  assert.equal(countCards(cards)['col-completed'],1);
  assert.equal(countCards(cards)[HISTORY_LANE],2);
  for(const card of groups[HISTORY_LANE]){
    assert.equal(card.history,true);
    assert.equal(card.live,false);
  }
  assert.equal(groups[HISTORY_LANE][0].progress,'已取消 · 需求撤回');
  assert.equal(groups[HISTORY_LANE][1].progress,'已被替代 · 新方案 B');
  assert.deepEqual(filterCards(cards,'需求撤回').map(card=>card.task.id),['cancelled-task']);
  assert.deepEqual(filterCards(cards,'新方案 B').map(card=>card.task.id),['old-task']);
  assert.deepEqual(filterCards(cards,'已完成').map(card=>card.task.id),['accepted-task']);
});

test('cards keep stable numbers and search never exposes hidden result, error or model text',()=>{
  const running=task('build','running',{
    title:'构建看板',
    attempts:[attempt({
      status:'running',
      endedAt:undefined,
      events:[{id:'tool-1',kind:'tool',toolName:'Bash',text:"node <<'EOF'\nconsole.log('secret-output')\nEOF",status:'RUNNING'}],
      result:'完整结果不应进入卡片',
      error:'完整错误不应进入卡片'
    })]
  });
  const failed=task('fix','failed',{title:'修复失败',attempts:[attempt({status:'failed',result:'SECRET-RESULT',error:'SECRET-ERROR'})]});
  const cards=cardsOf([running,failed]);
  assert.equal(cards[0].number,'#01');
  assert.match(cards[0].progress,/Bash · node/);
  assert.doesNotMatch(cards[0].progress,/secret-output|\n|完整结果/);
  assert.equal(filterCards(cards,'#02')[0].task.id,'fix');
  assert.equal(filterCards(cards,'SECRET').length,0);
  assert.equal(filterCards(cards,'完整结果').length,0);
  assert.equal(filterCards(cards,'configured-model').length,0);
  assert.equal(taskNumber(0),'#01');
  assert.equal(taskNumber(11),'#12');
  assert.equal(filterCards(cards,'   ').length,2);
});

test('grouping places every task exactly once across current lanes and history',()=>{
  const tasks=[
    task('run','running',{attempts:[attempt({status:'running',endedAt:undefined})]}),
    task('review','completed',{attempts:[attempt()]}),
    task('fail','failed'),
    task('history','stopped'),
    task('done','completed',{attempts:[(()=>{const a=attempt();a.acceptance={attemptId:a.id,at:'2026-01-10T00:02:00.000Z'};return a})()]})
  ];
  const cards=cardsOf(tasks);
  const groups=groupCards(cards);
  const flat=[...BOARD_LANES,HISTORY_LANE].flatMap(lane=>groups[lane]);
  assert.equal(flat.length,tasks.length);
  assert.deepEqual(new Set(flat.map(card=>card.task.id)),new Set(tasks.map(item=>item.id)));
  for(const lane of [...BOARD_LANES,HISTORY_LANE])for(const card of groups[lane])assert.equal(card.lane,lane);
  assert.deepEqual(countCards(cards),{'col-running':2,'col-review':1,'col-completed':1,[HISTORY_LANE]:1});
});

test('card status labels cover active, review, exception and historical states',()=>{
  const cases={
    idle:'待命',
    todo:'待执行',
    queued:'排队中',
    starting:'启动中',
    running:'处理中',
    stopping:'停止中',
    failed:'执行失败',
    blocked:'等待处理',
    interrupted:'已中断',
    unknown:'状态待核实'
  };
  for(const [status,label] of Object.entries(cases)){
    const card=taskCard(task(`status-${status}`,status),0,true);
    assert.equal(card.statusText,label,status);
    assert.equal(card.progress,label,status);
  }
  assert.equal(taskCard(task('waiting','completed',{attempts:[attempt()]}),0,true).statusText,'待核验');
  assert.equal(taskCard(task('legacy','done'),0,true).statusText,'待核对');
});

test('token labels distinguish unreported usage from a reported zero',()=>{
  assert.equal(tokenLabel([]),'未上报');
  assert.equal(tokenLabel([attempt({usage:null})]),'未上报');
  assert.equal(tokenLabel([attempt({usage:{inputTokens:0,outputTokens:0,cachedInputTokens:0,totalTokens:0}})]),'0 tok');
  assert.equal(tokenLabel([attempt({usage:{inputTokens:1000,outputTokens:500,cachedInputTokens:0,totalTokens:1500}})]),'1.5K tok');
});


test('board hides non-running exceptions and all history without mutating task facts',()=>{
  const current=task('live','running',{attempts:[attempt({status:'running',endedAt:undefined})]});
  const returned=task('returned','completed',{attempts:[attempt()]});
  const acceptedAttempt=attempt();acceptedAttempt.acceptance={attemptId:acceptedAttempt.id,at:'2026-01-10T00:04:00Z'};
  const accepted=task('accepted','completed',{attempts:[acceptedAttempt]});
  const hidden=['failed','unknown','blocked','interrupted','stopped','cancelled','superseded','idle','todo','queued'].map(status=>task(status,status));
  const stale=task('stale-active','running',{attempts:[attempt({status:'unknown',endedAt:undefined})]});
  const all=[current,returned,accepted,...hidden,stale],before=JSON.stringify(all);
  const visible=all.filter(boardVisible);
  assert.deepEqual(visible.map(t=>t.id),['live','returned','accepted']);
  assert.equal(JSON.stringify(all),before);
  assert.equal(filterCards(cardsOf(visible),'failed').length,0);
  assert.equal(boardVisible(current),true);
  assert.equal(taskCard(current,0,false).active,false);
});

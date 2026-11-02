import test from 'node:test';
import assert from 'node:assert/strict';
import {durationChip,durationTier} from '../cli/ui/board-duration.mjs';

const MINUTE=60_000;

function attempt(startedAt,endedAt=null,status='completed',id=startedAt){
  return {id,status,startedAt,endedAt};
}
function task(status,attempts){
  return {id:'task-1',status,attempts};
}

test('duration tiers split exactly at 10, 30 and 60 minutes',()=>{
  const cases=[
    [0,'tier1'],
    [1,'tier1'],
    [10*MINUTE-1,'tier1'],
    [10*MINUTE,'tier2'],
    [30*MINUTE-1,'tier2'],
    [30*MINUTE,'tier3'],
    [60*MINUTE-1,'tier3'],
    [60*MINUTE,'tier4'],
    [60*MINUTE+1,'tier4'],
    [24*60*MINUTE,'tier4'],
  ];
  for(const [milliseconds,tier] of cases)assert.equal(durationTier(milliseconds),tier,String(milliseconds));
});

test('missing, invalid and negative durations stay neutral',()=>{
  for(const value of [null,undefined,NaN,Infinity,-Infinity,-1,-MINUTE,'600000',{},[]]){
    assert.equal(durationTier(value),'none',String(value));
  }
});

test('completed cards report the accumulated duration and tier class',()=>{
  const chip=durationChip(task('completed',[
    attempt('2026-01-01T00:00:00.000Z','2026-01-01T00:08:15.000Z'),
  ]),Date.parse('2026-01-01T02:00:00.000Z'));
  assert.equal(chip.tier,'tier1');
  assert.equal(chip.className,'time-chip time-chip-tier1');
  assert.equal(chip.label,'8:15');
  assert.equal(chip.prefix,'累计执行');
  assert.equal(chip.icon,'clock');
  assert.equal(chip.title,'执行耗时：< 10分钟区间（累计执行 8:15）');
  assert.equal(chip.ariaLabel,'累计执行 8:15，小于10分钟');
});

test('running cards accumulate settled attempts plus the live attempt',()=>{
  const chip=durationChip(task('running',[
    attempt('2026-01-01T00:00:00.000Z','2026-01-01T00:20:00.000Z','completed','a'),
    attempt('2026-01-01T00:20:00.000Z',null,'running','b'),
  ]),Date.parse('2026-01-01T00:40:00.000Z'));
  assert.equal(chip.milliseconds,40*MINUTE);
  assert.equal(chip.running,true);
  assert.equal(chip.tier,'tier3');
  assert.equal(chip.label,'40:00');
  assert.equal(chip.prefix,'执行中');
  assert.equal(chip.title,'执行耗时：30–60分钟区间（执行中 40:00）');
  assert.equal(chip.ariaLabel,'执行中 40:00，30至60分钟');
});

test('an unfinished attempt without an active status is never counted as running',()=>{
  const chip=durationChip(task('running',[
    attempt('2026-01-01T00:00:00.000Z',null,'completed'),
  ]),Date.parse('2026-01-01T00:30:00.000Z'));
  assert.equal(chip.milliseconds,null);
  assert.equal(chip.running,false);
  assert.equal(chip.tier,'none');
});

test('stale snapshots mark the chip as last confirmed',()=>{
  const chip=durationChip(task('completed',[
    attempt('2026-01-01T00:00:00.000Z','2026-01-01T00:21:40.000Z'),
  ]),Date.parse('2026-01-01T03:00:00.000Z'),{stale:true});
  assert.equal(chip.tier,'tier2');
  assert.equal(chip.label,'21:40');
  assert.equal(chip.prefix,'上次确认');
  assert.equal(chip.title,'执行耗时：10–30分钟区间（上次确认 21:40）');
  assert.equal(chip.ariaLabel,'上次确认 21:40，10至30分钟');
});

test('no recorded duration uses the neutral chip without failure wording',()=>{
  const chip=durationChip(task('todo',[]));
  assert.equal(chip.tier,'none');
  assert.equal(chip.className,'time-chip time-chip-tier-none');
  assert.equal(chip.label,'未记录');
  assert.equal(chip.icon,'alert');
  assert.equal(chip.prefix,null);
  assert.equal(chip.milliseconds,null);
  assert.equal(chip.title,'执行耗时：未记录');
  assert.equal(chip.ariaLabel,'执行耗时未记录');
});

import {durationLabel,durationOf} from './model.mjs';

const MINUTE=60000;

const TIERS={
  tier1:{range:'< 10分钟区间',spoken:'小于10分钟',className:'time-chip time-chip-tier1'},
  tier2:{range:'10–30分钟区间',spoken:'10至30分钟',className:'time-chip time-chip-tier2'},
  tier3:{range:'30–60分钟区间',spoken:'30至60分钟',className:'time-chip time-chip-tier3'},
  tier4:{range:'≥ 60分钟区间',spoken:'大于等于60分钟',className:'time-chip time-chip-tier4'},
};
const NONE={tier:'none',range:'未记录',spoken:'未记录',className:'time-chip time-chip-tier-none'};

/**
 * Duration tiers shared by every board card. Invalid, negative or missing
 * milliseconds are neutral (not a task failure state), never a coloured tier.
 * @param {unknown} milliseconds
 */
export function durationTier(milliseconds){
  if(typeof milliseconds!=='number'||!Number.isFinite(milliseconds)||milliseconds<0)return 'none';
  if(milliseconds<10*MINUTE)return 'tier1';
  if(milliseconds<30*MINUTE)return 'tier2';
  if(milliseconds<60*MINUTE)return 'tier3';
  return 'tier4';
}

/**
 * Chip projection for one card; elapsed milliseconds still follow durationOf.
 * @param {import('./types').Task} task
 * @param {number} [now]
 * @param {{stale?:boolean}} [options]
 */
export function durationChip(task,now=Date.now(),options={}){
  const elapsed=durationOf(task,now);
  const milliseconds=elapsed.milliseconds;
  const tier=durationTier(milliseconds);
  if(tier==='none'){
    return {
      tier:'none',className:NONE.className,label:'未记录',
      title:'执行耗时：未记录',ariaLabel:'执行耗时未记录',
      icon:'alert',prefix:null,milliseconds:null,running:false,
    };
  }
  const preset=TIERS[tier];
  const prefix=options.stale?'上次确认':elapsed.running?'执行中':'累计执行';
  const label=durationLabel(milliseconds);
  return {
    tier,className:preset.className,label,
    title:`执行耗时：${preset.range}（${prefix} ${label}）`,
    ariaLabel:`${prefix} ${label}，${preset.spoken}`,
    icon:'clock',prefix,milliseconds,running:elapsed.running,
  };
}

// 周期分析报告的纯视图模型：浏览器与 Node 测试共用，不含 DOM 与后端依赖。
// 所有数字与建议均来自冻结统计与同轮分析输出，缺失值一律标记为未上报，不按 0 计算。

import {durationLabel,statusLabel,tokenLabel,tokenParts} from '../lib/presentation.mjs';
import {sortRows} from './table-model.mjs';

export {tokenLabel,tokenParts};

export const CATEGORY_KEYS=['skills_tools','time','tokens'];
export const RANGE_OPTIONS=[
  {days:7,label:'近 7 天'},
  {days:30,label:'近 30 天'},
  {days:null,label:'全部'},
];
export const PREVIEW_ROWS=3;
export const UNREPORTED='未上报';

const STATUS_LABELS={running:'正在更新',succeeded:'已完成',failed:'更新失败',interrupted:'更新中断'};
const PHASE_LABELS={collecting:'采集中',analyzing:'分析中',publishing:'发布中',completed:'已完成'};

export function codexThreadUrl(threadId){
  const value=typeof threadId==='string'?threadId.trim():'';
  if(!value)return null;
  return `codex://threads/${encodeURIComponent(value)}`;
}
function isRecord(value){return value!==null&&typeof value==='object'&&!Array.isArray(value)}
function num(value){return typeof value==='number'&&Number.isFinite(value)?value:null}
function count(value){const v=num(value);return v===null?0:v}
function str(value){return typeof value==='string'?value.trim():''}
function finite(value){const v=num(value);return v!==null&&v>=0?v:null}

export function countParts(value,unit=''){
  const v=finite(value);
  return {value:v===null?UNREPORTED:String(v),unit:v===null?'':unit};
}
export function ratio(value,total,digits=1){
  const v=num(value),t=num(total);
  if(v===null||t===null||t<=0)return null;
  return `${(v/t*100).toFixed(digits)}%`;
}
/** 条带宽度只接受可比较的原始用量，任一侧缺失时返回 null，不按 0 画条。 */
function shareOf(value,total){
  const v=finite(value),t=finite(total);
  if(v===null||t===null||t<=0)return null;
  return Number((v/t*100).toFixed(1));
}
export function dayLabel(value){
  const text=str(value);
  if(/^\d{4}-\d{2}-\d{2}$/.test(text))return text.slice(5);
  const parsed=Date.parse(text);
  if(!Number.isFinite(parsed))return text||'—';
  return new Date(parsed).toISOString().slice(5,10);
}
export function utcStamp(value){
  const parsed=Date.parse(str(value));
  if(!Number.isFinite(parsed))return '时间未上报';
  return `${new Date(parsed).toISOString().slice(0,19).replace('T',' ')} UTC`;
}
export function isoDay(value){
  const parsed=Date.parse(str(value));
  if(!Number.isFinite(parsed))return str(value)||'';
  return new Date(parsed).toISOString().slice(0,10);
}

export function rangeText(days){
  if(days===7)return '近 7 天';
  if(days===30)return '近 30 天';
  return '全部时间';
}

/** 只有服务端确认统计快照可用时才展示数字，AI 报告状态不代替统计回执。 */
export function statsAvailable(data){
  return data?.analysis?.statsAvailable===true;
}

function windowOf(data){
  const analysis=data?.analysis||null;
  const statsRange=data?.range||null;
  const window=isRecord(analysis?.window)?analysis.window:null;
  if(window&&(window.days===7||window.days===30||window.days===null||window.days===undefined)){
    const to=typeof window.to==='string'?window.to:(statsRange?.to||null);
    return {days:window.days===undefined?(statsRange?.days??null):window.days,from:typeof window.from==='string'?window.from:null,to:typeof to==='string'?to:null};
  }
  if(statsRange)return {days:statsRange.days??null,from:typeof statsRange.from==='string'?statsRange.from:null,to:typeof statsRange.to==='string'?statsRange.to:null};
  return {days:null,from:null,to:null};
}

export function reportWindow(data){
  const window=windowOf(data);
  const available=statsAvailable(data);
  const label=rangeText(window.days);
  const from=window.from?dayLabel(window.from):null;
  const to=window.to?dayLabel(window.to):null;
  const range=from&&to?`${from} ~ ${to}`:to?`至 ${to}`:'区间未上报';
  return {
    days:window.days,from:window.from,to:window.to,available,label,range,
    summary:available?`统计区间：${label} (${range})`:`统计区间：${label} (尚无统计快照)`,
  };
}

const FAILED_STATUSES=new Set(['failed','interrupted']);

export function analysisStatus(data,state={}){
  const analysis=data?.analysis||null;
  const latest=isRecord(analysis?.latestRun)?analysis.latestRun:null;
  const otherWindowRunning=analysis?.otherWindowRunning===true;
  const running=Boolean(state?.running)||latest?.status==='running'||otherWindowRunning;
  const available=Boolean(analysis?.available);
  const hasStats=statsAvailable(data);
  const runId=str(analysis?.runId)||str(latest?.runId)||null;
  let phase='idle';
  if(running)phase='running';
  else if(latest&&FAILED_STATUSES.has(str(latest.status)))phase=str(latest.status);
  else if(available)phase='succeeded';
  else if(hasStats)phase='stats';
  const phaseLabel=PHASE_LABELS[str(latest?.phase)]||null;
  const aiState=phaseLabel?`（${phaseLabel}）`:'';
  const badge={
    idle:{text:'尚无报告',tone:'quiet'},
    running:otherWindowRunning?{text:'其他区间更新中',tone:'running'}
      :{text:'报告正在更新',tone:'running'},
    succeeded:{text:'本轮报告完整生成',tone:'ok'},
    stats:{text:'统计已更新 · 尚无报告',tone:'quiet'},
    failed:available?{text:'更新失败 · 保留上次成功报告',tone:'fail'}
      :hasStats?{text:'统计已更新 · 本轮报告未生成',tone:'fail'}
        :{text:'尚无报告 · 更新失败',tone:'fail'},
    interrupted:available?{text:'更新中断 · 保留上次成功报告',tone:'fail'}
      :hasStats?{text:'统计已更新 · 本轮报告未生成',tone:'fail'}
        :{text:'尚无报告 · 更新中断',tone:'fail'},
  }[phase];
  const note={
    idle:'统计快照：尚未生成 · 尚无报告',
    running:otherWindowRunning?'其他区间正在更新；此处展示已保存统计。'
      :hasStats?`统计快照已更新 · 报告${aiState}正在更新`:`统计快照尚未生成 · 报告${aiState}正在更新`,
    succeeded:'统计快照：已更新 · 报告已生成',
    stats:'统计快照：已更新 · 尚无报告',
    failed:available?'上轮更新失败 · 保留上次成功报告'
      :hasStats?'统计快照：已更新 · 本轮报告未生成'
        :'统计快照：尚未生成 · 上轮更新失败',
    interrupted:available?'上轮更新中断 · 保留上次成功报告'
      :hasStats?'统计快照：已更新 · 本轮报告未生成'
        :'统计快照：尚未生成 · 上轮更新中断',
  }[phase];
  return {
    phase,available,statsAvailable:hasStats,running,otherWindowRunning,
    runId,shortRunId:runId?runId.slice(0,8):null,
    badge,note,
    statusLabel:STATUS_LABELS[phase]||(phase==='stats'?'统计已更新':phase),
    observedAt:analysis?.statsObservedAt||data?.observedAt||null,
    generatedAt:analysis?.generatedAt||null,
    error:latest?.error||null,
  };
}

export function reportMeta(data,state={}){
  const status=analysisStatus(data,state);
  const window=reportWindow(data);
  const round='周期分析';
  return {
    round,
    window:window.summary,
    windowRange:window.range,
    windowFrom:window.from,
    windowTo:window.to,
    observedRaw:status.observedAt,
    generatedRaw:status.generatedAt,
    badge:status.badge,
    observedAt:status.statsAvailable?`数据截止：${utcStamp(status.observedAt)}`:'数据截止：尚无统计快照',
    generatedAt:status.generatedAt?`报告生成时间：${utcStamp(status.generatedAt)}`
      :status.available?'报告生成时间：未上报':'报告生成时间：尚无报告',
    status,
  };
}

export function highlight(data,state={}){
  const analysis=data?.analysis||null;
  const status=analysisStatus(data,state);
  const observations=analysisObservations(data);
  const total=observations.total;
  const summary=str(analysis?.summary);
  if(status.available&&summary){
    return {text:`周期审计综述：${summary}`,showLink:total>0,linkLabel:`[直接查阅 ${total} 项优化建议 ↓]`};
  }
  if(status.otherWindowRunning)return {text:status.statsAvailable
    ?'周期审计综述：可查看此区间已保存的统计；其他区间正在更新。'
    :'周期审计综述：此区间尚无统计快照；其他区间正在更新。',showLink:false,linkLabel:''};
  if(status.running){
    return {
      text:status.statsAvailable
        ?'周期审计综述：统计快照已更新，可先查看下方数字；本轮报告正在更新，完成后将在此展示综述。'
        :'周期审计综述：尚无统计快照；本轮报告正在更新，完成后将在此展示综述。',
      showLink:false,linkLabel:'',
    };
  }
  if(status.phase==='failed'||status.phase==='interrupted'){
    return {
      text:status.available
        ?'周期审计综述：统计快照已更新，但本轮报告未生成；已保留上次成功报告。'
        :status.statsAvailable
          ?'周期审计综述：统计快照已更新，但本轮报告未生成。'
          :'周期审计综述：尚无统计快照，本轮报告未生成。',
      showLink:false,linkLabel:'',
    };
  }
  if(status.statsAvailable){
    return {text:'周期审计综述：统计快照已更新，报告尚未生成。',showLink:false,linkLabel:''};
  }
  return {text:'周期审计综述：尚无统计快照，报告尚未生成。',showLink:false,linkLabel:''};
}

function taskStateCounts(metrics){
  const accepted=count(metrics.accepted);
  return {
    accepted,running:count(metrics.running),
    pending:Math.max(0,count(metrics.returned)-accepted),
    blocked:count(metrics.failed)+count(metrics.blocked)+count(metrics.unknown),
    stopped:count(metrics.stopped),
  };
}

export function kpiCards(data){
  if(!statsAvailable(data)){
    return [
      {key:'tokens',label:'已报 Token'},
      {key:'cache',label:'输入上下文缓存'},
      {key:'tasks',label:'任务总数'},
      {key:'attempts',label:'执行尝试'},
    ].map(card=>({
      ...card,
      badge:{text:'无统计快照',tone:'quiet'},
      value:UNREPORTED,unit:'',
      footer:[{text:'统计尚未生成',tone:'quiet'}],
    }));
  }
  const tokens=data?.tokens||{};
  const metrics=data?.metrics||{};
  const coverage=tokens.coverage||{};
  const total=count(metrics.attemptCount);
  const reported=count(tokens.reportedAttempts);
  const missing=Math.max(0,total-reported);
  const cached=finite(tokens.cachedInputTokens);
  const input=finite(tokens.inputTokens);
  const cachedCoverage=coverage.cachedInputTokens||{};
  const inputCoverage=coverage.inputTokens||{};
  const cacheFull=cached!==null&&input!==null&&input>0
    &&count(cachedCoverage.reported)===count(cachedCoverage.total)
    &&count(inputCoverage.reported)===count(inputCoverage.total)
    &&count(cachedCoverage.total)>0;
  const states=taskStateCounts(metrics);
  const blocked=states.blocked;
  const sessions=count(metrics.sessionCount);
  const avgAttempts=sessions>0?(total/sessions):null;
  const totalTokens=tokenParts(tokens.totalTokens);
  const cacheTokens=tokenParts(tokens.cachedInputTokens);
  return [
    {
      key:'tokens',
      label:'已报 Token',
      badge:{text:total>0?`${reported}/${total} 尝试已报`:'尝试未上报',tone:reported>0&&reported===total?'ok':'quiet'},
      value:totalTokens.value,unit:totalTokens.unit,
      footer:[
        {text:`入 ${tokenLabel(tokens.inputTokens)}`},
        {text:`出 ${tokenLabel(tokens.outputTokens)}`},
        {text:missing>0?`${missing} 次未上报`:'全部尝试已上报',tone:missing>0?'danger':'quiet'},
      ],
    },
    {
      key:'cache',
      label:'输入上下文缓存',
      badge:cacheFull?{text:`${ratio(cached,input)} 命中`,tone:'ok'}:{text:'命中率未上报',tone:'quiet'},
      value:cacheTokens.value,unit:cacheTokens.unit,
      footer:[{text:'已含在输入中 · 不重复计入',tone:'quiet'}],
    },
    {
      key:'tasks',
      label:'任务总数',
      badge:blocked>0?{text:`${blocked} 需关注`,tone:'danger'}:{text:'无需关注',tone:'quiet'},
      value:countParts(metrics.taskCount).value,unit:'项',
      footer:[
        {text:`已验 ${count(metrics.accepted)}`},
        {text:`进行 ${count(metrics.running)}`},
        {text:`待验 ${states.pending}`},
      ],
    },
    {
      key:'attempts',
      label:'执行尝试',
      badge:{text:avgAttempts===null?'会话未上报':`均 ${avgAttempts.toFixed(1)} 次/会话`,tone:'quiet'},
      value:countParts(total).value,unit:'次',
      footer:[
        {text:`续接 ${count(metrics.continuationCount)}`},
        {text:`失败 ${count(metrics.failedAttempts)}`,tone:count(metrics.failedAttempts)>0?'danger':'quiet'},
        {text:`未报 ${missing}`,tone:'quiet'},
      ],
    },
  ];
}

const DAILY_TITLE='每天投入了多少';
const DAILY_SCOPE='只统计小队执行器已上报的记录，不代表 Codex 与 Qoder 账户的全部投入。';

/**
 * 每日投入只做一张真实记录表：日期、小队已报 Token、未报用量次数。
 * 缺失日期与缺失用量都保留“无记录/未上报”，不插值、不补 0，也不绘制比例图。
 */
export function trendSeries(data){
  const available=statsAvailable(data);
  const trend=Array.isArray(data?.trend)?data.trend:[];
  const window=windowOf(data);
  const byDate=new Map();
  for(const point of trend){
    const date=isoDay(point?.date);
    if(!date)continue;
    const input=finite(point?.tokens?.inputTokens);
    const output=finite(point?.tokens?.outputTokens);
    const total=finite(point?.tokens?.totalTokens);
    const tokenReported=total!==null||point?.tokens?.inputTokens!==null&&point?.tokens?.inputTokens!==undefined
      ||point?.tokens?.outputTokens!==null&&point?.tokens?.outputTokens!==undefined;
    byDate.set(date,{
      attempts:count(point.attempts),
      reportedAttempts:finite(point.reportedAttempts),
      tokenReported,
      total:total??(input||0)+(output||0),
    });
  }
  const dates=[...byDate.keys()].sort();
  let windowDates=[];
  if(window.days===7||window.days===30){
    const to=window.to?isoDay(window.to):(dates.at(-1)||null);
    if(to){
      const end=Date.parse(`${to}T00:00:00.000Z`);
      for(let i=window.days-1;i>=0;i-=1)windowDates.push(new Date(end-i*86400000).toISOString().slice(0,10));
    }
  }
  const source=windowDates.length?windowDates:dates;
  const rows=available?source.map(date=>{
    const point=byDate.get(date)||null;
    const tokenReported=Boolean(point&&point.tokenReported);
    const unreportedAttempts=!point
      ?null
      :tokenReported
        ?(point.reportedAttempts===null?null:Math.max(0,point.attempts-point.reportedAttempts))
        :point.attempts;
    return {
      date,
      label:dayLabel(date),
      missing:!point,
      attempts:point?point.attempts:null,
      tokenReported,
      tokenLabel:tokenReported?tokenLabel(point.total):UNREPORTED,
      unreportedAttempts,
      unreportedLabel:unreportedAttempts===null
        ?(point?UNREPORTED:'无记录')
        :`${unreportedAttempts} 次`,
    };
  }):[];
  const rangeLabel=window.from&&window.to?`${dayLabel(window.from)} ~ ${dayLabel(window.to)} (${window.days}日审计)`
    :window.days===null&&window.to?`全部时间 · 截至 ${dayLabel(window.to)}`:'审计区间未上报';
  const reportedDays=rows.filter(row=>row.tokenReported).length;
  return {
    available,
    rows,
    empty:!available||rows.length===0,
    title:DAILY_TITLE,
    scopeNote:DAILY_SCOPE,
    note:!available?'尚无统计快照，暂无按日记录。'
      :rows.length===0?'本区间没有按日记录。'
        :'缺失日期保留为无记录，缺失用量保留为未上报，均不按 0 补齐。',
    emptyText:available?'本区间没有按日记录。':'尚无统计快照，暂无按日记录。',
    metaLabel:available?`已报 ${reportedDays} / ${rows.length} 天`:'尚无统计快照',
    windowRange:available?rangeLabel:(window.from&&window.to?`${rangeLabel} · 尚无统计快照`:'尚无统计快照'),
  };
}

const EFFICIENCY_HEADLINE='[ 优先跟进 · FOCUS NOW ]';
const FOCUS_TITLE='优先跟进这几项工作';
const FOCUS_INTRO='这些工作已有较多投入，还没有核验结论，可先查看结果再决定是否继续。';
const FOCUS_EMPTY_TEXT='没有已上报投入但尚未核验的工作。';
const MAX_FOCUS_TASKS=3;

/**
 * 只依据真实任务事实列出最需要先看结果的未核验工作，最多三项。
 * 不推测返工、低效或浪费原因；缺失轮次保持未记录，缺失用量保持未上报。
 */
export function deliveryEfficiency(data){
  const available=statsAvailable(data);
  const list=(Array.isArray(data?.tasks)?data.tasks:[]).filter(isRecord);
  if(!available||!list.length){
    return {
      available:false,
      empty:true,
      headline:EFFICIENCY_HEADLINE,
      focusTitle:FOCUS_TITLE,
      focusIntro:FOCUS_INTRO,
      focusEmpty:true,
      focusEmptyText:available?FOCUS_EMPTY_TEXT:'尚无统计快照，暂无可观察的任务记录。',
      emptyText:available?'本区间没有可展示的任务记录。':'尚无统计快照，暂无可观察的交付事实。',
      focus:[],
      focusTotal:0,
      focusNote:'',
    };
  }
  const unverified=list.filter(task=>task.accepted!==true&&finite(task.tokens?.totalTokens)!==null&&finite(task.tokens.totalTokens)>0);
  const links=sessionLinkMap(data);
  const focus=unverified
    .slice()
    .sort((left,right)=>
      finite(right.tokens.totalTokens)-finite(left.tokens.totalTokens)
      ||count(right.failedAttempts)-count(left.failedAttempts)
      ||str(left.title).localeCompare(str(right.title)))
    .slice(0,MAX_FOCUS_TASKS)
    .map(task=>{
      const threadId=str(task.threadId);
      const link=links.get(threadId)||null;
      const scopeHref=(link?.tasks&&typeof link.tasks.get==='function'?link.tasks.get(str(task.id)):null)||link?.overview||null;
      const milliseconds=count(task.durationMs)+count(task.runningDurationMs);
      const rounds=num(task.fullAttemptCount);
      return {
        title:str(task.title)||'未命名任务',
        rounds,
        roundsLabel:rounds===null?'轮次未记录':`执行 ${rounds} 轮`,
        attempts:count(task.attemptCount),
        failedAttempts:count(task.failedAttempts),
        failureLabel:`失败 ${count(task.failedAttempts)} 次`,
        tokenLabel:tokenLabel(finite(task.tokens?.totalTokens)),
        durationLabel:milliseconds>0?durationLabel(milliseconds):'耗时未记录',
        scopeHref:scopeHref||null,
        hasScope:Boolean(scopeHref),
        linkLabel:'查看结果',
      };
    });
  return {
    available:true,
    empty:false,
    headline:EFFICIENCY_HEADLINE,
    focusTitle:FOCUS_TITLE,
    focusIntro:FOCUS_INTRO,
    focusEmpty:focus.length===0,
    focusEmptyText:FOCUS_EMPTY_TEXT,
    emptyText:null,
    focus,
    focusTotal:unverified.length,
    focusNote:unverified.length>MAX_FOCUS_TASKS?`按已报 Token 展示前 ${MAX_FOCUS_TASKS} 个，共 ${unverified.length} 个未核验任务。`:'',
  };
}

function sessionLinkMap(data){
  const list=Array.isArray(data?.sessions)?data.sessions:[];
  const map=new Map();
  for(const session of list){
    const threadId=str(session?.threadId);
    if(!threadId)continue;
    const tasks=new Map();
    for(const link of session?.links?.tasks||[]){
      const taskId=str(link?.taskId);
      if(taskId&&str(link?.url))tasks.set(taskId,str(link.url));
    }
    map.set(threadId,{session,tasks,overview:str(session?.links?.overview)||null});
  }
  return map;
}
function taskTitle(tasks,threadId,taskId){
  const list=Array.isArray(tasks)?tasks:[];
  const hit=list.find(task=>str(task?.threadId)===threadId&&str(task?.id)===taskId);
  return hit?str(hit.title):'';
}

export function sessionRows(data,{rank='tokens',currentThreadId=''}={}){
  const rankKey=rank==='tasks'?'tasks':'tokens';
  if(!statsAvailable(data)){
    return {
      rows:[],rank:rankKey,omitted:0,total:0,previewRows:PREVIEW_ROWS,canExpand:false,available:false,
      headline:'[ 会话消耗排行 · SESSION RANKING ]',
      subtitle:'尚无统计快照，未展示任何会话。',
      footer:'尚无统计快照。',
      emptyText:'尚无统计快照。',
    };
  }
  const list=Array.isArray(data?.sessions)?data.sessions:[];
  const links=sessionLinkMap(data);
  const analysis=data?.analysis||null;
  const primaryThreadId=str(analysis?.codexThreadId)||'';
  const sorted=[...list].sort((left,right)=>{
    if(rankKey==='tasks'){
      return count(right.taskCount)-count(left.taskCount)||String(left.threadId).localeCompare(String(right.threadId));
    }
    const lt=finite(left.tokens?.totalTokens),rt=finite(right.tokens?.totalTokens);
    return (rt??-1)-(lt??-1)||String(left.threadId).localeCompare(String(right.threadId));
  });
  const rows=sorted.map((session,index)=>{
    const threadId=str(session?.threadId);
    const link=links.get(threadId)||null;
    const representative=Array.isArray(session?.representativeTasks)?session.representativeTasks:[];
    const taskId=representative.length?str(representative[0].id):'';
    const scopeHref=(link?.tasks.get(taskId))||null;
    const codexHref=codexThreadUrl(threadId)||null;
    return {
      index:index+1,
      numberLabel:`#${String(index+1).padStart(2,'0')}`,
      threadId,
      title:str(session?.title)||'未命名会话',
      taskCount:count(session?.taskCount),
      attempts:count(session?.attemptCount),
      tokens:session?.tokens?.totalTokens??null,
      sortValues:{
        tasks:count(session?.taskCount),
        attempts:count(session?.attemptCount),
        tokens:finite(session?.tokens?.totalTokens),
      },
      tokenLabel:tokenLabel(session?.tokens?.totalTokens),
      hasScope:Boolean(scopeHref),
      scopeHref,
      scopeLabel:'查看小队',
      codexHref,
      codexLabel:'打开会话',
      hasCodex:Boolean(codexHref),
      isPrimary:Boolean(primaryThreadId&&threadId===primaryThreadId),
      isCurrent:Boolean(currentThreadId&&threadId===currentThreadId),
    };
  });
  const shown=rows;
  return {
    rows:shown,
    rank:rankKey,
    omitted:0,
    total:rows.length,
    previewRows:PREVIEW_ROWS,
    canExpand:rows.length>PREVIEW_ROWS,
    available:true,
    headline:'[ 会话消耗排行 · SESSION RANKING ]',
    subtitle:`按${rankKey==='tasks'?'任务数':'已报 Token'}排序；点击查看小队或打开会话。`,
    footer:`共 ${rows.length} 个会话 · ${count(data?.metrics?.attemptCount)} 次尝试`,
    emptyText:'本区间没有可展示的会话。',
  };
}

const SESSION_KIND_LABELS={squad:'小队会话',analysis:'分析报告',unassigned:'未关联会话'};

function shortStamp(value){
  const parsed=Date.parse(str(value));
  if(!Number.isFinite(parsed))return '时间未上报';
  const iso=new Date(parsed).toISOString();
  return `${iso.slice(5,10).replace('-','/')} ${iso.slice(11,16)} UTC`;
}
function qoderUsage(data){
  const usage=isRecord(data?.executorUsage?.qoder)?data.executorUsage.qoder:null;
  return usage;
}
const QODER_MODEL_SOURCE_LABELS={actual:'实际模型',configured:'配置模型',unknown:'模型未标注',mixed:'多来源'};
// 后端口径说明含执行器字段名，页面只使用用户可读的这一句。
const QODER_NOTE='Qoder 已上报的执行用量；不与 Codex 合并。';
const INTERNAL_USAGE_NOTE=/缓存|不可重复|推理包含|inputTokens|executor=/i;

/** 只保留用户可读的口径说明，不把后端字段或缓存相加提示带到页面。 */
function displayNote(value){
  const text=str(value);
  return text&&!INTERNAL_USAGE_NOTE.test(text)?text:null;
}

/**
 * Qoder 执行用量：只消费统计快照里的 executorUsage.qoder。
 * 旧快照没有该分项时明确显示未生成明细，不把历史 Codex 执行器或账户额度混入。
 */
export function qoderUsageView(data){
  const usage=qoderUsage(data);
  if(!usage){
    return {
      present:false,
      available:false,
      empty:true,
      emptyTitle:'尚未生成 Qoder 用量明细',
      emptyText:'这份统计快照没有 Qoder 执行用量明细。',
      note:'Qoder 用量不与 Codex 合并，不读取账户额度。',
      observedLabel:'Qoder 本机记录 · 未生成明细',
      coverageLabel:'',
      coverageSummary:'',
      totals:null,
      models:[],
      modelsCount:0,
      sessions:[],
      sessionsCount:0,
    };
  }
  const available=usage.available===true;
  const coverage=isRecord(usage.coverage)?usage.coverage:{};
  const attempts=count(coverage.totalAttempts);
  const reported=count(coverage.reportedAttempts);
  const executed=count(coverage.executedAttempts);
  const undated=count(coverage.undatedAttempts);
  const beforeWindow=count(coverage.beforeWindowAttempts);
  const future=count(coverage.futureAttempts);
  const coverageParts=[];
  if(attempts>0)coverageParts.push(`已记录 ${reported}/${attempts} 次执行用量`);
  if(undated>0)coverageParts.push(`${undated} 次无开始时间`);
  if(beforeWindow>0)coverageParts.push(`${beforeWindow} 次不在窗口内`);
  if(future>0)coverageParts.push(`${future} 次晚于当前时间`);
  if(!coverageParts.length)coverageParts.push('覆盖情况未上报');
  const observedLabel=usage.observedAt?`Qoder 本机记录 · 更新于 ${shortStamp(usage.observedAt)}`:'Qoder 本机记录 · 时间未上报';
  if(!available){
    return {
      present:true,
      available:false,
      empty:true,
      emptyTitle:'本窗口没有 Qoder 执行用量',
      emptyText:'本统计窗口内没有 Qoder 已上报的执行用量。',
      note:QODER_NOTE,
      observedLabel,
      coverageLabel:`已执行 ${executed} 次${undated>0?` · ${undated} 次无开始时间`:''}`,
      coverageSummary:`已执行 ${executed} 次`,
      totals:null,
      models:[],
      modelsCount:0,
      sessions:[],
      sessionsCount:0,
    };
  }
  const total=finite(usage.totals?.totalTokens);
  const input=finite(usage.totals?.inputTokens);
  const cached=finite(usage.totals?.cachedInputTokens);
  const output=finite(usage.totals?.outputTokens);
  const models=(Array.isArray(usage.models)?usage.models:[]).map(item=>({
    name:str(item?.model)||'模型未标注',
    source:str(item?.source),
    sourceLabel:QODER_MODEL_SOURCE_LABELS[str(item?.source)]||'来源未标注',
    attempts:count(item?.attempts),
    total:finite(item?.tokens?.totalTokens),
  })).sort((left,right)=>(right.total??-1)-(left.total??-1)||left.name.localeCompare(right.name))
    .map(item=>({
      ...item,
      tokenLabel:tokenLabel(item.total),
      percent:ratio(item.total,total)||'—',
    }));
  const links=sessionLinkMap(data);
  const codexTitles=new Map();
  const codexKinds=new Map();
  for(const session of Array.isArray(data?.codexUsage?.sessions)?data.codexUsage.sessions:[]){
    const threadId=str(session?.threadId);
    if(!threadId)continue;
    codexTitles.set(threadId,str(session?.title));
    codexKinds.set(threadId,str(session?.kind));
  }
  const statsTitles=new Map((Array.isArray(data?.sessions)?data.sessions:[])
    .map(session=>[str(session?.threadId),str(session?.title)]));
  const sessions=(Array.isArray(usage.sessions)?usage.sessions:[]).map(session=>{
    const threadId=str(session?.threadId);
    const link=links.get(threadId)||null;
    const threadTitle=links.get(threadId)?.session?.title;
    const kind=codexKinds.get(threadId)||'';
    return {
      threadId,
      title:str(session?.title)||str(threadTitle)||statsTitles.get(threadId)||codexTitles.get(threadId)||'未命名会话',
      kindLabel:SESSION_KIND_LABELS[kind]||'会话',
      models:(Array.isArray(session?.models)?session.models:[])
        .map(model=>str(model?.model))
        .filter(Boolean),
      total:finite(session?.tokens?.totalTokens),
      tokenLabel:tokenLabel(session?.tokens?.totalTokens),
      percent:ratio(session?.tokens?.totalTokens,total)||'—',
      reportedAttempts:count(session?.coverage?.reportedAttempts),
      attempts:count(session?.coverage?.totalAttempts),
      scopeHref:link?.overview||null,
      codexHref:codexThreadUrl(threadId)||null,
    };
  }).sort((left,right)=>(right.total??-1)-(left.total??-1)||left.title.localeCompare(right.title));
  return {
    present:true,
    available:true,
    empty:false,
    emptyTitle:null,
    emptyText:null,
    note:QODER_NOTE,
    observedLabel,
    coverageLabel:coverageParts.join(' · '),
    coverageSummary:attempts>0?`已记录 ${reported}/${attempts} 次执行`:'覆盖情况未上报',
    totals:{
      total:tokenParts(total),
      input:tokenParts(input),
      cached:tokenParts(cached),
      rawInput:tokenParts(input!==null&&cached!==null?Math.max(0,input-cached):null),
      output:tokenParts(output),
      cacheShare:ratio(cached,input),
      shares:{
        cached:shareOf(cached,total),
        rawInput:shareOf(input!==null&&cached!==null?Math.max(0,input-cached):null,total),
        output:shareOf(output,total),
      },
    },
    models:models.slice(0,4),
    modelsCount:models.length,
    modelsOmitted:Math.max(0,models.length-4),
    sessions,
    sessionsCount:sessions.length,
  };
}

/** 对比只看两侧已记录 Token 和同一小队对齐；不换算金额，也不判断效率优劣。 */
export function usageComparison(data){
  const codexRaw=isRecord(data?.codexUsage)?data.codexUsage:null;
  const qoderRaw=qoderUsage(data);
  const codexSessions=(Array.isArray(codexRaw?.sessions)?codexRaw.sessions:[]).filter(isRecord);
  const qoderSessions=(Array.isArray(qoderRaw?.sessions)?qoderRaw.sessions:[]).filter(isRecord);
  const links=sessionLinkMap(data);
  const statsTitles=new Map((Array.isArray(data?.sessions)?data.sessions:[])
    .map(session=>[str(session?.threadId),str(session?.title)]));
  const qoderByThread=new Map();
  for(const session of qoderSessions){
    const threadId=str(session?.threadId);
    if(threadId)qoderByThread.set(threadId,session);
  }
  const codexNonSquad=new Map();
  for(const session of codexSessions){
    const kind=str(session?.kind);
    if(kind==='squad')continue;
    const threadId=str(session?.threadId);
    if(threadId)codexNonSquad.set(threadId,session);
  }
  const usedQoder=new Set();
  const rows=[];
  for(const session of codexSessions){
    if(str(session?.kind)!=='squad')continue;
    const threadId=str(session?.threadId);
    const qoder=qoderByThread.get(threadId)||null;
    if(qoder)usedQoder.add(threadId);
    const link=links.get(threadId)||null;
    rows.push({
      key:threadId,
      title:str(session?.title)||statsTitles.get(threadId)||str(qoder?.title)||'未命名会话',
      codexLabel:tokenLabel(session?.totalTokens),
      qoderLabel:qoder?tokenLabel(qoder?.tokens?.totalTokens):'无记录',
      codexTotal:finite(session?.totalTokens),
      qoderTotal:qoder?finite(qoder?.tokens?.totalTokens):null,
      scopeHref:link?.overview||null,
      codexHref:codexThreadUrl(threadId)||null,
      kindLabel:'小队会话',
    });
  }
  for(const session of qoderSessions){
    const threadId=str(session?.threadId);
    if(!threadId||usedQoder.has(threadId)||codexNonSquad.has(threadId))continue;
    const link=links.get(threadId)||null;
    rows.push({
      key:threadId,
      title:str(session?.title)||statsTitles.get(threadId)||'未命名会话',
      codexLabel:'无记录',
      qoderLabel:tokenLabel(session?.tokens?.totalTokens),
      codexTotal:null,
      qoderTotal:finite(session?.tokens?.totalTokens),
      scopeHref:link?.overview||null,
      codexHref:codexThreadUrl(threadId)||null,
      kindLabel:'仅 Qoder 记录',
    });
  }
  rows.sort((left,right)=>left.title.localeCompare(right.title));
  const codexOnly=codexSessions.filter(session=>str(session?.kind)!=='squad').map(session=>({
    title:str(session?.title)||'未命名会话',
    kindLabel:SESSION_KIND_LABELS[str(session?.kind)]||'未对齐会话',
    codexLabel:tokenLabel(session?.totalTokens),
    qoderLabel:'未对齐',
    codexTotal:finite(session?.totalTokens),
    qoderTotal:null,
  }));
  const codexTotal=finite(codexRaw?.totals?.totalTokens);
  const qoderTotal=finite(qoderRaw?.totals?.totalTokens);
  const available=codexSessions.length>0||qoderSessions.length>0;
  return {
    available,
    empty:!available,
    emptyText:available?'':'尚无可对比的 Codex 或 Qoder 记录。',
    observedLabel:'同一统计窗口 · 按小队对比',
    coverageLabel:available?`已对齐 ${rows.length} 个会话 · Codex 分析/独立会话 ${codexOnly.length} 行单列`:'',
    coverageSummary:available?`已对齐 ${rows.length} 个会话`:'',
    summary:`Codex ${codexTotal===null?'未上报':tokenLabel(codexTotal)} · Qoder ${qoderTotal===null?'未上报':tokenLabel(qoderTotal)} · 各自独立，不合并`,
    rows,
    codexOnly,
    note:'两侧 Token 只表示各自已记录用量；模型、缓存与覆盖不同，不能换算为金额或效率优劣。',
  };
}

/**
 * Codex 本机消耗：只用冻结快照里的 codexUsage；没有记录时明确显示空态，不按 0 占位。
 * 额度/账户剩余不属于本模型输入。
 */
export function codexUsageView(data){
  const usage=isRecord(data?.codexUsage)?data.codexUsage:null;
  const available=usage?.available===true;
  const rawSessions=Array.isArray(usage?.sessions)?usage.sessions:[];
  const sessions=rawSessions.map(session=>({
    threadId:str(session?.threadId),
    title:str(session?.title)||'未命名会话',
    kind:['squad','analysis','unassigned'].includes(session?.kind)?session.kind:'unassigned',
    kindLabel:SESSION_KIND_LABELS[session?.kind]||SESSION_KIND_LABELS.unassigned,
    squadThreadId:str(session?.squadThreadId)||null,
    models:(Array.isArray(session?.models)?session.models:[])
      .map(model=>str(model?.model))
      .filter(Boolean),
    total:finite(session?.totalTokens),
    turnCount:count(session?.turnCount),
  }));
  const total=available&&finite(usage?.totals?.totalTokens)!==null
    ?finite(usage.totals.totalTokens)
    :available?sessions.reduce((sum,session)=>sum+(session.total||0),0):null;
  if(!available||!sessions.length||total===null||total<=0){
    return {
      available:false,
      empty:true,
      emptyTitle:'暂无本机消耗记录',
      emptyText:available
        ?'本机 Codex 记录中暂无可展示的消耗。'
        :str(usage?.note)||'尚未读取到本机 Codex 消耗记录。',
      note:displayNote(usage?.note),
      observedLabel:usage?.observedAt?`本机记录 · 更新于 ${shortStamp(usage.observedAt)}`:'本机记录 · 时间未上报',
      coverageLabel:'',
      coverageSummary:'',
      leaders:[],
      groups:[],
      models:[],
      modelsCount:0,
      modelsOmitted:0,
      allSessions:[],
      sessionsCount:0,
      totals:null,
    };
  }
  const links=sessionLinkMap(data);
  const ordered=sessions
    .slice()
    .sort((left,right)=>(right.total??-1)-(left.total??-1)||left.title.localeCompare(right.title));
  const allSessions=ordered.map(session=>{
    const link=links.get(session.threadId)||null;
    const taskLink=(link?.session?.representativeTasks||[])
      .map(task=>link?.tasks?.get(str(task?.id)))
      .find(Boolean)
      ||(link?.tasks ? Array.from(link.tasks.values()).find(Boolean) : null)
      ||link?.overview
      ||null;
    return {
      key:session.threadId||session.title,
      threadId:session.threadId,
      title:session.title,
      kind:session.kind,
      squadThreadId:session.squadThreadId,
      kindLabel:session.kindLabel,
      models:session.models,
      total:session.total,
      turnCount:session.turnCount,
      tokenLabel:tokenLabel(session.total),
      percent:ratio(session.total,total)||'—',
      scopeHref:taskLink||link?.overview||null,
      codexHref:codexThreadUrl(session.threadId)||null,
    };
  });
  const leaders=ordered
    .slice(0,3)
    .map((session,index)=>({
      ...session,
      numberLabel:`#${index+1}`,
      tokenLabel:tokenLabel(session.total),
      percent:ratio(session.total,total)||'—',
      width:Math.max(0,Math.min(100,session.total===null?0:session.total/total*100)),
    }));
  const groupTotal=kind=>sessions
    .filter(session=>session.kind===kind)
    .reduce((sum,session)=>sum+(session.total||0),0);
  const groups=['analysis','unassigned'].map(kind=>{
    const value=groupTotal(kind);
    return {
      key:kind,
      label:kind==='analysis'?'分析报告自消耗':'未关联小队的独立会话',
      value,
      tokenLabel:tokenLabel(value),
      percent:ratio(value,total)||'—',
      visible:value>0,
    };
  }).filter(group=>group.visible);
  const rawModels=Array.isArray(usage?.models)?usage.models:[];
  const models=rawModels.map(model=>({
    name:str(model?.model)||'未标注模型',
    total:finite(model?.totalTokens),
  })).filter(model=>model.total!==null)
    .sort((left,right)=>right.total-left.total||left.name.localeCompare(right.name))
    .map(model=>({
      ...model,
      tokenLabel:tokenLabel(model.total),
      percent:ratio(model.total,total)||'—',
      width:Math.max(0,Math.min(100,model.total/total*100)),
    }));
  const coverage=isRecord(usage?.coverage)?usage.coverage:{};
  const threads=count(coverage.threads);
  const readable=count(coverage.readableThreads);
  const missing=count(coverage.missingThreads);
  const unreported=count(coverage.unreportedThreads);
  const unreportedWithTokens=count(coverage.unreportedWithTokens);
  const undated=count(coverage.undatedRecords);
  const unattributed=count(coverage.unattributedModelRecords);
  const coverageParts=[];
  if(threads>0)coverageParts.push(`已读取 ${readable}/${threads} 个会话记录`);
  if(missing>0)coverageParts.push(`${missing} 个不可读`);
  if(unreported>0)coverageParts.push(`${unreported} 个会话未记录本窗口用量`);
  if(unreportedWithTokens>0)coverageParts.push(`${unreportedWithTokens} 个有历史用量但本窗口无记录`);
  if(undated>0)coverageParts.push(`${undated} 条记录无时间戳`);
  if(unattributed>0)coverageParts.push(`${unattributed} 条记录未标注模型`);
  const input=finite(usage?.totals?.inputTokens);
  const cached=finite(usage?.totals?.cachedInputTokens);
  const output=finite(usage?.totals?.outputTokens);
  const totalParts=tokenParts(total);
  const inputParts=tokenParts(input);
  const cachedParts=tokenParts(cached);
  const outputParts=tokenParts(output);
  return {
    available:true,
    empty:false,
    emptyTitle:null,
    emptyText:null,
    note:displayNote(usage?.note),
    observedLabel:`本机记录 · 更新于 ${shortStamp(usage?.observedAt)}`,
    coverageLabel:coverageParts.join(' · ')||'覆盖情况未上报',
    coverageSummary:threads>0?`已读取 ${readable}/${threads} 个会话`:'覆盖情况未上报',
    leaders,
    groups,
    models:models.slice(0,4),
    modelsCount:models.length,
    modelsOmitted:Math.max(0,models.length-4),
    allSessions,
    sessionsCount:allSessions.length,
    totals:{
      total:totalParts,
      input:inputParts,
      cached:cachedParts,
      rawInput:tokenParts(input!==null&&cached!==null?Math.max(0,input-cached):null),
      output:outputParts,
      cacheShare:ratio(cached,input),
      shares:{
        cached:shareOf(cached,total),
        rawInput:shareOf(input!==null&&cached!==null?Math.max(0,input-cached):null,total),
        output:shareOf(output,total),
      },
    },
  };
}

export const USAGE_MODES=[
  {value:'codex',label:'Codex'},
  {value:'qoder',label:'Qoder'},
  {value:'compare',label:'对比'},
];

/** 三个用量视图共用同一份已保存快照，切换只改变展示，不重新扫描或发起请求。 */
export function usageView(data){
  return {
    modes:USAGE_MODES,
    codex:codexUsageView(data),
    qoder:qoderUsageView(data),
    compare:usageComparison(data),
  };
}

const FAILURE_LABELS={
  timeout:'超时',
  permission:'权限/认证',
  argument:'参数/用法',
  service:'服务/网络',
  execution:'命令不可用',
  business:'业务调用失败',
  unconfirmed:'未见明确失败原因',
};
const MAX_CLI_ROWS=PREVIEW_ROWS;
const MAX_CLI_SESSIONS=3;

function cliRate(metric){
  const succeeded=count(metric?.succeeded);
  const failed=count(metric?.failed);
  const unknown=count(metric?.unknown);
  const known=succeeded+failed;
  const total=known+unknown;
  return {
    succeeded,
    failed,
    unknown,
    known,
    rate:known>0?`${(succeeded/known*100).toFixed(1)}%`:null,
    display:known>0?`${(succeeded/known*100).toFixed(1)}%`:'— (未确认)',
    confirmedLabel:total>0?`确认 ${known}/${total}`:'确认情况未上报',
  };
}

const CLI_SORT_COLUMNS=[
  {key:'command',type:'text',value:row=>row.title},
  {key:'calls',type:'number',value:row=>row.calls},
  {key:'execution',type:'number',value:row=>row.sortValues.execution},
  {key:'business',type:'number',value:row=>row.sortValues.business},
  {key:'failures',type:'number',value:row=>row.failures},
];

function cliQueryTerms(value){
  return str(value).split(/\s+/).filter(Boolean).map(term=>term.toLowerCase());
}

/**
 * CLI 表现：只消费后端已安全归一的 name/command 与状态计数，不接触原始命令参数。
 * unknown 不计入成功率分母，但通过 confirmedLabel 明示确认覆盖率。
 * 筛选、搜索与排序只影响展示行，计数始终来自真实记录。
 */
export function cliView(data,{filter='all',query='',sort=null,expanded=false}={}){
  const raw=isRecord(data?.capabilities?.cli)?data.capabilities.cli:null;
  const statsReady=statsAvailable(data);
  const list=Array.isArray(raw?.rows)?raw.rows:[];
  const unclassified=Number.isFinite(raw?.unclassifiedCalls)?Math.max(0,Math.floor(raw.unclassifiedCalls)):null;
  const queryText=typeof query==='string'?query.trim():'';
  const terms=cliQueryTerms(queryText);
  if(!statsReady||!raw||!list.length){
    return {
      available:false,
      empty:true,
      emptyText:statsReady?'尚无可识别CLI记录':'尚无统计快照，CLI 调用未统计。',
      note:str(raw?.note)||null,
      unclassifiedCalls:unclassified,
      totalCalls:0,
      rowCount:0,
      filteredCount:0,
      shownCount:0,
      hiddenCount:0,
      omitted:0,
      unknownCalls:0,
      coverageLabel:'',
      filter:'all',
      query:queryText,
      sort:null,
      noMatches:false,
      expanded:false,
      filters:[{value:'all',label:'全部 CLI (共 0 条指令)'}],
      canExpand:false,
      toggleLabel:null,
      rows:[],
    };
  }
  const links=sessionLinkMap(data);
  const rows=list.map(item=>{
    const name=str(item?.name);
    const command=str(item?.command);
    const title=command&&name&&command!==name&&!command.startsWith(`${name} `)?`${name} ${command}`:command||name||'未命名命令';
    const execution=cliRate(item?.execution);
    const business=cliRate(item?.business);
    const failureCategories=(Array.isArray(item?.failures)?item.failures:[])
      .map(failure=>({
        category:str(failure?.category),
        label:FAILURE_LABELS[str(failure?.category)]||str(failure?.category)||'未分类',
        count:count(failure?.count),
      }))
      .filter(failure=>failure.count>0)
      .sort((left,right)=>right.count-left.count||left.label.localeCompare(right.label));
    const rawSessions=Array.isArray(item?.sessions)?item.sessions:[];
    const failures=Math.max(execution.failed,business.failed,failureCategories.reduce((total,item)=>total+item.count,0));
    const calls=count(item?.calls);
    const sessions=rawSessions.map(session=>{
      const threadId=str(session?.threadId);
      const taskId=str(session?.taskId);
      const link=links.get(threadId)||null;
      const sessionTitle=str(session?.title)||str(session?.taskTitle)||'未命名会话';
      const taskTitleText=str(session?.taskTitle);
      return {
        key:`${threadId}\u0000${taskId}`,
        label:taskTitleText&&taskTitleText!==sessionTitle?`${sessionTitle} · ${taskTitleText}`:sessionTitle,
        taskHref:(link?.tasks.get(taskId))||null,
        codexHref:codexThreadUrl(threadId)||null,
      };
    });
    return {
      key:`${name}\u0000${command}`,
      name,
      command,
      title,
      calls,
      execution,
      business,
      failures,
      sortValues:{
        command:title,
        calls,
        execution:execution.known>0?execution.succeeded/execution.known:null,
        business:business.known>0?business.succeeded/business.known:null,
        failures,
      },
      failureCategories,
      hasFailures:failures>0,
      sessions:sessions.slice(0,MAX_CLI_SESSIONS),
      sessionsOmitted:Math.max(0,sessions.length-MAX_CLI_SESSIONS),
      hasSessions:sessions.length>0,
    };
  }).filter(row=>row.calls>0)
    .sort((left,right)=>right.calls-left.calls||left.title.localeCompare(right.title));
  if(!rows.length){
    return {
      available:false,
      empty:true,
      emptyText:'尚无可识别CLI记录',
      note:str(raw?.note)||null,
      unclassifiedCalls:unclassified,
      totalCalls:0,
      rowCount:0,
      filteredCount:0,
      shownCount:0,
      hiddenCount:0,
      omitted:0,
      unknownCalls:0,
      coverageLabel:'',
      filter:'all',
      query:queryText,
      sort:null,
      noMatches:false,
      expanded:false,
      filters:[{value:'all',label:'全部 CLI (共 0 条指令)'}],
      canExpand:false,
      toggleLabel:null,
      rows:[],
    };
  }

  const nameCounts=new Map();
  for(const row of rows){
    const key=row.name||'未标注 CLI';
    nameCounts.set(key,(nameCounts.get(key)||0)+1);
  }
  const filters=[
    {value:'all',label:`全部 CLI (共 ${rows.length} 条指令)`},
    ...Array.from(nameCounts,([value,number])=>({value,label:`${value} (${number} 条)`}))
      .sort((left,right)=>left.value.localeCompare(right.value)),
  ];
  const activeFilter=filters.some(item=>item.value===filter)?filter:'all';
  let filtered=activeFilter==='all'
    ?rows
    :rows.filter(row=>(row.name||'未标注 CLI')===activeFilter);
  if(terms.length){
    filtered=filtered.filter(row=>{
      const text=`${row.name} ${row.command} ${row.title}`.toLowerCase();
      return terms.every(term=>text.includes(term));
    });
  }
  const activeSort=sort&&typeof sort.key==='string'&&CLI_SORT_COLUMNS.some(column=>column.key===sort.key)
    ?{key:sort.key,direction:sort.direction==='desc'?'desc':'asc'}
    :null;
  if(activeSort)filtered=sortRows(filtered,activeSort,CLI_SORT_COLUMNS);
  const shown=expanded?filtered:filtered.slice(0,MAX_CLI_ROWS);
  const hiddenCount=Math.max(0,filtered.length-shown.length);
  const totalCalls=rows.reduce((sum,row)=>sum+row.calls,0);
  const unknownCalls=rows.reduce((sum,row)=>sum+row.execution.unknown,0);
  const knownCalls=totalCalls-unknownCalls;
  return {
    available:true,
    empty:false,
    emptyText:null,
    note:str(raw?.note)||null,
    unclassifiedCalls:unclassified,
    totalCalls,
    rowCount:rows.length,
    filteredCount:filtered.length,
    shownCount:shown.length,
    hiddenCount,
    omitted:hiddenCount,
    unknownCalls,
    coverageLabel:totalCalls>0?`执行状态确认 ${knownCalls}/${totalCalls}`:'确认情况未上报',
    filter:activeFilter,
    query:queryText,
    sort:activeSort,
    noMatches:filtered.length===0,
    expanded:Boolean(expanded)&&filtered.length>MAX_CLI_ROWS,
    filters,
    canExpand:filtered.length>MAX_CLI_ROWS,
    toggleLabel:filtered.length>MAX_CLI_ROWS
      ?expanded?`收起至前 ${PREVIEW_ROWS} 条`:`展开全部 ${filtered.length} 条指令`
      :null,
    rows:shown,
  };
}

export function skillRows(data){
  if(!statsAvailable(data))return {rows:[],total:0,empty:true,available:false};
  const list=Array.isArray(data?.capabilities?.skillReads)?data.capabilities.skillReads:[];
  const total=list.reduce((sum,item)=>sum+count(item?.reads),0);
  const rows=list.map(item=>({name:str(item?.name)||'未命名技能',reads:count(item?.reads)}))
    .filter(row=>row.name!=='未命名技能'||row.reads>0);
  return {rows,total,empty:rows.length===0,available:true};
}

function refLink(ref,tasks,links){
  const parts=String(ref||'').split(':');
  const needsTask=parts[0]==='task'||parts[0]==='metric'||parts[0]==='tool'||parts[0]==='skill'||parts[0]==='cli-task';
  if(needsTask&&parts.length>=3){
    const threadId=parts[1],taskId=parts[2];
    const url=links.get(threadId)?.tasks.get(taskId)||null;
    return {label:taskTitle(tasks,threadId,taskId)||'查看关联任务',href:url};
  }
  if(parts[0]==='thread'&&parts.length>=2){
    const threadId=parts[1];
    const title=str(links.get(threadId)?.session?.title);
    return {label:title||'会话记录',href:links.get(threadId)?.overview||null};
  }
  if(parts[0]==='cli')return {label:'CLI 调用记录',href:null};
  if(parts[0]==='codex')return {label:'Codex 用量记录',href:null};
  if(parts[0]==='qoder')return {label:'Qoder 用量汇总',href:null};
  if(parts[0]==='benefit')return {label:'小队收益汇总',href:null};
  return {label:'关联统计',href:null};
}

const OBSERVATION_CATEGORIES=[
  {key:'skills_tools',label:'技能与工具'},
  {key:'time',label:'耗时与节奏'},
  {key:'tokens',label:'Token 投入'},
];

const OBSERVATION_FALLBACKS={
  problem:'已保存分析未提供问题描述。',
  evidence:'已保存分析未提供证据摘要。',
  next:'已保存分析未提供下一步建议。',
  verification:'已保存分析未提供验证方式。',
};

/**
 * 把同轮已保存观察映射为四段式问题卡；缺失段落明确标记，不用空泛建议补位。
 */
export function observationStages(item){
  const source=isRecord(item)?item:{};
  const stages=[
    {key:'problem',label:'【具体问题】',text:str(source.title)},
    {key:'evidence',label:'【相关证据】',text:str(source.observation)},
    {key:'next',label:'【下一步】',text:str(source.action)},
    {key:'verification',label:'【验证方法】',text:str(source.verification)},
  ];
  return stages.map(stage=>({
    ...stage,
    missing:!stage.text,
    text:stage.text||OBSERVATION_FALLBACKS[stage.key],
  }));
}

/**
 * 一条连续的 Codex 观察：综述导语加扁平条目，证据与验证方式默认折叠。
 * 不复制设计样例的原因、收益或质量评分，也不把原生 ID 和字段名带进可读文案。
 */
export function analysisObservations(data){
  const analysis=data?.analysis||null;
  const categories=isRecord(analysis?.categories)?analysis.categories:{};
  const tasks=Array.isArray(data?.tasks)?data.tasks:[];
  const links=sessionLinkMap(data);
  const hasStats=statsAvailable(data);
  const summary=str(analysis?.summary);
  const items=[];
  for(const meta of OBSERVATION_CATEGORIES){
    const raw=Array.isArray(categories[meta.key])?categories[meta.key]:[];
    for(const item of raw.slice(0,3)){
      const refs=Array.isArray(item?.evidenceRefs)?item.evidenceRefs.map(ref=>String(ref)):[];
      const seen=new Set();
      const linked=refs.map(ref=>refLink(ref,tasks,links)).filter(link=>{
        const key=link.href?`${link.label}\u0000${link.href}`:link.label;
        if(seen.has(key))return false;
        seen.add(key);
        return true;
      });
      const observations=linked.filter(link=>link.href);
      const evidenceNames=linked.filter(link=>!link.href).map(link=>link.label);
      const observation=str(item?.observation);
      const action=str(item?.action);
      const rawVerification=str(item?.verification);
      const verification=/^(?:task|metric|thread|tool|skill|cli-task|cli|codex|qoder|benefit):/.test(rawVerification)
        ?refLink(rawVerification,tasks,links).label:rawVerification;
      items.push({
        number:String(items.length+1).padStart(2,'0'),
        categoryKey:meta.key,
        categoryLabel:meta.label,
        title:str(item?.title)||'未命名建议',
        observation,
        action,
        verification,
        refs:observations,
        evidenceNames,
        hasDetails:Boolean(observation||verification||observations.length||evidenceNames.length),
      });
    }
  }
  const emptyText=!hasStats
    ?'尚无统计快照，Codex 观察将在统计生成后出现。'
    :analysis?.available?'本轮没有可用的观察条目。':'本轮 AI 分析尚未生成观察。';
  const intro=summary
    ||(!hasStats?'统计尚未生成，暂无 Codex 观察。'
      :analysis?.available?'本轮报告未返回综述；以下是已保存的观察条目。'
        :'统计快照已更新，Codex 观察尚未生成。');
  return {
    available:hasStats||Boolean(analysis?.available),
    hasSummary:Boolean(summary),
    intro,
    items,
    total:items.length,
    empty:items.length===0,
    emptyText,
  };
}

const BENEFIT_TITLE='小队收益';
const BENEFIT_DETAIL_TITLE='小队收益计算依据';
const BENEFIT_DETAIL_NOTE='收益只来自已保存的周期快照；跨周期任务在完成周期计入，不随页面实时重算。Token 与耗时均为估算，不换算费用或账户额度。';
const BENEFIT_EMPTY_TEXT='本周期尚无收益报告。';
const BENEFIT_NO_SUMMARY_TEXT='本周期收益报告尚未包含汇总结果。';
const BENEFIT_SPEED_NOTE='速度按同一口径的实际模型输出取中位数；整轮耗时按任务起止时间粗略估算，不按单步耗时换算。';

const DELIVERY_STATUS_LABELS={
  completed:'已完成',accepted:'已核验',succeeded:'已完成',
  incomplete:'未完成',failed:'未完成',stopped:'已停止',interrupted:'已中断',
  running:'进行中',cancelled:'已取消',unknown:'未确认',
};
const EXCLUSION_LABELS={
  NO_BASELINE:'缺少可比较的历史 Codex 基线',
  MISSING_BASELINE:'缺少可比较的历史 Codex 基线',
  PARTIAL_BASELINE:'历史基线不完整',
  NO_ACTUAL:'缺少本期实际投入记录',
  MISSING_ACTUAL:'缺少本期实际投入记录',
  NO_QODER:'没有 Qoder 实际执行记录',
  NO_SPEED:'缺少可比较的实际模型速度',
  MISSING_SPEED:'缺少可比较的实际模型速度',
  INCOMPLETE_DELIVERY:'交付未完成或核验记录不完整',
  NOT_COMPLETED:'交付未完成',
  NO_TOKEN_USAGE:'缺少已上报的 Token 用量',
  UNREPORTED_TOKENS:'Token 用量未上报',
  'delivery-incomplete':'交付尚未完成',
  'delivery-failed':'交付最终失败',
  'delivery-stopped':'交付已停止',
  'delivery-unobserved':'未找到该交付的本机任务记录',
  'codex-usage-missing':'缺少该交付的本机 Codex 用量',
  'codex-attribution-missing':'Codex 用量未区分主控与子 Agent',
  'codex-cross-period':'Codex 用量窗口未覆盖完整交付',
  'codex-usage-incomplete':'Codex 用量字段不完整',
  'qoder-not-involved':'没有记录 Qoder 子任务用量',
  'qoder-usage-incomplete':'Qoder 子任务用量未完整上报',
  'baseline-missing':'缺少可比较的历史纯 Codex 基线',
  'baseline-incomplete':'基线交付信息不完整',
  'baseline-impure':'基线交付不是纯 Codex 交付',
  'baseline-not-historical':'基线不是更早完成的历史交付',
  'baseline-conditions-missing':'缺少基线匹配条件',
  'baseline-conditions-mismatch':'基线匹配条件不一致',
  'actual-incomplete':'本期 Codex 用量覆盖不完整',
  'speed-missing-model':'缺少该模型的有效速度',
  'speed-run-basis':'时间按整轮速度粗略换算',
  'evidence-view-conflict':'证据与快照完成状态不一致',
};

function firstFinite(...values){
  for(const value of values){const v=finite(value);if(v!==null)return v}
  return null;
}
function firstNum(...values){
  for(const value of values){const v=num(value);if(v!==null)return v}
  return null;
}
function rateText(value){
  const v=num(value);
  if(v===null)return null;
  return `${Number((Math.abs(v)*100).toFixed(1))}%`;
}
function timeParts(seconds){
  const v=num(seconds);
  if(v===null)return null;
  const abs=Math.abs(v);
  if(abs===0)return {value:'0',unit:'分钟'};
  if(abs<60)return {value:'不足 1',unit:'分钟'};
  if(abs<3600)return {value:String(Math.round(abs/60)),unit:'分钟'};
  const hours=abs/3600;
  return {value:hours>=10?String(Math.round(hours)):hours.toFixed(1).replace(/\.0$/,''),unit:'小时'};
}
function timeText(seconds){
  const parts=timeParts(seconds);
  return parts?`${parts.value} ${parts.unit}`:UNREPORTED;
}
function tokenSavingText(saved){
  if(saved===null)return '暂无法估算';
  if(saved===0)return '持平';
  return saved>0?`减少 ${tokenLabel(saved)}`:`增加 ${tokenLabel(Math.abs(saved))}`;
}
function timeSavingText(saved){
  if(saved===null)return '暂无法估算';
  if(saved===0)return '持平';
  return saved>0?`节省 ${timeText(saved)}`:`多投入 ${timeText(Math.abs(saved))}`;
}
function deltaTokenLabel(saved){
  if(saved===null)return UNREPORTED;
  if(saved===0)return '持平';
  return `${saved>0?'+':'-'}${tokenLabel(Math.abs(saved))}`;
}
function deltaTimeLabel(saved){
  if(saved===null)return UNREPORTED;
  if(saved===0)return '持平';
  return `${saved>0?'+':'-'}${timeText(Math.abs(saved))}`;
}
function momentLabel(value){
  const parsed=Date.parse(str(value));
  if(!Number.isFinite(parsed))return null;
  return `${new Date(parsed).toISOString().slice(0,16).replace('T',' ')} UTC`;
}
function spanLabel(range){
  const from=momentLabel(range?.from??range?.startedAt);
  const to=momentLabel(range?.to??range?.completedAt??range?.endedAt??range?.lastActivityAt);
  if(from&&to)return `${from} ~ ${to}`;
  if(to)return `至 ${to}`;
  if(from)return `自 ${from}`;
  return '起止区间未上报';
}
// 主标题固定为“少用/节省”，方向只由数值符号表达：负值代表实际投入高于历史基线。
function metricPercent(saved,baseline,rate){
  if(saved===0)return null;
  const computed=baseline!==null&&baseline>0?`${Number((Math.abs(saved)/baseline*100).toFixed(1))}%`:null;
  const text=computed||rateText(rate);
  if(!text)return null;
  return saved<0?`-${text}`:text;
}
function benefitTokenMetric(summary){
  const baseline=firstFinite(summary?.baselineCodexTokens);
  const saved=firstNum(summary?.codexTokensSaved);
  if(saved===null){
    return {key:'tokens',label:'测算少用 Codex Token',value:'暂无法估算',percent:null,tone:'quiet',missing:true};
  }
  return {
    key:'tokens',
    label:'测算少用 Codex Token',
    value:saved===0?'持平':`${saved<0?'-':''}${tokenLabel(Math.abs(saved))}`,
    percent:metricPercent(saved,baseline,summary?.tokenSavingRate),
    tone:saved>0?'ok':saved<0?'warn':'quiet',
    missing:false,
  };
}
function benefitTimeMetric(summary){
  const baseline=firstFinite(summary?.baselineSeconds);
  const saved=firstNum(summary?.secondsSaved);
  if(saved===null){
    return {key:'time',label:'测算节省处理时间',value:'暂无法估算',percent:null,tone:'quiet',missing:true};
  }
  const parts=timeParts(saved)||{value:'0',unit:'秒'};
  return {
    key:'time',
    label:'测算节省处理时间',
    value:saved===0?'持平':`${Math.abs(saved)<60?'':'约 '}${saved<0?'-':''}${parts.value} ${parts.unit}`,
    percent:metricPercent(saved,baseline,summary?.timeSavingRate),
    tone:saved>0?'ok':saved<0?'warn':'quiet',
    missing:false,
  };
}
/** 外层口径句只引用真实可测算交付数，不把观察项或已完成交付当成全部已纳入。 */
function benefitSummaryLine(tokenDeliveries,timeDeliveries){
  const tokenKnown=tokenDeliveries!==null&&tokenDeliveries>0;
  const timeKnown=timeDeliveries!==null&&timeDeliveries>0;
  if(tokenKnown&&timeKnown&&tokenDeliveries===timeDeliveries){
    return `仅测算 ${tokenDeliveries} 项可比交付，不外推整体`;
  }
  if(tokenKnown&&timeKnown){
    return `仅测算 Token ${tokenDeliveries} 项、时间 ${timeDeliveries} 项可比交付，不外推整体`;
  }
  if(tokenKnown)return `仅测算 ${tokenDeliveries} 项可比交付的 Token，时间口径暂不可测算`;
  if(timeKnown)return `仅测算 ${timeDeliveries} 项可比交付的时间，Token 口径暂不可测算`;
  return '测算覆盖未确认，不外推整体';
}
/** 负收益只陈述相对基线多用/多投入，用绝对值，不用“将节省”。 */
function benefitNegativeNote(savedTokens,savedSeconds){
  const notes=[];
  if(savedTokens!==null&&savedTokens<0)notes.push(`测算比全 Codex 基线多用 ${tokenLabel(Math.abs(savedTokens))} Codex Token`);
  if(savedSeconds!==null&&savedSeconds<0)notes.push(`多投入约 ${timeText(Math.abs(savedSeconds))}处理时间`);
  return notes.length?`${notes.join('；')}。`:null;
}
function exclusionText(reason){
  const raw=typeof reason==='string'?reason.trim()
    :str(reason?.label)||str(reason?.code)||str(reason?.reason);
  if(!raw)return null;
  if(EXCLUSION_LABELS[raw])return EXCLUSION_LABELS[raw];
  if(/[\u4e00-\u9fa5]/.test(raw))return raw;
  return '不具备可比较条件';
}
const BASELINE_SOURCE_LABEL='历史 Codex 基线';
function benefitSources(delivery,links){
  const baseline=isRecord(delivery?.baseline)?delivery.baseline:null;
  if(!baseline)return [];
  const explicit=Array.isArray(baseline.sources)?baseline.sources:[];
  const ref=str(baseline.sourceRef);
  const candidates=explicit.length
    ?explicit
    :[{sourceRef:ref,threadId:str(baseline.threadId),title:str(baseline.title)}];
  const seen=new Set();
  const sources=[];
  let unlinked=false;
  for(const source of candidates){
    const sourceRef=str(source?.sourceRef);
    // 原生引用只用于匹配本机会话，绝不直接展示。
    const threadId=str(source?.threadId)||(sourceRef&&links.has(sourceRef)?sourceRef:'');
    const taskId=str(source?.taskId);
    const linked=threadId?links.get(threadId)||null:null;
    const label=str(source?.title)||str(source?.taskTitle)||str(linked?.session?.title);
    const href=(taskId?linked?.tasks.get(taskId):null)||linked?.overview
      ||(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(threadId)?codexThreadUrl(threadId):null);
    if(!label&&!href){unlinked=true;continue;}
    const finalLabel=label||BASELINE_SOURCE_LABEL;
    const key=`${finalLabel}\u0000${href||''}`;
    if(seen.has(key))continue;
    seen.add(key);
    sources.push({label:finalLabel,href});
  }
  if(!sources.length&&unlinked)sources.push({label:BASELINE_SOURCE_LABEL,href:null});
  return sources;
}
function deliveryTokens(value){
  return isRecord(value)?firstFinite(value.tokens):firstFinite(value);
}
function benefitDelivery(delivery,links,tasks,windowRange){
  const threadId=str(delivery?.threadId);
  const deliveryId=str(delivery?.deliveryId)||str(delivery?.taskId);
  const linked=threadId?links.get(threadId)||null:null;
  const title=str(delivery?.title)||taskTitle(tasks,threadId,deliveryId)||str(linked?.session?.title)||'未命名交付';
  const status=str(delivery?.status);
  const baseline=isRecord(delivery?.baseline)?delivery.baseline:null;
  const estimate=isRecord(delivery?.estimate)?delivery.estimate:null;
  const codexActual=isRecord(delivery?.actual?.codex)?delivery.actual.codex:null;
  const qoderActual=isRecord(delivery?.actual?.qoder)?delivery.actual.qoder:null;
  const actualCodex=deliveryTokens(codexActual);
  const qoderUsed=qoderActual?.used!==false;
  const actualQoder=qoderUsed?deliveryTokens(qoderActual):null;
  const baselineTokens=firstFinite(baseline?.tokens,baseline?.totalTokens);
  const baselineSeconds=firstNum(estimate?.baselineSeconds,baseline?.seconds,baseline?.durationSeconds);
  const savedTokens=firstNum(estimate?.codexTokensSaved,estimate?.tokensSaved,estimate?.savedTokens);
  const savedSeconds=firstNum(estimate?.secondsSaved,estimate?.timeSaved);
  const seenExclusions=new Set();
  const exclusions=[];
  for(const reason of Array.isArray(delivery?.excludedReasons)?delivery.excludedReasons:[]){
    const text=exclusionText(reason);
    if(!text||seenExclusions.has(text))continue;
    seenExclusions.add(text);
    exclusions.push(text);
  }
  const linksOut=[];
  if(linked?.overview)linksOut.push({label:'打开会话',href:linked.overview});
  const taskHref=deliveryId?linked?.tasks.get(deliveryId):null;
  if(taskHref)linksOut.push({label:'查看小队任务',href:taskHref});
  const sources=benefitSources(delivery,links);
  return {
    title,
    statusLabel:DELIVERY_STATUS_LABELS[status]||'状态未上报',
    rangeLabel:`${Date.parse(delivery?.range?.startedAt)<Date.parse(windowRange?.from)?'跨周期 · 完整交付范围：':''}${spanLabel(delivery?.range)}`,
    actualLabel:`Codex ${actualCodex===null?UNREPORTED:tokenLabel(actualCodex)} · ${qoderUsed?`Qoder ${actualQoder===null?UNREPORTED:tokenLabel(actualQoder)}`:'Qoder 未参与'}`,
    actualCodexLabel:actualCodex===null?UNREPORTED:tokenLabel(actualCodex),
    actualQoderLabel:qoderUsed?(actualQoder===null?UNREPORTED:tokenLabel(actualQoder)):'未参与',
    qoderUsed,
    baselineLabel:baselineTokens===null?'基线未上报':`基线 ${tokenLabel(baselineTokens)}`,
    baselineTokenLabel:baselineTokens===null?UNREPORTED:tokenLabel(baselineTokens),
    baselineTimeLabel:baselineSeconds===null?null:`基线耗时 ${timeText(baselineSeconds)}`,
    netTokenLabel:deltaTokenLabel(savedTokens),
    netTimeLabel:deltaTimeLabel(savedSeconds),
    processing:[...(Array.isArray(estimate?.processing)?estimate.processing:[]).map(part=>({
      label:`${({'baseline':'全 Codex','actual-codex':'实际 Codex',qoder:'Qoder'})[part.side]||'模型'} · ${str(part.model)||'模型未记录'}`,
      value:`输出 ${tokenLabel(finite(part.outputTokens))} Token · ${finite(part.tokensPerSecond)===null?'速度未记录':`约 ${Number(part.tokensPerSecond).toFixed(1)} Token/秒`} · ${part.seconds===null?'时间暂无法估算':timeText(part.seconds)}${part.basis==='run'?'（整轮粗估）':''}`,
    })),...(baseline?.semanticMatch?.basis?.length?[{
      label:'基线选择',
      value:'按工作内容、规模和交付要求选取同类历史交付。',
    }]:[])],
    tokenSavingLabel:tokenSavingText(savedTokens),
    timeSavingLabel:timeSavingText(savedSeconds),
    estimated:Boolean(estimate),
    sortValues:{
      baselineTokens:baselineTokens??null,
      codexTokens:actualCodex??null,
      qoderTokens:actualQoder??null,
      savedTokens:savedTokens??null,
      savedSeconds:savedSeconds??null,
    },
    sources,
    sourcesNote:sources.length?'':'基线来源未上报',
    exclusions,
    included:Boolean(estimate),
    links:linksOut,
    hasLinks:linksOut.length>0,
  };
}
function benefitSpeeds(benefits){
  const list=Array.isArray(benefits?.speeds)?benefits.speeds:[];
  const rows=[];
  for(const entry of list){
    const speed=firstNum(entry?.tokensPerSecond);
    const samples=firstNum(entry?.samples);
    const label=str(entry?.model)||'实际模型';
    if(label==='实际模型'&&speed===null)continue;
    const rough=entry?.rough===true||entry?.basis==='run';
    rows.push({
      label,
      valueLabel:speed===null?'速度未上报':`约 ${speed>=10?speed.toFixed(0):speed.toFixed(1)} Token/秒`,
      samplesLabel:samples===null?'样本数未上报':`${samples} 个实测样本`,
      basisLabel:rough?'整轮粗估':'模型实测',
      rough,
      reported:speed!==null,
    });
  }
  return {
    rows,
    empty:rows.length===0,
    partial:rows.some(row=>!row.reported),
    note:BENEFIT_SPEED_NOTE,
    emptyNote:'尚无已上报的实际模型速度。',
  };
}
function benefitExclusionSummary(coverage){
  const counts=new Map();
  for(const reason of Array.isArray(coverage?.reasons)?coverage.reasons:[]){
    const label=exclusionText(reason);
    const amount=count(reason?.count);
    if(!label||amount<=0)continue;
    counts.set(label,(counts.get(label)||0)+amount);
  }
  return [...counts].map(([label,amount])=>({
    label,
    count:amount,
    countLabel:`${amount} 个交付`,
  }));
}

/**
 * 小队收益卡只消费已保存的周期快照，不在页面实时计算或发起更新。
 * 外层只给 Token 与耗时两个核心估算，证据、来源与排除原因全部放进计算依据。
 */
export function squadBenefits(data){
  const raw=isRecord(data?.benefits)?data.benefits:null;
  const present=Boolean(raw);
  const summary=present&&isRecord(raw.summary)?raw.summary:null;
  const coverage=present&&isRecord(raw.coverage)?raw.coverage:null;
  const tokenMetric=benefitTokenMetric(summary);
  const timeMetric=benefitTimeMetric(summary);
  const savedTokens=num(summary?.codexTokensSaved);
  const savedSeconds=num(summary?.secondsSaved);
  const state=!present||!summary
    ?'missing'
    :tokenMetric.missing&&timeMetric.missing?'missing'
      :tokenMetric.missing||timeMetric.missing?'partial'
        :(savedTokens!==null&&savedTokens<0)||(savedSeconds!==null&&savedSeconds<0)?'negative':'positive';
  const completed=count(coverage?.completedDeliveries);
  const links=sessionLinkMap(data);
  const tasks=Array.isArray(data?.tasks)?data.tasks:[];
  const deliveries=(present&&Array.isArray(raw.deliveries)?raw.deliveries:[])
    .map(delivery=>benefitDelivery(delivery,links,tasks,raw.range))
    .sort((left,right)=>Number(right.included)-Number(left.included));
  const observations=analysisObservations(data);
  const savedObservation=present?str(raw.observation):'';
  const observationItem=observations.items[0]||null;
  const observationSource=savedObservation||str(observationItem?.observation)||'';
  // 只调整已保存报告的展示文案，不改写报告和测算数据。
  const observation=observationSource.replace(/收益据此估算/g,'收益据此测算');
  const tokenDeliveries=num(coverage?.tokenEstimatedDeliveries);
  const timeDeliveries=num(coverage?.timeEstimatedDeliveries);
  const range=present&&isRecord(raw.range)?raw.range:(isRecord(data?.range)?data.range:null);
  const baselineTokens=firstFinite(summary?.baselineCodexTokens);
  const actualTokens=firstFinite(summary?.actualCodexTokens);
  const qoderTokens=firstFinite(summary?.qoderTokens);
  const baselineSeconds=firstFinite(summary?.baselineSeconds);
  const squadSeconds=firstFinite(summary?.squadSeconds);
  return {
    visible:state!=='missing',
    present,
    available:present,
    empty:state==='missing',
    emptyTitle:'暂无法估算',
    emptyText:!present?BENEFIT_EMPTY_TEXT:summary?'暂无法估算':BENEFIT_NO_SUMMARY_TEXT,
    state,
    title:BENEFIT_TITLE,
    metrics:[tokenMetric,timeMetric],
    summaryLine:benefitSummaryLine(tokenDeliveries,timeDeliveries),
    negativeNote:benefitNegativeNote(savedTokens,savedSeconds),
    coverageLabel:completed>0
      ?`覆盖 ${count(coverage?.tokenEstimatedDeliveries)} / ${completed} 次已完成交付`
      :'尚无可比较的已完成交付',
    observation,
    observationLinks:savedObservation?[]:(observationItem?.refs||[]).slice(0,3),
    details:{
      title:BENEFIT_DETAIL_TITLE,
      present,
      emptyText:present?null:BENEFIT_EMPTY_TEXT,
      summaryLabel:'计算口径与覆盖',
      tableEmptyText:'本周期没有可列出的已完成交付。',
      previewLimit:PREVIEW_ROWS,
      canExpand:deliveries.length>PREVIEW_ROWS,
      expandLabel:`展开全部 ${deliveries.length} 项`,
      collapseLabel:`收起至 ${PREVIEW_ROWS} 项`,
      rangeLabel:spanLabel(range),
      generatedLabel:present&&str(raw.generatedAt)?`生成时间 ${utcStamp(raw.generatedAt)}`:'生成时间未上报',
      coverageLabel:completed>0
        ?`已完成交付 ${completed} 个 · Token 可估 ${count(coverage?.tokenEstimatedDeliveries)} 个 · 时间可估 ${count(coverage?.timeEstimatedDeliveries)} 个`
        :'尚无可比较的已完成交付',
      groups:[
        {
          title:'投入对比',
          rows:[
            {key:'baseline',label:'纯 Codex 基线',value:`${baselineTokens===null?UNREPORTED:tokenLabel(baselineTokens)} Token${baselineSeconds===null?'':` · ${timeText(baselineSeconds)}`}`},
            {key:'actual-codex',label:'可比交付的实际 Codex 投入',value:`${actualTokens===null?UNREPORTED:tokenLabel(actualTokens)} Token`},
            {key:'actual-qoder',label:'可比交付的 Qoder 投入',value:`${qoderTokens===null?UNREPORTED:tokenLabel(qoderTokens)} Token`},
            {key:'squad-time',label:'小队等效处理时间（Codex + Qoder）',value:timeText(squadSeconds)},
          ],
        },
        {
          title:'测算结果',
          rows:[
            {key:'token-saving',label:tokenMetric.label,value:tokenMetric.value,percent:tokenMetric.percent,tone:tokenMetric.tone},
            {key:'time-saving',label:timeMetric.label,value:timeMetric.value,percent:timeMetric.percent,tone:timeMetric.tone},
          ],
        },
      ],
      deliveries,
      deliveryTotal:deliveries.length,
      deliveriesOmitted:0,
      countLabel:deliveries.length
        ?`共 ${deliveries.length} 项 · ${deliveries.filter(item=>item.included).length} 项已纳入 · ${deliveries.filter(item=>!item.included).length} 项未计入`
        :'本周期没有可列出的已完成交付。',
      tableNote:'点击行内“依据”打开这项工作专属的依据弹框：基线来源、完整起止时间、实际投入、模型输出速度与排除原因。',
      includedCount:deliveries.filter(item=>item.included).length,
      excludedCount:deliveries.filter(item=>!item.included).length,
      exclusionSummary:benefitExclusionSummary(coverage),
      speeds:benefitSpeeds(raw),
      signedNote:state==='negative'
        ?'负值表示本周期实际投入高于纯 Codex 历史基线；Token 与时间为负时，代表相对基线多用、多投入，而不是节省。'
        :null,
      note:BENEFIT_DETAIL_NOTE,
    },
  };
}

export function reportModel(data,state={},actions={}){
  const status=analysisStatus(data,state);
  const window=reportWindow(data);
  return {
    schemaVersion:1,
    windowDays:window.days,
    meta:reportMeta(data,state),
    highlight:highlight(data,state),
    kpis:kpiCards(data),
    trend:trendSeries(data),
    efficiency:deliveryEfficiency(data),
    sessions:sessionRows(data,{rank:state?.rank||'tokens',currentThreadId:actions?.currentThreadId||''}),
    skills:skillRows(data),
    usage:usageView(data),
    benefits:squadBenefits(data),
    cli:cliView(data),
    observations:analysisObservations(data),
    footer:{
      title:'Codex 小队 · 周期分析报告',
    },
    state:status,
  };
}

/**
 * 统计页只读接口：按选中区间读取已保存统计，并并行读取轻量的运行列表补充 AI 状态。
 * 这里从不发起 POST，也不触发采集或模型调用。
 */
export const ANALYSIS_RUNS_ENDPOINT='./api/analysis/runs';

export function analyticsRequestPath(days){
  return `./api/analytics?days=${days===7||days===30?days:'all'}`;
}

export function mergeAnalyticsSnapshot(saved,runs=null){
  const value=isRecord(saved)?saved:{};
  const analysis=isRecord(value.analysis)?value.analysis:null;
  const current=isRecord(runs?.current)?runs.current:null;
  const days=windowOf(value).days;
  const sameWindow=run=>isRecord(run)&&(Object.hasOwn(run,'days')?run.days:run.window?.days)===days;
  const latest=[current,analysis?.latestRun,...(Array.isArray(runs?.history)?runs.history:[])].find(sameWindow)||null;
  // 只补充当前运行状态；AI 综述与建议一律来自本次已保存快照，避免上一轮内容串入。
  const next=analysis
    ?{...analysis,latestRun:latest}
    :{available:false,statsAvailable:false,latestRun:latest};
  next.otherWindowRunning=current?.status==='running'&&!sameWindow(current);
  if(isRecord(runs?.schedule))next.schedule=runs.schedule;
  return {...value,analysis:next};
}

/**
 * @param {{days?: 7|30|null, request: (url: string, init?: RequestInit) => Promise<Response>, signal?: AbortSignal|null}} [options]
 */
export async function readAnalyticsSnapshot({days=null,request,signal=null}={}){
  if(typeof request!=='function')throw new Error('统计读取入口不可用');
  const options=signal?{cache:'no-store',signal}:{cache:'no-store'};
  // 运行列表缺失时只降级 AI 状态，不影响已保存统计的展示。
  const runsRead=Promise.resolve()
    .then(()=>request(ANALYSIS_RUNS_ENDPOINT,options))
    .then(async response=>{
      if(!response?.ok)return null;
      const value=await response.json();
      return isRecord(value)&&value.schemaVersion===1?value:null;
    })
    .catch(()=>null);
  const savedResponse=await request(analyticsRequestPath(days),options);
  if(!savedResponse?.ok)throw new Error('已保存统计暂时不可用');
  const saved=await savedResponse.json();
  if(!isRecord(saved)||saved.schemaVersion!==1||saved.scope!=='global')throw new Error('统计范围未确认');
  return mergeAnalyticsSnapshot(saved,await runsRead);
}

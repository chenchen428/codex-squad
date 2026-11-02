import pages from './design/pages.json';
import {mountHistory} from './session-history.mjs';
import nextPages from './design/v6/pages.json';
import {boardVisible} from './board-model.mjs';
import type {Snapshot,Task} from './types';
import {number,dialogue,processOf,processSummary,durationLabel,handoffRoleLabel,deliveryLabel,relativeTimeLabel} from './model.mjs';
import {renderMarkdown} from './markdown.mjs';
import {READ_TIMEOUT_MS,startPolling} from './polling.mjs';
import {createPageStyles} from './page-styles.mjs';
import {executionMetricsOf} from './session-activity.mjs';
import {renderShell} from './shell';
import {renderBoard,type BoardState} from './board';
import {renderAnalysis,type AnalysisData,type AnalysisState} from './analysis';
import {readAnalyticsSnapshot} from './analysis-report.mjs';
import {closeAllDialogs,createRuntimeInfoReader,openVersionSheet,renderVersionEntry,type RuntimeInfo,type RuntimeUpdates,type VersionEntryHandle,type VersionSheetHandle} from './runtime-info';
import {renderVerificationStamp} from './verification';

type Page='overview'|'session'|'analysis';
const templates=pages as Record<'overview'|'session'|'usage',{bodyClass:string[];htmlClass:string[];html:string;fonts:string[]}>;
const skins=nextPages as Record<string,{bodyClass:string[];htmlClass:string[];html:string;fonts:string[]}>;
const $=<T extends Element=HTMLElement>(selector:string,root:ParentNode=document)=>root.querySelector<T>(selector)!;
const all=(selector:string,root:ParentNode=document)=>Array.from(root.querySelectorAll<HTMLElement>(selector));
const clock=(value?:string)=>value?new Date(value).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}):'未记录';
function texts(root:Node,mapping:Record<string,string>){
  const keys=Object.keys(mapping).sort((a,b)=>b.length-a.length),pattern=new RegExp(keys.map(k=>k.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|'),'g');
  const walk=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let n:Node|null;
  while((n=walk.nextNode()))if(n.textContent)n.textContent=n.textContent.replace(pattern,k=>mapping[k]);
}
function notice(root:HTMLElement,text:string){const p=document.createElement('p');p.className='data-notice';p.textContent=text;root.prepend(p)}
type Message=ReturnType<typeof dialogue>[number];
function roundNumber(value:unknown){const round=Number(value);return Number.isSafeInteger(round)&&round>0?round:null}
function syncRoundHeader(section:HTMLElement,task:Task){
  const paragraph=Array.from(section.querySelectorAll('p')).find(node=>node.textContent?.includes('任务说明：'));
  if(!paragraph)return;
  const latest=Array.isArray(task.attempts)?task.attempts.at(-1):undefined;
  const round=roundNumber(task.currentRound)??roundNumber(latest?.index);
  const goal=String(task.currentGoal||latest?.handoff?.goal||'').trim()||'未记录当前目标。';
  const label=document.createElement('span');label.className='font-medium text-ink';
  label.textContent=round?`第${round}轮 · 当前目标：`:'当前目标：';
  paragraph.replaceChildren(label,document.createTextNode(goal));
  paragraph.title=goal;paragraph.dataset.currentRound=round?String(round):'';
}
function syncMessageHeading(row:HTMLElement,message:Message,name:string){
  const heading=row.firstElementChild!;
  const handoff=message.kind==='handoff'?message.handoff:null;
  heading.children[0].textContent=handoff?handoffRoleLabel(handoff):message.role==='user'?'主会话':name;
  heading.children[1].textContent=clock(message.time);
  if(!handoff){row.removeAttribute('data-handoff');heading.querySelector('.handoff-delivery')?.remove();return}
  row.dataset.handoff=handoff.kind||'initial';
  let badge=heading.querySelector<HTMLElement>('.handoff-delivery');
  if(!badge){badge=document.createElement('span');badge.className='handoff-delivery';heading.append(badge)}
  const delivery=handoff.delivery;
  badge.dataset.delivery=delivery?.state||'pending';
  badge.textContent=deliveryLabel(delivery);
  badge.title=delivery?.state==='received'&&delivery.respondedAt?`已收到公开回复：${clock(delivery.respondedAt)}`:
    delivery?.state==='sent'&&delivery.submittedAt?`已提交至原生会话，尚未收到公开回复：${clock(delivery.submittedAt)}`:
      deliveryLabel(delivery);
}
type ExecutionMetrics=ReturnType<typeof executionMetricsOf>;
type ExecutionStatus=ExecutionMetrics['status'];
const STATUS_ICONS:Record<string,string>={
  loader:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9" stroke-dasharray="3 4"/></svg>',
  check:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m8.3 12.2 2.4 2.4 5-5"/></svg>',
  clock:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 2"/></svg>',
  stop:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><rect x="9" y="9" width="6" height="6" rx="1"/></svg>',
  error:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="m9.2 9.2 5.6 5.6M14.8 9.2l-5.6 5.6"/></svg>',
  dot:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/></svg>'
};
function syncStatusBadge(el:HTMLElement,status:ExecutionStatus){
  el.dataset.tone=status.tone;
  if(el.textContent!==status.label)el.textContent=status.label;
}
function syncActivityIcon(icon:HTMLElement,status:ExecutionStatus){
  const signature=`${status.tone}:${status.icon}:${status.active}`;
  if(icon.dataset.signature===signature)return;
  icon.dataset.signature=signature;icon.dataset.tone=status.tone;icon.innerHTML=STATUS_ICONS[status.icon]||STATUS_ICONS.dot;
}
const SPEED_HINT='平均输出 = 已报输出 Token ÷ 各次执行的实际耗时（秒），仅表示墙钟平均，不是模型实时生成速度；任一次未上报用量或时长不完整时不计算。';
const DURATION_HINT='累计耗时按每次执行的实际起止累计；执行中的一次计入当前已运行时间。';
const CURRENT_DURATION_HINT='本轮耗时只计当前轮次的实际起止；累计耗时包含此前所有轮次。';
const LOAD_ERROR='页面资源加载失败，请重新加载';
type BoardCountSource={tasks?:unknown;task?:unknown;boardTaskCount?:unknown}|null|undefined;
/**
 * 顶部看板任务数只有一份事实：全量看板快照按 boardVisible 统计；单任务快照只能
 * 转交服务端声明的 boardTaskCount，不能用自己的任务子集覆写上一条全量计数。
 * 两者都没有时返回 null，由壳显示未知态而不是猜测数字。
 */
export function resolveBoardTaskCount(previous:number|null,snapshot:BoardCountSource):number|null{
  if(!snapshot)return previous;
  const declared=snapshot.boardTaskCount;
  if(typeof declared==='number'&&Number.isSafeInteger(declared)&&declared>=0)return declared;
  if(Array.isArray(snapshot.tasks)&&snapshot.task===undefined)return snapshot.tasks.filter(task=>boardVisible(task as Task)).length;
  return previous;
}
function durationText(metrics:ExecutionMetrics){
  const milliseconds=metrics.duration.milliseconds;
  if(milliseconds==null)return '未记录';
  return `${metrics.state==='disconnected'?'上次确认':metrics.duration.running?'执行中':'累计执行'} ${durationLabel(milliseconds)}`;
}
function currentDurationText(metrics:ExecutionMetrics){
  const milliseconds=metrics.current.milliseconds;
  if(milliseconds==null)return '未记录';
  const prefix=metrics.state==='disconnected'?'上次确认':metrics.current.running?'执行中':'';
  return prefix?`${prefix} ${durationLabel(milliseconds)}`:durationLabel(milliseconds);
}
function tokenText(tokens:ExecutionMetrics['tokens']){return tokens.totalTokens==null?'未上报':number(tokens.totalTokens)}
function tokenHint(tokens:ExecutionMetrics['tokens']){
  if(!tokens.count)return '暂无执行尝试；未上报 Token 不做估算。';
  return `已上报 ${tokens.reported}/${tokens.count} 次执行；仅累计真实上报的 Token，缓存不重复累计。`;
}
function speedText(speed:ExecutionMetrics['speed']){
  if(!speed)return '未上报';
  return `${speed.tokensPerSecond.toFixed(1)} Token/s`;
}
function syncExecutionMetrics(node:HTMLElement,metrics:ExecutionMetrics,root:ParentNode=document){
  node.dataset.state=metrics.state;node.dataset.tone=metrics.status.tone;
  const icon=$<HTMLElement>('[data-activity-icon]',node);if(icon)syncActivityIcon(icon,metrics.status);
  const status=$<HTMLElement>('[data-activity-status]',node);if(status)syncStatusBadge(status,metrics.status);
  const command=$<HTMLElement>('[data-activity-command]',node);
  const detail=metrics.running?metrics.command:metrics.note||'';
  if(command){if(command.textContent!==detail){command.textContent=detail;command.title=detail}command.hidden=!detail}
  const duration=$<HTMLElement>('[data-activity-duration]',node);if(duration)duration.textContent=durationText(metrics);
  const current=$<HTMLElement>('[data-activity-current-duration]',node);if(current)current.textContent=currentDurationText(metrics);
  const tokens=$<HTMLElement>('[data-activity-tokens]',node);if(tokens)tokens.textContent=tokenText(metrics.tokens);
  const speed=$<HTMLElement>('[data-activity-speed]',node);if(speed)speed.textContent=speedText(metrics.speed);
  const badge=$<HTMLElement>('[data-task-status]',root);if(badge)syncStatusBadge(badge,metrics.status);
}
function executionFooter(task:Task,metrics:ExecutionMetrics,executor:string){
  const footer=document.createElement('div');footer.className='session-activity';footer.dataset.taskActivity=task.id;footer.dataset.state=metrics.state;footer.dataset.tone=metrics.status.tone;
  const current=document.createElement('div');current.className='session-activity-current';current.setAttribute('role','status');current.setAttribute('aria-live','polite');current.setAttribute('aria-atomic','true');
  const icon=document.createElement('span');icon.className='session-activity-icon';icon.dataset.activityIcon='';icon.setAttribute('aria-hidden','true');icon.innerHTML=STATUS_ICONS[metrics.status.icon]||STATUS_ICONS.dot;
  icon.dataset.tone=metrics.status.tone;icon.dataset.signature=`${metrics.status.tone}:${metrics.status.icon}:${metrics.status.active}`;
  const status=document.createElement('span');status.className='session-activity-status';status.dataset.activityStatus='';status.dataset.tone=metrics.status.tone;status.textContent=metrics.status.label;
  const detail=metrics.running?metrics.command:metrics.note||'';
  const command=document.createElement('span');command.className='session-activity-command';command.dataset.activityCommand='';command.textContent=detail;command.title=detail;command.hidden=!detail;
  current.append(icon,status,command);
  const metricsRow=document.createElement('dl');metricsRow.className='session-activity-metrics';
  const metric=(label:string,value:string,hint='',attribute?:string)=>{
    const item=document.createElement('div');item.className='session-activity-metric';if(hint)item.title=hint;
    const term=document.createElement('dt');term.textContent=label;
    const detail=document.createElement('dd');detail.textContent=value;if(attribute)detail.setAttribute(attribute,'');
    item.append(term,detail);return item;
  };
  metricsRow.append(
    metric('执行人',executor),
    metric('本轮耗时',currentDurationText(metrics),CURRENT_DURATION_HINT,'data-activity-current-duration'),
    metric('累计耗时',durationText(metrics),DURATION_HINT,'data-activity-duration'),
    metric('已报 Token',tokenText(metrics.tokens),tokenHint(metrics.tokens),'data-activity-tokens'),
    metric('平均输出',speedText(metrics.speed),SPEED_HINT,'data-activity-speed'),
  );
  footer.append(current,metricsRow);
  return footer;
}

function appendTaskNotices(area:HTMLElement,task:Task){
  if(task.attempts.at(-1)?.error)notice(area,task.attempts.at(-1)?.diagnostic?.message||task.attempts.at(-1)!.error!);
  // 核验、停止与任务处置不再在会话正文追加摘要；右上角状态与最新结论弹层承载核验事实。
  const hasRecords=Boolean(task.acceptance||task.verification||task.attempts.some(attempt=>attempt.acceptance||attempt.verification));
  if(!hasRecords&&['done','accepted'].includes(String(task.status||'').toLowerCase())){
    notice(area,'该任务只有历史状态，没有可核对的验收记录，未按已完成展示。');
  }
}

export function mount({fixture=false,initial=null as Snapshot|null,poll=true,initialAnalytics=null as AnalysisData|null}={}){
  let data=initial,disconnected=false,page:Page='overview',taskId:string|null=null,lastRender='';
  let boardCount=initial?resolveBoardTaskCount(null,initial):null;
  let analysisData=initialAnalytics,analysisStale=false,analysisPolling:ReturnType<typeof startPolling>|null=null,analysisKey='';
  const analysisState:AnalysisState={days:7,capability:'skills',rank:'tokens'};
  const boardState:BoardState={query:''};
  let cssPage='',preparingStyle='',styleError='',closed=false,refreshing=false;
  const pageStyles=createPageStyles(document);
  const historyStart=new Map<string,number>();
  let historyController:ReturnType<typeof mountHistory>|null=null,taskResponse:any=null;
  let polling:ReturnType<typeof startPolling>|null=null;
  let routeEpoch=0,loadedView='';
  const reading=new Map<string,{top:number;opened:Set<string>;anchor?:string;offset:number;follow:boolean}>();
  let sessionTracking:{area:HTMLElement;follow:boolean;observer:ResizeObserver}|null=null;
  const host=$<HTMLElement>('#root');
  const shell=fixture?null:renderShell(host,shellOptions());
  const root=shell?.content||host;
  let runtimeInfo:RuntimeInfo|null=null;
  let versionEntry:VersionEntryHandle|null=null;
  let versionSheet:VersionSheetHandle|null=null;
  let runtimeReader:ReturnType<typeof createRuntimeInfoReader>|null=null;
  if(!fixture){
    versionEntry=renderVersionEntry({onOpen:showVersionSheet});
    const actions=host.querySelector<HTMLElement>('.squad-nav-actions');
    if(actions)actions.insertBefore(versionEntry.element,actions.firstChild);
    runtimeReader=createRuntimeInfoReader({
      onUpdate:syncRuntimeInfo,
    });
    void runtimeReader.start();
  }
  function syncRuntimeInfo(next:RuntimeInfo){
    runtimeInfo=next;
    versionEntry?.update((next.updates||null) as RuntimeUpdates|null);
    if(versionSheet)versionSheet.update(next);
  }
  function touchRuntime(maxAgeMs=30000){
    void runtimeReader?.readIfStale(maxAgeMs);
  }
  function showVersionSheet(){
    versionSheet=openVersionSheet(runtimeInfo,{onClose:()=>{versionSheet=null}});
    touchRuntime(1000);
  }
  function syncBoardCount(snapshot:BoardCountSource){boardCount=resolveBoardTaskCount(boardCount,snapshot)}
  function shellOptions(){return {
    page,title:data?.binding.title||'当前会话',days:analysisState.days,
    taskCount:boardCount,
    connected:page==='analysis'?!analysisStale:Boolean(data?.connected&&!disconnected),observedAt:(page==='analysis'?analysisData?.observedAt:data?.observedAt)||'',
    taskTitle:data?.tasks.find(t=>t.id===taskId)?.title,taskIndex:(data as any)?.taskIndex||(data?data.tasks.findIndex(t=>t.id===taskId)+1:undefined),
    onPage:(next:'overview'|'analysis')=>navigate(next),
    onDays:selectDays,onRefresh:()=>void refreshView(),
    onRetry:()=>{styleError='';preparingStyle='';void refreshView();render(true)}
  }}
  async function refreshView(){
    refreshing=true;shell?.setPending('正在刷新…');
    touchRuntime(10000);
    if(page==='analysis'){await analysisPolling?.refresh()}else await polling?.refresh();
    refreshing=false;if(!closed){shell?.update(shellOptions());shell?.setPending(styleError?LOAD_ERROR:null,Boolean(styleError))}
  }
  function attachSharedShell(){
    if(!shell)return;
    shell.update(shellOptions());
    if(page==='overview'){
      const header=$<HTMLElement>('header',root),toolbar=header?.lastElementChild;
      if(toolbar){toolbar.className='squad-board-toolbar';header.replaceWith(toolbar)}
    }else if(page==='analysis'){
      const main=$<HTMLElement>('main',root);if(main.dataset.shellAdapted)return;main.dataset.shellAdapted='true';
      main.classList.add('squad-periodic-report');
    }else $('main > header',root)?.remove();
  }
  function updateTaskMetrics(){
    if(page==='overview'){
      const now=Date.now();
      for(const node of all('[data-verified-at]',root)){
        const label=relativeTimeLabel(node.dataset.verifiedAt||'',now);
        const text=label?`核验于 ${label}`:'';
        if(node.textContent!==text)node.textContent=text;
      }
      return;
    }
    if(page!=='session'||!data)return;
    const node=$<HTMLElement>('[data-task-activity]',root);if(!node)return;
    const task=data.tasks.find(task=>task.id===node.dataset.taskActivity);if(!task)return;
    const name=data.members.find(member=>member.id===task.memberId)?.executor==='qoder'?'Qoder':'Codex';
    const metrics=executionMetricsOf(task,{connected:!disconnected&&data.connected,now:Date.now(),observedAt:data.observedAt,executor:name});
    syncExecutionMetrics(node,metrics,root);
    $<HTMLElement>('#session-scroll-area',root)?.setAttribute('aria-busy',String(metrics.state==='running'));
  }
  function route(){
    const [name,id]=location.hash.slice(1).split('/');page=['usage','analysis','analytics'].includes(name)?'analysis':name==='session'?'session':'overview';
    if(page==='session'&&id)taskId=decodeURIComponent(id);
    routeEpoch++;taskResponse=null;historyController?.close();historyController=null;
    styleError='';closeAllDialogs();syncAnalysis();
    render(true);restartPolling();
  }
  function selectDays(days:7|30|null){
    if(analysisState.days===days)return;
    analysisState.days=days;
    if(page!=='analysis'){render(true);return}
    // 只读切换：清空旧区间快照，避免上一轮的 AI 建议混入新统计。
    analysisData=null;analysisStale=false;
    syncAnalysis(true);render(true);
  }
  function syncAnalysis(force=false){
    if(page!=='analysis'||!poll||fixture){analysisPolling?.close();analysisPolling=null;analysisKey='';return}
    const days=analysisState.days,key=`reports:${days===null?'all':days}`;
    if(!force&&analysisKey===key)return;
    analysisPolling?.close();analysisKey=key;analysisStale=false;
    analysisPolling=startPolling({interval:3000,read:async(signal:AbortSignal)=>{
      const budget=AbortSignal.any([signal,AbortSignal.timeout(READ_TIMEOUT_MS)]);
      // 统计快照与运行列表并行读取；两次都是轻量 GET，不启动统计或模型。
      return readAnalyticsSnapshot({days,request:(url:string,init:RequestInit={})=>fetch(url,{...init,signal:budget}),signal:budget});
    },onData(next:AnalysisData){if(analysisKey!==key)return;analysisData=next;analysisStale=false;render();touchRuntime()},onError(){if(analysisKey!==key)return;analysisStale=true;render()}});
  }
  function skinName(){return page==='session'?'session':page==='overview'?'board':'analytics-global'}
  function pendingView(message:string|null,failed=false){
    if(shell){shell.update(shellOptions());shell.setPending(message,failed);return}
    let status=document.querySelector<HTMLElement>('#page-transition');
    if(message===null){status?.remove();return}
    if(!status){status=document.createElement('div');status.id='page-transition';status.className='page-transition';status.setAttribute('role','status');status.setAttribute('aria-live','polite');document.body.append(status)}
    status.replaceChildren();const text=document.createElement('span');text.textContent=message;status.append(text);
    if(failed){const retry=document.createElement('button');retry.textContent='重新加载';retry.onclick=()=>{styleError='';preparingStyle='';void analysisPolling?.refresh();render(true)};status.append(retry)}
    if(!root.childElementCount){root.innerHTML='<main class="page-boot"><p>正在打开小队…</p></main>';root.setAttribute('aria-busy','true')}
  }
  function stalePlaceholder(message:string){
    if(root.querySelector('[data-stale-page]'))return;
    const view=document.createElement('div');view.className='squad-stale-page';view.dataset.stalePage='';
    const label=document.createElement('p');label.textContent=message;
    view.append(label);root.replaceChildren(view);root.setAttribute('aria-busy','false');
  }
  function applyStyles(commit=false){
    const name=skinName(),skin=page==='session'?templates.session:skins[name];
    if(cssPage===name)return true;
    if(!pageStyles.isReady(name)){
      pendingView(styleError?LOAD_ERROR:'正在准备页面…',Boolean(styleError));
      if(!styleError&&preparingStyle!==name){
        preparingStyle=name;
        const families=page==='session'?['Noto Serif SC','Plus Jakarta Sans','Space Grotesk','Space Mono']:name==='board'?['Noto Sans SC','Space Grotesk','Space Mono']:['Newsreader','Space Grotesk','Space Mono'];
        const text=[...new Set((data?.tasks.map(t=>t.title+' '+(t.currentGoal||t.attempts[0]?.handoff?.goal||'')).join(' ')||'')+'Codex 小队任务分析返回当前会话整体执行过程正在启动')].join('');
        void pageStyles.prepare({key:name,fontFiles:page==='analysis'?['v8/assets/b710bd4898388f83fecd.css','v8/assets/85b88de6c127390064ec.css','9c0ee3ac4db172bcba01.css']:[...new Set([...skin.fonts,...skins.board.fonts])],cssFile:page==='analysis'?'v8/analytics.css':page==='session'?'session.css':`v6/${name}.css`,fontFaces:[...families.flatMap(family=>[400,600,700].map(weight=>`${weight} 14px "${family}"`)),...(page==='overview'?[]:['400 16px "Material Symbols Outlined"'])],text})
          .then(()=>{if(!closed&&skinName()===name){preparingStyle='';render(true)}})
          .catch((e:Error)=>{if(!closed&&skinName()===name){preparingStyle='';styleError=e.message;pendingView(LOAD_ERROR,true)}});
      }
      return false;
    }
    if(!commit)return true;
    pageStyles.activate(name);
    document.body.className=[...(fixture?skin.bodyClass:['squad-app','live']),...(page==='session'?['session-page-body']:page==='overview'?['board-page']:['analysis-page'])].join(' ');document.documentElement.className=skin.htmlClass.join(' ');cssPage=name;
    return true;
  }
  function navigate(next:Page,id?:string){location.hash=next==='session'?`session/${encodeURIComponent(id||taskId||data?.tasks[0]?.id||'')}`:next}
  function render(force=false){
    if(poll&&!fixture&&loadedView!==`${page}:${taskId||''}`){pendingView('正在读取页面…');return}
    if(!fixture&&!data){pendingView(styleError?LOAD_ERROR:(disconnected?null:'正在读取当前会话的小队…'),Boolean(styleError));return}
    const stylesReady=applyStyles();
    if(page==='analysis'&&!fixture&&!analysisData){
      if(analysisStale&&!styleError){stalePlaceholder('正在等待分析记录恢复…');pendingView(null);return}
      pendingView(styleError?LOAD_ERROR:'正在读取分析记录…',Boolean(styleError));return
    }
    if(!stylesReady)return;
    document.querySelector('#page-transition')?.remove();if(!refreshing)shell?.setPending(null);root.removeAttribute('aria-busy');
    const selected=data?.tasks.find(t=>t.id===taskId);
    const signature=fixture?page:JSON.stringify([page,taskId,page==='session'?[
      selected?.status,selected?.title,selected?.currentRound,selected?.currentGoal,selected?.attempts[0]?.handoff?.goal,selected?.attempts.at(-1)?.error,
      selected?.acceptance?.note,selected?.acceptance?.at,selected?.acceptance?.changedSinceVerification,
      selected?.verification?.at,selected?.retirement?.outcome,selected?.retirement?.reason,selected?.retirement?.replacedBy,selected?.retirement?.at,
      selected?.stop?.state,selected?.stop?.terminal,selected?.stop?.reason,selected?.stop?.requestedAt,
      selected?.attempts.map(attempt=>[attempt.id,attempt.status,attempt.acceptance?.note,attempt.acceptance?.at,attempt.acceptance?.changedSinceVerification,attempt.verification?.at,attempt.verification?.index]),
    ]:page==='analysis'?null:data?.cursor,page==='session'?false:disconnected,page==='analysis'?analysisData:null,analysisStale,analysisState]);
    if(!force&&signature===lastRender){if(taskResponse)historyController?.apply(taskResponse);attachSharedShell();updateTaskMetrics();return}lastRender=signature;
    historyController?.close();historyController=null;
    const oldScroll=$<HTMLElement>('#session-scroll-area',root),scrollTop=oldScroll?.scrollTop||0;
    const opened=new Set(all('details[open][data-key]',root).map(x=>x.dataset.key!));
    if(oldScroll?.dataset.task){const bounds=oldScroll.getBoundingClientRect();const anchor=all('[data-message]',oldScroll).find(x=>x.getBoundingClientRect().bottom>bounds.top);reading.set(oldScroll.dataset.task,{top:scrollTop,opened,follow:sessionTracking?.area===oldScroll?sessionTracking.follow:oldScroll.scrollHeight-oldScroll.scrollTop-oldScroll.clientHeight<48,anchor:anchor?.dataset.message,offset:anchor?anchor.getBoundingClientRect().top-bounds.top:0})}
    sessionTracking?.observer.disconnect();sessionTracking=null;
    const focused=(document.activeElement as HTMLElement)?.dataset.key;
    applyStyles(true);
    if(page==='overview'){
      if(fixture)root.innerHTML=skins.board.html;
      else if(data)renderBoard(root,data,boardState,{onTask:id=>navigate('session',id),onAnalysis:()=>navigate('analysis'),onRefresh:()=>void polling?.refresh(),stale:disconnected});
      if(focused)all('[data-key]',root).find(x=>x.dataset.key===focused)?.focus({preventScroll:true});
      attachSharedShell();updateTaskMetrics();return;
    }
    if(page==='analysis'){
      const y=window.scrollY;
      if(fixture)root.innerHTML=skins['analytics-global'].html;
      else if(analysisData){
        renderAnalysis(root,analysisData,analysisState,{
          currentThreadId:data!.binding.threadId,
          onDays:selectDays,
          onCapability(tab){analysisState.capability=tab;render(true)},onRank(rank){analysisState.rank=rank;render(true)},
          onTask:id=>navigate('session',id),onBoard:()=>navigate('overview'),onRefresh(){void analysisPolling?.refresh()},
        });
      }
      all('details',root).forEach((el,index)=>{el.dataset.key=el.dataset.key||`analysis:fold:${index}`;if(opened.has(el.dataset.key))el.setAttribute('open','')});
      if(focused)all('[data-key]',root).find(x=>x.dataset.key===focused)?.focus({preventScroll:true});
      attachSharedShell();
      window.scrollTo({top:y});return;
    }
    root.innerHTML=templates.session.html;
    const main=$<HTMLElement>('main',root);main.querySelector('#usage')?.removeAttribute('id');if(page==='session')main.classList.add('session-page');
    if(!fixture&&data){
      texts(main,{'只读演示':'只读','（只读演示）':'（只读）'});
      const selected=taskId?data.tasks.find(t=>t.id===taskId):data.tasks[0];
      if(page==='session'&&selected)renderSession(main,selected);else if(page==='session'){const section=$('section',main),heading=$('h1',section);heading.textContent=taskId?'该子任务不可用':'当前会话尚无子任务';section.replaceChildren(heading);$('#session-scroll-area',main).replaceChildren();notice($('#session-scroll-area',main),'请返回小队核对任务身份。');}
      // The export has a three-page preview switch. Product navigation has only squad/usage.
      all('nav a[href="#session"],footer a[href="#session"]',main).forEach(x=>{const separator=x.nextElementSibling;if(separator?.textContent==='|')separator.remove();x.remove()});
      texts(main,{'返回任务总览':'返回小队任务看板','用量说明':'分析','任务总览':'小队任务看板'});
    }
    all('a[href^="#"]',main).forEach(link=>link.addEventListener('click',event=>{const next=link.getAttribute('href')!.slice(1).split('/')[0];if(['overview','session','usage'].includes(next)){event.preventDefault();navigate(next==='usage'?'analysis':next as Page,link.dataset.task)}}));
    all('details',main).forEach((el,index)=>{el.dataset.key=el.dataset.key||`${taskId||'fixture'}:fold:${index}`;if(opened.has(el.dataset.key))el.setAttribute('open','')});
    attachSharedShell();
    if(page==='session'){
      const area=$<HTMLElement>('#session-scroll-area',main),saved=reading.get(area?.dataset.task||'');
      if(saved){all('details[data-key]',area).forEach(x=>{if(saved.opened.has(x.dataset.key!))x.setAttribute('open','')});area.scrollTop=saved.top;const anchor=all('[data-message]',area).find(x=>x.dataset.message===saved.anchor);if(saved.follow)area.scrollTop=area.scrollHeight;else if(anchor)area.scrollTop+=anchor.getBoundingClientRect().top-area.getBoundingClientRect().top-saved.offset}
      else area.scrollTop=area.scrollHeight;
      watchConversation(area,saved?.follow??true);
    }
    if(focused)all('[data-key]',main).find(x=>x.dataset.key===focused)?.focus({preventScroll:true});
    updateTaskMetrics();
  }
  function watchConversation(area:HTMLElement,follow:boolean){
    const button=area.parentElement?.querySelector<HTMLButtonElement>('button');
    const track={area,follow,observer:new ResizeObserver(()=>{if(track.follow)area.scrollTop=area.scrollHeight})};sessionTracking=track;
    track.observer.observe(area);for(const row of Array.from(area.children))track.observer.observe(row);
    const state=()=>{if(button){button.setAttribute('aria-pressed',String(track.follow));button.dataset.following=String(track.follow)}};
    const pause=()=>{track.follow=false;state()};
    area.tabIndex=0;area.setAttribute('role','region');area.setAttribute('aria-label','公开对话');
    area.addEventListener('wheel',event=>{if(event.deltaY<0)pause()},{passive:true});
    area.addEventListener('pointerdown',event=>{if((event.target as Element).closest('summary'))pause()});
    area.addEventListener('keydown',event=>{if(['PageUp','Home','ArrowUp'].includes(event.key))pause()});
    area.addEventListener('scroll',()=>{
      track.follow=area.scrollHeight-area.scrollTop-area.clientHeight<48;state();
      if(historyController)return;
      const id=area.dataset.task!,start=historyStart.get(id)||0;
      if(!track.follow&&area.scrollTop<24&&start>0){historyStart.set(id,Math.max(0,start-20));render(true)}
    },{passive:true});
    button?.addEventListener('click',()=>{track.follow=true;state();if(historyController)void historyController.latest();area.scrollTop=area.scrollHeight});state();
  }
  function renderSession(main:HTMLElement,task:Task){
    const s=data!,section=$('section',main),member=s.members.find(m=>m.id===task.memberId),name=member?.executor==='qoder'?'Qoder':'Codex';
    const metrics=executionMetricsOf(task,{connected:!disconnected&&s.connected,now:Date.now(),observedAt:s.observedAt,executor:name});
    // The template's top executor/usage card is replaced by the persistent footer metrics.
    Array.from(section.children).find(child=>child.tagName==='DIV'&&Array.from(child.querySelectorAll('span')).some(span=>span.textContent?.trim()==='执行人：'))?.remove();
    texts(section,{'修复报表筛选异常':s.binding.title,'子任务 2':`子任务 ${(s as any).taskIndex||s.tasks.indexOf(task)+1}`,'保留报错前的输入':task.title});
    syncRoundHeader(section,task);
    const statusBadge=$('h1',section).parentElement!.lastElementChild as HTMLElement;
    statusBadge.className='task-status-badge';statusBadge.dataset.taskStatus='';syncStatusBadge(statusBadge,metrics.status);
    renderVerificationStamp(section,task);
    const area=$<HTMLElement>('#session-scroll-area',main);area.dataset.task=task.id;
    const replyTemplate=Array.from(area.children).find(el=>el.tagName==='DIV'&&el.querySelector('.text-ink'))!.cloneNode(true) as HTMLElement;
    const processTemplate=replyTemplate.querySelector('details')?.cloneNode(true) as HTMLDetailsElement|undefined;
    const messages=taskResponse?[]:dialogue(task);area.replaceChildren();
    const addMessage=(message:Message)=>{
      const row=replyTemplate.cloneNode(true) as HTMLElement;row.dataset.message=message.id;row.dataset.key=`message:${message.id}`;all('details',row).forEach(x=>x.remove());
      syncMessageHeading(row,message,name);
      const body=row.lastElementChild as HTMLElement;
      body.classList.add('message-markdown');
      if(!taskResponse)body.innerHTML=renderMarkdown(message.text);
      return row;
    };
    if(taskResponse){
      historyController=mountHistory({area,taskId:task.id,createRow:addMessage,read:readTask,processTemplate,footer:executionFooter(task,metrics,name),onHeight:()=>{if(sessionTracking?.follow)area.scrollTop=area.scrollHeight},updateRow:(row:HTMLElement,item:Message)=>syncMessageHeading(row,item,name)});
      historyController.apply(taskResponse);
      appendTaskNotices(area,task);
      const footerNode=area.querySelector<HTMLElement>('.session-activity');
      if(footerNode)for(const node of Array.from(area.querySelectorAll<HTMLElement>('.data-notice')))area.insertBefore(node,footerNode);
      area.setAttribute('aria-busy',String(metrics.state==='running'));return;
    }
    if(!historyStart.has(task.id))historyStart.set(task.id,Math.max(0,messages.length-20));
    const cutoff=Math.min(historyStart.get(task.id)!,messages.length);
    if(cutoff){const earlier=document.createElement('p');earlier.className='text-xs text-ink-faint';earlier.dataset.historyRemaining=String(cutoff);earlier.textContent='向上滚动加载较早消息';area.append(earlier)}
    area.append(...messages.slice(cutoff).map(addMessage));if(!messages.length)notice(area,'本子任务暂无公开回复。');
    const processes=processOf(task);
    if(processes.length&&processTemplate){
      processTemplate.removeAttribute('open');processTemplate.dataset.key=`${task.id}:process`;
      const summary=processTemplate.querySelector('summary')!;summary.textContent=`执行过程 · ${processes.length} 项`;
      const content=document.createElement('div');content.className='process-list';
      for(const item of processes){
        const line=processSummary(item),entry=document.createElement('p');entry.className='process-line';entry.dataset.state=line.state;
        const command=document.createElement('span');command.className='process-command';command.textContent=line.action;
        const state=document.createElement('span');state.className='process-state';state.textContent=line.status;
        entry.append(command);if(line.status)entry.append(state);content.append(entry);
      }
      processTemplate.replaceChildren(summary,content);area.append(processTemplate);
    }
    appendTaskNotices(area,task);
    area.setAttribute('aria-busy',String(metrics.state==='running'));
    area.append(executionFooter(task,metrics,name));
  }
  async function readTask(params:Record<string,string>){
    const epoch=routeEpoch;
    const response=await fetch('./api/task?'+new URLSearchParams(params),{signal:AbortSignal.timeout(READ_TIMEOUT_MS),cache:'no-store'});
    if(!response.ok)throw Error('任务记录暂时不可用');const next=await response.json();
    if(closed||epoch!==routeEpoch||next.taskId&&next.taskId!==taskId)throw Error('读取已过期');
    return next;
  }
  function restartPolling(){
    polling?.close();polling=null;if(!poll||fixture||closed)return;
    const epoch=routeEpoch,view=page,id=taskId;
    if(view==='analysis'){
      loadedView=`${page}:${taskId||''}`;
      if(data)render();
      // 分析页的计数只能来自全量看板快照；会话快照只含单个任务，不能留在快照位。
      void fetch('./api/board',{signal:AbortSignal.timeout(READ_TIMEOUT_MS),cache:'no-store'}).then(response=>{if(!response.ok)throw Error('会话暂时不可用');return response.json()}).then(next=>{if(epoch!==routeEpoch||closed)return;data=next;syncBoardCount(next);disconnected=next.connected===false;render()}).catch(()=>{if(epoch===routeEpoch){disconnected=true;render()}});
      return;
    }
    polling=startPolling({read:async(signal:AbortSignal)=>{
      const query=view==='session'&&id?'./api/task?'+new URLSearchParams({id,...historyController?.params()}):'./api/board';
      const response=await fetch(query,{signal:AbortSignal.any([signal,AbortSignal.timeout(READ_TIMEOUT_MS)]),cache:'no-store'});
      if(!response.ok)throw Error('无法读取小队记录');const next=await response.json();
      if(next.schemaVersion!==1)throw Error('快照未确认');return next;
    },onData(next:any){
      if(epoch!==routeEpoch)return;
      if(view==='session'&&id){if(next.task?.id!==id)return;taskResponse=next;data={...next,tasks:[next.task]};}
      else data=next;
      syncBoardCount(next);
      loadedView=`${page}:${taskId||''}`;disconnected=next.connected===false;render();touchRuntime();
    },onError(){if(epoch===routeEpoch){disconnected=true;updateTaskMetrics();shell?.update(shellOptions())}}});
  }
  window.addEventListener('hashchange',route);route();
  const metricsTimer=!fixture?setInterval(updateTaskMetrics,1000):undefined;
  const refresh=()=>{if(document.visibilityState==='visible'){touchRuntime(10000);if(page==='analysis')void analysisPolling?.refresh();else void polling?.refresh()}};
  window.addEventListener('visibilitychange',refresh);
  return {update(next:Snapshot){data=next;syncBoardCount(next);disconnected=next.connected===false;render()},updateAnalytics(next:AnalysisData){analysisData=next;analysisStale=false;render()},disconnect(_message='无法读取小队记录'){disconnected=true;render()},close(){closed=true;runtimeReader?.close();versionSheet=null;closeAllDialogs();shell?.dispose();pageStyles.close();document.querySelector('#page-transition')?.remove();polling?.close();historyController?.close();analysisPolling?.close();sessionTracking?.observer.disconnect();clearInterval(metricsTimer);window.removeEventListener('hashchange',route);window.removeEventListener('visibilitychange',refresh)}};
}

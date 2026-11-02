import type {Snapshot,Task} from './types';
import pages from './design/v6/pages.json';
import {relativeTimeLabel} from './model.mjs';
import {BOARD_LANES,boardVisible,filterCards,groupCards,normalizeQuery,taskCard,tokenLabel} from './board-model.mjs';
import {durationChip} from './board-duration.mjs';

export type BoardState={query:string;scrollTopByLane?:Record<string,number>};
export type BoardActions={onTask:(id:string)=>void;onAnalysis:()=>void;onRefresh:()=>void;stale?:boolean};

type Card={task:Task;index:number;lane:string;history:boolean;number:string;status:string;statusText:string;progress:string;resultSummary:string;verifiedAt:string|null;live:boolean;active:boolean;search:string};
type Member=Snapshot['members'][number];
type LaneTemplate={base:HTMLElement;failed:HTMLElement;unknown:HTMLElement};
type LaneView={section:HTMLElement;list:HTMLElement;template:LaneTemplate;empty:HTMLElement;counts:HTMLElement[];dot:HTMLElement;quickDot?:HTMLElement;all:number};

const template=(pages as {board:{html:string}}).board.html;
const templateLanes=['col-pending','col-running','col-review','col-attention','col-completed'];
const laneNames:Record<string,string>={ 'col-running':'处理中','col-review':'核验中','col-completed':'已完成' };
const laneHints:Record<string,string>={ 'col-running':'活跃进程','col-review':'等待核验','col-completed':'已完成核验' };

function must<T extends Element>(root:ParentNode,selector:string):T{
  const value=root.querySelector<T>(selector);
  if(!value)throw new Error(`看板模板缺少 ${selector}`);
  return value;
}
function setLabel(element:HTMLElement,text:string){
  for(const node of Array.from(element.childNodes))if(node.nodeType===3)node.remove();
  element.append(element.ownerDocument.createTextNode(text));
}
function clockOf(value:string|undefined):string{
  const date=new Date(value||'');
  return Number.isFinite(date.getTime())?date.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit'}):'未记录';
}
function templateFor(card:Card,templates:LaneTemplate):HTMLElement{
  if(card.lane!=='col-running')return templates.base;
  if(card.status==='failed'||card.status==='blocked')return templates.failed;
  if(card.status==='unknown'||card.status==='interrupted')return templates.unknown;
  return templates.base;
}

type ChipView={className:string;label:string;title:string;ariaLabel:string;icon:string};
const SVG_NS='http://www.w3.org/2000/svg';
function chipIcon(doc:Document,icon:string):SVGElement{
  const svg=doc.createElementNS(SVG_NS,'svg');
  for(const [name,value] of Object.entries({viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':'2.2','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true'}))svg.setAttribute(name,value);
  const circle=doc.createElementNS(SVG_NS,'circle');
  circle.setAttribute('cx','12');
  circle.setAttribute('cy','12');
  circle.setAttribute('r','10');
  svg.append(circle);
  if(icon==='clock'){
    const polyline=doc.createElementNS(SVG_NS,'polyline');
    polyline.setAttribute('points','12 6 12 12 16 14');
    svg.append(polyline);
    return svg;
  }
  const lines=[['12','8','12','12'],['12','16','12.01','16']];
  for(const [x1,y1,x2,y2] of lines){
    const line=doc.createElementNS(SVG_NS,'line');
    line.setAttribute('x1',x1);
    line.setAttribute('y1',y1);
    line.setAttribute('x2',x2);
    line.setAttribute('y2',y2);
    svg.append(line);
  }
  return svg;
}
function timeChip(doc:Document,chip:ChipView,taskId:string):HTMLElement{
  const node=doc.createElement('span');
  node.className=chip.className;
  node.title=chip.title;
  node.setAttribute('aria-label',chip.ariaLabel);
  node.dataset.taskDuration=taskId;
  node.append(chipIcon(doc,chip.icon),doc.createTextNode(chip.label));
  return node;
}

export function renderBoard(root:HTMLElement,snapshot:Snapshot,state:BoardState,actions:BoardActions):void{
  const document=root.ownerDocument;
  const snapshotConnected=snapshot.connected!==false;
  const stale=!snapshotConnected||actions.stale===true;
  const previousInput=root.querySelector<HTMLInputElement>('#searchInput');
  const inputHadFocus=!!previousInput&&document.activeElement===previousInput;
  const selectionStart=previousInput?.selectionStart??null;
  const selectionEnd=previousInput?.selectionEnd??null;
  const query=previousInput?previousInput.value:(typeof state.query==='string'?state.query:'');

  const laneTops:Record<string,number>={...(state.scrollTopByLane??{})};
  root.querySelectorAll<HTMLElement>('.column-scroll').forEach(list=>{
    const lane=list.closest<HTMLElement>('section[id]')?.id;
    if(lane)laneTops[lane]=list.scrollTop;
  });

  root.innerHTML=template;
  root.querySelectorAll('script').forEach(node=>node.remove());
  root.querySelectorAll<HTMLElement>('[onclick]').forEach(node=>node.removeAttribute('onclick'));
  const attentionSources=Array.from(root.querySelectorAll<HTMLElement>('#col-attention .task-card'));
  const failedTemplate=attentionSources.find(node=>node.textContent?.includes('执行失败'));
  const unknownTemplate=attentionSources.find(node=>node.textContent?.includes('状态待核实'));
  root.querySelector<HTMLElement>('#col-pending')?.remove();
  root.querySelector<HTMLElement>('#col-attention')?.remove();
  for(const lane of BOARD_LANES){
    const section=must<HTMLElement>(root,`#${lane}`);
    const heading=section.querySelector<HTMLElement>('h2');
    if(heading)heading.textContent=laneNames[lane];
    const hint=section.firstElementChild?.querySelector<HTMLElement>(':scope > span');
    if(hint)hint.textContent=laneHints[lane];
  }

  const header=must<HTMLElement>(root,'header');
  const contextRow=must<HTMLElement>(header,':scope > div:first-child');
  const contextTag=must<HTMLElement>(contextRow,':scope > div:first-child > span:first-child');
  const contextTitle=must<HTMLElement>(contextRow,':scope > div:first-child > span:last-child');
  contextTag.textContent=stale?'上次快照':'实时快照';
  contextTag.title=stale?'显示上次同步快照，恢复后自动更新':'来自当前小队快照';
  const bindingTitle=snapshot.binding.title?.trim()||'Codex 小队';
  contextTitle.textContent=bindingTitle;
  contextTitle.title=snapshot.binding.workspace||bindingTitle;

  const syncHost=must<HTMLElement>(contextRow,':scope > div:last-child');
  const refreshButton=must<HTMLButtonElement>(syncHost,'#refreshBtn');
  syncHost.replaceChildren();
  const syncBadge=document.createElement('span');
  syncBadge.id='syncBadge';
  syncBadge.className=stale
    ?'inline-flex items-center gap-1 text-[11px] font-mono text-status-gray bg-status-gray-bg px-1.5 py-0.5 rounded border border-status-gray/30'
    :'inline-flex items-center gap-1 text-[11px] font-mono text-status-green bg-status-green-bg px-1.5 py-0.5 rounded border border-status-green/20';
  syncBadge.title=stale?`上次同步快照：${clockOf(snapshot.observedAt)}，恢复后自动更新`:`观测时间：${clockOf(snapshot.observedAt)}`;
  const syncDot=document.createElement('span');
  syncDot.className=stale?'w-1.5 h-1.5 rounded-full bg-status-gray':'w-1.5 h-1.5 rounded-full bg-status-green sync-dot';
  const syncLabel=document.createElement('span');
  syncLabel.textContent=stale?`上次同步 ${clockOf(snapshot.observedAt)}`:'3秒自动同步';
  syncBadge.append(syncDot,syncLabel);
  syncHost.append(syncBadge,refreshButton);

  const totalCount=must<HTMLElement>(root,'#totalCount');
  const metricStrongs=Array.from(totalCount.closest<HTMLElement>('div')?.querySelectorAll<HTMLElement>('strong')??[]);
  const runningCount=metricStrongs[1];
  const reviewCount=metricStrongs[2];
  if(!runningCount||!reviewCount)throw new Error('看板模板缺少运行或核验计数');
  const runningLabel=runningCount.parentElement?.firstChild;
  const reviewLabel=reviewCount.parentElement?.firstChild;
  if(runningLabel)runningLabel.nodeValue='处理中 ';
  if(reviewLabel)reviewLabel.nodeValue='核验中 ';
  const visibleWrap=document.createElement('span');
  visibleWrap.id='visibleCount';
  visibleWrap.className='hidden';
  visibleWrap.append(document.createTextNode(' · 可见 '));
  const visibleValue=document.createElement('strong');
  visibleValue.className='text-ink-deep font-semibold';
  visibleWrap.append(visibleValue);
  totalCount.after(visibleWrap);

  const canvas=must<HTMLElement>(root,'#boardCanvas');
  canvas.className='board-canvas';
  const lanesTrack=document.createElement('div');
  lanesTrack.className='board-lanes';
  for(const lane of BOARD_LANES){
    const section=must<HTMLElement>(root,`#${lane}`);
    section.classList.remove('w-[280px]','shrink-0','max-h-[calc(100vh-175px)]');
    section.classList.add('board-lane');
    lanesTrack.append(section);
  }
  canvas.append(lanesTrack);
  const notice=document.createElement('p');
  notice.id='boardNotice';
  notice.className='hidden mx-3 mt-2 px-3 py-2 rounded-md border border-border-warm bg-paper-subtle text-[11px] text-ink-muted';
  notice.setAttribute('role','status');
  notice.setAttribute('aria-live','polite');
  canvas.before(notice);

  const laneNodes=new Map<string,LaneView>();
  for(const lane of BOARD_LANES){
    const section=must<HTMLElement>(root,`#${lane}`);
    section.dataset.lane=lane;
    const list=must<HTMLElement>(section,'.column-scroll');
    const sources=Array.from(list.children).filter((node):node is HTMLElement=>node instanceof HTMLElement&&node.classList.contains('task-card'));
    if(!sources.length)throw new Error(`看板模板缺少 ${lane} 任务卡片`);
    const headerBox=must<HTMLElement>(section,':scope > div:first-child');
    const headerSpans=Array.from(headerBox.firstElementChild?.querySelectorAll<HTMLElement>(':scope > span')??[]);
    const dot=headerSpans[0];
    const laneCount=headerSpans.at(-1);
    if(!dot||!laneCount)throw new Error(`看板模板缺少 ${lane} 计数`);
    laneCount.dataset.laneCount=lane;
    list.replaceChildren();
    laneNodes.set(lane,{
      section,
      list,
      template:{
        base:sources[0],
        failed:failedTemplate||sources[0],
        unknown:unknownTemplate||sources.at(-1)!
      },
      empty:document.createElement('p'),
      counts:[laneCount],
      dot,
      all:0
    });
    const view=laneNodes.get(lane)!;
    view.empty.className='p-2 text-center text-[11px] text-ink-subtle';
    view.empty.dataset.laneEmpty=lane;
    view.empty.textContent='暂无任务';
  }

  const quickNav=must<HTMLElement>(header,'.overflow-x-auto');
  const quickButtons=Array.from(quickNav.querySelectorAll<HTMLButtonElement>('button'));
  if(quickButtons.length!==templateLanes.length)throw new Error('看板模板缺少泳道快捷导航');
  quickButtons.forEach((button,index)=>{
    const lane=templateLanes[index];
    const view=laneNodes.get(lane);
    if(!view){button.remove();return;}
    button.type='button';
    button.dataset.laneTarget=lane;
    button.setAttribute('aria-label',`跳转到${laneNames[lane]}泳道`);
    const spans=Array.from(button.querySelectorAll<HTMLElement>(':scope > span'));
    const count=spans.at(-1);
    if(!count)throw new Error(`快捷导航缺少 ${lane} 计数`);
    if(spans[1])spans[1].textContent=laneNames[lane];
    count.dataset.laneCount=lane;
    view.counts.push(count);
    if(lane==='col-running')view.quickDot=spans[0];
    button.addEventListener('click',()=>scrollToLane(lane));
  });

  const members=new Map<string,Member>(snapshot.members.map(member=>[member.id,member]));
  const cards=snapshot.tasks.map((task,index)=>taskCard(task,index,snapshotConnected) as Card)
    .filter(card=>boardVisible(card.task));
  const groups=groupCards(cards);
  const observedAt=Date.parse(snapshot.observedAt);
  const now=stale?(Number.isFinite(observedAt)?observedAt:0):Date.now();
  const cardNodes:HTMLElement[]=[];
  for(const lane of BOARD_LANES){
    const view=laneNodes.get(lane)!;
    view.all=groups[lane].length;
    const fragment=document.createDocumentFragment();
    for(const card of groups[lane]){
      const node=createCard(card,view.template,members,now,stale);
      cardNodes.push(node);
      fragment.append(node);
    }
    view.list.append(fragment,view.empty);
  }

  const input=must<HTMLInputElement>(root,'#searchInput');
  input.placeholder='搜索任务标题、编号或进展...';
  input.setAttribute('aria-label','搜索任务标题、编号或进展');
  input.value=query;
  const clearButton=must<HTMLButtonElement>(root,'#clearSearch');
  clearButton.type='button';
  clearButton.setAttribute('aria-label','清除搜索');

  const syncTime=must<HTMLElement>(root,'#syncTime');
  syncTime.textContent=clockOf(snapshot.observedAt);
  const footerNote=root.querySelector<HTMLElement>('footer > div:first-child > span:last-child');
  if(footerNote)footerNote.textContent=stale?'只读 · 显示上次同步快照':'只读 · 点击任务查看对话与执行记录';

  const analysis=must<HTMLAnchorElement>(root,'header nav a[href="#analytics"]');
  analysis.addEventListener('click',event=>{event.preventDefault();captureState();actions.onAnalysis()});
  const refresh=must<HTMLButtonElement>(root,'#refreshBtn');
  refresh.type='button';
  refresh.setAttribute('aria-label','刷新看板');
  refresh.addEventListener('click',()=>{captureState();actions.onRefresh()});
  input.addEventListener('input',()=>{state.query=input.value;applyFilter(input.value)});
  clearButton.addEventListener('click',()=>{
    input.value='';
    state.query='';
    applyFilter('');
    input.focus({preventScroll:true});
    input.setSelectionRange(0,0);
  });

  applyFilter(query);
  for(const [lane,view] of laneNodes){
    const top=laneTops[lane];
    if(typeof top==='number')view.list.scrollTop=top;
  }
  if(inputHadFocus)input.focus({preventScroll:true});
  if(selectionStart!==null||selectionEnd!==null){
    try{input.setSelectionRange(selectionStart??input.value.length,selectionEnd??selectionStart??input.value.length)}catch{}
  }
  state.query=input.value;
  state.scrollTopByLane=Object.fromEntries(Array.from(laneNodes,([lane,view])=>[lane,view.list.scrollTop]));
  for(const [lane,view] of laneNodes)view.list.addEventListener('scroll',()=>{
    const tops=state.scrollTopByLane||(state.scrollTopByLane={});
    tops[lane]=view.list.scrollTop;
  },{passive:true});

  function captureState(){
    state.query=input.value;
    state.scrollTopByLane=Object.fromEntries(Array.from(laneNodes,([lane,view])=>[lane,view.list.scrollTop]));
  }

  function scrollToLane(lane:string){
    const view=laneNodes.get(lane);
    const first=laneNodes.get(BOARD_LANES[0])?.section;
    if(!view||!first)return;
    const reduce=document.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches??false;
    const behavior=reduce?'auto':'smooth';
    const stacked=Math.abs(view.section.offsetLeft-first.offsetLeft)<1;
    view.section.scrollIntoView({block:stacked?'start':'nearest',inline:'nearest',behavior});
  }

  function applyFilter(raw:string){
    const needle=normalizeQuery(raw);
    const matchedCards=filterCards(cards,raw) as Card[];
    const matched=new Set(matchedCards.map(card=>card.task.id));
    const visibleCounts=Object.fromEntries(BOARD_LANES.map(lane=>[lane,0])) as Record<string,number>;
    let visible=0;
    for(const node of cardNodes){
      const show=matched.has(node.dataset.key||'');
      node.hidden=!show;
      if(show){visible++;visibleCounts[node.dataset.lane||'']++}
    }
    for(const lane of BOARD_LANES){
      const view=laneNodes.get(lane)!;
      const shown=visibleCounts[lane];
      for(const node of view.counts){
        node.textContent=String(needle?shown:view.all);
        if(needle)node.title=`可见 ${shown} / 全部 ${view.all}`;
        else node.removeAttribute('title');
      }
      view.empty.hidden=shown>0;
      view.empty.textContent=needle?'无匹配任务':'暂无任务';
      view.section.classList.toggle('is-empty',shown===0);
      if(lane==='col-running'){
        const runningLive=!stale&&groups[lane].some((card:Card)=>card.live&&matched.has(card.task.id));
        view.dot.classList.toggle('sync-dot',runningLive);
        view.quickDot?.classList.toggle('sync-dot',runningLive);
        const hint=view.section.firstElementChild?.querySelector<HTMLElement>(':scope > span');
        if(hint)hint.textContent=stale?'暂未更新':runningLive?'活跃进程':'暂无活跃进程';
      }
    }
    totalCount.textContent=String(cards.length);
    totalCount.title='当前三泳道任务数';
    visibleValue.textContent=String(visible);
    visibleWrap.classList.toggle('hidden',!needle);
    runningCount.textContent=String(needle?visibleCounts['col-running']:laneNodes.get('col-running')!.all);
    reviewCount.textContent=String(needle?visibleCounts['col-review']:laneNodes.get('col-review')!.all);
    runningCount.title=needle?`可见 ${visibleCounts['col-running']} / 全部 ${laneNodes.get('col-running')!.all}`:'';
    reviewCount.title=needle?`可见 ${visibleCounts['col-review']} / 全部 ${laneNodes.get('col-review')!.all}`:'';
    clearButton.classList.toggle('hidden',input.value.length===0);
    let message='';
    if(cards.length===0)message='当前没有任务。';
    else if(needle&&visible===0)message=`未找到匹配“${input.value.trim()}”的任务，清除搜索可查看全部。`;
    notice.textContent=message;
    notice.classList.toggle('hidden',!message);
  }

  function createCard(card:Card,templates:LaneTemplate,memberMap:Map<string,Member>,taskNow:number,cardStale:boolean):HTMLElement{
    const task=card.task;
    const element=templateFor(card,templates).cloneNode(true) as HTMLElement;
    if(!card.active)for(const dot of Array.from(element.querySelectorAll<HTMLElement>('.sync-dot')))dot.classList.remove('sync-dot');
    element.removeAttribute('onclick');
    element.removeAttribute('data-id');
    element.removeAttribute('data-title');
    element.dataset.key=task.id;
    element.dataset.lane=card.lane;
    element.dataset.search=card.search;
    element.setAttribute('role','link');
    element.tabIndex=0;
    element.setAttribute('aria-label',`查看任务 ${card.number}：${task.title||'未命名任务'}，${card.statusText}`);

    const top=must<HTMLElement>(element,':scope > div:first-child');
    const topSpans=Array.from(top.querySelectorAll<HTMLElement>(':scope > span'));
    const numberNode=topSpans[0];
    const badge=topSpans[1];
    if(!numberNode||!badge)throw new Error('任务卡片缺少编号或状态');
    numberNode.textContent=card.number;
    setLabel(badge,card.statusText);
    const title=must<HTMLElement>(element,'h3');
    const titleText=task.title?.trim()||'未命名任务';
    title.textContent=titleText;
    title.title=titleText;
    const progress=must<HTMLElement>(element,'p');
    progress.textContent=card.resultSummary||card.progress;
    if(card.lane==='col-running'||card.resultSummary)progress.title=card.resultSummary||card.progress;
    else progress.removeAttribute('title');

    const bottom=must<HTMLElement>(element,':scope > div:last-child');
    const rows=Array.from(bottom.querySelectorAll<HTMLElement>(':scope > div'));
    const meta=rows[0];
    const timing=rows[1];
    if(!meta||!timing)throw new Error('任务卡片缺少执行信息');
    const executorNode=must<HTMLElement>(meta,':scope > span:first-child');
    const attemptNode=must<HTMLElement>(meta,':scope > span:last-child');
    const member=memberMap.get(task.memberId);
    const executor=member?.executor?.trim()||'未记录';
    const executorText=executor.toLowerCase()==='qoder'?'Qoder':executor.toLowerCase()==='codex'?'Codex':executor;
    setLabel(executorNode,executorText);
    executorNode.title=`执行人：${executorText}`;
    attemptNode.textContent=`执行 ${task.attempts.length} 轮`;

    timing.classList.add('task-card-footer-row');
    const durationNode=must<HTMLElement>(timing,':scope > span:first-child');
    durationNode.replaceWith(timeChip(document,durationChip(task,taskNow,{stale:cardStale}),task.id));
    const tokenNode=must<HTMLElement>(timing,':scope > span:last-child');
    tokenNode.classList.add('task-card-token-val');
    tokenNode.textContent=tokenLabel(task.attempts);
    if(card.verifiedAt){
      const verifiedLabel=relativeTimeLabel(card.verifiedAt);
      if(verifiedLabel){
        const verified=document.createElement('span');
        verified.className='text-ink-muted';
        verified.dataset.verifiedAt=card.verifiedAt;
        verified.textContent=`核验于 ${verifiedLabel}`;
        bottom.append(verified);
      }
    }

    const open=()=>{captureState();actions.onTask(task.id)};
    element.addEventListener('click',open);
    element.addEventListener('keydown',event=>{
      if(event.key==='Enter'||event.key===' '){event.preventDefault();open()}
    });
    return element;
  }
}

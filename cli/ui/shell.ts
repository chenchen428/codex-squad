import {syncStatusOf} from './polling.mjs';

export type ShellPage='overview'|'analysis'|'session';
export type ShellDays=7|30|null;

export type ShellOptions={
  page:ShellPage;
  title:string;
  days:ShellDays;
  taskCount:number|null;
  connected:boolean;
  observedAt:string;
  /** 详情页当前子任务标题；完整内容同时写入 title 属性。 */
  taskTitle?:string;
  /** 详情页子任务序号，从 1 开始。 */
  taskIndex?:number;
  onPage:(page:'overview'|'analysis')=>void;
  onDays:(days:ShellDays)=>void;
  onRefresh:()=>void;
  onRetry:()=>void;
};

export type ShellHandle={
  element:HTMLElement;
  content:HTMLElement;
  setPending:(message:string|null,error?:boolean)=>void;
  update:(options:Partial<ShellOptions>)=>void;
  dispose:()=>void;
};

const refreshIcon='<svg class="squad-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>';
const backIcon='<svg class="squad-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 19l-7-7m0 0l7-7m-7 7h18"></path></svg>';
const warningIcon='<svg class="squad-error-icon" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clip-rule="evenodd"></path></svg>';

function node<K extends keyof HTMLElementTagNameMap>(document:Document,tag:K,className?:string):HTMLElementTagNameMap[K]{
  const element=document.createElement(tag);
  if(className)element.className=className;
  return element;
}
function span(document:Document,className:string,text?:string):HTMLSpanElement{
  const element=node(document,'span',className);
  if(text!==undefined)element.textContent=text;
  return element;
}
function clock(value:string,seconds:boolean):string{
  const date=new Date(value);
  if(!Number.isFinite(date.getTime()))return '未记录';
  return date.toLocaleTimeString('zh-CN',seconds?{hour:'2-digit',minute:'2-digit',second:'2-digit'}:{hour:'2-digit',minute:'2-digit'});
}
function rangeKey(days:ShellDays):string{return days===null?'all':String(days)}

export function renderShell(host:HTMLElement,options:ShellOptions):ShellHandle{
  const document=host.ownerDocument;
  const controller=new AbortController();
  const listen={signal:controller.signal};
  let state:ShellOptions={...options};
  let pendingMessage:string|null=null,pendingError=false;

  const element=node(document,'div','squad-shell-root');
  const content=node(document,'div','squad-page-content');

  const rail=node(document,'div','squad-progress-rail');
  const progressBar=node(document,'div','squad-progress-bar');
  rail.append(progressBar);

  const metaTitle=span(document,'squad-meta-title');
  const metaLeft=node(document,'div','squad-meta-left');
  const brand=span(document,'squad-meta-badge squad-product-brand');
  const logo=node(document,'img','product-logo');
  logo.src='./design/product-logo.png';
  logo.alt='';
  logo.width=28;
  logo.height=28;
  brand.append(logo,span(document,'','Codex 小队'));
  metaLeft.append(brand,span(document,'squad-meta-separator','/'),metaTitle);
  const pulseDot=node(document,'span','squad-pulse-dot');
  const syncText=span(document,'squad-sync-text','实时同步');
  const syncDetail=span(document,'squad-sync-detail','3秒自动同步');
  const syncIndicator=node(document,'span','squad-sync-indicator');
  syncIndicator.append(pulseDot,syncText,syncDetail);
  const metaRight=node(document,'div','squad-meta-right');
  metaRight.append(syncIndicator,span(document,'squad-meta-badge squad-meta-badge-quiet','只读'));
  /** 恒定高度 meta 栏内的隐藏播报区：详细加载文案不再新起一行。 */
  const liveStatus=span(document,'squad-live-status');
  liveStatus.setAttribute('role','status');
  liveStatus.setAttribute('aria-live','polite');
  liveStatus.setAttribute('aria-atomic','true');
  const metaBar=node(document,'header','squad-meta-bar');
  metaBar.append(metaLeft,metaRight,liveStatus);

  const errorLabel=span(document,'squad-error-label','页面资源加载失败');
  const errorText=node(document,'span','squad-error-text');
  errorText.innerHTML=warningIcon;
  errorText.append(errorLabel);
  const retryButton=node(document,'button','squad-btn-retry');
  retryButton.type='button';
  retryButton.textContent='重新加载';
  retryButton.addEventListener('click',()=>state.onRetry(),listen);
  const errorBanner=node(document,'div','squad-error-banner');
  errorBanner.hidden=true;
  errorBanner.setAttribute('role','alert');
  errorBanner.append(errorText,retryButton);

  const boardCount=span(document,'squad-tab-count');
  const tabs:{overview:HTMLButtonElement;analysis:HTMLButtonElement}={overview:navTab('overview','小队任务看板',boardCount),analysis:navTab('analysis','分析')};
  const navTabs=node(document,'div','squad-nav-tabs');
  navTabs.append(tabs.overview,tabs.analysis);
  const refreshButton=node(document,'button','squad-btn-refresh');
  refreshButton.type='button';
  refreshButton.title='立刻刷新数据';
  refreshButton.setAttribute('aria-label','立刻刷新数据');
  refreshButton.innerHTML=refreshIcon;
  refreshButton.addEventListener('click',()=>state.onRefresh(),listen);
  const navActions=node(document,'div','squad-nav-actions');
  navActions.append(refreshButton);
  const nav=node(document,'nav','squad-main-nav');
  nav.setAttribute('aria-label','小队主导航');
  nav.append(navTabs,navActions);

  const rangeGroup=node(document,'div','squad-range-group');
  rangeGroup.setAttribute('role','group');
  rangeGroup.setAttribute('aria-label','时间范围');
  const rangeButtons=new Map<string,HTMLButtonElement>();
  for(const option of [{days:7 as ShellDays,label:'近7天'},{days:30 as ShellDays,label:'近30天'},{days:null,label:'全部'}]){
    const button=node(document,'button','squad-range-btn');
    button.type='button';
    button.textContent=option.label;
    button.addEventListener('click',()=>state.onDays(option.days),listen);
    rangeButtons.set(rangeKey(option.days),button);
    rangeGroup.append(button);
  }
  const rangeStamp=span(document,'squad-range-stamp');
  const rangeCluster=node(document,'div','squad-range-cluster');
  rangeCluster.append(rangeGroup,rangeStamp);
  const subBar=node(document,'div','squad-sub-bar');
  subBar.hidden=true;
  subBar.append(rangeCluster);

  const backLink=node(document,'button','squad-back-link');
  backLink.type='button';
  backLink.innerHTML=backIcon;
  backLink.append(span(document,'','返回看板'));
  backLink.addEventListener('click',()=>state.onPage('overview'),listen);
  const stepSeparator=span(document,'squad-breadcrumb-separator','·');
  const breadcrumbStep=span(document,'squad-breadcrumb-step');
  const breadcrumbCurrent=span(document,'squad-breadcrumb-current');
  const breadcrumbLeft=node(document,'div','squad-breadcrumb-left');
  breadcrumbLeft.append(backLink,span(document,'squad-breadcrumb-separator','/'),breadcrumbStep,stepSeparator,breadcrumbCurrent);
  const breadcrumb=node(document,'div','squad-breadcrumb-bar');
  breadcrumb.hidden=true;
  breadcrumb.append(breadcrumbLeft);

  element.append(rail,metaBar,errorBanner,nav,subBar,breadcrumb,content);
  host.replaceChildren(element);

  function navTab(page:'overview'|'analysis',label:string,count?:HTMLSpanElement):HTMLButtonElement{
    const button=node(document,'button','squad-nav-tab');
    button.type='button';
    button.append(span(document,'',label));
    if(count)button.append(count);
    button.addEventListener('click',()=>state.onPage(page),listen);
    return button;
  }
  function apply(){
    const analysisPage=state.page==='analysis';
    const boardActive=!analysisPage;
    tabs.overview.classList.toggle('active',boardActive);
    tabs.analysis.classList.toggle('active',analysisPage);
    if(boardActive)tabs.overview.setAttribute('aria-current','page');else tabs.overview.removeAttribute('aria-current');
    if(analysisPage)tabs.analysis.setAttribute('aria-current','page');else tabs.analysis.removeAttribute('aria-current');
    boardCount.textContent=state.taskCount===null?'—':String(state.taskCount);
    metaTitle.textContent=state.title;
    metaTitle.title=state.title;
    // The report owns its analysis window; choosing a window must not imply a live rescan.
    subBar.hidden=true;
    refreshButton.title=analysisPage?'读取已保存的报告':'立刻刷新数据';
    refreshButton.setAttribute('aria-label',refreshButton.title);
    breadcrumb.hidden=state.page!=='session';
    for(const [key,button] of rangeButtons){const selected=rangeKey(state.days)===key;button.classList.toggle('active',selected);button.setAttribute('aria-pressed',String(selected))}
    rangeStamp.textContent=`截至 ${clock(state.observedAt,false)}`;
    const index=state.taskIndex,taskTitle=state.taskTitle??'';
    const hasStep=typeof index==='number';
    breadcrumbStep.hidden=!hasStep;
    stepSeparator.hidden=!hasStep;
    breadcrumbStep.textContent=hasStep?`子任务 #${String(index).padStart(2,'0')}`:'';
    breadcrumbCurrent.textContent=taskTitle;
    breadcrumbCurrent.title=taskTitle;
    syncState();
  }
  function syncState(){
    const error=Boolean(pendingError)&&pendingMessage!==null;
    const loading=pendingMessage!==null&&!error;
    const reportPage=state.page==='analysis';
    const sync=reportPage
      ?{label:'周期报告',detail:'每天一次',recovering:false}
      :syncStatusOf({connected:state.connected,observedAt:state.observedAt});
    progressBar.classList.toggle('active',loading);
    refreshButton.classList.toggle('spinning',loading);
    errorBanner.hidden=!error;
    if(error&&pendingMessage)errorLabel.textContent=pendingMessage;
    syncIndicator.classList.toggle('recovering',!loading&&sync.recovering);
    pulseDot.classList.toggle('syncing',loading);
    pulseDot.classList.toggle('offline',!loading&&sync.recovering);
    syncText.textContent=loading?'同步中…':sync.label;
    syncDetail.textContent=loading?'正在同步':sync.detail;
    syncIndicator.title=loading&&pendingMessage?pendingMessage:'';
    // 详细加载文案只进入 meta 栏内的隐藏播报区；失败已有 role=alert 横幅，避免重复播报。
    const live=error?'':loading?pendingMessage??'':sync.label;
    if(liveStatus.textContent!==live)liveStatus.textContent=live;
  }
  apply();
  syncState();

  return {
    element,
    content,
    setPending(message,error=false){pendingMessage=message;pendingError=Boolean(error);syncState()},
    update(next){state={...state,...next};apply()},
    dispose(){controller.abort();element.remove()}
  };
}

'use strict';
const D=window.REVIEW_DATA,$=s=>document.querySelector(s),qa=new URLSearchParams(location.search).get('qa');
const storageKey=`stitch-review:${new URL('.',location.href).pathname}:${D.id}:${qa?'qa:'+qa:'user'}`;
const statusText={open:'待选择',confirmed:'已确认',revise:'继续改稿 · 待复选'};
const kinds={'illustration':'本地界面示意','stitch-original':'原始 Stitch','browser-repaired':'来源修复 · 浏览器稿','product-capture':'真实产品截图'};
let saved={groups:{},issues:[],ui:{}},saveError=false;
function h(tag,attrs={},...children){const n=document.createElement(tag);for(const[k,v]of Object.entries(attrs)){if(k.startsWith('on'))n.addEventListener(k.slice(2),v);else if(k==='class')n.className=v;else if(v!==false&&v!=null)n.setAttribute(k,v===true?'':v);}for(const c of children.flat())if(c!=null)n.append(c instanceof Node?c:document.createTextNode(c));return n;}
function svg(tag,attrs={}){const n=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const[k,v]of Object.entries(attrs))n.setAttribute(k,v);return n;}
function toast(text){$('#toast').textContent=text;$('#toast').classList.add('visible');clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('#toast').classList.remove('visible'),2200);}
try{const raw=localStorage.getItem(storageKey);if(raw)saved=JSON.parse(raw);}catch{saveError=true;toast('本机记录未能读取，请先检查或导出已有记录。');}
function persist(){try{localStorage.setItem(storageKey,JSON.stringify(saved));saveError=false;return true;}catch{saveError=true;toast('内容尚未保存，请从清单复制备份。');return false;}}
const record=g=>saved.groups[g.id]||=( {choice:null,status:'open',note:'',events:[]} );
const findOption=(g,id)=>g.options.find(o=>o.id===id);
const identity=o=>o?JSON.stringify([o.id,o.version,o.states.map(s=>[s.id,s.asset.id,s.asset.sha256])]):'';
const choiceLabel=(g,id)=>findOption(g,id)?.title||'尚未选择';
function addEvent(g,type,extra={}){const r=record(g);r.events.push({type,at:new Date().toISOString(),revision:D.revision,choice:r.choice,status:r.status,note:r.note,source:r.source||null,...extra});}
for(const g of D.groups){const r=record(g),next=identity(findOption(g,r.choice));if(r.choice&&r.source&&r.source!==next){if(r.changedTo!==next){addEvent(g,'source-changed');r.changedTo=next;}r.status='open';r.notice='此前选稿的来源已变化，原决定和备注保留，需重新确认。';if(!findOption(g,r.choice)){r.choice=null;r.source=null;}}}
let groupIndex=Math.max(0,D.groups.findIndex(g=>g.id===saved.ui.groupId));
let stateId=saved.ui.stateId||'default',focused=null,models=[],boardWidth=300,world={width:0,height:0},camera={x:0,y:0,scale:1};
const ZOOM_WHEEL=.004,ZOOM_STEP=1.5;
let hand=false,space=false,drag=null,pinch=null,moved=false,ignoreClick=false,noteSnapshot=null;
const pointers=new Map(),current=()=>D.groups[groupIndex],currentRecord=()=>record(current());
const viewport=$('#viewport'),surface=$('#canvas-surface');
function uiSave(){saved.ui={...saved.ui,groupId:current().id,stateId,optionId:focused,view:'review'};persist();}
function frameFor(o){return o.states.find(s=>s.id===stateId);}
function nextGroupIndex(){for(let step=1;step<D.groups.length;step++){const i=(groupIndex+step)%D.groups.length;if(record(D.groups[i]).status!=='confirmed')return i;}return -1;}
function closeGroups(focus=false){$('#group-menu').hidden=true;$('#group-trigger').setAttribute('aria-expanded','false');if(focus)$('#group-trigger').focus();}
function selectGroup(index){closeGroups();groupIndex=index;focused=record(current()).choice||null;stateId=current().options[0].states[0].id;renderGroup();$('#group-trigger').focus();}
function renderGroupPicker(){
  const complete=D.groups.filter(g=>record(g).status==='confirmed').length;
  $('#group-trigger-title').textContent=current().code+' '+current().title;$('#group-trigger').dataset.index=groupIndex;
  $('#group-intent').textContent='已确认 '+complete+' / '+D.groups.length+' 组';
  $('#group-menu').replaceChildren(h('div',{class:'group-menu-heading'},h('strong',{},'选择审阅组'),h('span',{},'已确认 '+complete+' / '+D.groups.length)),
    ...D.groups.map((g,i)=>{const r=record(g),state=r.status==='confirmed'?'confirmed':r.status==='revise'?'revise':r.choice?'draft':'open',label={confirmed:'已确认',revise:'待改稿',draft:'待确认',open:'待选择'}[state];return h('button',{class:'group-option','data-group-index':i,'aria-current':i===groupIndex?'step':null,onclick:()=>selectGroup(i)},h('span',{class:'group-code'},g.code),h('span',{class:'group-option-copy'},h('strong',{},g.title),h('small',{},g.options.length+' 个方案'+(i===groupIndex?' · 正在审阅':''))),h('span',{class:'group-status '+state},label));}));
}
function openGroups(){renderGroupPicker();$('#group-menu').hidden=false;$('#group-trigger').setAttribute('aria-expanded','true');$('#group-menu').querySelectorAll('.group-option')[groupIndex].focus();}
function available(){const v=viewport.getBoundingClientRect(),n=$('#note-panel').getBoundingClientRect(),tools=$('#canvas-tools').getBoundingClientRect();return{w:v.width,h:v.height,left:24,right:24,top:window.innerWidth<=760?72:68,bottom:Math.max(v.bottom-n.top,v.bottom-tools.top)+24};}
function zoomAt(next,cx,cy){const k=Math.max(.05,Math.min(5,next)),wx=(cx-camera.x)/camera.scale,wy=(cy-camera.y)/camera.scale;camera={scale:k,x:cx-wx*k,y:cy-wy*k};paint();}
function fitAll(){const a=available(),scale=Math.max(.05,Math.min(1,(a.w-96)/world.width,(a.h-a.top-a.bottom)/world.height));camera={scale,x:(a.w-world.width*scale)/2,y:a.top+(a.h-a.top-a.bottom-world.height*scale)/2};paint();}
function sameWidth(){const a=available();camera={scale:1,x:world.width<a.w?(a.w-world.width)/2:48,y:a.top+12};paint();toast('所有画稿按同一宽度显示，可平移查看。');}
function focusBoard(id,locate=false){if(!findOption(current(),id))return;focused=id;updateDecision();uiSave();if(locate){const m=models.find(m=>m.option.id===id),a=available(),scale=Math.max(.1,Math.min(1.6,(a.w-48)/m.width,(a.h-a.top-a.bottom)/m.height));camera={scale,x:(a.w-m.width*scale)/2-m.x*scale,y:a.top+(a.h-a.top-a.bottom-m.height*scale)/2};paint();}}
function paint(){
  surface.style.transform=`translate(${camera.x}px,${camera.y}px) scale(${camera.scale})`;
  viewport.style.backgroundSize=`${20*camera.scale}px ${20*camera.scale}px`;viewport.style.backgroundPosition=`${camera.x}px ${camera.y}px`;
  viewport.dataset.scale=camera.scale;viewport.dataset.x=camera.x;viewport.dataset.y=camera.y;
  $('#zoom-value').textContent=Math.round(camera.scale*100)+'%';drawMinimap();
}
function choose(id){const g=current(),r=record(g);if(r.status==='confirmed')return;const o=findOption(g,id);if(!o)return;r.choice=id;r.source=identity(o);r.notice='';focused=id;persist();updateDecision();uiSave();}
function commit(status,type){const g=current(),r=record(g);r.status=status;r.notice='';r.source=identity(findOption(g,r.choice));delete r.changedTo;addEvent(g,type);const ok=persist();updateDecision();if(ok){if(status==='confirmed'&&nextGroupIndex()===-1)showSummary();else toast(status==='confirmed'?'本组已确认，点击“下一组”继续。':'当前暂时保留，继续改稿并等待复选。');}}
function confirm(){const r=currentRecord();if(r.status==='confirmed'){const next=nextGroupIndex();if(next>=0)selectGroup(next);else showSummary();return;}
  if(focused&&r.choice!==focused){choose(focused);return;}
  if(!findOption(current(),r.choice)){toast('先选择一个方案；也可以只写备注。');return;}
  if(r.choice==='current'&&/不喜欢|重新来|重新改|重来|继续改|再改|待改/.test(r.note)){
    const d=$('#decision-dialog');d.replaceChildren(h('div',{class:'dialog-heading'},h('h2',{},'保留当前，备注里的问题还需要改吗？'),h('button',{'aria-label':'暂不决定',onclick:()=>d.close()},'✕')),h('p',{class:'dialog-note'},r.note),h('div',{class:'dialog-actions'},h('button',{onclick:()=>{d.close();commit('revise','keep-and-revise');}},'仍需改稿'),h('button',{class:'primary',onclick:()=>{d.close();commit('confirmed','resolved-and-keep');}},'问题已解决，确认保留')));d.showModal();return;
  }commit('confirmed','confirm');
}
function updateDecision(){
  const g=current(),r=record(g),locked=r.status==='confirmed';
  for(const m of models){const selected=r.choice===m.option.id;m.root.classList.toggle('chosen',selected);m.root.classList.toggle('focused',focused===m.option.id);m.root.classList.toggle('locked',locked&&selected);const input=m.root.querySelector('input');input.checked=selected;input.disabled=locked;m.root.querySelector('.board-choice').classList.toggle('selected',selected);}
  $('#review-note').readOnly=locked;
  $('#selected-status-badge').textContent=r.notice|| (locked?'已确认：'+choiceLabel(g,r.choice):r.status==='revise'?'继续改稿 · 待复选':r.choice?'暂存：'+choiceLabel(g,r.choice):'尚未选择');
  $('#selected-status-badge').title=r.notice||choiceLabel(g,r.choice);$('#selected-status-badge').classList.toggle('confirmed',locked);$('#selected-status-badge').classList.toggle('revise',r.status==='revise');
  const next=nextGroupIndex(),complete=D.groups.filter(g=>record(g).status==='confirmed').length,confirmButton=$('#confirm-choice');
  confirmButton.querySelector('span').textContent=locked?(next>=0?'下一组 →':'查看并复制结果'):focused&&r.choice!==focused?'选择 '+(findOption(g,focused)?.shortTitle||'当前'):'确认选择';
  $('#revise-choice').textContent=locked?'修改决定':'继续改稿';$('#save-status').textContent=saveError?'尚未保存':r.note?'已保存':'自动保存';
  $('#flow-hint').textContent=locked?(next>=0?'已确认 '+complete+' / '+D.groups.length+' 组 · 下一组：'+D.groups[next].code+' '+D.groups[next].title:'全部 '+D.groups.length+' 组已确认 · 请复制结果，粘贴发给 Agent。'):r.status==='revise'?'本组仍待改稿，不计入已确认；可切换其他组先审阅。':r.choice?'已暂存 '+choiceLabel(g,r.choice)+' · 确认后可'+(next>=0?'继续下一组。':'整理并复制结果。'):'第 '+(groupIndex+1)+' / '+D.groups.length+' 组 · 先比较画稿，再选择并确认；也可先写备注。';
  renderGroupPicker();
  document.querySelectorAll('#board-jumps button').forEach(b=>{b.setAttribute('aria-pressed',b.dataset.id===focused);b.classList.toggle('chosen',b.dataset.id===r.choice);});
  drawMinimap();
}
function boardNode(o,index){
  const root=$('#board-template').content.firstElementChild.cloneNode(true),s=frameFor(o),a=s?.asset;
  root.className='canvas-board';root.dataset.option=o.id;root.style.left=index*(boardWidth+32)+'px';root.style.top='0px';root.style.width=boardWidth+'px';
  const heading=root.children[0];heading.className='board-heading';heading.replaceChildren(h('span',{class:'board-name'},h('i',{class:'board-dot '+(o.id==='current'?'baseline':'')}),h('strong',{title:o.title},o.title),o.recommended?h('span',{class:'recommended'},'推荐'):null),h('span',{class:'board-version'},o.version));
  const body=root.children[1];body.removeAttribute('id');body.className='artboard-card';const height=a?boardWidth*a.height/a.width:boardWidth*1.5;body.style.height=height+'px';body.replaceChildren();
  if(a){const img=h('img',{src:a.image,alt:o.title+' / '+s.label+' / '+a.id,width:a.width,height:a.height,draggable:'false'});body.append(img);img.addEventListener('error',()=>{body.replaceChildren(h('div',{class:'image-error'},'此图暂未载入，请核对来源。'));});}
  else body.append(h('div',{class:'image-error'},'此方案尚无相同状态的图。'));
  const controls=h('div',{class:'board-tools'},h('button',{'aria-label':'定位 '+o.title,title:'定位画板',onclick:e=>{e.stopPropagation();focusBoard(o.id,true);}},'⌖'),h('button',{'aria-label':'独立大图 '+o.title,title:'独立大图',onclick:e=>{e.stopPropagation();openImage(o);}},'⛶'));
  if(a?.preview)controls.append(h('a',{href:a.preview,target:'_blank',rel:'noopener','aria-label':'打开交互稿 '+o.title,title:'打开交互稿',onclick:e=>e.stopPropagation()},'↗'));
  body.append(controls);
  body.addEventListener('click',()=>{if(ignoreClick){ignoreClick=false;return;}focusBoard(o.id,false);});body.addEventListener('dblclick',()=>focusBoard(o.id,true));
  const footer=root.children[2];footer.className='board-footer';footer.replaceChildren();
  if(a)footer.append(h('details',{class:'board-source'},h('summary',{},a.displaySource||kinds[a.kind]),h('div',{class:'source-popup'},h('strong',{},o.title+' · '+o.version+' · '+s.label),h('p',{},a.id),h('p',{},a.width+' × '+a.height+' px'),h('p',{},'SHA-256 '+a.sha256),a.screen?h('p',{},a.screen):null)));
  const radio=h('input',{type:'radio',name:'board_select',value:o.id,'aria-label':o.id==='current'?'保留当前':'选择 '+o.shortTitle,onchange:()=>choose(o.id)});
  footer.append(h('label',{class:'board-choice'},radio,h('span',{},o.id==='current'?'保留当前':'选择 '+o.shortTitle)));
  return{root,option:o,x:index*(boardWidth+32),y:0,width:boardWidth,height:height+92};
}
function renderGroup(){
  const g=current();if(!g.options[0].states.some(s=>s.id===stateId))stateId=g.options[0].states[0].id;
  boardWidth=Math.min(720,g.viewport?.width||300);
  if(focused&&!findOption(g,focused))focused=null;
  $('#project-title').textContent=D.title;$('#canvas-goal-text').textContent=g.intent;
  $('#state-select').replaceChildren(...g.options[0].states.map(s=>h('option',{value:s.id,selected:s.id===stateId},D.round+' · '+s.label)));
  $('#board-count').textContent=g.options.length+' 个画板'+(qa?' · QA':'');
  models=g.options.map(boardNode);surface.replaceChildren(...models.map(m=>m.root));models.forEach(m=>m.height=m.root.offsetHeight);world={width:models.length*boardWidth+(models.length-1)*32,height:Math.max(...models.map(m=>m.height))};surface.style.width=world.width+'px';surface.style.height=world.height+'px';
  $('#board-jumps').replaceChildren(...g.options.map(o=>h('button',{'data-id':o.id,title:o.title,onclick:()=>focusBoard(o.id,true)},o.id==='current'?'当前':o.shortTitle)));
  $('#review-note').value=record(g).note;updateDecision();uiSave();
  requestAnimationFrame(fitAll);
}
function drawMinimap(){
  const mini=$('#minimap');if(!world.width)return;
  const map=svg('svg',{viewBox:`-12 -12 ${world.width+24} ${world.height+24}`,'aria-label':'画布总览',role:'img'});
  for(const m of models){const selected=currentRecord().choice===m.option.id;const rect=svg('rect',{x:m.x,y:0,width:m.width,height:m.height-42,rx:14,fill:selected?'#296352':m.option.id==='current'?'#a4aab3':'#929fac',stroke:focused===m.option.id?'#296352':'none','stroke-width':14,tabindex:0,role:'button','aria-label':'总览定位 '+m.option.title});rect.addEventListener('click',()=>focusBoard(m.option.id,true));rect.addEventListener('keydown',e=>{if(e.key==='Enter')focusBoard(m.option.id,true);});map.append(rect);}
  const v=viewport.getBoundingClientRect();map.append(svg('rect',{x:-camera.x/camera.scale,y:-camera.y/camera.scale,width:v.width/camera.scale,height:v.height/camera.scale,fill:'none',stroke:'#2d68c4','stroke-width':9,'pointer-events':'none'}));
  mini.replaceChildren(h('div',{class:'minimap-title'},h('span',{},'画布总览'),h('span',{},models.length+' 稿')),map,h('button',{onclick:fitAll},'适应全部'));
}
function summaryText(){return D.title+' · '+D.round+' · 用户决策结果\n审阅 ID：'+D.id+'\n本轮版本：'+D.revision+'\n已确认：'+D.groups.filter(g=>record(g).status==='confirmed').length+' / '+D.groups.length+' 组\n\n这是我主动复制发送的结果，请以此为本轮决定，不要从页面或本机存储猜测选择。只有已确认项代表采用；待选、暂存和继续改稿项不代表采用，实现仍按原任务授权范围。\n\n'+D.groups.map(g=>{const r=record(g),o=findOption(g,r.choice);return g.code+' '+g.title+'\n状态：'+statusText[r.status]+'\n选择：'+(o?o.title+' / '+o.version:'尚未选择')+(r.choice&&r.status!=='confirmed'?'（暂存，未采用）':'')+'\n组 ID：'+g.id+'；方案 ID：'+(r.choice||'无')+'\n备注原话：\n'+(r.note||'未填写')+'\n问题原话：'+g.issues.concat(saved.issues.filter(i=>i.groupId===g.id)).map(i=>i.quote).join('；')+(r.status==='confirmed'&&o?'\n已确认图稿：\n'+o.states.map(s=>s.label+' | '+s.asset.id+' | SHA-256 '+s.asset.sha256+'\n图片：'+s.asset.image+(s.asset.screen?'\nStitch：'+s.asset.projectId+' / '+s.asset.screen+' / '+s.asset.file:'')).join('\n'):'');}).join('\n\n');}
function showSummary(){const d=$('#summary-dialog');const text=h('textarea',{id:'summary-text',readonly:true,'aria-label':'含备注的选择清单'});text.value=summaryText();
  const complete=D.groups.filter(g=>record(g).status==='confirmed').length,copy=h('button',{id:'copy-result',class:'primary',onclick:async()=>{try{await navigator.clipboard.writeText(text.value);copy.textContent='已复制，去发给 Agent';$('#handoff-status').textContent='已复制到剪贴板。请粘贴发给 Agent，页面不会自动发送。';}catch{text.focus();text.select();$('#handoff-status').textContent='请手动复制已选中的内容，再粘贴发给 Agent。';}}},'复制结果给 Agent');
  d.replaceChildren(h('div',{class:'dialog-heading'},h('div',{},h('h2',{},'本轮选择与备注'),h('p',{},'已确认 '+complete+' / '+D.groups.length+' 组'+(complete<D.groups.length?'，其余仍待选择或改稿。':'，本轮选择已完成。'))),h('button',{'aria-label':'关闭选择清单',onclick:()=>d.close()},'✕')),
    h('div',{class:'summary-content'},h('p',{class:'handoff-guide'},'选择和备注只保存在这台设备上。检查结果后复制，粘贴发给 Agent；Agent 以你发送的这份结果为准。'),
    ...D.groups.map(g=>{const r=record(g);return h('article',{class:'summary-row'},h('div',{},h('strong',{},g.code+' '+g.title),h('span',{class:'summary-status '+r.status},statusText[r.status])),h('p',{},choiceLabel(g,r.choice)),h('p',{class:'summary-note'},r.note||'还没有备注。'),h('details',{},h('summary',{},'原话与决定记录'),h('pre',{},g.issues.concat(saved.issues.filter(i=>i.groupId===g.id)).map(i=>i.quote).join('\n')+'\n\n'+r.events.map(e=>e.at+' · '+e.type+'\n'+(e.previous!=null?'此前备注：'+e.previous+'\n':'')+(e.note||'')).join('\n\n'))));}),
    text,h('details',{class:'backup-records'},h('summary',{},'本机记录备份'),h('button',{onclick:()=>{const url=URL.createObjectURL(new Blob([JSON.stringify({reviewId:D.id,revision:D.revision,...saved},null,2)],{type:'application/json'}));h('a',{href:url,download:D.id+'-decisions.json'}).click();URL.revokeObjectURL(url);}},'导出原始记录'))),h('div',{class:'summary-footer'},h('p',{id:'handoff-status',role:'status','aria-live':'polite'},'1 检查选择与备注 → 2 复制结果 → 3 粘贴发给 Agent'),h('div',{class:'dialog-actions'},h('button',{onclick:()=>d.close()},'返回调整'),copy)));d.showModal();}
function openImage(o){const s=frameFor(o);if(!s){toast('此状态尚无图稿。');return;}const a=s.asset,d=$('#image-dialog');let zoom=1,x=0,y=0,drag=null;
  const stage=h('div',{class:'large-stage',tabindex:0,'aria-label':o.title+'完整大图'}),img=h('img',{src:a.image,alt:o.title+' · '+s.label,width:a.width,height:a.height,draggable:'false'}),ratio=h('span',{},'100%');stage.append(img);
  const paintImage=()=>{const r=stage.getBoundingClientRect(),base=Math.min((r.width-40)/a.width,(r.height-40)/a.height),scale=base*zoom;img.style.transform=`translate(${(r.width-a.width*scale)/2+x}px,${(r.height-a.height*scale)/2+y}px) scale(${scale})`;ratio.textContent=Math.round(zoom*100)+'%';stage.dataset.zoom=zoom;};
  const change=k=>{zoom=Math.max(.2,Math.min(12,zoom*k));paintImage();},reset=()=>{zoom=1;x=0;y=0;paintImage();};
  d.replaceChildren(h('div',{class:'large-heading'},h('div',{},h('strong',{},o.title),h('span',{},o.version+' · '+s.label+' · '+(a.displaySource||kinds[a.kind]))),h('button',{'aria-label':'关闭大图',onclick:async()=>{if(document.fullscreenElement)await document.exitFullscreen();d.close();}},'关闭 ✕')),
    h('div',{class:'large-tools'},h('button',{'aria-label':'缩小大图',onclick:()=>change(1/ZOOM_STEP)},'−'),ratio,h('button',{'aria-label':'放大大图',onclick:()=>change(ZOOM_STEP)},'＋'),h('button',{onclick:reset},'整图复位'),h('button',{onclick:async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen();}catch{toast('独立大图仍可缩放查看。');}}},'浏览器全屏'),a.preview?h('a',{href:a.preview,target:'_blank',rel:'noopener'},'打开交互稿 ↗'):null),stage);
  stage.addEventListener('wheel',e=>{e.preventDefault();change(Math.exp(-e.deltaY*ZOOM_WHEEL));},{passive:false});stage.addEventListener('pointerdown',e=>{stage.setPointerCapture(e.pointerId);drag={cx:e.clientX,cy:e.clientY,x,y};});stage.addEventListener('pointermove',e=>{if(drag){x=drag.x+e.clientX-drag.cx;y=drag.y+e.clientY-drag.cy;paintImage();}});stage.addEventListener('pointerup',()=>drag=null);stage.addEventListener('pointercancel',()=>drag=null);stage.addEventListener('dblclick',reset);
  const resize=new ResizeObserver(paintImage);resize.observe(stage);d.addEventListener('close',()=>{resize.disconnect();d.replaceChildren();},{once:true});img.onload=paintImage;d.showModal();requestAnimationFrame(paintImage);
}
function exclude(target){return target.closest('button,input,textarea,select,a,details,#note-panel,#canvas-tools,#minimap,#board-jumps');}
viewport.addEventListener('pointerdown',e=>{
  if(exclude(e.target))return;const rect=viewport.getBoundingClientRect();pointers.set(e.pointerId,{x:e.clientX-rect.x,y:e.clientY-rect.y});moved=false;
  if(pointers.size===1){drag={cx:e.clientX,cy:e.clientY,x:camera.x,y:camera.y};if(!e.target.closest('.canvas-board')||hand||space)viewport.setPointerCapture(e.pointerId);}
  else if(pointers.size===2){const[a,b]=[...pointers.values()],cx=(a.x+b.x)/2,cy=(a.y+b.y)/2;pinch={distance:Math.hypot(a.x-b.x,a.y-b.y),scale:camera.scale,wx:(cx-camera.x)/camera.scale,wy:(cy-camera.y)/camera.scale};drag=null;for(const id of pointers.keys())viewport.setPointerCapture(id);moved=true;}
});
viewport.addEventListener('pointermove',e=>{
  if(!pointers.has(e.pointerId))return;const rect=viewport.getBoundingClientRect();pointers.set(e.pointerId,{x:e.clientX-rect.x,y:e.clientY-rect.y});
  if(pointers.size===2&&pinch){const[a,b]=[...pointers.values()],cx=(a.x+b.x)/2,cy=(a.y+b.y)/2,scale=Math.max(.05,Math.min(5,pinch.scale*Math.hypot(a.x-b.x,a.y-b.y)/pinch.distance));camera={scale,x:cx-pinch.wx*scale,y:cy-pinch.wy*scale};moved=true;paint();}
  else if(drag){const dx=e.clientX-drag.cx,dy=e.clientY-drag.cy;if(Math.hypot(dx,dy)>4||moved){moved=true;viewport.setPointerCapture(e.pointerId);camera.x=drag.x+dx;camera.y=drag.y+dy;paint();}}
});
function release(e){pointers.delete(e.pointerId);if(moved){ignoreClick=true;setTimeout(()=>ignoreClick=false,50);}drag=null;pinch=null;if(pointers.size===1){const p=[...pointers.values()][0],rect=viewport.getBoundingClientRect();drag={cx:rect.x+p.x,cy:rect.y+p.y,x:camera.x,y:camera.y};}}
viewport.addEventListener('pointerup',release);viewport.addEventListener('pointercancel',release);
viewport.addEventListener('wheel',e=>{if(exclude(e.target))return;e.preventDefault();if(e.ctrlKey||e.metaKey){const r=viewport.getBoundingClientRect();zoomAt(camera.scale*Math.exp(-e.deltaY*ZOOM_WHEEL),e.clientX-r.x,e.clientY-r.y);}else{camera.x-=e.deltaX;camera.y-=e.deltaY;paint();}},{passive:false});
viewport.addEventListener('dblclick',e=>{if(!e.target.closest('.canvas-board')&&!exclude(e.target))fitAll();});
$('#group-trigger').onclick=()=>{if($('#group-menu').hidden)openGroups();else closeGroups();};
$('#group-trigger').onkeydown=e=>{if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();openGroups();}};
$('#group-menu').onkeydown=e=>{if(e.key==='Escape'){e.preventDefault();closeGroups(true);return;}const buttons=[...$('#group-menu').querySelectorAll('.group-option')],i=buttons.indexOf(document.activeElement);if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault();buttons[e.key==='Home'?0:e.key==='End'?buttons.length-1:(i+(e.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length].focus();}};
document.addEventListener('pointerdown',e=>{if(!$('#group-picker').contains(e.target))closeGroups();});
$('#state-select').onchange=e=>{stateId=e.target.value;renderGroup();};
$('#zoom-out').onclick=()=>{const a=available();zoomAt(camera.scale/ZOOM_STEP,a.w/2,a.h/2);};
$('#zoom-in').onclick=()=>{const a=available();zoomAt(camera.scale*ZOOM_STEP,a.w/2,a.h/2);};
$('#zoom-value').onclick=sameWidth;$('#same-width').onclick=sameWidth;$('#fit-all').onclick=fitAll;
$('#hand-tool').onclick=e=>{hand=!hand;e.currentTarget.setAttribute('aria-pressed',hand);viewport.classList.toggle('hand-active',hand);};
$('#show-summary').onclick=showSummary;$('#confirm-choice').onclick=confirm;$('#revise-choice').onclick=()=>{if(currentRecord().status==='confirmed'){addEvent(current(),'reopen');currentRecord().status='open';persist();updateDecision();}else commit('revise','request-revision');};
$('#toggle-note').onclick=()=>{$('#note-panel').classList.toggle('expanded');if($('#note-panel').classList.contains('expanded'))$('#review-note').focus();requestAnimationFrame(()=>{if(window.innerWidth<=760&&focused)focusBoard(focused,true);});};
$('#review-note').onfocus=()=>noteSnapshot={id:current().id,value:currentRecord().note};
$('#review-note').oninput=e=>{if(noteSnapshot&&!noteSnapshot.captured&&noteSnapshot.value!==e.target.value){addEvent(current(),'note-before-edit',{previous:noteSnapshot.value});noteSnapshot.captured=true;}currentRecord().note=e.target.value;persist();$('#save-status').textContent=saveError?'尚未保存':'已保存';};
$('#review-note').onblur=()=>{if(!noteSnapshot)return;const g=D.groups.find(g=>g.id===noteSnapshot.id),r=record(g);if(noteSnapshot.value!==r.note)addEvent(g,'note',{previous:noteSnapshot.value});noteSnapshot=null;persist();};
window.addEventListener('keydown',e=>{if(e.target.closest('input,textarea,select,button,a,[role=button],#group-picker')||document.querySelector('dialog[open]'))return;if(e.code==='Space'){space=true;viewport.classList.add('hand-active');e.preventDefault();}if(['+','=','-','0'].includes(e.key)){e.preventDefault();const a=available();if(e.key==='0')fitAll();else zoomAt(camera.scale*(e.key==='-' ? 1/ZOOM_STEP : ZOOM_STEP),a.w/2,a.h/2);}});
window.addEventListener('keyup',e=>{if(e.code==='Space'){space=false;viewport.classList.toggle('hand-active',hand);}});window.addEventListener('blur',()=>{space=false;drag=null;pinch=null;pointers.clear();});
let resizeTimer;window.addEventListener('resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{if(document.querySelector('#image-dialog[open]'))return;if(window.innerWidth<=760&&focused)focusBoard(focused,true);else fitAll();},80);});
renderGroup();

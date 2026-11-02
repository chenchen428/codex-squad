import {renderMarkdown} from './markdown.mjs';
import {processSummary} from './model.mjs';
export const HISTORY_WINDOW=60;
export function historyCursor(taskId,id,kind='message'){
  const bytes=new TextEncoder().encode(JSON.stringify({v:1,t:taskId,k:kind,b:id}));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
}
/** A bounded row window. Text chunks are hydrated only near the viewport. */
export function mountHistory({area,taskId,createRow,read,processTemplate,footer,onHeight=()=>{},updateRow=(_row,_item)=>{}}){
  let closed=false,busy=false,revision=0,processRevision=0,hasOlder=false,hasNewer=false;
  const rows=new Map(),ordered=[],active=new Map(),requests=new Set(),timers=new Set();
  function retry(fn){const timer=setTimeout(()=>{timers.delete(timer);if(!closed)fn()},3000);timers.add(timer)}
  function near(chunk){const box=chunk.getBoundingClientRect(),root=area.getBoundingClientRect();return box.bottom>=root.top-500&&box.top<=root.bottom+500}
  const top=document.createElement('div'),bottom=document.createElement('div'),process=processTemplate?.cloneNode(false)||document.createElement('details');
  top.className=bottom.className='history-spacer';top.dataset.historyEdge='older';bottom.dataset.historyEdge='newer';
  const hint=document.createElement('p');hint.className='history-hint';
  area.replaceChildren(top,hint,bottom,process,footer);
  const summary=processTemplate?.querySelector('summary')?.cloneNode(false)||document.createElement('summary');summary.textContent='执行过程';process.append(summary);process.dataset.key=taskId+':process';
  const tools=document.createElement('div');tools.className='process-list history-process';process.append(tools);
  let toolItems=[],toolBefore=null,toolBusy=false,toolCount=0,toolHasNewer=false;
  function anchor(){const bounds=area.getBoundingClientRect();const row=ordered.map(id=>rows.get(id)?.row).find(row=>row?.getBoundingClientRect().bottom>bounds.top);return row?{row,y:row.getBoundingClientRect().top}:null}
  function preserve(fn){const saved=anchor();fn();if(saved?.row.isConnected)area.scrollTop+=saved.row.getBoundingClientRect().top-saved.y;onHeight()}
  function height(el){return el.getBoundingClientRect().height}
  function addSpacer(el,n){el.style.height=Math.max(0,(parseFloat(el.style.height)||0)+n)+'px'}
  const observer=new IntersectionObserver(entries=>{
    for(const event of entries){const chunk=event.target;if(event.isIntersecting)void hydrate(chunk);else dehydrate(chunk)}
  },{root:area,rootMargin:'500px 0px'});
  function dehydrate(chunk){
    if(!active.has(chunk))return;
    const h=height(chunk);if(h>0)chunk.style.minHeight=h+'px';chunk.replaceChildren();active.delete(chunk);
  }
  async function hydrate(chunk){
    const owner=rows.get(chunk.dataset.owner);if(closed||!owner||active.has(chunk)||requests.has(chunk))return;
    requests.add(chunk);const version=owner.item.revision;
    try{
      const offset=Number(chunk.dataset.from),segment=owner.item.segments?.find(s=>s.from===offset);
      let text,fence=segment?.fence||'';
      if(owner.item.textOffset===offset&&typeof owner.item.text==='string'){text=owner.item.text;owner.item.text=undefined}
      else{const response=await read({id:taskId,item:owner.item.id,offset:String(offset)});if(closed||owner.item.revision!==version||!chunk.isConnected)return;text=response.chunk.text;fence=response.chunk.fence||'';if(response.chunk.revision!==version)return;}
      if(!near(chunk))return;
      preserve(()=>{
        chunk.innerHTML=renderMarkdown((fence?fence+'\n':'')+text);
        chunk.style.minHeight='';active.set(chunk,true);
      });
    }catch{if(!closed){chunk.textContent='正在恢复消息读取…';chunk.style.minHeight='24px';retry(()=>{if(chunk.isConnected&&near(chunk))void hydrate(chunk)})}}
    finally{requests.delete(chunk);if(!closed){queueMicrotask(onScroll);if(owner.item.revision!==version&&chunk.isConnected&&near(chunk))queueMicrotask(()=>void hydrate(chunk))}}
  }
  function setItem(item){
    const existing=rows.get(item.id);
    if(existing&&existing.item.revision===item.revision)return;
    const row=existing?.row||createRow(item),body=row.lastElementChild;
    if(existing)updateRow(row,item);
    if(!existing)body.replaceChildren();
    body.classList.add('history-message-body');
    const oldChunks=new Map([...body.children].map(chunk=>[Number(chunk.dataset.from),chunk])),kept=new Set();
    const segments=item.segments?.length?item.segments:[{from:0,to:item.text?.length||0,fence:'',hash:String(item.revision)}];
    for(const segment of segments){
      let chunk=oldChunks.get(segment.from);
      if(!chunk||chunk.dataset.hash!==segment.hash){
        chunk=document.createElement('div');chunk.className='history-text-chunk';chunk.dataset.owner=item.id;chunk.dataset.from=String(segment.from);chunk.dataset.hash=segment.hash;
        chunk.style.minHeight=Math.max(24,Math.ceil((segment.to-segment.from)/55)*25)+'px';observer.observe(chunk);
      }
      kept.add(chunk);body.append(chunk);
    }
    for(const chunk of oldChunks.values())if(!kept.has(chunk)){observer.unobserve(chunk);active.delete(chunk);chunk.remove()}
    const value={row,item:{...item}};rows.set(item.id,existing?Object.assign(existing,value):value);
    if(!existing)ordered.push(item.id);
    return row;
  }
  function trim(direction){
    while(ordered.length>HISTORY_WINDOW){
      const id=direction==='older'?ordered.pop():ordered.shift(),entry=rows.get(id);
      const spacer=direction==='older'?bottom:top;addSpacer(spacer,height(entry.row));
      for(const chunk of entry.row.lastElementChild.children){observer.unobserve(chunk);active.delete(chunk)}
      entry.row.remove();rows.delete(id);if(direction==='older')hasNewer=true;else hasOlder=true;
    }
  }
  function insert(page,direction='latest'){
    preserve(()=>{
      if(direction==='latest'&&page.reset){for(const id of ordered){const e=rows.get(id);for(const c of e.row.lastElementChild.children)observer.unobserve(c);e.row.remove()}ordered.length=0;rows.clear();active.clear();top.style.height=bottom.style.height='0px';hasNewer=false;}
      for(const id of page.removed||[]){const entry=rows.get(id);if(!entry)continue;for(const chunk of entry.row.lastElementChild.children){observer.unobserve(chunk);active.delete(chunk)}entry.row.remove();rows.delete(id);ordered.splice(ordered.indexOf(id),1)}
      const newIds=[];
      for(const item of page.items||[]){if(direction==='delta'&&hasNewer&&!rows.has(item.id))continue;const exists=rows.has(item.id);setItem(item);if(!exists)newIds.push(item.id)}
      if(direction==='older'&&newIds.length){ordered.splice(ordered.length-newIds.length,newIds.length);ordered.unshift(...newIds)}
      let next=bottom;for(const id of [...ordered].reverse()){const row=rows.get(id).row;if(row.nextSibling!==next)area.insertBefore(row,next);next=row}
      if(direction==='older')hasOlder=page.hasMore===true;else if(direction==='newer')hasNewer=page.hasNewer===true;else if(direction!=='delta'){hasOlder=page.hasMore===true;hasNewer=page.hasNewer===true;}
      if(direction==='older'){top.style.height='0px'}else if(direction==='newer'){bottom.style.height='0px'}
      trim(direction);hint.textContent=hasOlder?'向上滚动读取较早消息':'';hint.hidden=!hasOlder;
    });
  }
  async function page(direction){
    if(busy||closed||!ordered.length)return;busy=true;
    try{
      const edge=direction==='older'?ordered[0]:ordered.at(-1),key=direction==='older'?'before':'newer';
      const response=await read({id:taskId,[key]:historyCursor(taskId,edge)});if(!closed)insert(response.conversation,direction);
    }catch{hint.textContent='正在恢复历史读取…';retry(onScroll)}finally{busy=false}
  }
  function onScroll(){
    if(closed||busy)return;const bounds=area.getBoundingClientRect();
    const first=rows.get(ordered[0])?.row,last=rows.get(ordered.at(-1))?.row;
    if(hasOlder&&first&&first.getBoundingClientRect().bottom>=bounds.top-100)void page('older');
    else if(hasNewer&&last&&last.getBoundingClientRect().top<=bounds.bottom+100)void page('newer');
  }
  area.addEventListener('scroll',onScroll,{passive:true});
  function renderTools(items,prepend=false){
    const saved=tools.scrollHeight-tools.scrollTop;
    toolItems=prepend?[...items,...toolItems]:items;
    if(toolItems.length>60){if(prepend){toolItems=toolItems.slice(0,60);toolHasNewer=true}else toolItems=toolItems.slice(-60)}tools.replaceChildren();
    for(const item of toolItems){const line=processSummary(item),p=document.createElement('p');p.className='process-line';p.dataset.state=line.state;const command=document.createElement('span'),state=document.createElement('span');command.className='process-command';command.textContent=line.action;state.className='process-state';state.textContent=line.status;p.append(command,state);tools.append(p)}
    if(prepend)tools.scrollTop=tools.scrollHeight-saved;
  }
  async function loadTools(direction='latest'){
    if(toolBusy||closed)return;toolBusy=true;
    try{
      const range=direction==='older'&&toolBefore?{processBefore:historyCursor(taskId,toolItems[0].id,'process')}:direction==='newer'?{processNewer:historyCursor(taskId,toolItems.at(-1).id,'process')}:{processLimit:'30'};
      const response=await read({id:taskId,...range,after:String(revision)});if(closed)return;
      processRevision=response.process.revision;toolBefore=response.process.before;
      if(direction==='latest'){toolHasNewer=false;renderTools(response.process.items||[]);tools.scrollTop=tools.scrollHeight}
      else if(direction==='older')renderTools(response.process.items||[],true);
      else{toolHasNewer=response.process.hasNewer;renderTools([...toolItems,...response.process.items])}
    }catch{if(!closed&&process.open)retry(()=>void loadTools(direction))}finally{toolBusy=false}
  }
  process.addEventListener('toggle',()=>{if(process.open)void loadTools()});
  tools.addEventListener('scroll',()=>{if(tools.scrollTop<24&&toolBefore)void loadTools('older');else if(toolHasNewer&&tools.scrollTop+tools.clientHeight>tools.scrollHeight-24)void loadTools('newer')},{passive:true});
  return {
    params(){return revision?{after:String(revision),...(process.open?{processAfter:String(processRevision)}:{})}:{}},
    apply(response){
      const page=response.conversation;
      revision=page.revision||0;toolCount=response.process?.count||0;summary.textContent=`执行过程 · ${toolCount} 项`;process.hidden=!toolCount;
      if(page.reset||!ordered.length)insert({...page,reset:true},'latest');else insert(page,'delta');
      if(response.process?.items&&process.open){if(tools.scrollHeight-tools.scrollTop-tools.clientHeight<24){if(response.process.reset)renderTools(response.process.items);else if(response.process.items.length&&!toolHasNewer)void loadTools()}else if(response.process.items.length)toolHasNewer=true;processRevision=response.process.revision}
      onHeight();
    },
    async latest(){const response=await read({id:taskId});if(closed)return;insert({...response.conversation,reset:true},'latest');revision=response.conversation.revision;area.scrollTop=area.scrollHeight;onHeight()},
    close(){closed=true;for(const timer of timers)clearTimeout(timer);timers.clear();observer.disconnect();area.removeEventListener('scroll',onScroll);active.clear();rows.clear()}
  };
}

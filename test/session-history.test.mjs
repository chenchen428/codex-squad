import test from 'node:test';import assert from 'node:assert/strict';
import{mountHistory}from'../cli/ui/session-history.mjs';

function htmlText(value){
  return String(value)
    .replace(/<br\s*\/?>/gi,'\n')
    .replace(/<\/(?:p|div|li|h[1-6]|pre|blockquote|tr)>/gi,'\n')
    .replace(/<[^>]+>/g,'')
    .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&amp;/g,'&');
}
class FakeElement{
  constructor(tag){
    this.tagName=String(tag).toUpperCase();this.children=[];this.parentNode=null;this.dataset={};this.style={};this.className='';this.hidden=false;
    this.textValue='';this.htmlValue='';this.isRoot=false;this.open=false;
    this.rect={top:0,bottom:100,height:100,left:0,right:800,width:800};
    this.scrollTop=0;this.scrollHeight=0;this.clientHeight=0;this.listeners=new Map();
    const classes=new Set();
    this.classList={add:(...names)=>names.forEach(name=>classes.add(name)),remove:(...names)=>names.forEach(name=>classes.delete(name)),contains:name=>classes.has(name)};
  }
  get lastElementChild(){return this.children.at(-1)||null}
  get nextSibling(){if(!this.parentNode)return null;const index=this.parentNode.children.indexOf(this);return this.parentNode.children[index+1]||null}
  get isConnected(){let node=this;while(node.parentNode)node=node.parentNode;return node.isRoot===true}
  append(...nodes){for(const node of nodes){if(node.parentNode)node.remove();node.parentNode=this;this.children.push(node)}}
  insertBefore(node,next){if(node.parentNode)node.remove();const index=next?this.children.indexOf(next):-1;if(index<0)this.children.push(node);else this.children.splice(index,0,node);node.parentNode=this;return node}
  replaceChildren(...nodes){for(const child of this.children)child.parentNode=null;this.children=[];this.textValue='';this.htmlValue='';this.append(...nodes)}
  remove(){if(!this.parentNode)return;const index=this.parentNode.children.indexOf(this);if(index>=0)this.parentNode.children.splice(index,1);this.parentNode=null}
  set innerHTML(value){this.htmlValue=String(value);this.textValue=htmlText(value);for(const child of this.children)child.parentNode=null;this.children=[]}
  get innerHTML(){return this.htmlValue}
  set textContent(value){this.textValue=String(value);this.htmlValue='';for(const child of this.children)child.parentNode=null;this.children=[]}
  get textContent(){return this.children.length?this.children.map(child=>child.textContent).join(''):this.textValue}
  getBoundingClientRect(){return this.rect}
  addEventListener(type,listener){if(!this.listeners.has(type))this.listeners.set(type,[]);this.listeners.get(type).push(listener)}
  removeEventListener(type,listener){const list=this.listeners.get(type);if(list)this.listeners.set(type,list.filter(item=>item!==listener))}
}
class FakeIntersectionObserver{
  static instances=[];
  constructor(callback){this.callback=callback;this.targets=new Set();FakeIntersectionObserver.instances.push(this)}
  observe(target){this.targets.add(target);queueMicrotask(()=>{if(this.targets.has(target)&&target.isConnected)this.callback([{target,isIntersecting:true}])})}
  unobserve(target){this.targets.delete(target)}
  disconnect(){this.targets.clear()}
  emit(target,isIntersecting){if(this.targets.has(target))this.callback([{target,isIntersecting}])}
}
globalThis.document={createElement:tag=>new FakeElement(tag)};
globalThis.IntersectionObserver=FakeIntersectionObserver;

async function flush(){
  for(let index=0;index<4;index++)await Promise.resolve();
  await new Promise(resolve=>setImmediate(resolve));
  for(let index=0;index<4;index++)await Promise.resolve();
}
function message(id,text,revision=1,prefix=''){
  const segments=prefix?[{from:0,to:prefix.length,fence:'',hash:`h-${revision}-0`},{from:prefix.length,to:text.length,fence:'',hash:`h-${revision}-1`}]:[{from:0,to:text.length,fence:'',hash:`h-${revision}`}];
  return{id,kind:'message',role:'assistant',revision,text:prefix?text.slice(prefix.length):text,textOffset:prefix?prefix.length:0,textTotal:text.length,textComplete:segments.length===1,segments};
}
function harness(){
  const area=new FakeElement('section');area.isRoot=true;area.rect={top:0,bottom:600,height:600,left:0,right:800,width:800};
  let reader=()=>{throw new Error('unexpected chunk read')};const calls=[];
  const controller=mountHistory({
    area,taskId:'task-1',
    createRow(item){const row=new FakeElement('article');row.className='history-message';row.dataset.id=item.id;row.append(new FakeElement('div'));return row},
    read:async params=>{calls.push(params);return reader(params,calls.length)},
    footer:new FakeElement('footer')
  });
  return{
    area,controller,calls,observer:FakeIntersectionObserver.instances.at(-1),
    reply(reply){reader=reply},
    apply(items,revision=1,reset=true){controller.apply({conversation:{revision,items,reset,hasMore:false,hasNewer:false,removed:[]},process:{revision:0,count:0,items:[]}})},
    chunk(itemId,from=0){const row=area.children.find(element=>element.dataset.id===itemId);return row?.lastElementChild.children.find(chunk=>Number(chunk.dataset.from)===from)||null}
  };
}
function chunkReply(server,params){
  const from=Number(params.offset),segment=server.segments.find(item=>item.from===from);
  return{chunk:{id:params.item,from,next:segment.to,total:server.text.length,done:segment.to>=server.text.length,text:server.text.slice(from,segment.to),fence:segment.fence,revision:server.revision}};
}

test('首次内联渲染后离屏清空，再入屏仍显示原文且不出现undefined',async()=>{
  const page=harness(),text='公开回复：这是完整答案。',server={text,revision:1,segments:message('m-1',text).segments};
  page.reply(params=>chunkReply(server,params));
  page.apply([message('m-1',text)]);
  await flush();
  let chunk=page.chunk('m-1');
  assert.equal(chunk.textContent.trim(),text);assert.equal(page.calls.length,0);
  page.observer.emit(chunk,false);
  assert.equal(chunk.textContent,'');
  page.observer.emit(chunk,true);
  await flush();
  assert.equal(page.chunk('m-1').textContent.trim(),text);
  assert.deepEqual(page.calls,[{id:'task-1',item:'m-1',offset:'0'}]);
  chunk=page.chunk('m-1');
  assert.equal(chunk.textContent.trim(),text);
  assert.doesNotMatch(page.area.textContent,/undefined/);
  page.observer.emit(chunk,false);page.observer.emit(chunk,true);
  await flush();
  assert.equal(page.calls.length,2);
  assert.equal(page.chunk('m-1').textContent.trim(),text);
  assert.doesNotMatch(page.area.textContent,/undefined/);
});

test('内联空串被当作真实文本，消费后按同一消息与偏移异步读回',async()=>{
  const page=harness(),empty=message('m-empty',''),real=message('m-real','真实正文');
  const servers={'m-empty':{text:'',revision:1,segments:empty.segments},'m-real':{text:'真实正文',revision:1,segments:real.segments}};
  page.reply(params=>chunkReply(servers[params.item],params));
  page.apply([empty,real]);
  await flush();
  assert.equal(page.calls.length,0);
  assert.equal(page.chunk('m-empty').textContent,'');
  assert.equal(page.chunk('m-real').textContent.trim(),'真实正文');
  for(const id of['m-empty','m-real'])page.observer.emit(page.chunk(id),false);
  assert.equal(page.chunk('m-empty').textContent,'');
  for(const id of['m-empty','m-real'])page.observer.emit(page.chunk(id),true);
  await flush();
  assert.deepEqual(page.calls.map(call=>[call.item,call.offset]),[['m-empty','0'],['m-real','0']]);
  assert.equal(page.chunk('m-empty').textContent,'');
  assert.equal(page.chunk('m-real').textContent.trim(),'真实正文');
  assert.doesNotMatch(page.area.textContent,/undefined/);
});

test('异步分块读取失败显示恢复提示，重试后渲染原文',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const page=harness(),prefix='前半段原文。',text=prefix+'后半段原文。',server={text,revision:1,segments:message('m-retry',text,1,prefix).segments};
  let failed=false;
  page.reply(params=>{
    if(params.offset==='0'&&!failed){failed=true;throw new Error('network')}
    return chunkReply(server,params);
  });
  page.apply([message('m-retry',text,1,prefix)]);
  await flush();
  const chunk=page.chunk('m-retry',0);
  assert.equal(chunk.textContent,'正在恢复消息读取…');
  assert.equal(page.chunk('m-retry',prefix.length).textContent.trim(),text.slice(prefix.length));
  t.mock.timers.tick(3000);
  await flush();
  assert.equal(page.calls.filter(call=>call.offset==='0').length,2);
  assert.equal(page.chunk('m-retry',0).textContent.trim(),prefix);
  assert.doesNotMatch(page.area.textContent,/undefined/);
});

test('异步读取返回更新revision时先不写入，页面更新后才渲染新正文',async()=>{
  const page=harness(),oldPrefix='旧的第一段。',oldText=oldPrefix+'旧的第二段。',newPrefix='新的第一段。',newText=newPrefix+'新的第二段。';
  const oldItem=message('m-rev',oldText,1,oldPrefix),newItem=message('m-rev',newText,2,newPrefix);
  const server={text:oldText,revision:1,segments:oldItem.segments};
  let releaseStale;const stale=new Promise(resolve=>{releaseStale=resolve});let staleRequested=false;
  page.reply(params=>{
    if(!staleRequested&&params.offset==='0'){staleRequested=true;return stale}
    return chunkReply(server,params);
  });
  page.apply([oldItem]);
  await flush();
  assert.equal(page.chunk('m-rev',oldPrefix.length).textContent.trim(),oldText.slice(oldPrefix.length));
  assert.equal(page.chunk('m-rev',0).textContent,'');
  releaseStale({chunk:{id:'m-rev',from:0,next:newPrefix.length,total:newText.length,done:false,text:newPrefix,fence:'',revision:2}});
  await flush();
  assert.equal(page.chunk('m-rev',0).textContent,'');
  assert.doesNotMatch(page.area.textContent,/新的第一段/);
  server.text=newText;server.revision=2;server.segments=newItem.segments;
  page.apply([newItem],2,false);
  await flush();
  assert.equal(page.chunk('m-rev',0).textContent.trim(),newPrefix);
  assert.equal(page.chunk('m-rev',newPrefix.length).textContent.trim(),newText.slice(newPrefix.length));
  assert.doesNotMatch(page.area.textContent,/旧的第一段|旧的第二段|undefined/);
});

test('送达状态更新只刷新已有行的头部，不清空已渲染正文',async()=>{
  const area=new FakeElement('section');area.isRoot=true;area.rect={top:0,bottom:600,height:600,left:0,right:800,width:800};
  const text='第1轮 · 首次交办\n\n**目标**\n保留已渲染正文',base=message('h-1',text,1);
  const item=(revision,state)=>({...base,revision,kind:'handoff',role:'user',handoff:{kind:'initial',attemptIndex:1,delivery:{state,terminal:false}}});
  let reads=0;
  const syncBadge=(row,entry)=>{row.children[0].children[1].textContent=entry.handoff.delivery.state};
  const controller=mountHistory({
    area,taskId:'task-1',
    createRow(entry){
      const row=new FakeElement('article');row.dataset.id=entry.id;
      const heading=new FakeElement('div'),role=new FakeElement('span'),badge=new FakeElement('span');
      role.textContent='Codex · 首次交办';heading.append(role,badge);
      row.append(heading,new FakeElement('div'));syncBadge(row,entry);return row;
    },
    read:async()=>{reads+=1;throw new Error('已有正文不应重新读取')},
    updateRow:syncBadge,
    footer:new FakeElement('footer')
  });
  const apply=(revision,state,reset)=>controller.apply({conversation:{revision,items:[item(revision,state)],reset,hasMore:false,hasNewer:false,removed:[]},process:{revision:0,count:0,items:[]}});
  apply(1,'pending',true);await flush();
  const row=area.children.find(element=>element.dataset.id==='h-1'),badge=row.children[0].children[1];
  assert.equal(badge.textContent,'pending');
  assert.match(row.lastElementChild.children[0].innerHTML,/<p>第1轮 · 首次交办<\/p>/);
  assert.match(row.lastElementChild.children[0].innerHTML,/<strong>目标<\/strong>/);
  assert.match(row.lastElementChild.textContent.trim(),/^第1轮 · 首次交办[\s\S]*目标[\s\S]*保留已渲染正文$/);
  apply(2,'received',false);await flush();
  assert.equal(badge.textContent,'received');
  assert.match(row.lastElementChild.children[0].innerHTML,/<strong>目标<\/strong>/);
  assert.match(row.lastElementChild.textContent.trim(),/^第1轮 · 首次交办[\s\S]*目标[\s\S]*保留已渲染正文$/);
  assert.equal(reads,0);
  assert.doesNotMatch(area.textContent,/undefined/);
});

test('handoff、用户与助手消息统一经过 Markdown 渲染，没有纯文本回退',async()=>{
  const page=harness();
  const handoff='**交办目标**\n\n- 保留报错输入';
  const user='请检查 `session-history` 的增量渲染。';
  const assistant='## 结论\n\n1. 已修复\n2. 已补测试';
  page.apply([
    {...message('m-handoff',handoff),kind:'handoff',role:'user'},
    {...message('m-user',user),role:'user'},
    message('m-assistant',assistant),
  ]);
  await flush();
  const handoffChunk=page.chunk('m-handoff'),userChunk=page.chunk('m-user'),assistantChunk=page.chunk('m-assistant');
  assert.match(handoffChunk.innerHTML,/<strong>交办目标<\/strong>/);
  assert.match(handoffChunk.innerHTML,/<ul>\n<li>保留报错输入<\/li>\n<\/ul>/);
  assert.match(userChunk.innerHTML,/<code>session-history<\/code>/);
  assert.match(assistantChunk.innerHTML,/<h2>结论<\/h2>/);
  assert.match(assistantChunk.innerHTML,/<ol>\n<li>已修复<\/li>\n<li>已补测试<\/li>\n<\/ol>/);
  for(const chunk of [handoffChunk,userChunk,assistantChunk]){
    assert.equal(chunk.innerHTML,chunk.htmlValue);
    assert.notEqual(chunk.innerHTML.trim(),chunk.textContent.trim());
    assert.doesNotMatch(chunk.innerHTML,/\*\*交办目标\*\*|## 结论/);
  }
  assert.doesNotMatch(page.area.textContent,/undefined/);
});

test('消息窗口仍限制为60条，只有入屏分块才读取',async()=>{
  const page=harness();
  page.reply(params=>{
    if(!params.item)return{conversation:{revision:1,items:[],reset:false,hasMore:false,hasNewer:false,removed:[]}};
    return chunkReply({text:'正文',revision:1,segments:message(params.item,'正文').segments},params);
  });
  page.apply(Array.from({length:65},(_,index)=>message('m-'+index,'正文 '+index)));
  await flush();
  const rows=page.area.children.filter(element=>element.dataset.id);
  assert.equal(rows.length,60);
  assert.equal(rows[0].dataset.id,'m-5');
  assert.equal(rows.at(-1).dataset.id,'m-64');
  assert.deepEqual(page.calls.filter(call=>call.item),[]);
});

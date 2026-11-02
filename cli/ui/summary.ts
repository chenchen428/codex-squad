const title=document.querySelector<HTMLElement>('#title')!,meta=document.querySelector<HTMLElement>('#meta')!,content=document.querySelector<HTMLElement>('#content')!;
function markdown(text:string,container:HTMLElement){
 let code:HTMLPreElement|null=null;
 for(const line of text.split('\n')){
  if(line.startsWith('```')){if(code){code=null}else{code=document.createElement('pre');container.append(code)}continue}
  if(code){code.textContent+=line+'\n';continue}
  if(!line.trim())continue;
  const heading=/^(#{1,6})\s+(.+)$/.exec(line);const el=document.createElement(heading?(heading[1].length<=2?'h2':'h3'):'p');el.textContent=heading?heading[2]:line||'\u00a0';container.append(el);
 }
}
async function show(){
 try{
  const response=await fetch('./api',{cache:'no-store'});if(!response.ok)throw Error('无法读取会话总结，请在原会话核对插件服务。');const data=await response.json();
  if(!data){meta.textContent='尚未保存总结';content.textContent='当前会话还没有 Agent 总结。主会话收尾时，由 Agent 使用插件保存。';return}
  title.textContent=data.title;meta.textContent=`第 ${data.revision} 次记录 · ${new Date(data.updatedAt).toLocaleString('zh-CN')} · ${data.threadId}`;content.removeAttribute('role');markdown(data.content,content);
  const stages=document.querySelector('#stages')!;for(const stage of [...data.history].reverse()){const details=document.createElement('details'),summary=document.createElement('summary'),body=document.createElement('div');summary.textContent=`第 ${stage.revision} 次 · ${stage.title}`;body.className='stage-content';body.textContent=stage.content;details.append(summary,body);stages.append(details)}document.querySelector<HTMLElement>('#history')!.hidden=!data.history.length;
 }catch(error){meta.textContent='读取失败';content.setAttribute('role','alert');content.textContent=error instanceof Error?error.message:String(error)}
}
void show();void fetch('../api/links',{cache:'no-store'}).then(r=>r.ok?r.json():null).then(links=>{if(links?.review)document.querySelector<HTMLElement>('#review-link')!.hidden=false}).catch(()=>{});

/** Prepare inactive page CSS while keeping the current page styled. Commit only after all assets are ready. */
export function createPageStyles(document){
  const pages=new Map(),fonts=new Map(),fontLinks=[];
  let current=null;
  function stylesheet(file,kind){
    const link=document.createElement('link');link.rel='stylesheet';link.href=`./design/${file}`;
    link.dataset.pageStyle=kind;
    if(kind==='page')link.media='not all';
    const ready=new Promise((resolve,reject)=>{
      link.addEventListener('load',()=>resolve(link),{once:true});
      link.addEventListener('error',()=>{link.remove();reject(Error('页面样式加载失败，请重试。'))},{once:true});
    });
    document.head.append(link);return {link,ready};
  }
  function font(file){
    if(!fonts.has(file)){const entry=stylesheet(file,'font');fontLinks.push(entry.link);fonts.set(file,entry.ready.catch(error=>{fonts.delete(file);throw error}))}
    return fonts.get(file);
  }
  return {
    isReady(key){return pages.get(key)?.ready===true},
    /** @param {{key:string,fontFiles:string[],cssFile:string,fontFaces?:string[],text?:string}} options */
    prepare({key,fontFiles,cssFile,fontFaces=[],text='Codex 小队任务分析'} ){
      if(pages.has(key))return pages.get(key).promise;
      const sheet=stylesheet(cssFile,'page'),entry={...sheet,ready:false,promise:null};
      entry.promise=Promise.all([sheet.ready,...[...new Set(fontFiles)].map(font)])
        .then(async()=>{if(document.fonts)await Promise.all(fontFaces.map(face=>document.fonts.load(face,text)));entry.ready=true})
        .catch(error=>{sheet.link.remove();pages.delete(key);throw error});
      pages.set(key,entry);return entry.promise;
    },
    activate(key){
      const next=pages.get(key);if(!next?.ready)throw Error('页面资源尚未就绪');
      if(current===key)return;
      next.link.media='all';
      if(current)pages.get(current).link.media='not all';
      current=key;
    },
    close(){for(const entry of pages.values())entry.link.remove();pages.clear();for(const link of fontLinks)link.remove();fonts.clear()}
  };
}

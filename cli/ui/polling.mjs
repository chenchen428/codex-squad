/** Slow snapshots occasionally approach ten seconds; both read paths share this budget. */
export const READ_TIMEOUT_MS=30000;

export function syncStatusOf({connected,observedAt}){
  if(connected)return {label:'实时同步',detail:'3秒自动同步',recovering:false};
  const observed=Date.parse(observedAt||'');
  if(!Number.isFinite(observed))return {label:'等待首次同步',detail:'正在连接',recovering:true};
  return {label:'正在恢复同步',detail:`上次同步 ${new Date(observed).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}`,recovering:true};
}

/** One request at a time; refreshing and closing never leave an old loop behind. */
export function startPolling({read,onData,onError,interval=3000}){
  let timer,pending,closed=false;
  const controller=new AbortController();
  function refresh(){
    if(closed)return Promise.resolve();
    if(pending)return pending;
    clearTimeout(timer);
    pending=(async()=>{
      try{
        let value;
        try{value=await read(controller.signal)}catch(error){if(!closed)onError(error);return}
        if(!closed)onData(value);
      }
      finally{pending=null;if(!closed)timer=setTimeout(refresh,interval)}
    })();
    return pending;
  }
  void refresh();
  return {refresh,close(){closed=true;clearTimeout(timer);controller.abort()}};
}

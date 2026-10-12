// @web-revision: web-v4
// This file deliberately imports no modules. Recovery controls must survive an
// incomplete upload or a failed ES-module graph before application code runs.
export const WEB_REVISION='web-v4';
export const REQUIRED_RUNTIME=Object.freeze([
  '/css/app.css','/js/main.js','/js/api.js','/js/bridge.js','/js/actions.js',
  '/js/chat.js','/js/notes.js','/js/recorder.js','/js/state.js','/js/voice.js',
]);
const JS_TYPES=new Set(['text/javascript','application/javascript','application/x-javascript','text/ecmascript','application/ecmascript']);
const BOOT_ATTEMPTS=new WeakMap();
export function revisionUrl(path){return `${path}?rev=${WEB_REVISION}`;}
export function failureLabel(failure){
  const reason={network:'下載失敗或被重新導向',mime:'內容類型錯誤，可能不是前端檔案',revision:'版本不一致，請完整覆蓋本次更新'}[failure.reason];
  return `${failure.path}：${failure.reason==='http'?`HTTP ${failure.status}`:reason||'檔案無法載入'}`;
}
export async function checkRuntime(fetchImpl=globalThis.fetch.bind(globalThis),{timeoutMs=10000}={}){
  const results=await Promise.all(REQUIRED_RUNTIME.map(async path=>{
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
    try{
      const response=await fetchImpl(revisionUrl(path),{method:'GET',credentials:'same-origin',cache:'no-store',redirect:'error',signal:controller.signal});
      if(!response.ok)return {path,reason:'http',status:response.status};
      const type=(response.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();
      if(path.endsWith('.css')?type!=='text/css':!JS_TYPES.has(type))return {path,reason:'mime'};
      const source=await response.text();if(!source.slice(0,256).includes(`@web-revision: ${WEB_REVISION}`))return {path,reason:'revision'};
      return null;
    }catch{return {path,reason:'network'};}finally{clearTimeout(timer);}
  }));
  return results.filter(Boolean);
}
export function wireRecovery(doc){
  if(doc.documentElement.dataset.recoveryWired)return;
  doc.documentElement.dataset.recoveryWired=WEB_REVISION;
  const panel=doc.querySelector('#account-panel'),toggle=doc.querySelector('#account-toggle');
  function open(value){panel.open=value;toggle.setAttribute('aria-expanded',String(value));}
  toggle.addEventListener('click',()=>open(!panel.open));
  doc.querySelector('#account-close').addEventListener('click',()=>open(false));
  doc.querySelector('#footer-settings').addEventListener('click',()=>{open(true);panel.scrollIntoView({behavior:'smooth'});});
  panel.addEventListener('toggle',()=>toggle.setAttribute('aria-expanded',String(panel.open)));
}
export function bootApplication(options={}){
  const doc=options.doc||globalThis.document;
  if(BOOT_ATTEMPTS.has(doc))return BOOT_ATTEMPTS.get(doc);
  const attempt=runBoot({...options,doc});BOOT_ATTEMPTS.set(doc,attempt);return attempt;
}
async function runBoot({doc,fetchImpl=globalThis.fetch.bind(globalThis),loadModule=()=>import('/js/main.js?rev=web-v4')}={}){
  wireRecovery(doc);
  const notice=doc.querySelector('#startup-notice'),message=doc.querySelector('#startup-message'),details=doc.querySelector('#startup-details');
  const appLock=doc.querySelector('#app-control-lock'),pairLock=doc.querySelector('#pair-control-lock');
  appLock.disabled=true;pairLock.disabled=true;notice.hidden=false;details.hidden=true;details.replaceChildren();
  message.textContent='正在確認前端檔案與版本…';
  const failures=await checkRuntime(fetchImpl);
  if(failures.length){
    notice.classList.add('error');message.textContent='前端尚未完整載入，功能已暫停。連線設定入口仍可使用；請先完整覆蓋更新檔、確認 WEB_DIR，再重新載入。';
    for(const failure of failures){const item=doc.createElement('li');item.textContent=failureLabel(failure);details.append(item);}details.hidden=false;
    doc.querySelector('#account-panel').open=true;return {ready:false,failures};
  }
  try{
    await loadModule();appLock.disabled=false;pairLock.disabled=false;notice.hidden=true;doc.documentElement.dataset.appRevision=WEB_REVISION;
    return {ready:true,failures:[]};
  }catch{
    notice.classList.add('error');message.textContent='應用程式未完整啟動，功能仍暫停。請完整覆蓋同一版本檔案後重新載入；連線設定入口仍可使用。';
    doc.querySelector('#account-panel').open=true;return {ready:false,failures:[{path:'/js/main.js',reason:'initialization'}]};
  }
}
if(typeof document!=='undefined'&&typeof window!=='undefined'){
  bootApplication().catch(()=>{
    // Native <details>, disabled HTML fieldsets and the reload link still work
    // even if bootstrap itself encounters an unsupported browser condition.
    const notice=document.querySelector('#startup-notice');if(notice){notice.hidden=false;notice.classList.add('error');document.querySelector('#startup-message').textContent='載入尚未完成。請展開連線設定，確認更新檔完整後重新載入。';}
  });
}

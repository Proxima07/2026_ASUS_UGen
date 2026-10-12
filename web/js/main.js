// @web-revision: web-v9
import {Api} from './api.js?rev=web-v9';
import {Bridge} from './bridge.js?rev=web-v9';
import {Actions} from './actions.js?rev=web-v9';
import {Chat} from './chat.js?rev=web-v9';
import {Notes} from './notes.js?rev=web-v9';
import {Recorder} from './recorder.js?rev=web-v9';
import {Voice,CaptureCoordinator} from './voice.js?rev=web-v9';
import {errorMessage,setMessage} from './state.js?rev=web-v9';
import {ConversationCoordinator} from './conversation.js?rev=web-v9';

let identity=null, checking=false, checkAgain=false, loggingOut=false, authGeneration=0, toastTimer, voice=null, connectionIssue=null, nativeRenewals=0;
const capture=new CaptureCoordinator();
const conversations=new ConversationCoordinator();
const account=document.querySelector('#account-panel');
const pairForm=document.querySelector('#pair-form');
const pairMessage=document.querySelector('#pair-message');
const warning=document.querySelector('#connection-warning');
const logout=document.querySelector('#logout-button');
const authenticated=()=>Boolean(identity)&&!loggingOut;
const LOGIN_STAGES={cookie_probe:'網頁 Cookie API 驗證',validate_identity:'核對手機與網頁身分',invalidate_api:'停止舊 API 請求',clear_conversation:'清除舊對話編號',clear_bridge:'停止舊手機操作',clear_actions:'清除舊操作',clear_chat:'清除舊文字對話',clear_notes:'清除舊平台筆記',clear_audio:'清除舊錄音草稿',clear_voice:'清除舊語音指令',bind_session:'啟用已核對登入',bridge_ready:'更新 APK 連線介面',ready:'登入完成'};
function loginError(stage,code){console.error('[local-assistant login]',{phase:stage,code});return {phase:'web_failed',stage,code,message:'登入驗證的介面處理未完成，手機操作已暫停。請按「重新建立登入」；若仍失敗，請重新載入完整網頁更新。'};}
function toast(message){const node=document.querySelector('#toast');node.textContent=message;node.hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>{node.hidden=true;},4500);}
function openAccount(value=true){account.open=value;document.querySelector('#account-toggle').setAttribute('aria-expanded',String(value));}
function tab(name){if(name!=='voice'&&voice?.isBusy())voice.interrupt('已暫停語音。回到首頁後，可以重新說一次。');document.querySelector('#tools-navigation').hidden=name==='voice';document.querySelector('#tools-toggle').textContent=name==='voice'?'其他工具':'返回語音';document.querySelector('#tools-toggle').setAttribute('aria-expanded',String(name!=='voice'));for(const button of document.querySelectorAll('[data-tab]')){const selected=button.dataset.tab===name;button.classList.toggle('active',selected);button.setAttribute('aria-selected',String(selected));}for(const panel of document.querySelectorAll('.tab-panel'))panel.hidden=panel.id!==`panel-${name}`;if(name==='notes'&&authenticated())notes.load();}
function updateAccount(){
  pairForm.hidden=bridge.nativePresent||authenticated();
  const native=bridge.nativePresent,paired=Boolean(bridge.ready&&bridge.identity?.user_id&&bridge.identity?.device_id),phase=connectionIssue?.phase;
  let description=identity?`已連接 · ${identity.label||'你的裝置'}`:'輸入中樞提供的一次性配對碼。登入狀態只保存在這個瀏覽器。';
  let notice='尚未連線。請先完成配對。';
  if(native&&!authenticated()){
    if(paired&&phase==='web_unauthorized'){description='APK 配對有效；網頁登入尚未同步。請按 APK 上方「同步」，不用重新輸入配對碼。';notice='APK 已配對，網頁登入 Cookie 尚未通過驗證（HTTP 401）。請按上方「同步」。';}
    else if(phase==='identity_mismatch'){description='APK 與網頁目前是不同裝置身分，手機操作已停止。請按 APK 上方「同步」更新網頁登入。';notice='手機與網頁的登入身分不一致，請按「同步」重新核對。';}
    else if(phase==='native_revoked'){description='後端確認 APK 裝置配對已失效。請向管理者取得新的配對碼，再到 APK 連線設定完成配對。';notice='APK 裝置配對已失效，需要在手機重新配對。';}
    else if(phase==='renewing_native'){description='正在使用 APK 已保存的配對重新建立網頁登入，不需再次輸入配對碼。';notice='正在重新同步 APK 與網頁登入，請稍候。';}
    else if(phase==='native_failed'){description='手機登入同步未完成。請按 APK 上方「同步」，並查看下方連線處理資訊。';notice='APK 登入同步未完成，請查看連線處理資訊；目前不能執行手機操作。';}
    else if(phase==='web_failed'){description='APK 已開啟；網頁 API 未能完成登入驗證。請查看下方 HTTP 狀態與追蹤 ID。';notice='網頁登入驗證未完成，請查看連線處理資訊或按 APK 上方「同步」。';}
    else if(paired){description='APK 配對已核對，正在驗證網頁登入 Cookie…';notice='正在核對網頁登入，請稍候。';}
    else{description='正在連接 APK 並核對登入狀態…';notice='正在等候 APK 登入同步，請稍候；若停留在這裡，請按上方「同步」。';}
  }
  document.querySelector('#native-pair-tip').hidden=!native||authenticated();
  document.querySelector('#native-pair-tip').textContent=native?'APK 配對與網頁登入是兩個步驟；同步會使用已保存的配對更新網頁 Cookie。':'';
  document.querySelector('#session-description').textContent=description;
  logout.hidden=!authenticated();logout.textContent=native?'解除手機配對':'登出網頁';
  const retry=document.querySelector('#connection-retry');if(retry){retry.hidden=authenticated()||!native&&!connectionIssue;retry.disabled=native?Boolean(bridge.helloMessageId):checking;retry.textContent=native?'重新建立登入':'重新檢查登入';}
  warning.hidden=authenticated();warning.textContent=notice;
  const debug=document.querySelector('#connection-debug');
  if(debug){debug.hidden=!native&&!connectionIssue;if(connectionIssue&&phase!=='web_checking'&&phase!=='connected'&&phase!=='renewing_native')debug.open=true;const fields={version:'web-v9',native:native?(paired?'APK 身分已核對':bridge.ready?'橋接已回覆，但未提供完整身分':'尚未完成橋接'):'一般瀏覽器',web:authenticated()?'Cookie 驗證成功':phase==='web_unauthorized'?'Cookie 未授權':phase==='identity_mismatch'?'身分不一致':phase==='native_failed'?'等待 APK 同步完成':phase==='web_failed'?'驗證失敗':'等待驗證',stage:LOGIN_STAGES[connectionIssue?.stage]||'等待 APK 同步',http:connectionIssue?.status?`HTTP ${connectionIssue.status}`:'尚未取得',code:connectionIssue?.code||'尚未取得',trace:connectionIssue?.httpRequestId||'尚未取得',error:connectionIssue?.message||connectionIssue?.code||'尚無錯誤'};for(const [key,value]of Object.entries(fields)){const node=document.querySelector(`#connection-debug-${key}`);if(node)node.textContent=String(value).slice(0,500);}}
  if(location.protocol!=='https:'){warning.hidden=false;warning.textContent='請使用 HTTPS 網址。登入 Cookie 與麥克風需要安全連線。';}
}
function clearPrivateState(message){
  // Revoke execution permission before touching any DOM. Every owner must be
  // cleared even if one UI cleanup fails; a failed reset cannot authorize a
  // replacement account or leave old private content visible.
  authGeneration++;identity=null;bridge.bindSession(null);let failure=null;
  for(const [stage,reset]of [
    ['invalidate_api',()=>api.invalidateSession()],['clear_conversation',()=>conversations.reset()],
    ['clear_bridge',()=>bridge.clearPrivateOperations()],['clear_actions',()=>actions.stop()],
    ['clear_chat',()=>chat.clear()],['clear_notes',()=>notes.clear()],
    ['clear_audio',()=>recorder.clear()],['clear_voice',()=>voice?.clear(message)],
  ]){try{reset();}catch{const issue=loginError(stage,'login_state_reset_failed');if(!failure)failure=issue;}}
  if(failure){const main=document.querySelector('main');main.inert=true;main.hidden=true;}
  return failure;
}
function signedOut(issue=null){const failure=clearPrivateState();connectionIssue=issue||failure;loggingOut=false;const main=document.querySelector('main');main.inert=Boolean(failure);main.hidden=Boolean(failure);updateAccount();openAccount();}
function recoverNativeSession(manual=false){
  if(!bridge.nativePresent)return verifySession();if(bridge.helloMessageId)return;if(!manual&&nativeRenewals>=1)return;nativeRenewals=1;
  const failure=clearPrivateState('正在重新建立網頁登入，請稍候。');if(failure){connectionIssue=failure;updateAccount();openAccount();return;}connectionIssue={phase:'renewing_native'};updateAccount();
  try{bridge.refreshSession();}catch(error){connectionIssue={phase:'native_failed',message:errorMessage(error)};updateAccount();openAccount();}
}
const api=new Api({onUnauthorized:error=>{if(identity){signedOut({phase:'web_unauthorized',...error});if(bridge.nativePresent)recoverNativeSession();}}});
const bridge=new Bridge({onChange:()=>{try{if(identity&&bridge.identity&&(identity.user_id!==bridge.identity.user_id||identity.device_id!==bridge.identity.device_id)){const failure=clearPrivateState('手機登入身分已更新，正在重新核對。');if(failure){connectionIssue=failure;updateAccount();openAccount();return;}}updateAccount();actions.render();notes.render();if(bridge.ready)verifySession();}catch{signedOut(loginError('bridge_ready','login_ui_failed'));}},onResult:value=>{if(authenticated()){voice?.flow.nativeResult(value).catch(e=>toast(errorMessage(e)));actions.nativeResult(value).catch(e=>toast(errorMessage(e)));}},onError:(message,value)=>{if(value?.request_type==='hello'){connectionIssue={phase:value.error?.code==='native_device_revoked'?'native_revoked':'native_failed',message,code:value.error?.code,status:value.error?.http_status||null,httpRequestId:value.error?.http_request_id||null};updateAccount();openAccount();}if(value?.request_type==='logout'){loggingOut=false;document.querySelector('main').inert=false;updateAccount();}voice?.flow.nativeError(value,message);toast(message);if(authenticated()){actions.busy.clear();actions.refresh().catch(()=>{});}},onLogout:signedOut});
const actions=new Actions({api,bridge,container:document.querySelector('#action-area'),isRequestVisible:id=>conversations.ownsRequest(id),onRequest:record=>chat.update(record),toast});
const notes=new Notes({api,bridge,actions,authenticated,toast});
const chat=new Chat({api,bridge,actions,conversations,authenticated,onNotesChanged:()=>notes.load(),toast});
const recorder=new Recorder({api,bridge,actions,capture,authenticated,onSaved:()=>notes.load(),onTranscript:text=>{if(!text.trim())return toast('逐字稿還沒有內容。');if(text.length>8000)return toast('逐字稿超過對話上限，請先縮短內容。');tab('chat');chat.fill(text);toast('已帶入對話，你可以修正後送出。');},toast});
voice=new Voice({api,bridge,capture,conversations,authenticated,identity:()=>identity,authenticationMessage:()=>warning.textContent,toast});

async function verifySession(){
  if(loggingOut)return;if(bridge.nativePresent&&!bridge.ready){updateAccount();return;}if(checking){checkAgain=true;return;}checking=true;let generation=authGeneration,stage='cookie_probe',checked=null,probeTimer;
  try{
    connectionIssue={phase:'web_checking',stage};updateAccount();
    // The API has its own abort deadline. This independent deadline also
    // closes the coordinator when a transport ignores abort or never settles.
    checked=await Promise.race([api.me(),new Promise((_,reject)=>{probeTimer=setTimeout(()=>reject({code:'web_session_timeout',message:'網頁登入驗證超過 20 秒，已停止等待。請按「重新建立登入」再試。'}),20000);})]);
    clearTimeout(probeTimer);probeTimer=null;if(generation!==authGeneration||loggingOut)return;
    stage='validate_identity';connectionIssue={phase:'web_checking',stage,status:200,httpRequestId:checked?.http_request_id};updateAccount();
    if(!checked.user_id||!checked.device_id)throw new Error('後端沒有回傳完整的登入身分。');
    if(bridge.nativePresent&&(!bridge.identity?.user_id||!bridge.identity?.device_id||checked.user_id!==bridge.identity.user_id||checked.device_id!==bridge.identity.device_id)){
      signedOut({phase:'identity_mismatch',code:'session_identity_mismatch',status:200,httpRequestId:checked.http_request_id});return;
    }
    if(bridge.nativePresent&&checked.auth_kind!=='session'){
      signedOut({phase:'web_failed',code:'cookie_session_required',status:200,httpRequestId:checked.http_request_id,message:'API 回覆成功，但不是 Cookie session 登入。請檢查代理設定。'});return;
    }
    if(!identity||identity.user_id!==checked.user_id||identity.device_id!==checked.device_id){
      const failure=clearPrivateState('登入身分已更新，請重新開始這次指令。');
      // This generation belongs to our own reset, not a superseding login.
      // Errors after it must be reported rather than treated as stale replies.
      generation=authGeneration;if(failure)throw failure;
    }
    stage='bind_session';bridge.bindSession(checked);identity=checked;connectionIssue={phase:'connected',stage:'ready',status:200,httpRequestId:checked.http_request_id};updateAccount();openAccount(false);const main=document.querySelector('main');main.inert=false;main.hidden=false;await Promise.allSettled([actions.start(),notes.load()]);
  }catch(error){
    if(generation!==authGeneration)return;
    let issue;
    if(error.code==='login_state_reset_failed')issue={...error,status:200,httpRequestId:checked?.http_request_id};
    else if(stage!=='cookie_probe')issue={...loginError(stage,'login_ui_failed'),status:200,httpRequestId:checked?.http_request_id};
    else{console.error('[local-assistant login]',{phase:stage,code:error.code||'web_probe_failed'});issue={phase:error.status===401?'web_unauthorized':'web_failed',stage,status:error.status||null,httpRequestId:error.httpRequestId||null,code:error.code,message:error.status===401?'網頁 Cookie 未通過登入驗證。':errorMessage(error)};}
    signedOut(issue);
    if(error.status===401&&bridge.nativePresent)recoverNativeSession();else if(error.status!==401)setMessage(pairMessage,issue.message,true);
  }finally{clearTimeout(probeTimer);checking=false;updateAccount();if(checkAgain){checkAgain=false;verifySession();}}
}
document.querySelector('#connection-retry')?.addEventListener('click',()=>{if(bridge.nativePresent)recoverNativeSession(true);else verifySession();});
for(const button of document.querySelectorAll('[data-tab]'))button.addEventListener('click',()=>tab(button.dataset.tab));
document.querySelector('#new-conversation').addEventListener('click',()=>{conversations.reset();chat.clear();voice?.clear(authenticated()?'新對話已開始，點一下麥克風就可以說話。':'請先完成連線配對。');notes.cancelPendingActions();actions.stop();if(authenticated())actions.start().catch(()=>{});toast('已開啟新對話；已保存的筆記會保留。');});
document.querySelector('#tools-toggle').addEventListener('click',()=>tab(document.querySelector('#tools-navigation').hidden?'chat':'voice'));
document.querySelector('#use-voice-button').addEventListener('click',()=>tab('audio'));
pairForm.addEventListener('submit',async event=>{event.preventDefault();if(bridge.nativePresent)return;const submit=document.querySelector('#pair-submit');submit.disabled=true;clearPrivateState('正在更新配對，請稍候。');identity=null;updateAccount();setMessage(pairMessage,'正在配對…');try{await api.pair(document.querySelector('#pair-code').value.trim(),document.querySelector('#pair-label').value.trim());document.querySelector('#pair-code').value='';setMessage(pairMessage,'');await verifySession();if(authenticated())toast('已連接你的私人中樞。');}catch(e){setMessage(pairMessage,`${errorMessage(e)} 若配對碼已使用，請向管理者取得新的配對碼。`,true);}finally{submit.disabled=false;}});
logout.addEventListener('click',async()=>{clearPrivateState('正在登出，已停止這次指令。');loggingOut=true;document.querySelector('main').inert=true;voice?.interrupt('正在登出，已停止這次語音。');chat.pause();recorder.clear();logout.disabled=true;try{if(bridge.nativePresent){bridge.logout();setMessage(pairMessage,'正在解除手機配對。');}else{await api.logout();signedOut();toast('已登出。');}}catch(e){loggingOut=false;document.querySelector('main').inert=false;setMessage(pairMessage,errorMessage(e),true);}finally{if(!bridge.nativePresent){loggingOut=false;document.querySelector('main').inert=false;}logout.disabled=false;}});
document.addEventListener('visibilitychange',()=>{if(document.hidden)chat.pause();if(!document.hidden)verifySession().then(()=>{if(authenticated()){voice?.flow.refreshDisplay();actions.refresh().catch(()=>{});}});});
bridge.init();updateAccount();if(!bridge.nativePresent)verifySession();

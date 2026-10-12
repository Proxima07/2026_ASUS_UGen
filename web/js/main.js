// @web-revision: web-v4
import {Api} from './api.js?rev=web-v4';
import {Bridge} from './bridge.js?rev=web-v4';
import {Actions} from './actions.js?rev=web-v4';
import {Chat} from './chat.js?rev=web-v4';
import {Notes} from './notes.js?rev=web-v4';
import {Recorder} from './recorder.js?rev=web-v4';
import {Voice,CaptureCoordinator} from './voice.js?rev=web-v4';
import {errorMessage,setMessage} from './state.js?rev=web-v4';

let identity=null, checking=false, checkAgain=false, loggingOut=false, authGeneration=0, toastTimer, voice=null;
const capture=new CaptureCoordinator();
const account=document.querySelector('#account-panel');
const pairForm=document.querySelector('#pair-form');
const pairMessage=document.querySelector('#pair-message');
const warning=document.querySelector('#connection-warning');
const logout=document.querySelector('#logout-button');
const authenticated=()=>Boolean(identity)&&!loggingOut;
function toast(message){const node=document.querySelector('#toast');node.textContent=message;node.hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>{node.hidden=true;},4500);}
function openAccount(value=true){account.open=value;document.querySelector('#account-toggle').setAttribute('aria-expanded',String(value));}
function tab(name){if(name!=='voice'&&voice&&['requesting','recording','uploading','transcribing','understanding','dispatching','waiting','selecting'].includes(voice.flow.state))voice.interrupt('已暫停語音。回到首頁後，可以重新說一次。');document.querySelector('#tools-navigation').hidden=name==='voice';document.querySelector('#tools-toggle').textContent=name==='voice'?'其他工具':'返回語音';document.querySelector('#tools-toggle').setAttribute('aria-expanded',String(name!=='voice'));for(const button of document.querySelectorAll('[data-tab]')){const selected=button.dataset.tab===name;button.classList.toggle('active',selected);button.setAttribute('aria-selected',String(selected));}for(const panel of document.querySelectorAll('.tab-panel'))panel.hidden=panel.id!==`panel-${name}`;if(name==='notes'&&authenticated())notes.load();}
function updateAccount(){
  pairForm.hidden=bridge.nativePresent || authenticated();
  document.querySelector('#native-pair-tip').hidden=!bridge.nativePresent || authenticated();
  document.querySelector('#session-description').textContent=identity?`已連接 · ${identity.label || '你的裝置'}`:bridge.nativePresent?'請在 APK 上方的連線設定配對；登入到期時按「同步」重新連接。':'輸入中樞提供的一次性配對碼。登入狀態只保存在這個瀏覽器。';
  logout.hidden=!authenticated();logout.textContent=bridge.nativePresent?'解除手機配對':'登出網頁';
  warning.hidden=authenticated();warning.textContent=bridge.nativePresent?'請先完成 APK 配對，或按「同步」更新登入狀態。':'尚未連線。請先完成配對。';
  if(location.protocol!=='https:'){warning.hidden=false;warning.textContent='請使用 HTTPS 網址。登入 Cookie 與麥克風需要安全連線。';}
}
function signedOut(){authGeneration++;loggingOut=false;document.querySelector('main').inert=false;identity=null;actions.stop();chat.clear();notes.clear();recorder.clear();voice?.clear();updateAccount();openAccount();}
const api=new Api({onUnauthorized:()=>{if(identity)signedOut();}});
const bridge=new Bridge({onChange:()=>{updateAccount();actions.render();notes.render();if(bridge.ready)verifySession();},onResult:value=>{if(authenticated()){voice?.flow.nativeResult(value).catch(e=>toast(errorMessage(e)));actions.nativeResult(value).catch(e=>toast(errorMessage(e)));}},onError:(message,value)=>{if(value?.request_type==='logout'){loggingOut=false;document.querySelector('main').inert=false;updateAccount();}voice?.flow.nativeError(value,message);toast(message);if(authenticated()){actions.busy.clear();actions.refresh().catch(()=>{});}},onLogout:signedOut});
const actions=new Actions({api,bridge,container:document.querySelector('#action-area'),onRequest:record=>chat.update(record),toast});
const notes=new Notes({api,bridge,actions,authenticated,toast});
const chat=new Chat({api,actions,authenticated,onNotesChanged:()=>notes.load(),toast});
const recorder=new Recorder({api,capture,authenticated,onSaved:()=>notes.load(),onTranscript:text=>{if(!text.trim())return toast('逐字稿還沒有內容。');if(text.length>8000)return toast('逐字稿超過對話上限，請先縮短內容。');tab('chat');chat.fill(text);toast('已帶入對話，你可以修正後送出。');},toast});
voice=new Voice({api,bridge,capture,authenticated,toast});

async function verifySession(){if(loggingOut)return;if(checking){checkAgain=true;return;}checking=true;const generation=authGeneration;try{const checked=await api.me();if(generation!==authGeneration||loggingOut)return;identity=checked;updateAccount();openAccount(false);await Promise.allSettled([actions.start(),notes.load()]);}catch(e){if(generation!==authGeneration)return;signedOut();if(e.status!==401)setMessage(pairMessage,errorMessage(e),true);}finally{checking=false;if(checkAgain){checkAgain=false;verifySession();}}}
for(const button of document.querySelectorAll('[data-tab]'))button.addEventListener('click',()=>tab(button.dataset.tab));
document.querySelector('#tools-toggle').addEventListener('click',()=>tab(document.querySelector('#tools-navigation').hidden?'chat':'voice'));
document.querySelector('#use-voice-button').addEventListener('click',()=>tab('audio'));
pairForm.addEventListener('submit',async event=>{event.preventDefault();if(bridge.nativePresent)return;const submit=document.querySelector('#pair-submit');submit.disabled=true;setMessage(pairMessage,'正在配對…');try{await api.pair(document.querySelector('#pair-code').value.trim(),document.querySelector('#pair-label').value.trim());document.querySelector('#pair-code').value='';setMessage(pairMessage,'');await verifySession();if(authenticated())toast('已連接你的私人中樞。');}catch(e){setMessage(pairMessage,`${errorMessage(e)} 若配對碼已使用，請向管理者取得新的配對碼。`,true);}finally{submit.disabled=false;}});
logout.addEventListener('click',async()=>{loggingOut=true;document.querySelector('main').inert=true;voice?.interrupt('正在登出，已停止這次語音。');recorder.clear();logout.disabled=true;try{if(bridge.nativePresent){bridge.logout();setMessage(pairMessage,'正在解除手機配對。');}else{await api.logout();signedOut();toast('已登出。');}}catch(e){loggingOut=false;document.querySelector('main').inert=false;setMessage(pairMessage,errorMessage(e),true);}finally{if(!bridge.nativePresent){loggingOut=false;document.querySelector('main').inert=false;}logout.disabled=false;}});
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&authenticated()){voice?.flow.refreshDisplay();actions.refresh().catch(()=>{});}});
bridge.init();updateAccount();verifySession();

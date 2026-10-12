import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {mount,settle,deferred} from './dom-fixture.js';
import {Api} from '../js/api.js?rev=web-v9';

const identity={user_id:'user_A',device_id:'dev_A',label:'A',auth_kind:'session'};
const response=(status,value,trace='http_fixture')=>({ok:status>=200&&status<300,status,headers:{get:key=>key==='X-Request-ID'?trace:null},json:async()=>value});

test('登入 probe 的 401 保留 HTTP 追蹤資訊，由 coordinator 決定同步而不先清除 epoch',async()=>{
  let unauthorized=0;const api=new Api({fetchImpl:async()=>response(401,{error:{code:'unauthorized',message:'未登入'}}),onUnauthorized:()=>unauthorized++});
  await assert.rejects(api.me(),error=>error.status===401&&error.httpRequestId==='http_fixture');assert.equal(unauthorized,0);
  await assert.rejects(api.notes(),error=>error.status===401);assert.equal(unauthorized,1);
});

let sequence=0;
async function nativeMount(){
  const document=mount(await readFile(new URL('../index.html',import.meta.url),'utf8'));
  const keys=['document','navigator','location','NativeBridge','MediaRecorder','AudioContext','webkitAudioContext','isSecureContext','fetch','setTimeout','clearTimeout','setInterval','clearInterval'];const descriptors=new Map(keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  const sent=[],requests=[],timers=new Map(),intervals=new Map();let timerId=0;
  const h={document,sent,requests,timers,intervals,me:()=>response(200,identity),actions:()=>response(200,{items:[]})};
  const replace=(key,value)=>Object.defineProperty(globalThis,key,{configurable:true,value});
  replace('document',document);replace('navigator',{});replace('location',{protocol:'https:'});replace('NativeBridge',{postMessage:raw=>sent.push(JSON.parse(raw))});replace('MediaRecorder',undefined);replace('AudioContext',undefined);replace('webkitAudioContext',undefined);replace('isSecureContext',true);
  replace('setTimeout',(fn,ms)=>{const id=++timerId;timers.set(id,{fn,ms});return id;});replace('clearTimeout',id=>timers.delete(id));replace('setInterval',(fn,ms)=>{const id=++timerId;intervals.set(id,{fn,ms});return id;});replace('clearInterval',id=>intervals.delete(id));
  replace('fetch',async path=>{requests.push(path);if(path==='/v1/auth/me')return h.me();if(path==='/v1/actions')return h.actions();if(path.startsWith('/v1/notes?'))return response(200,{items:[]});throw new Error(`unexpected ${path}`);});
  h.reply=async(message,type='ready',extra={})=>{globalThis.NativeBridge.onmessage({data:JSON.stringify({protocol_version:'1',message_id:message.message_id,type,...(type==='ready'?{identity:{user_id:identity.user_id,device_id:identity.device_id},capabilities:['notes.create_native'],recording:{protocol_version:'1'}}:{}),...extra})});await settle();};
  h.restore=()=>{for(const [key,descriptor]of descriptors){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}};
  await import(`../js/main.js?native-auth-${++sequence}`);await settle();return h;
}

test('完整 APK 掛載先等 hello；Cookie 401 自動同步一次，之後只允許明確人工重試',async()=>{
  const h=await nativeMount();try{
    assert.equal(h.requests.length,0);assert.equal(h.sent.length,1);assert.equal(h.sent[0].type,'hello');
    h.me=()=>response(401,{error:{code:'unauthorized',message:'未登入'}},'http_cookie_401');await h.reply(h.sent[0]);
    assert.equal(h.sent.filter(message=>message.type==='hello').length,2);assert.equal(h.requests.filter(path=>path==='/v1/auth/me').length,1);
    await h.reply(h.sent[1]);assert.equal(h.sent.length,2);assert.equal(h.requests.filter(path=>path==='/v1/actions'||path.startsWith('/v1/notes?')).length,0);
    assert.match(h.document.querySelector('#session-description').textContent,/APK 配對有效/);assert.match(h.document.querySelector('#connection-warning').textContent,/HTTP 401/);assert.equal(h.document.querySelector('#pair-form').hidden,true);assert.equal(h.document.querySelector('#connection-debug-trace').textContent,'http_cookie_401');
    const retry=h.document.querySelector('#connection-retry');assert.equal(retry.disabled,false);await retry.emit('click');await retry.emit('click');await settle();assert.equal(h.sent.length,3);
    h.me=()=>response(200,identity);await h.reply(h.sent[2]);assert.equal(h.document.querySelector('#session-description').textContent,'已連接 · A');assert.equal(h.document.querySelector('#connection-warning').hidden,true);
    h.actions=()=>response(401,{error:{code:'unauthorized',message:'未登入'}});for(const timer of [...h.intervals.values()])timer.fn();await settle();
    assert.equal(h.sent.filter(message=>message.type==='hello').length,3);assert.match(h.document.querySelector('#session-description').textContent,/APK 配對有效/);
  }finally{h.restore();}
});

test('Cookie 登入成功但與 APK 身分不同，不載入任何私人資料',async()=>{
  const h=await nativeMount();try{h.me=()=>response(200,{...identity,user_id:'user_B',device_id:'dev_B'});await h.reply(h.sent[0]);assert.equal(h.sent.length,1);assert.deepEqual(h.requests,['/v1/auth/me']);assert.match(h.document.querySelector('#connection-warning').textContent,/身分不一致/);assert.equal(h.document.querySelector('#connection-debug-web').textContent,'身分不一致');assert.equal(h.document.querySelector('#logout-button').hidden,true);}finally{h.restore();}
});

test('較早 Cookie probe 晚到的 401 不會推翻更新後 hello 與新的登入驗證',async()=>{
  const h=await nativeMount(),old=deferred();try{
    h.me=()=>old.promise;await h.reply(h.sent[0]);assert.deepEqual(h.requests,['/v1/auth/me']);
    const retry=h.document.querySelector('#connection-retry');assert.equal(retry.disabled,false);await retry.emit('click');await settle();assert.equal(h.sent.length,2);
    h.me=()=>response(200,identity);await h.reply(h.sent[1]);old.resolve(response(401,{error:{code:'unauthorized',message:'舊 Cookie 未登入'}}));await settle();
    assert.equal(h.document.querySelector('#session-description').textContent,'已連接 · A');assert.equal(h.document.querySelector('#connection-warning').hidden,true);assert.equal(h.sent.length,2);assert.equal(h.requests.filter(path=>path==='/v1/auth/me').length,2);
  }finally{h.restore();}
});

test('相同裝置的 Bearer 成功不能冒充 Cookie 登入驗證成功',async()=>{
  const h=await nativeMount();try{h.me=()=>response(200,{...identity,auth_kind:'device'});await h.reply(h.sent[0]);assert.deepEqual(h.requests,['/v1/auth/me']);assert.match(h.document.querySelector('#connection-debug-error').textContent,/不是 Cookie session/);assert.equal(h.document.querySelector('#connection-warning').hidden,false);}finally{h.restore();}
});

test('APK hello 逾時不無限等待；晚到 ready 不啟用舊身分，手動重試可恢復',async()=>{
  const h=await nativeMount();try{const old=h.sent[0];const timeout=[...h.timers.values()].find(timer=>timer.ms===60000);assert.ok(timeout);timeout.fn();await settle();assert.equal(h.document.querySelector('#connection-retry').disabled,false);assert.match(h.document.querySelector('#connection-debug-error').textContent,/逾時/);await h.reply(old);assert.equal(h.requests.length,0);await h.document.querySelector('#connection-retry').emit('click');await settle();await h.reply(h.sent[1]);assert.equal(h.document.querySelector('#session-description').textContent,'已連接 · A');}finally{h.restore();}
});

test('WebView API 網路錯誤與原生 Cookie 錯誤分開顯示，不自動重新配對',async()=>{
  const h=await nativeMount();try{h.me=()=>Promise.reject(new Error('private transport details'));await h.reply(h.sent[0]);assert.equal(h.sent.length,1);assert.match(h.document.querySelector('#connection-debug-error').textContent,/連線中斷/);assert.doesNotMatch(h.document.querySelector('#connection-debug-error').textContent,/private transport/);assert.equal(h.document.querySelector('#pair-form').hidden,true);await h.document.querySelector('#connection-retry').emit('click');await settle();await h.reply(h.sent[1],'error',{error:{code:'session_cookie_rejected',http_status:401,message:'WebView Cookie 未通過驗證'}});assert.match(h.document.querySelector('#connection-debug-error').textContent,/Cookie/);assert.equal(h.document.querySelector('#connection-debug-http').textContent,'HTTP 401');assert.equal(h.document.querySelector('#connection-retry').disabled,false);}finally{h.restore();}
});

test('Cookie 200 後錄音草稿清理失敗不再停在驗證中，顯示階段並停止全部私人操作',async()=>{
  const h=await nativeMount(),logs=[],originalError=console.error;console.error=(...values)=>logs.push(values);
  try{
    const playback=h.document.querySelector('#record-playback'),remove=playback.removeAttribute;
    playback.removeAttribute=()=>{throw new TypeError('private playback content must never enter logs');};
    h.document.querySelector('#voice-transcript').textContent='上一個帳號的語音';
    h.me=()=>response(200,identity,'http_cookie_proven');await h.reply(h.sent[0]);
    assert.deepEqual(h.requests,['/v1/auth/me']);assert.equal(h.document.querySelector('#logout-button').hidden,true);
    assert.equal(h.document.querySelector('#connection-debug-code').textContent,'login_state_reset_failed');
    assert.equal(h.document.querySelector('#connection-debug-stage').textContent,'清除舊錄音草稿');
    assert.equal(h.document.querySelector('#connection-debug-http').textContent,'HTTP 200');
    assert.equal(h.document.querySelector('#connection-debug-trace').textContent,'http_cookie_proven');
    assert.equal(h.document.querySelector('#connection-debug').open,true);assert.equal(h.document.querySelector('main').hidden,true);
    assert.equal(h.document.querySelector('#voice-transcript').textContent,'');
    assert.doesNotMatch(JSON.stringify(logs),/private playback|上一個帳號/);
    assert.deepEqual(logs[0],['[local-assistant login]',{phase:'clear_audio',code:'login_state_reset_failed'}]);
    await h.document.querySelector('#voice-mic').emit('click');await settle();
    assert.match(h.document.querySelector('#toast').textContent,/網頁登入驗證未完成/);assert.equal(h.sent.length,1);
    playback.removeAttribute=remove;await h.document.querySelector('#connection-retry').emit('click');await settle();await h.reply(h.sent[1]);
    assert.equal(h.document.querySelector('#session-description').textContent,'已連接 · A');assert.equal(h.document.querySelector('main').hidden,false);
  }finally{console.error=originalError;h.restore();}
});

test('一次清理中的多個 DOM 故障不阻止後續清理，未清空內容保持隱藏',async()=>{
  const h=await nativeMount(),pending=deferred(),originalError=console.error;console.error=()=>{};
  try{
    h.me=()=>pending.promise;await h.reply(h.sent[0]);
    const actions=h.document.querySelector('#action-area'),notes=h.document.querySelector('#notes-list'),playback=h.document.querySelector('#record-playback');let audioClears=0;
    actions.replaceChildren=()=>{throw new Error('old action private body');};
    const old=h.document.createElement('p');old.textContent='previous private note';notes.append(old);notes.replaceChildren=()=>{throw new Error('old note private body');};
    playback.removeAttribute=()=>{audioClears++;throw new Error('old audio private body');};h.document.querySelector('#voice-transcript').textContent='old transcript';
    pending.resolve(response(200,identity));await settle();
    assert.equal(h.document.querySelector('#connection-debug-stage').textContent,'清除舊操作');assert.ok(audioClears>=1);
    assert.equal(h.document.querySelector('#voice-transcript').textContent,'');assert.ok(notes.children.includes(old));
    assert.equal(h.document.querySelector('main').hidden,true);assert.equal(h.document.querySelector('main').inert,true);assert.deepEqual(h.requests,['/v1/auth/me']);
  }finally{console.error=originalError;h.restore();}
});

test('ready 的附屬筆記 render 失敗在 Cookie probe 前也會顯示錯誤，可以人工恢復',async()=>{
  const h=await nativeMount(),originalError=console.error;console.error=()=>{};
  try{
    const list=h.document.querySelector('#notes-list'),append=list.append;list.append=()=>{throw new Error('private render payload');};
    await h.reply(h.sent[0]);assert.deepEqual(h.requests,[]);assert.equal(h.document.querySelector('#connection-debug-code').textContent,'login_ui_failed');
    assert.equal(h.document.querySelector('#connection-debug-stage').textContent,'更新 APK 連線介面');assert.equal(h.document.querySelector('#connection-debug').open,true);
    assert.doesNotMatch(h.document.querySelector('#pair-message').textContent,/private render/);
    list.append=append;await h.document.querySelector('#connection-retry').emit('click');await settle();await h.reply(h.sent[1]);
    assert.equal(h.document.querySelector('#session-description').textContent,'已連接 · A');
  }finally{console.error=originalError;h.restore();}
});

test('Cookie transport 不回覆且忽略 abort 時，獨立 20 秒期限停止等待；晚到 200 不授權',async()=>{
  const h=await nativeMount(),old=deferred(),originalError=console.error;console.error=()=>{};
  try{
    h.me=()=>old.promise;await h.reply(h.sent[0]);assert.equal(h.document.querySelector('#connection-debug-stage').textContent,'網頁 Cookie API 驗證');
    const watchdog=[...h.timers.values()].find(timer=>timer.ms===20000);assert.ok(watchdog);watchdog.fn();await settle();
    assert.equal(h.document.querySelector('#connection-debug-code').textContent,'web_session_timeout');assert.match(h.document.querySelector('#pair-message').textContent,/20 秒/);
    old.resolve(response(200,identity));await settle();assert.equal(h.document.querySelector('#logout-button').hidden,true);assert.deepEqual(h.requests,['/v1/auth/me']);
    await h.document.querySelector('#connection-retry').emit('click');await settle();h.me=()=>response(200,identity);await h.reply(h.sent[1]);
    assert.equal(h.document.querySelector('#session-description').textContent,'已連接 · A');
  }finally{console.error=originalError;h.restore();}
});

test('登入成功提交介面出錯也撤銷已指定的身分，不吞自己的 generation 轉換',async()=>{
  const h=await nativeMount(),originalError=console.error;console.error=()=>{};
  try{
    const toggle=h.document.querySelector('#account-toggle'),set=toggle.setAttribute;
    toggle.setAttribute=function(key,value){if(value==='false')throw new Error('private commit details');return set.call(this,key,value);};
    await h.reply(h.sent[0]);assert.equal(h.document.querySelector('#connection-debug-code').textContent,'login_ui_failed');
    assert.equal(h.document.querySelector('#connection-debug-stage').textContent,'啟用已核對登入');assert.equal(h.document.querySelector('#connection-debug-http').textContent,'HTTP 200');
    assert.equal(h.document.querySelector('#logout-button').hidden,true);assert.deepEqual(h.requests,['/v1/auth/me']);
    assert.doesNotMatch(h.document.querySelector('#pair-message').textContent,/private commit/);
    await h.document.querySelector('#voice-mic').emit('click');await settle();assert.equal(h.sent.length,1);
  }finally{console.error=originalError;h.restore();}
});

test('已有登入的 401 遇上清理故障先撤銷權限，不保留舊帳號或重新執行手機操作',async()=>{
  const h=await nativeMount(),originalError=console.error;console.error=()=>{};
  try{
    await h.reply(h.sent[0]);assert.equal(h.document.querySelector('#session-description').textContent,'已連接 · A');
    h.document.querySelector('#record-playback').removeAttribute=()=>{throw new Error('private old session');};
    h.actions=()=>response(401,{error:{code:'unauthorized',message:'未登入'}});
    for(const timer of [...h.intervals.values()])timer.fn();await settle();
    assert.equal(h.document.querySelector('#logout-button').hidden,true);assert.equal(h.document.querySelector('main').hidden,true);
    assert.equal(h.document.querySelector('#connection-debug-code').textContent,'login_state_reset_failed');
    await h.document.querySelector('#voice-mic').emit('click');await settle();assert.equal(h.sent.length,1);
  }finally{console.error=originalError;h.restore();}
});

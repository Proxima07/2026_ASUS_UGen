import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {mount,settle,deferred} from './dom-fixture.js';
import {Api} from '../js/api.js?rev=web-v8';

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

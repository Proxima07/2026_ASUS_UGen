import test from 'node:test';
import assert from 'node:assert/strict';
import {Api,ApiError} from '../js/api.js?rev=web-v8';

const response=(body,status=200)=>({ok:status>=200&&status<300,status,json:async()=>body});
test('預設瀏覽器 fetch 綁定全域物件，避免 Window 接收者檢查造成 Illegal invocation',async()=>{
  const original=globalThis.fetch;
  const calls=[];
  globalThis.fetch=function(path,options){
    if(this!==globalThis)throw new TypeError('Illegal invocation');
    calls.push({path,options});
    return Promise.resolve(response({device_id:'fixture'}));
  };
  try {
    const api=new Api();
    assert.equal((await api.me()).device_id,'fixture');
    assert.equal(calls.length,1);
    assert.equal(calls[0].path,'/v1/auth/me');
    assert.equal(calls[0].options.redirect,'error');
  } finally {globalThis.fetch=original;}
});
test('API 只使用同來源、HttpOnly Cookie、禁止轉址，不將裝置 token 放進一般請求',async()=>{let captured;const api=new Api({fetchImpl:async(path,options)=>{captured={path,options};return response({items:[]});}});await api.notes('私人想法');assert.equal(captured.path,'/v1/notes?q=%E7%A7%81%E4%BA%BA%E6%83%B3%E6%B3%95');assert.equal(captured.options.credentials,'same-origin');assert.equal(captured.options.redirect,'error');assert.equal(captured.options.cache,'no-store');assert.equal(captured.options.headers.Authorization,undefined);await assert.rejects(()=>api.request('https://other.example/v1/notes'),/同來源/);});
test('配對憑證只換取安全 session，交換後移除原物件 token',async()=>{const calls=[];const paired={token:'private-device-token',device_id:'dev1'};const api=new Api({fetchImpl:async(path,options)=>{calls.push({path,options});return response(path.endsWith('/pair')?paired:{device_id:'dev1'});}});const result=await api.pair('one-use-code','我的手機');assert.equal(calls[1].path,'/v1/auth/session');assert.equal(calls[1].options.headers.Authorization,'Bearer private-device-token');assert.equal(paired.token,undefined);assert.equal(result.token,undefined);});
test('配對 session 失敗仍移除 token',async()=>{const paired={token:'secret'};const api=new Api({fetchImpl:async(path)=>response(path.endsWith('/pair')?paired:{error:{code:'failed',message:'連線失敗'}},path.endsWith('/pair')?200:503)});await assert.rejects(()=>api.pair('pair-code','browser'),/連線失敗/);assert.equal(paired.token,undefined);});
test('重試 chat 保留傳入的 idempotency_key，不在 API helper 重建',async()=>{const bodies=[];const api=new Api({fetchImpl:async(path,options)=>{bodies.push(JSON.parse(options.body));return response({request_id:'req1'});}});await api.chat('幫我設鬧鐘','same-key');await api.chat('幫我設鬧鐘','same-key');assert.equal(bodies[0].idempotency_key,bodies[1].idempotency_key);});
test('音訊使用 raw body 與 audio MIME，不包成 JSON 或 multipart',async()=>{let options;const api=new Api({fetchImpl:async(_,o)=>{options=o;return response({job_id:'job1'},202);}});const blob=new Blob(['audio'],{type:'audio/webm'});await api.uploadAudio(blob,'audio/webm');assert.equal(options.body,blob);assert.equal(options.headers['Content-Type'],'audio/webm');});
test('401 清除登入狀態並保留可讀錯誤',async()=>{let revoked=false;const api=new Api({onUnauthorized:()=>{revoked=true;},fetchImpl:async()=>response({error:{code:'unauthorized',message:'請先配對'}},401)});await assert.rejects(()=>api.notes(),error=>error instanceof ApiError&&error.status===401&&error.code==='unauthorized');assert.equal(revoked,true);});
test('Tunnel 回傳 HTML 時顯示部署錯誤，不渲染原回應',async()=>{const api=new Api({fetchImpl:async()=>({ok:true,status:200,json:async()=>{throw new SyntaxError('<html>private error');}})});await assert.rejects(()=>api.me(),error=>error.code==='invalid_response'&&!error.message.includes('private error'));});
test('語音 command 音訊使用專用 query，不先產生摘要筆記',async()=>{let captured;const api=new Api({fetchImpl:async(path,options)=>{captured={path,options};return response({job_id:'job1'},202);}});const blob=new Blob(['audio'],{type:'audio/webm'});await api.uploadCommandAudio(blob,'audio/webm');assert.equal(captured.path,'/v1/audio?purpose=command');assert.equal(captured.options.body,blob);});
test('語音 chat 傳遞手機優先與原生能力；文字工具同樣預設手機記事本',async()=>{const bodies=[];const api=new Api({fetchImpl:async(_,options)=>{bodies.push(JSON.parse(options.body));return response({request_id:'req1'});}});await api.chat('記下靈感','voice-key',{noteTarget:'phone_first',nativeCapabilities:['notes.create_native']});await api.chat('記下靈感','text-key');assert.equal(bodies[0].note_target,'phone_first');assert.deepEqual(bodies[0].native_capabilities,['notes.create_native']);assert.equal(bodies[1].note_target,'phone_first');assert.deepEqual(bodies[1].native_capabilities,[]);});
test('音訊工作 ID 只在語音來源傳入 chat，不污染一般文字指令',async()=>{const bodies=[];const api=new Api({fetchImpl:async(_,options)=>{bodies.push(JSON.parse(options.body));return response({request_id:'req1'});}});await api.chat('語音文字','voice-key',{sourceJobId:'job1'});await api.chat('一般文字','text-key');assert.equal(bodies[0].source_job_id,'job1');assert.equal('source_job_id'in bodies[1],false);});
test('server HTTP Request ID 與 pipeline trace_id 分開保留，不互相覆蓋',async()=>{const api=new Api({fetchImpl:async()=>({...response({request_id:'req1',trace_id:'audio_upload_trace'}),headers:new Headers({'X-Request-ID':'chat_http_id'})})});const value=await api.chat('語音','key',{sourceJobId:'job1'});assert.equal(value.trace_id,'audio_upload_trace');assert.equal(value.http_request_id,'chat_http_id');});
test('HTTP API 失敗保留 server Request ID，舊 fake response 無 headers 仍相容',async()=>{const api=new Api({fetchImpl:async()=>({...response({error:{code:'stt_disabled',message:'尚未配置本地轉錄'}},503),headers:new Headers({'X-Request-ID':'error_http_id'})})});await assert.rejects(()=>api.uploadCommandAudio(new Blob(['a']),'audio/webm'),error=>error.httpRequestId==='error_http_id'&&error.code==='stt_disabled');});

import test from 'node:test';
import assert from 'node:assert/strict';
import {Api} from '../js/api.js?rev=web-v8';
import {Bridge} from '../js/bridge.js?rev=web-v8';
import {CaptureCoordinator,CaptureSession,NativeCaptureSession} from '../js/capture.js?rev=web-v8';
import {VoiceFlow} from '../js/voice.js?rev=web-v8';
import {Recorder} from '../js/recorder.js?rev=web-v8';

const deferred=()=>{let resolve;const promise=new Promise(ok=>resolve=ok);return {promise,resolve};};
const response=(status,value)=>({ok:status>=200&&status<300,status,json:async()=>value});
const identity={user_id:'user_A',device_id:'dev_A'};
const timers=()=>{let count=0;const pending=new Map();return {pending,setTimer(fn,ms){const id=++count;pending.set(id,{fn,ms});return id;},clearTimer(id){pending.delete(id);}};};

test('登入身分更新後，舊成功筆記回覆和舊 401 都不能影響新帳號',async()=>{
  for(const status of [200,401]){
    const request=deferred();let unauthorized=0;
    const api=new Api({fetchImpl:()=>request.promise,onUnauthorized:()=>unauthorized++});
    const pending=api.notes();api.invalidateSession();request.resolve(response(status,{items:[{content:'A private'}]}));
    await assert.rejects(pending,error=>error.code==='stale_session');assert.equal(unauthorized,0);
  }
});

test('瀏覽器麥克風沒有回覆時期限到達可重新錄音，晚到 stream 被停止',async()=>{
  const clock=timers(),capture=new CaptureCoordinator(),permission=deferred();let stopped=0,errors=0;
  const session=new CaptureSession({coordinator:capture,token:capture.acquire('voice'),...clock,onError:()=>errors++});
  const pending=session.requestStream(()=>permission.promise);
  const [{fn,ms}]=clock.pending.values();assert.equal(ms,15000);fn();assert.equal(await pending,null);
  assert.equal(capture.owner,null);assert.equal(errors,1);const next=capture.acquire('next');
  permission.resolve({getTracks:()=>[{stop:()=>stopped++}]});await Promise.resolve();
  assert.equal(stopped,1);assert.equal(capture.owner,next);assert.equal(clock.pending.size,0);
});

test('取消仍在等待的 permission promise 立即結束，不必等使用者允許',async()=>{
  const clock=timers(),permission=deferred(),capture=new CaptureCoordinator();let stopped=0;
  const session=new CaptureSession({coordinator:capture,token:capture.acquire('voice'),...clock});
  const pending=session.requestStream(()=>permission.promise);session.cancel();assert.equal(await pending,null);
  permission.resolve({getTracks:()=>[{stop:()=>stopped++}]});await Promise.resolve();
  assert.equal(stopped,1);assert.equal(capture.owner,null);assert.equal(clock.pending.size,0);
});

function nativeFixture(){
  const oldNative=globalThis.NativeBridge,sent=[];globalThis.NativeBridge={postMessage:raw=>sent.push(JSON.parse(raw))};
  const bridge=new Bridge();bridge.nativePresent=true;bridge.ready=true;bridge.identity=identity;bridge.bindSession(identity);bridge.recording={protocol_version:'1'};
  const receive=(message,type,extra={})=>bridge.receive({protocol_version:'1',message_id:message.message_id,type,...extra});
  return {bridge,sent,receive,restore(){bridge.cancelRecording();if(oldNative===undefined)delete globalThis.NativeBridge;else globalThis.NativeBridge=oldNative;}};
}

test('APK 錄製完整音檔後，JS 只收到工作 metadata；已停止的錄音不會重複送出',()=>{
  const h=nativeFixture(),clock=timers(),capture=new CaptureCoordinator(),phases=[],jobs=[];
  try{
    const session=new NativeCaptureSession({bridge:h.bridge,identity,coordinator:capture,token:capture.acquire('voice'),...clock,onPhase:phase=>phases.push(phase),onUploaded:job=>jobs.push(job)});
    assert.equal(session.start(),true);const start=h.sent[0];assert.equal(start.type,'recording_start');assert.equal(start.expected_device_id,identity.device_id);
    h.receive(start,'recording_started',{recording_id:'record_1'});assert.equal(session.state,'recording');assert.ok(h.bridge.pending.has(start.message_id));
    session.stop();session.stop();const stop=h.sent.find(message=>message.type==='recording_stop');assert.equal(h.sent.filter(message=>message.type==='recording_stop').length,1);assert.equal(capture.owner,null);
    h.receive(start,'recording_uploaded',{recording_id:'record_1',job_id:'wrong',purpose:'command'});assert.equal(jobs.length,0);
    h.receive(stop,'recording_uploading',{recording_id:'record_1'});
    h.receive(stop,'recording_uploaded',{recording_id:'record_1',job_id:'audio_job',purpose:'command',status:'queued'});
    h.receive(stop,'recording_uploaded',{recording_id:'record_1',job_id:'audio_job',purpose:'command'});
    assert.equal(jobs.length,1);assert.deepEqual(phases,['recording','stopping','uploading']);assert.equal(h.bridge.recordingSession,null);assert.equal(clock.pending.size,0);
    assert.ok(h.sent.every(message=>!('audio' in message)&&!('base64' in message)));
  }finally{h.restore();}
});

test('APK 與網頁不同身分不能錄音或執行 action',()=>{
  const h=nativeFixture();try{h.bridge.capabilities.add('phone.dial');h.bridge.bindSession({user_id:'user_B',device_id:'dev_B'});assert.throws(()=>h.bridge.execute('action','phone.dial'),/身分/);assert.throws(()=>h.bridge.startRecording({user_id:'user_B',device_id:'dev_B'},()=>{}),/身分/);assert.equal(h.sent.length,0);}finally{h.restore();}
});

test('APK 取消權限等待後，新 recorder 不接受舊 started 事件',()=>{
  const h=nativeFixture(),clock=timers(),capture=new CaptureCoordinator();
  try{
    const first=new NativeCaptureSession({bridge:h.bridge,identity,coordinator:capture,token:capture.acquire('voice'),...clock});first.start();const old=h.sent[0];first.cancel();
    const next=new NativeCaptureSession({bridge:h.bridge,identity,coordinator:capture,token:capture.acquire('voice'),...clock});next.start();const owner=capture.owner;
    h.receive(old,'recording_started',{recording_id:'old_record'});assert.equal(first.state,'cancelled');assert.equal(next.state,'requesting');assert.equal(capture.owner,owner);
    assert.equal(h.sent[1].type,'recording_cancel');assert.equal(h.sent[1].start_message_id,old.message_id);next.cancel();
  }finally{h.restore();}
});

test('原生上傳結果只觸發 STT 工作查詢，不再將音訊交給瀏覽器上傳',async()=>{
  let uploads=0,polls=0,chats=0;
  const flow=new VoiceFlow({api:{uploadCommandAudio:async()=>uploads++,audioJob:async()=>{polls++;return {status:'transcribed',transcript:'計時十分鐘'};},chat:async()=>{chats++;return {request_id:'request_1'};},getRequest:async()=>({request_id:'request_1',status:'completed'})},bridge:{ready:false,capabilities:new Set()},isAuthorized:()=>true,isForeground:()=>true});
  const run=flow.begin();flow.recording(run);await flow.acceptUploadedJob(run,{job_id:'audio_1',status:'queued'});await flow.acceptUploadedJob(run,{job_id:'audio_1',status:'queued'});
  assert.equal(uploads,0);assert.equal(polls,1);assert.equal(chats,1);assert.equal(flow.state,'completed');
});

test('原生錄音上限與 upload timeout 都取消並釋放 owner，晚到工作不進入 STT',()=>{
  for(const afterStop of [false,true]){
    const h=nativeFixture(),clock=timers(),capture=new CaptureCoordinator();let errors=0,jobs=0;
    try{const session=new NativeCaptureSession({bridge:h.bridge,identity,coordinator:capture,token:capture.acquire('voice'),...clock,onError:()=>errors++,onUploaded:()=>jobs++});session.start();h.receive(h.sent[0],'recording_started',{recording_id:'r1'});if(afterStop)session.stop();const stop=h.sent.find(x=>x.type==='recording_stop');const [{fn,ms}]=clock.pending.values();assert.equal(ms,afterStop?135000:180000);fn();if(stop)h.receive(stop,'recording_uploaded',{recording_id:'r1',job_id:'late',purpose:'command'});assert.equal(errors,1);assert.equal(jobs,0);assert.equal(capture.owner,null);assert.equal(h.bridge.recordingSession,null);}finally{h.restore();}
  }
});

test('錄音草稿預設只建立記事本 handoff action；平台儲存必須明確指定',async()=>{
  const oldDocument=Object.getOwnPropertyDescriptor(globalThis,'document');const nodes=new Map();
  Object.defineProperty(globalThis,'document',{configurable:true,value:{querySelector:id=>{if(!nodes.has(id))nodes.set(id,{textContent:'',disabled:false,classList:{toggle(){}}});return nodes.get(id);}}});
  const calls=[];const recorder={authenticated:()=>true,generation:0,title:{value:'備忘'},content:{value:'週五帶報告'},transcript:{value:''},saveAttempt:null,toast:()=>{},onSaved:()=>calls.push('refresh-platform'),bridge:{supports:kind=>kind==='notes.create_native',execute:(id,kind)=>calls.push([id,kind])},actions:{trackIndependent:action=>calls.push(['track',action.action_id])},api:{createNativeNoteAction:async()=>{calls.push('native-action');return {action_id:'action_native'};},createNote:async()=>calls.push('platform-note')}};
  try{await Recorder.prototype.save.call(recorder);assert.equal(calls.includes('platform-note'),false);assert.equal(calls.includes('native-action'),true);assert.deepEqual(calls.find(Array.isArray),['track','action_native']);assert.match(nodes.get('#audio-save-message').textContent,/記事本 App 儲存/);calls.length=0;await Recorder.prototype.save.call(recorder,'platform');assert.deepEqual(calls,['platform-note','refresh-platform']);}
  finally{if(oldDocument)Object.defineProperty(globalThis,'document',oldDocument);else delete globalThis.document;}
});

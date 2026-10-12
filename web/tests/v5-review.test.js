import test from 'node:test';
import assert from 'node:assert/strict';
import {CaptureCoordinator,CaptureSession} from '../js/capture.js?rev=web-v9';
import {Voice} from '../js/voice.js?rev=web-v9';
import {Recorder} from '../js/recorder.js?rev=web-v9';

function recording({stopThrows=false,synchronousStop=false}={}){
  const handlers=new Map();
  return {
    state:'inactive',mimeType:'audio/webm',stopCalls:0,
    addEventListener(type,handler){const list=handlers.get(type)||[];list.push(handler);handlers.set(type,list);},
    start(){this.state='recording';},
    stop(){this.stopCalls++;if(stopThrows)throw new Error('device stop failure');this.state='inactive';if(synchronousStop)this.emit('stop');},
    emit(type,value={}){for(const handler of handlers.get(type)||[])handler(value);}
  };
}
function fixture({recorder=recording(),tracks,context,stopTimeoutMs=3000,maxBytes}={}){
  const coordinator=new CaptureCoordinator(),token=coordinator.acquire('voice');
  const timerCallbacks=new Map(),phases=[],blobs=[],errors=[],cancellations=[];
  let timerSequence=0;
  const ordinaryTrack={stops:0,stop(){this.stops++;}};
  const stream={getTracks:()=>tracks||[ordinaryTrack]};
  const session=new CaptureSession({
    coordinator,token,stopTimeoutMs,maxBytes,
    setTimer(fn,ms){const id=++timerSequence;timerCallbacks.set(id,{fn,ms});return id;},
    clearTimer(id){timerCallbacks.delete(id);},
    onPhase:phase=>phases.push(phase),onBlob:blob=>blobs.push(blob),
    onError:error=>errors.push(error),onCancel:()=>cancellations.push(true)
  });
  session.attach(stream,recorder);if(context)session.setContext(context);
  return {session,coordinator,token,recorder,stream,ordinaryTrack,timerCallbacks,phases,blobs,errors,cancellations};
}
function addAudio(recorder,text='audio'){recorder.emit('dataavailable',{data:new Blob([text],{type:'audio/webm'})});}

test('review: 手動停止立即釋放持有權，等待最終音訊時不鎖住下一次錄音',async()=>{
  const h=fixture();h.session.start();addAudio(h.recorder,'before');
  assert.equal(h.session.stop(true),true);
  assert.equal(h.coordinator.owner,null);assert.equal(h.ordinaryTrack.stops,1);
  assert.equal(h.session.state,'stopping');assert.equal(h.blobs.length,0);
  addAudio(h.recorder,'final');h.recorder.emit('stop');
  h.recorder.emit('stop');addAudio(h.recorder,'late');h.recorder.emit('error');
  assert.equal(h.blobs.length,1);assert.equal(await h.blobs[0].text(),'beforefinal');
  assert.equal(h.errors.length,0);assert.equal(h.timerCallbacks.size,0);
  assert.equal(h.session.state,'stopped');
});

test('review: recorder.stop／track.stop／AudioContext.close 同步拋錯仍關閉其餘 track 並可重錄',()=>{
  let ordinaryStops=0,closeCalls=0;
  const h=fixture({recorder:recording({stopThrows:true}),
    tracks:[{stop(){throw new Error('bad track');}},{stop(){ordinaryStops++;}}],
    context:{close(){closeCalls++;throw new Error('bad context');}}});
  h.session.start();addAudio(h.recorder);
  assert.doesNotThrow(()=>h.session.stop());
  assert.equal(ordinaryStops,1);assert.equal(closeCalls,1);assert.equal(h.coordinator.owner,null);
  assert.equal(h.session.state,'failed');assert.equal(h.blobs.length,0);assert.equal(h.errors.length,1);
  assert.ok(h.coordinator.acquire('advanced'));assert.equal(h.timerCallbacks.size,0);
  h.recorder.emit('stop');h.recorder.emit('error');
  assert.equal(h.errors.length,1);assert.equal(h.blobs.length,0);
});

test('review: AudioContext.close 非同步拒絕不延遲停止與鎖釋放',async()=>{
  const h=fixture({context:{close:()=>Promise.reject(new Error('close rejected'))}});
  h.session.start();addAudio(h.recorder);h.session.stop();
  assert.equal(h.coordinator.owner,null);assert.equal(h.session.state,'stopping');
  await Promise.resolve();h.recorder.emit('stop');
  assert.equal(h.blobs.length,1);assert.equal(h.errors.length,0);
});

test('review: stop event 遺失有 watchdog，晚到的音訊與 stop 不得事後送出',()=>{
  const h=fixture({stopTimeoutMs:31});h.session.start();addAudio(h.recorder);
  h.session.stop();h.session.stop();
  assert.equal(h.recorder.stopCalls,1);assert.equal(h.timerCallbacks.size,1);
  const [{fn,ms}]=h.timerCallbacks.values();assert.equal(ms,31);fn();
  assert.equal(h.coordinator.owner,null);assert.equal(h.session.state,'failed');
  assert.equal(h.errors.length,1);assert.match(h.errors[0].message,/沒有完成收尾/);
  addAudio(h.recorder,'late');h.recorder.emit('stop');fn();
  assert.equal(h.errors.length,1);assert.equal(h.blobs.length,0);assert.equal(h.timerCallbacks.size,0);
});

test('review: 已按停止但尚未送出的錄音仍可捨棄，不會晚到後自動上傳',()=>{
  const h=fixture();h.session.start();addAudio(h.recorder);h.session.stop(true);
  h.session.cancel();h.session.cancel();
  assert.equal(h.session.state,'cancelled');assert.equal(h.cancellations.length,1);
  assert.equal(h.coordinator.owner,null);assert.equal(h.timerCallbacks.size,0);
  addAudio(h.recorder,'late');h.recorder.emit('stop');h.recorder.emit('error');
  assert.equal(h.blobs.length,0);assert.equal(h.errors.length,0);
});

test('review: 權限等待時取消立即釋放，晚到 stream 被關閉且不啟動 recorder',()=>{
  const coordinator=new CaptureCoordinator(),token=coordinator.acquire('voice');
  let cancellations=0,stopped=0,starts=0;
  const session=new CaptureSession({coordinator,token,onCancel:()=>cancellations++});
  session.cancel();assert.equal(coordinator.owner,null);assert.equal(cancellations,1);
  const newer=coordinator.acquire('advanced');
  const stream={getTracks:()=>[{stop:()=>stopped++}]};
  const recorder={start:()=>starts++,addEventListener(){throw new Error('must not attach');}};
  assert.equal(session.attach(stream,recorder),false);assert.equal(session.start(),false);
  assert.equal(stopped,1);assert.equal(starts,0);assert.equal(coordinator.owner,newer);
});

test('review: 舊 session 的晚到 stop／cancel 不解除新 owner 或關閉新 stream',()=>{
  const h=fixture();h.session.start();addAudio(h.recorder);h.session.stop();
  const newToken=h.coordinator.acquire('advanced');
  let newStops=0,newCloseCalls=0;
  const nextRecorder=recording();
  const next=new CaptureSession({coordinator:h.coordinator,token:newToken});
  next.attach({getTracks:()=>[{stop:()=>newStops++}]},nextRecorder);
  next.setContext({close:()=>newCloseCalls++});next.start();
  h.recorder.emit('stop');h.session.release();h.session.cancel();h.recorder.emit('error');
  assert.equal(h.coordinator.owner,newToken);assert.equal(next.state,'recording');
  assert.equal(newStops,0);assert.equal(newCloseCalls,0);assert.equal(h.blobs.length,1);
  next.cancel();assert.equal(newStops,1);assert.equal(newCloseCalls,1);assert.equal(h.coordinator.owner,null);
});

test('review: 同步 stop event 只產生一次 blob，callback 時麥克風已可重新取得',()=>{
  const h=fixture({recorder:recording({synchronousStop:true})});
  let callbackToken=null;h.session.onBlob=blob=>{h.blobs.push(blob);callbackToken=h.coordinator.acquire('advanced');};
  h.session.start();addAudio(h.recorder);h.session.stop();
  assert.equal(h.session.state,'stopped');assert.equal(h.blobs.length,1);
  assert.ok(callbackToken);assert.equal(h.coordinator.owner,callbackToken);
  h.recorder.emit('stop');h.session.release();assert.equal(h.coordinator.owner,callbackToken);
  h.coordinator.release(callbackToken);
});

test('review: 非使用者要求的 stop 會失敗並清除 partial audio，不能冒充完整錄音',()=>{
  const h=fixture();h.session.start();addAudio(h.recorder);h.recorder.state='inactive';h.recorder.emit('stop');
  assert.equal(h.session.state,'failed');assert.equal(h.coordinator.owner,null);
  assert.equal(h.errors.length,1);assert.equal(h.blobs.length,0);
  h.recorder.emit('stop');assert.equal(h.errors.length,1);
});

test('review: 音訊超過上限立即捨棄並釋放，不讓晚到 stop 送出超大音檔',()=>{
  const h=fixture({maxBytes:3});h.session.start();addAudio(h.recorder,'four');
  assert.equal(h.session.state,'failed');assert.equal(h.coordinator.owner,null);
  assert.equal(h.errors.length,1);assert.equal(h.session.chunks.length,0);
  h.recorder.emit('stop');assert.equal(h.blobs.length,0);
});

test('review: 結束沒有 dataavailable 的錄音回報失敗，仍可再錄音',()=>{
  const h=fixture();h.session.start();h.session.stop();h.recorder.emit('stop');
  assert.equal(h.session.state,'failed');assert.equal(h.errors.length,1);assert.equal(h.blobs.length,0);
  assert.equal(h.coordinator.owner,null);assert.equal(h.timerCallbacks.size,0);
  assert.ok(h.coordinator.acquire('voice'));
});

test('review: stop 等待期間 recorder error 清掉 watchdog，重複錯誤不重複通知',()=>{
  const h=fixture();h.session.start();addAudio(h.recorder);h.session.stop();
  const [{fn}]=h.timerCallbacks.values();h.recorder.emit('error');fn();h.recorder.emit('error');h.recorder.emit('stop');
  assert.equal(h.session.state,'failed');assert.equal(h.errors.length,1);
  assert.equal(h.timerCallbacks.size,0);assert.equal(h.blobs.length,0);assert.equal(h.coordinator.owner,null);
});

test('review: getTracks 失敗不影響 AudioContext 清理與持有權釋放',()=>{
  const h=fixture();let closes=0;
  h.session.stream={getTracks(){throw new Error('stream missing');}};
  h.session.setContext({close:()=>closes++});h.session.cancel();
  assert.equal(closes,1);assert.equal(h.coordinator.owner,null);assert.equal(h.session.state,'cancelled');
});

test('review: 已釋放的 session 不接受晚到的 AudioContext，立即關閉且不動新 owner',()=>{
  const h=fixture();h.session.cancel();const newer=h.coordinator.acquire('advanced');let closes=0;
  assert.equal(h.session.setContext({close(){closes++;throw new Error('closed too late');}}),false);
  assert.equal(closes,1);assert.equal(h.coordinator.owner,newer);assert.equal(h.session.context,null);
});

test('review: 停止的 UI 回呼或 watchdog 設定拋錯也不留下麥克風鎖',()=>{
  for(const failAt of ['phase','timer']){
    const h=fixture();h.session.start();addAudio(h.recorder);
    if(failAt==='phase')h.session.onPhase=()=>{throw new Error('UI render failure');};
    else h.session.setTimer=()=>{throw new Error('timer setup failure');};
    assert.doesNotThrow(()=>h.session.stop());assert.equal(h.coordinator.owner,null);
    assert.equal(h.session.state,'failed');assert.equal(h.errors.length,1);assert.equal(h.blobs.length,0);
  }
});

test('review: 尚未取得 recorder 的停止不得在權限晚到後重新啟動',()=>{
  const coordinator=new CaptureCoordinator(),token=coordinator.acquire('voice');let errors=0,trackStops=0;
  const session=new CaptureSession({coordinator,token,onError:()=>errors++});
  session.stop(true);assert.equal(coordinator.owner,null);assert.equal(session.finalized,true);assert.equal(errors,1);
  assert.equal(session.attach({getTracks:()=>[{stop:()=>trackStops++}]},recording()),false);
  assert.equal(session.start(),false);assert.equal(trackStops,1);
});

function deferred(){let resolve,reject;const promise=new Promise((ok,no)=>{resolve=ok;reject=no;});return {promise,resolve,reject};}
function browserFixture({permission,constructorThrows=false,stopThrows=false,resume}={}){
  const keys=['navigator','isSecureContext','document','MediaRecorder','AudioContext','webkitAudioContext','performance','setInterval','clearInterval','setTimeout','clearTimeout'];
  const descriptors=new Map(keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  const nodes=new Map(),events=new Map(),intervals=new Map(),timeouts=new Map(),recorders=[];
  let now=0,timerSequence=0,trackStops=0,contextCloses=0,uploads=0;
  const node=()=>({textContent:'',value:'',hidden:false,disabled:false,files:[],listeners:new Map(),attributes:new Map(),classList:{toggle(){}},
    addEventListener(type,fn){this.listeners.set(type,fn);},setAttribute(key,value){this.attributes.set(key,value);},
    replaceChildren(){},append(){},removeAttribute(key){this.attributes.delete(key);}});
  const doc={hidden:false,querySelector(selector){if(!nodes.has(selector))nodes.set(selector,node());return nodes.get(selector);},
    addEventListener(type,fn){const callbacks=events.get(type)||[];callbacks.push(fn);events.set(type,callbacks);},
    emit(type){for(const fn of events.get(type)||[])fn();},createElement:node};
  const stream={getTracks:()=>[{stop:()=>trackStops++}]};
  class MediaRecorderStub{
    constructor(){if(constructorThrows)throw new Error('unsupported media recorder');const recorder=recording({stopThrows});recorders.push(recorder);return recorder;}
    static isTypeSupported(){return true;}
  }
  class AudioContextStub{
    constructor(){return {resume:()=>resume||Promise.resolve(),close:()=>{contextCloses++;return Promise.resolve();},
      createMediaStreamSource:()=>({connect(){}}),createAnalyser:()=>({fftSize:2048,getFloatTimeDomainData(values){values.fill(0);}})};}
  }
  const replace=(key,value)=>Object.defineProperty(globalThis,key,{configurable:true,value});
  replace('navigator',{mediaDevices:{getUserMedia:()=>permission?.promise||Promise.resolve(stream)}});
  replace('isSecureContext',true);replace('document',doc);replace('MediaRecorder',MediaRecorderStub);
  replace('AudioContext',AudioContextStub);replace('webkitAudioContext',undefined);replace('performance',{now:()=>now});
  replace('setInterval',(fn,ms)=>{const id=++timerSequence;intervals.set(id,{fn,ms});return id;});
  replace('clearInterval',id=>intervals.delete(id));
  replace('setTimeout',(fn,ms)=>{const id=++timerSequence;timeouts.set(id,{fn,ms});return id;});
  replace('clearTimeout',id=>timeouts.delete(id));
  const coordinator=new CaptureCoordinator(),uploadPending=deferred();
  const api={uploadCommandAudio:()=>{uploads++;return uploadPending.promise;}};
  const voice=new Voice({api,bridge:{ready:false,capabilities:new Set()},capture:coordinator,authenticated:()=>true});
  return {voice,coordinator,stream,doc,nodes,intervals,timeouts,recorders,uploadPending,
    get trackStops(){return trackStops;},get contextCloses(){return contextCloses;},get uploads(){return uploads;},
    advance(ms){now+=ms;for(const {fn}of [...intervals.values()])fn();},
    restore(){voice.interrupt('test cleanup');for(const [key,descriptor]of descriptors){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}}
  };
}

test('review: Voice 實際按取消後仍在前景，晚到麥克風權限不開始錄音或上傳',async()=>{
  const permission=deferred(),h=browserFixture({permission});
  try{
    const pending=h.voice.start();assert.equal(h.voice.flow.state,'requesting');
    assert.equal(h.nodes.get('#voice-cancel').hidden,false);
    h.nodes.get('#voice-cancel').listeners.get('click')();
    assert.equal(h.coordinator.owner,null);assert.equal(h.voice.session,null);
    permission.resolve(h.stream);await pending;
    assert.equal(h.recorders.length,0);assert.equal(h.trackStops,1);assert.equal(h.uploads,0);
    assert.equal(h.voice.flow.state,'paused');
  }finally{h.restore();}
});

test('review: Voice 權限等待時離開背景再回來，晚到 stream 仍被捨棄',async()=>{
  const permission=deferred(),h=browserFixture({permission});
  try{
    const pending=h.voice.start();h.doc.hidden=true;h.doc.emit('visibilitychange');h.doc.hidden=false;
    permission.resolve(h.stream);await pending;
    assert.equal(h.coordinator.owner,null);assert.equal(h.recorders.length,0);assert.equal(h.trackStops,1);
    assert.equal(h.voice.flow.state,'paused');assert.equal(h.uploads,0);
  }finally{h.restore();}
});

test('review: AudioContext.resume 無回覆仍有計時，手動停止可釋放並只送出一次',async()=>{
  const resume=deferred(),h=browserFixture({resume:resume.promise});
  try{
    await h.voice.start();assert.equal(h.voice.flow.state,'recording');
    h.advance(2300);assert.equal(h.nodes.get('#voice-time').textContent,'00:02');
    assert.equal(h.nodes.get('#voice-stop').disabled,false);addAudio(h.recorders[0]);
    h.nodes.get('#voice-stop').listeners.get('click')();
    assert.equal(h.coordinator.owner,null);assert.equal(h.voice.flow.state,'stopping');
    assert.equal(h.intervals.size,0);assert.equal(h.contextCloses,1);
    h.recorders[0].emit('stop');h.recorders[0].emit('stop');
    assert.equal(h.uploads,1);assert.equal(h.voice.flow.state,'uploading');
    resume.resolve();await Promise.resolve();assert.equal(h.intervals.size,0);
  }finally{h.restore();}
});

test('review: Voice recorder 建構失敗也要停止剛取得的麥克風 stream',async()=>{
  const h=browserFixture({constructorThrows:true});
  try{
    await h.voice.start();assert.equal(h.voice.flow.state,'failed');assert.equal(h.coordinator.owner,null);
    assert.equal(h.trackStops,1);assert.equal(h.uploads,0);assert.equal(h.voice.session,null);
  }finally{h.restore();}
});

test('review: Voice 實際停止拋錯後可立刻重錄，舊 recorder 回呼不污染新錄音',async()=>{
  const h=browserFixture({stopThrows:true});
  try{
    await h.voice.start();const oldRecorder=h.recorders[0];addAudio(oldRecorder);
    h.nodes.get('#voice-stop').listeners.get('click')();
    assert.equal(h.coordinator.owner,null);assert.equal(h.voice.flow.state,'failed');assert.equal(h.trackStops,1);
    await h.voice.start();const newSession=h.voice.session,newToken=h.coordinator.owner;
    assert.equal(h.voice.flow.state,'recording');assert.notEqual(newSession,null);
    oldRecorder.emit('stop');oldRecorder.emit('error');addAudio(oldRecorder,'late');
    assert.equal(h.voice.session,newSession);assert.equal(h.coordinator.owner,newToken);
    assert.equal(h.voice.flow.state,'recording');assert.equal(h.trackStops,1);assert.equal(h.uploads,0);
  }finally{h.restore();}
});

test('review: Voice 停止無回呼逾時後可再錄音，晚到舊 stop 不會送出錄音',async()=>{
  const h=browserFixture();
  try{
    await h.voice.start();const oldRecorder=h.recorders[0];addAudio(oldRecorder);h.voice.stop();
    const watchdog=[...h.timeouts.values()].find(item=>item.ms===3000);assert.ok(watchdog);
    watchdog.fn();assert.equal(h.voice.flow.state,'failed');assert.equal(h.coordinator.owner,null);
    await h.voice.start();const newSession=h.voice.session;
    oldRecorder.emit('stop');addAudio(oldRecorder,'late');
    assert.equal(h.voice.session,newSession);assert.equal(h.voice.flow.state,'recording');assert.equal(h.uploads,0);
  }finally{h.restore();}
});

test('review: Recorder 建構錄音器失敗關閉 stream 並恢復可錄音狀態',async()=>{
  const h=browserFixture({constructorThrows:true});
  const recorder=new Recorder({api:{},capture:h.coordinator,authenticated:()=>true});
  try{
    await recorder.start();assert.equal(h.coordinator.owner,null);assert.equal(h.trackStops,1);
    assert.equal(recorder.recordingBusy,false);assert.equal(recorder.session,null);
    assert.equal(recorder.startButton.disabled,false);assert.match(recorder.message.textContent,/unsupported media recorder/);
  }finally{recorder.clear();h.restore();}
});

test('review: Recorder 停止拋錯可重錄，舊音訊不覆寫新錄音或釋放新 owner',async()=>{
  const h=browserFixture({stopThrows:true});
  const recorder=new Recorder({api:{},capture:h.coordinator,authenticated:()=>true});
  try{
    await recorder.start();const oldRecorder=h.recorders[0];addAudio(oldRecorder);recorder.stop();
    assert.equal(h.coordinator.owner,null);assert.equal(h.trackStops,1);assert.equal(recorder.recordingBusy,false);
    await recorder.start();const newSession=recorder.session,newToken=h.coordinator.owner;
    oldRecorder.emit('stop');oldRecorder.emit('error');addAudio(oldRecorder,'late');
    assert.equal(recorder.session,newSession);assert.equal(h.coordinator.owner,newToken);
    assert.equal(recorder.recordingBusy,true);assert.equal(recorder.blob,null);assert.equal(h.trackStops,1);
  }finally{recorder.clear();h.restore();}
});

test('review: Recorder 收尾中離開背景取消，晚到終止事件不產生可上傳音檔',async()=>{
  const h=browserFixture(),recorder=new Recorder({api:{},capture:h.coordinator,authenticated:()=>true});
  try{
    await recorder.start();const oldRecorder=h.recorders[0];addAudio(oldRecorder);recorder.stop();
    assert.equal(h.coordinator.owner,null);h.doc.hidden=true;h.doc.emit('visibilitychange');h.doc.hidden=false;
    oldRecorder.emit('stop');addAudio(oldRecorder,'late');
    assert.equal(recorder.blob,null);assert.equal(recorder.session,null);assert.equal(recorder.recordingBusy,false);
    assert.equal(h.timeouts.size,0);assert.equal(h.intervals.size,0);
  }finally{recorder.clear();h.restore();}
});

test('review: Recorder 前景可用停止按鈕取消權限等待，晚到 stream 不會建立錄音器',async()=>{
  const permission=deferred(),h=browserFixture({permission});
  const recorder=new Recorder({api:{},capture:h.coordinator,authenticated:()=>true});
  try{
    const pending=recorder.start();assert.equal(recorder.stopButton.disabled,false);
    assert.match(recorder.stopButton.textContent,/取消/);recorder.stopButton.listeners.get('click')();
    assert.equal(h.coordinator.owner,null);
    permission.resolve(h.stream);await pending;
    assert.equal(h.recorders.length,0);assert.equal(h.trackStops,1);assert.equal(recorder.blob,null);
    assert.equal(recorder.recordingBusy,false);assert.equal(recorder.startButton.disabled,false);
  }finally{recorder.clear();h.restore();}
});

test('review: Voice 錄音收尾時可開始 Recorder，Voice 晚到 stop 不停止進階錄音',async()=>{
  const h=browserFixture(),recorder=new Recorder({api:{},capture:h.coordinator,authenticated:()=>true});
  try{
    await h.voice.start();const voiceRecorder=h.recorders[0];addAudio(voiceRecorder);h.voice.stop();
    await recorder.start();const advancedSession=recorder.session,newToken=h.coordinator.owner;
    assert.equal(advancedSession.state,'recording');voiceRecorder.emit('stop');
    assert.equal(h.uploads,1);assert.equal(recorder.session,advancedSession);
    assert.equal(h.coordinator.owner,newToken);assert.equal(advancedSession.state,'recording');assert.equal(h.trackStops,1);
  }finally{recorder.clear();h.restore();}
});

test('review: Recorder 正常收尾只保存一次完整 blob，新的 Voice 不被舊 callback 清理',async()=>{
  const h=browserFixture(),recorder=new Recorder({api:{},capture:h.coordinator,authenticated:()=>true});
  try{
    await recorder.start();assert.equal(recorder.stopButton.textContent,'停止錄音');
    const oldRecorder=h.recorders[0];addAudio(oldRecorder,'first');recorder.stop();
    await h.voice.start();const voiceSession=h.voice.session,newToken=h.coordinator.owner;
    addAudio(oldRecorder,'final');oldRecorder.emit('stop');oldRecorder.emit('stop');
    assert.equal(await recorder.blob.text(),'firstfinal');assert.equal(h.voice.session,voiceSession);
    assert.equal(h.coordinator.owner,newToken);assert.equal(voiceSession.state,'recording');assert.equal(h.trackStops,1);
  }finally{recorder.clear();h.restore();}
});

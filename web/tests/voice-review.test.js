import test from 'node:test';
import assert from 'node:assert/strict';
import {VoiceFlow,Voice,CaptureCoordinator} from '../js/voice.js?rev=web-v6';
import {Bridge} from '../js/bridge.js?rev=web-v6';
import {Recorder} from '../js/recorder.js?rev=web-v6';

function deferred(){let resolve;let reject;const promise=new Promise((ok,no)=>{resolve=ok;reject=no;});return {promise,resolve,reject};}
function harness(overrides={}){
  let foreground=true,authorized=true,sequence=0;
  const executions=[],chats=[],records=[],timers=new Map();
  const api={
    uploadCommandAudio:async()=>({job_id:'job_current'}),
    audioJob:async()=>({status:'transcribed',transcript:'幫我設定七點鬧鐘'}),
    chat:async(...args)=>{chats.push(args);return {request_id:'req_current'};},
    getRequest:async()=>({request_id:'req_current',status:'completed',message:'已完成'}),
    ...overrides.api
  };
  const bridge={ready:true,capabilities:new Set(['alarm.create','phone.dial','contacts.search','notes.save_local']),supports:()=>true,execute:(id,kind)=>{const message_id=`message_${executions.length+1}`;executions.push({id,kind,message_id});return message_id;},...overrides.bridge};
  const flow=new VoiceFlow({api,bridge,isAuthorized:()=>authorized,isForeground:()=>foreground,onRecord:record=>records.push(record),makeId:prefix=>`${prefix}_${++sequence}`,setTimer:(fn)=>{const id=++sequence;timers.set(id,fn);return id;},clearTimer:id=>timers.delete(id)});
  return {flow,api,bridge,executions,chats,records,timers,setForeground:value=>{foreground=value;},setAuthorized:value=>{authorized=value;}};
}
function actionRecord({request='req_current',id='act_current',kind='alarm.create',state='pending_confirmation'}={}){
  return {request_id:request,status:'awaiting_device',action_id:id,action:{action_id:id,request_id:request,kind,state,payload:{hour:7,minute:0}}};
}

// Listing/history events do not enter the VoiceFlow at all. Even an unsolicited
// native result must never create a permit to execute an older server action.
test('頁面初始／未開始語音時，原生結果不建立自動操作權限',async()=>{
  const h=harness();
  assert.equal(await h.flow.nativeResult({message_id:'old',action_id:'old'}),false);
  assert.equal(h.executions.length,0);assert.equal(h.flow.run,null);
});
test('本地 STT 完成後只送一次 LLM，且帶手機優先與實際橋接能力',async()=>{
  const h=harness();const run=h.flow.begin();
  await Promise.all([h.flow.submitTranscript(run,'幫我寫筆記'),h.flow.submitTranscript(run,'幫我寫筆記')]);
  assert.equal(h.chats.length,1);assert.equal(h.chats[0][2].noteTarget,'phone_first');
  assert.deepEqual(h.chats[0][2].nativeCapabilities,['alarm.create','phone.dial','contacts.search','notes.save_local']);
});
test('背景停止後晚到的 STT 即使回到前景也不送 LLM',async()=>{
  const audio=deferred();const h=harness({api:{audioJob:()=>audio.promise}});
  const run=h.flow.begin();const pending=h.flow.acceptAudio(run,new Blob(['audio'],{type:'audio/webm'}));
  await Promise.resolve();h.setForeground(false);h.flow.cancel('背景已暫停');h.setForeground(true);
  audio.resolve({status:'transcribed',transcript:'幫我打電話給媽媽'});await pending;
  assert.equal(h.chats.length,0);assert.equal(h.executions.length,0);
});
test('解除配對後晚到的 LLM 不會領取或執行手機操作',async()=>{
  const chat=deferred();let reads=0;const h=harness({api:{chat:()=>chat.promise,getRequest:async()=>{reads++;return actionRecord();}}});
  const run=h.flow.begin();const pending=h.flow.submitTranscript(run,'幫我設定鬧鐘');
  h.setAuthorized(false);h.flow.cancel('已解除配對');chat.resolve({request_id:'req_current'});await pending;
  assert.equal(reads,0);assert.equal(h.executions.length,0);
});
test('只有同一語音請求且 request/action 相符的待確認操作可自動送出',async()=>{
  const h=harness();const run=h.flow.begin();run.requestId='req_current';
  await h.flow.processRecord(run,actionRecord({request:'req_other'}));
  await h.flow.processRecord(run,{...actionRecord(),action:{...actionRecord().action,request_id:'req_other'}});
  assert.equal(h.executions.length,0);assert.equal(h.flow.state,'failed');
});
test('同一 action 的重複請求更新及不確定錯誤不會自動重試',async()=>{
  const h=harness();const run=h.flow.begin();run.requestId='req_current';
  await h.flow.processRecord(run,actionRecord());await h.flow.processRecord(run,actionRecord());
  assert.equal(h.executions.length,1);
  assert.equal(h.flow.nativeError({message_id:h.executions[0].message_id},'結果尚未同步'),true);
  await h.flow.processRecord(run,actionRecord());
  assert.equal(h.executions.length,1);assert.equal(h.flow.state,'failed');
});
test('claimed／逾時操作不在新的語音前景流程中重做',async()=>{
  for(const state of ['claimed','expired','execution_expired']){
    const h=harness();const run=h.flow.begin();run.requestId='req_current';
    await h.flow.processRecord(run,actionRecord({state}));
    assert.equal(h.executions.length,0);assert.equal(h.flow.state,'failed');
  }
});
test('原生結果必須同時對上 message ID 與 action ID 才允許下一步',async()=>{
  let reads=0;const h=harness({api:{getRequest:async()=>{reads++;return {request_id:'req_current',status:'cancelled',message:'已取消'};}}});
  const run=h.flow.begin();run.requestId='req_current';await h.flow.processRecord(run,actionRecord());
  const sent=h.executions[0];
  assert.equal(await h.flow.nativeResult({message_id:'other',action_id:sent.id}),false);
  assert.equal(await h.flow.nativeResult({message_id:sent.message_id,action_id:'other'}),false);
  assert.equal(reads,0);
  assert.equal(await h.flow.nativeResult({message_id:sent.message_id,action_id:sent.id}),true);
  assert.equal(reads,1);assert.equal(h.executions.length,1);
  assert.equal(await h.flow.nativeResult({message_id:sent.message_id,action_id:sent.id}),false);
});
test('聯絡人搜尋的後續撥號只自動送出新 action，一個 request 可接續而不重放搜尋',async()=>{
  const h=harness({api:{getRequest:async()=>actionRecord({id:'act_dial',kind:'phone.dial'})}});
  const run=h.flow.begin();run.requestId='req_current';await h.flow.processRecord(run,actionRecord({id:'act_lookup',kind:'contacts.search'}));
  const lookup=h.executions[0];await h.flow.nativeResult({message_id:lookup.message_id,action_id:lookup.id});
  assert.deepEqual(h.executions.map(e=>e.id),['act_lookup','act_dial']);
  assert.equal(await h.flow.nativeResult({message_id:lookup.message_id,action_id:lookup.id}),false);
  assert.equal(h.executions.length,2);
});
test('背景中到達的聯絡人結果不能自動開啟撥號介面',async()=>{
  let reads=0;const h=harness({api:{getRequest:async()=>{reads++;return actionRecord({id:'act_dial',kind:'phone.dial'});}}});
  const run=h.flow.begin();run.requestId='req_current';await h.flow.processRecord(run,actionRecord({kind:'contacts.search'}));
  h.setForeground(false);const sent=h.executions[0];
  assert.equal(await h.flow.nativeResult({message_id:sent.message_id,action_id:sent.id}),false);
  assert.equal(reads,0);assert.equal(h.executions.length,1);
});
test('不認識的筆記候選 ID 不會被送給後端，合法選擇不可雙擊重送',async()=>{
  const selection=deferred();const selected=[];
  const h=harness({api:{selectNote:(request,id)=>{selected.push({request,id});return selection.promise;},getRequest:async()=>({request_id:'req_current',status:'completed',message:'已完成'})}});
  const run=h.flow.begin();run.requestId='req_current';
  await h.flow.processRecord(run,{request_id:'req_current',status:'needs_note_selection',note_candidates:[{candidate_id:'valid',title:'課程'}]});
  await h.flow.choose('invalid');assert.equal(selected.length,0);
  const first=h.flow.choose('valid'),second=h.flow.choose('valid');
  selection.resolve({});await Promise.all([first,second]);assert.deepEqual(selected,[{request:'req_current',id:'valid'}]);
});
test('待麥克風權限期間離開畫面，晚到的 stream 立即關閉且不建立 recorder',async()=>{
  const permission=deferred();const oldNavigator=Object.getOwnPropertyDescriptor(globalThis,'navigator');const oldSecure=Object.getOwnPropertyDescriptor(globalThis,'isSecureContext');
  let stopped=0;const stream={getTracks:()=>[{stop:()=>{stopped++;}}]};
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaDevices:{getUserMedia:()=>permission.promise}}});
  Object.defineProperty(globalThis,'isSecureContext',{configurable:true,value:true});
  const h=harness();const capture=new CaptureCoordinator();
  const fake={flow:h.flow,capture,authenticated:()=>true,toast:()=>{},time:{},level:{},session:null,stream:null,recorder:null,captureToken:null,captureRun:null,chunks:[],interrupted:false,
    releaseCapture(token){for(const track of this.stream?.getTracks()||[])track.stop();this.stream=null;this.capture.release(token);if(this.captureToken===token)this.captureToken=null;}};
  try{
    Object.setPrototypeOf(fake,Voice.prototype);const start=Voice.prototype.start.call(fake);h.setForeground(false);Voice.prototype.interrupt.call(fake,'已離開畫面');h.setForeground(true);
    permission.resolve(stream);await start;assert.equal(stopped,1);assert.equal(fake.recorder,null);assert.equal(capture.owner,null);
  }finally{if(oldNavigator)Object.defineProperty(globalThis,'navigator',oldNavigator);else delete globalThis.navigator;if(oldSecure)Object.defineProperty(globalThis,'isSecureContext',oldSecure);else delete globalThis.isSecureContext;}
});
test('Bridge 拒絕未知訊息、錯配 action 與重複回覆，不污染已送的操作',()=>{
  const oldNative=globalThis.NativeBridge;const sent=[],results=[],errors=[];
  globalThis.NativeBridge={postMessage:raw=>sent.push(JSON.parse(raw))};
  try{
    const bridge=new Bridge({onResult:result=>results.push(result),onError:(message,value)=>errors.push({message,value})});bridge.nativePresent=true;bridge.ready=true;bridge.capabilities=new Set(['alarm.create']);
    const id=bridge.execute('act_current','alarm.create');
    bridge.receive({protocol_version:'1',type:'action_result',message_id:'unknown',action_id:'act_current',state:'completed'});
    bridge.receive({protocol_version:'1',type:'action_result',message_id:id,action_id:'act_wrong',state:'completed'});
    assert.equal(results.length,0);assert.equal(bridge.pending.size,1);
    const result={protocol_version:'1',type:'action_result',message_id:id,action_id:'act_current',state:'completed'};
    bridge.receive(result);bridge.receive(result);assert.equal(results.length,1);assert.equal(bridge.pending.size,0);
    const errorId=bridge.execute('act_failure','alarm.create');
    bridge.receive({protocol_version:'1',type:'error',message_id:errorId,error:{code:'claim_uncertain',message:'可能已執行'}});
    assert.equal(errors.length,1);assert.equal(errors[0].value.action_id,'act_failure');assert.equal(errors[0].value.request_type,'execute_action');
  }finally{if(oldNative===undefined)delete globalThis.NativeBridge;else globalThis.NativeBridge=oldNative;}
});

test('進階錄音工具在麥克風授權等待時切入背景，不會晚到後開始錄音',async()=>{
  const permission=deferred();const descriptors=new Map(['navigator','isSecureContext','document','MediaRecorder'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  let created=0,stopped=0;const node={textContent:'',classList:{toggle(){}}};
  const doc={hidden:false,querySelector:()=>node};const stream={getTracks:()=>[{stop:()=>{stopped++;}}]};
  class FakeRecorder{constructor(){created++;this.state='inactive';this.mimeType='audio/webm';}static isTypeSupported(){return true;}addEventListener(){}start(){this.state='recording';}stop(){this.state='inactive';}}
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaDevices:{getUserMedia:()=>permission.promise}}});
  Object.defineProperty(globalThis,'isSecureContext',{configurable:true,value:true});
  Object.defineProperty(globalThis,'document',{configurable:true,value:doc});
  Object.defineProperty(globalThis,'MediaRecorder',{configurable:true,value:FakeRecorder});
  const capture=new CaptureCoordinator();
  const fake={capture,captureToken:null,authenticated:()=>true,toast:()=>{},uploading:false,recorder:null,startButton:{},stopButton:{},file:{},generation:0,stream:null,timer:null,message:node,status:node,
    setRecording(){},stop(){this.recorder?.stop();},releaseMicrophone(){clearInterval(this.timer);for(const track of this.stream?.getTracks()||[])track.stop();this.stream=null;this.capture.release(this.captureToken);this.captureToken=null;}};
  try{const start=Recorder.prototype.start.call(fake);doc.hidden=true;permission.resolve(stream);await start;assert.equal(created,0);assert.equal(stopped,1);assert.equal(capture.owner,null);}
  finally{fake.releaseMicrophone();for(const [key,descriptor] of descriptors){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}}
});

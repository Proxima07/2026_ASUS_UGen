import test from 'node:test';
import assert from 'node:assert/strict';
import {CaptureCoordinator,CaptureSession,NativeCaptureSession} from '../js/capture.js?rev=web-v10';
import {deferred} from './dom-fixture.js';

// Web IDL operations accept an omitted/global receiver, but not the recorder
// object. Use ordinary functions so accidental this rebinding remains visible.
function browserTimers(){
  const descriptors=new Map(['setTimeout','clearTimeout'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  const pending=new Map();let sequence=0;
  const check=value=>{if(value!==undefined&&value!==null&&value!==globalThis)throw new TypeError('Illegal invocation');};
  Object.defineProperty(globalThis,'setTimeout',{configurable:true,value:function(fn,ms){check(this);const id=++sequence;pending.set(id,{fn,ms});return id;}});
  Object.defineProperty(globalThis,'clearTimeout',{configurable:true,value:function(id){check(this);return pending.delete(id);}});
  return {pending,restore(){for(const [key,descriptor]of descriptors)Object.defineProperty(globalThis,key,descriptor);}};
}

test('瀏覽器錄音使用預設 timer 可取得 stream、結束並交付一個完整音檔',async()=>{
  const clock=browserTimers(),coordinator=new CaptureCoordinator(),blobs=[],phases=[];let tracksStopped=0;
  try{
    const session=new CaptureSession({coordinator,token:coordinator.acquire('voice'),onBlob:blob=>blobs.push(blob),onPhase:phase=>phases.push(phase)});
    const stream={getTracks:()=>[{stop:()=>tracksStopped++}]};
    assert.equal(await session.requestStream(async()=>stream),stream);assert.equal(clock.pending.size,0);
    const callbacks=new Map(),recorder={state:'inactive',mimeType:'audio/webm',addEventListener:(type,callback)=>callbacks.set(type,callback),start(){this.state='recording';},stop(){this.state='inactive';}};
    session.attach(stream,recorder);assert.equal(session.start(),true);
    callbacks.get('dataavailable')({data:new Blob(['recorded audio'])});
    assert.equal(session.stop(true),true);assert.equal(coordinator.owner,null);assert.equal(tracksStopped,1);
    assert.ok([...clock.pending.values()].some(timer=>timer.ms===3000));
    callbacks.get('stop')();callbacks.get('stop')();
    assert.deepEqual(phases,['recording','stopping']);assert.equal(blobs.length,1);assert.equal(blobs[0].type,'audio/webm');assert.equal(clock.pending.size,0);
  }finally{clock.restore();}
});

test('瀏覽器預設 timer 取消權限等待時立即釋放 owner，晚到 stream 不影響新錄音',async()=>{
  const clock=browserTimers(),coordinator=new CaptureCoordinator(),permission=deferred();let tracksStopped=0;
  try{
    const session=new CaptureSession({coordinator,token:coordinator.acquire('voice')});
    const pending=session.requestStream(()=>permission.promise);assert.ok([...clock.pending.values()].some(timer=>timer.ms===15000));
    session.cancel();assert.equal(await pending,null);assert.equal(clock.pending.size,0);assert.equal(coordinator.owner,null);
    const next=coordinator.acquire('next');permission.resolve({getTracks:()=>[{stop:()=>tracksStopped++}]});await Promise.resolve();
    assert.equal(tracksStopped,1);assert.equal(coordinator.owner,next);
  }finally{clock.restore();}
});

test('APK 預設 timer 可取消逾時錄音並釋放 owner，晚到 uploaded 不觸發 STT',()=>{
  const clock=browserTimers(),coordinator=new CaptureCoordinator();let cancelled=0,errors=0,jobs=0;
  try{
    const handle={},session=new NativeCaptureSession({coordinator,token:coordinator.acquire('voice'),identity:{user_id:'user_A',device_id:'dev_A'},bridge:{startRecording:()=>handle,cancelRecording:value=>{assert.equal(value,handle);cancelled++;}},onError:()=>errors++,onUploaded:()=>jobs++});
    assert.equal(session.start(),true);session.receive({type:'recording_started'});
    const timeout=[...clock.pending.values()].find(timer=>timer.ms===180000);assert.ok(timeout);timeout.fn();
    assert.equal(cancelled,1);assert.equal(errors,1);assert.equal(coordinator.owner,null);assert.equal(clock.pending.size,0);
    session.receive({type:'recording_uploaded',purpose:'command',job_id:'late_job'});assert.equal(jobs,0);
  }finally{clock.restore();}
});

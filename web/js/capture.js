// @web-revision: web-v6
export class CaptureCoordinator {
  constructor(){this.owner=null;}
  acquire(name){if(this.owner)return null;this.owner={name};return this.owner;}
  release(token){if(this.owner===token)this.owner=null;}
}

export function stopTracks(stream){
  let tracks=[];try{tracks=stream?.getTracks()||[];}catch{/* Continue releasing the owner even if a device object fails. */}
  for(const track of tracks){try{track.stop();}catch{/* Cleanup each remaining track independently. */}}
}
function closeContext(context){try{const result=context?.close();if(result?.catch)result.catch(()=>{});}catch{/* AudioContext failures cannot retain microphone ownership. */}}

// Each recording owns its own stream, callbacks and token. No old callback can
// clean up another recording. Release happens synchronously, not in onstop.
export class CaptureSession {
  constructor({coordinator,token,onPhase=()=>{},onBlob=()=>{},onError=()=>{},onCancel=()=>{},setTimer=setTimeout,clearTimer=clearTimeout,stopTimeoutMs=3000,maxBytes=10*1024*1024}={}){
    Object.assign(this,{coordinator,token,onPhase,onBlob,onError,onCancel,setTimer,clearTimer,stopTimeoutMs,maxBytes});
    this.stream=null;this.recorder=null;this.context=null;this.chunks=[];this.bytes=0;this.state='requesting';this.stopRequested=false;this.sendRequested=false;this.finalized=false;this.released=false;this.watchdog=null;
  }
  setStream(stream){if(this.finalized){stopTracks(stream);return false;}this.stream=stream;return true;}
  attach(stream,recorder){
    if(this.finalized){stopTracks(stream);return false;}
    this.stream=stream;this.recorder=recorder;
    recorder.addEventListener('dataavailable',event=>{if(this.finalized)return;if(event.data?.size){this.chunks.push(event.data);this.bytes+=event.data.size;if(this.bytes>this.maxBytes)this.fail('錄音超過 10 MiB，已停止；請縮短指令。');}});
    recorder.addEventListener('error',()=>this.fail('錄音器發生錯誤，這段語音沒有送出。'));
    recorder.addEventListener('stop',()=>this.finish());return true;
  }
  setContext(context){if(this.released||this.finalized){closeContext(context);return false;}this.context=context;return true;}
  start(){
    if(this.finalized||!this.recorder)return false;
    try{this.recorder.start(250);if(this.finalized)return false;this.state='recording';this.onPhase('recording');return true;}
    catch{this.fail('錄音器無法開始，請檢查麥克風授權後再試。');return false;}
  }
  stop(send=true){
    if(this.finalized)return false;
    if(this.stopRequested){if(!send)this.cancel();return false;}
    if(!send){this.cancel();return true;}
    this.stopRequested=true;this.sendRequested=true;this.state='stopping';
    try{
      this.onPhase('stopping');
      if(!this.recorder){this.fail('錄音尚未開始，這段語音沒有送出。');return false;}
      this.watchdog=this.setTimer(()=>this.fail('錄音器沒有完成收尾，這段語音未送出。麥克風已釋放，可以重新錄音。'),this.stopTimeoutMs);
      if(['recording','paused'].includes(this.recorder.state))this.recorder.stop();
    }
    catch{this.fail('錄音無法正常結束，這段語音未送出。麥克風已釋放，可以重新錄音。');}
    finally{this.release();}
    return true;
  }
  finish(){
    if(this.finalized)return;
    if(!this.stopRequested||!this.sendRequested){this.fail('錄音意外停止，這段語音沒有送出。');return;}
    this.finalized=true;this.state='stopped';this.clearTimer(this.watchdog);this.watchdog=null;this.release();
    const chunks=this.chunks;this.chunks=[];
    if(!chunks.length){this.state='failed';this.onError(new Error('沒有取得錄音內容，請重新錄音。'));return;}
    const blob=new Blob(chunks,{type:this.recorder?.mimeType||'audio/webm'});this.onBlob(blob);
  }
  fail(message){
    if(this.finalized)return;this.finalized=true;this.state='failed';this.chunks=[];this.clearTimer(this.watchdog);this.watchdog=null;
    try{if(this.recorder&&['recording','paused'].includes(this.recorder.state))this.recorder.stop();}catch{/* release() still executes. */}finally{this.release();}
    this.onError(new Error(message));
  }
  cancel(){
    if(this.finalized){this.release();return;}
    this.finalized=true;this.sendRequested=false;this.state='cancelled';this.chunks=[];this.clearTimer(this.watchdog);this.watchdog=null;
    try{if(this.recorder&&['recording','paused'].includes(this.recorder.state))this.recorder.stop();}catch{/* Cancellation never submits an incomplete recording. */}finally{this.release();}
    this.onCancel();
  }
  release(){
    if(this.released)return;this.released=true;
    try{stopTracks(this.stream);closeContext(this.context);}finally{this.stream=null;this.context=null;this.coordinator?.release(this.token);}
  }
}

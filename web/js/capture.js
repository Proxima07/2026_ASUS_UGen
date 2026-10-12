// @web-revision: web-v9
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
    this.stream=null;this.recorder=null;this.context=null;this.chunks=[];this.bytes=0;this.state='requesting';this.stopRequested=false;this.sendRequested=false;this.finalized=false;this.released=false;this.watchdog=null;this.permissionWatchdog=null;this.permissionResolve=null;
  }
  requestStream(request,timeoutMs=15000){
    if(this.finalized)return Promise.resolve(null);
    return new Promise(resolve=>{
      this.permissionResolve=resolve;
      this.permissionWatchdog=this.setTimer(()=>this.fail('麥克風在 15 秒內沒有開始。請檢查 APK／瀏覽器麥克風權限後重新錄音。'),timeoutMs);
      let requested;try{requested=request();}catch(error){requested=Promise.reject(error);}
      Promise.resolve(requested).then(stream=>{
        if(this.finalized){stopTracks(stream);return;}
        this.clearTimer(this.permissionWatchdog);this.permissionWatchdog=null;this.permissionResolve=null;this.setStream(stream);resolve(stream);
      },error=>{
        if(this.finalized)return;
        this.fail(error?.name==='NotAllowedError'?'麥克風沒有取得授權，請在 APK／瀏覽器設定允許。':'麥克風無法開啟，請檢查是否被其他程式使用。');
      });
    });
  }
  clearPermissionWait(){this.clearTimer(this.permissionWatchdog);this.permissionWatchdog=null;const resolve=this.permissionResolve;this.permissionResolve=null;resolve?.(null);}
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
    try{this.clearPermissionWait();stopTracks(this.stream);closeContext(this.context);}finally{this.stream=null;this.context=null;this.coordinator?.release(this.token);}
  }
}

// APK keeps the encoded file private and uploads it only after an explicit stop.
// JavaScript receives progress/job metadata, never the recording bytes.
export class NativeCaptureSession {
  constructor({bridge,identity,coordinator,token,onPhase=()=>{},onProgress=()=>{},onUploaded=()=>{},onError=()=>{},onCancel=()=>{},setTimer=setTimeout,clearTimer=clearTimeout}={}){
    Object.assign(this,{bridge,identity,coordinator,token,onPhase,onProgress,onUploaded,onError,onCancel,setTimer,clearTimer});this.state='requesting';this.finalized=false;this.released=false;this.native=null;this.watchdog=null;
  }
  start(){
    if(this.finalized)return false;
    try{this.watchdog=this.setTimer(()=>this.fail('手機麥克風在 15 秒內沒有開始。請允許 APK 麥克風權限後重新錄音。'),15000);this.native=this.bridge.startRecording(this.identity,value=>this.receive(value));return true;}
    catch(error){this.fail(error?.message||'手機錄音無法開始。');return false;}
  }
  receive(value){
    if(this.finalized)return;
    try{
    if(value.type==='recording_started'){if(this.state!=='requesting')return;this.clearTimer(this.watchdog);this.watchdog=this.setTimer(()=>this.fail('已到三分鐘上限，手機錄音已停止；這段音訊沒有送出。'),180000);this.state='recording';this.onPhase('recording');}
    else if(value.type==='recording_progress'){if(this.state==='recording')this.onProgress({elapsedMs:value.elapsed_ms,level:value.level});}
    else if(value.type==='recording_stopping'){if(this.state==='stopping')this.onPhase('stopping');}
    else if(value.type==='recording_uploading'){if(this.state!=='stopping')return;this.state='uploading';this.onPhase('uploading');}
    else if(value.type==='recording_uploaded'){
      if(!['stopping','uploading'].includes(this.state))return;
      if(typeof value.job_id!=='string'||value.purpose!=='command'){this.fail('手機回傳的錄音工作無法核對，這次指令已停止。');return;}
      this.finalized=true;this.state='stopped';this.clearTimer(this.watchdog);this.watchdog=null;this.release();this.onUploaded(value);
    }else if(value.type==='recording_cancelled'){this.finalized=true;this.state='cancelled';this.clearTimer(this.watchdog);this.watchdog=null;this.release();this.onCancel(value.reason==='limit'?'已到三分鐘上限，手機錄音已捨棄，沒有送出。':'手機錄音已取消，音訊沒有送出。');}
    else if(value.type==='error')this.fail(value.error?.message||value.message||'手機錄音或上傳未完成。請重新錄音；已送出的後端工作可能仍在進行。');
    }catch{this.fail('錄音介面無法更新，手機錄音已停止，請重新整理網頁。');}
  }
  stop(send=true){
    if(this.finalized)return false;if(!send||this.state==='requesting'){this.cancel();return true;}if(this.state!=='recording')return false;
    this.state='stopping';this.clearTimer(this.watchdog);this.watchdog=null;
    try{this.onPhase('stopping');this.watchdog=this.setTimer(()=>this.fail('等待手機音檔上傳逾時。請先檢查後端；這段錄音不會自動重送。'),135000);this.bridge.stopRecording(this.native);}
    catch(error){this.fail(error?.message||'手機錄音無法結束。');}finally{this.release();}return true;
  }
  fail(message){if(this.finalized)return;this.finalized=true;this.state='failed';this.clearTimer(this.watchdog);this.watchdog=null;this.bridge.cancelRecording(this.native);this.release();this.onError(new Error(message));}
  cancel(){if(this.finalized){this.release();return;}this.finalized=true;this.state='cancelled';this.clearTimer(this.watchdog);this.watchdog=null;this.bridge.cancelRecording(this.native);this.release();this.onCancel();}
  release(){if(this.released)return;this.released=true;this.coordinator?.release(this.token);}
}

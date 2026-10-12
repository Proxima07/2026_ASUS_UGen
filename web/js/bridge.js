// @web-revision: web-v7
import {identifier} from './state.js?rev=web-v7';
export function validBridgeMessage(value) {
  return Boolean(value && typeof value==='object' && !Array.isArray(value) && value.protocol_version==='1' && typeof value.type==='string' && ['ready','action_result','error','logged_out','recording_started','recording_progress','recording_stopping','recording_uploading','recording_uploaded','recording_cancelled'].includes(value.type));
}
export class Bridge {
  constructor({onChange=()=>{},onResult=()=>{},onError=()=>{},onLogout=()=>{}}={}){this.onChange=onChange;this.onResult=onResult;this.onError=onError;this.onLogout=onLogout;this.nativePresent=false;this.ready=false;this.capabilities=new Set();this.helloTimer=null;this.pending=new Map();this.recording=null;this.identity=null;this.recordingSession=null;}
  init(){
    this.nativePresent=Boolean(globalThis.NativeBridge && typeof globalThis.NativeBridge.postMessage==='function');
    if(!this.nativePresent){this.onChange();return;}
    globalThis.NativeBridge.onmessage=(event)=>this.receive(event.data);
    this.send({type:'hello'});
    this.helloTimer=setTimeout(()=>{if(!this.ready)this.onError('手機橋接尚未就緒，請重新開啟 APK。');},8000);
    this.onChange();
  }
  send(value){
    if(!this.nativePresent)throw new Error('這項功能需要從 Android APK 開啟。');
    const message={protocol_version:'1',message_id:identifier('msg'),...value};
    this.pending.set(message.message_id,message);
    try{globalThis.NativeBridge.postMessage(JSON.stringify(message));}catch(error){this.pending.delete(message.message_id);throw error;}return message.message_id;
  }
  supports(kind){return this.ready && this.capabilities.has(kind);}
  bindSession(identity){this.sessionIdentity=identity?{user_id:identity.user_id,device_id:identity.device_id}:null;}
  matchesSession(){return Boolean(this.sessionIdentity?.user_id&&this.sessionIdentity.user_id===this.identity?.user_id&&this.sessionIdentity?.device_id&&this.sessionIdentity.device_id===this.identity?.device_id);}
  execute(actionId,kind){if(!this.supports(kind))throw new Error(this.nativePresent?'手機尚未提供這項操作，請檢查 APK 版本與權限。':'手機操作需要使用 Android APK。');if(!this.matchesSession())throw new Error('APK 與網頁登入身分尚未核對，請按「同步」重新連接。');return this.send({type:'execute_action',action_id:actionId});}
  logout(){return this.send({type:'logout'});}
  canRecord(){return this.ready&&this.recording?.protocol_version==='1';}
  startRecording(identity,onEvent){
    if(!this.canRecord())throw new Error('這個 APK 尚未提供手機錄音，請安裝本次 APK 更新。');
    if(!identity?.device_id||!identity?.user_id||identity.device_id!==this.identity?.device_id||identity.user_id!==this.identity?.user_id)throw new Error('APK 與網頁登入身分不一致，請按「同步」重新連接。');
    if(this.recordingSession)throw new Error('手機上一段錄音尚未結束，請先取消。');
    const session={startMessageId:identifier('record'),stopMessageId:null,recordingId:null,onEvent};this.recordingSession=session;
    try{this.send({type:'recording_start',message_id:session.startMessageId,purpose:'command',expected_device_id:identity.device_id,expected_user_id:identity.user_id});}catch(error){this.recordingSession=null;throw error;}
    return session;
  }
  stopRecording(session){if(this.recordingSession!==session||!session.recordingId)throw new Error('手機錄音尚未開始，請取消後重試。');session.stopMessageId=identifier('record_stop');this.send({type:'recording_stop',message_id:session.stopMessageId,recording_id:session.recordingId});}
  cancelRecording(session=this.recordingSession){
    if(!session||this.recordingSession!==session)return;
    this.recordingSession=null;this.pending.delete(session.startMessageId);if(session.stopMessageId)this.pending.delete(session.stopMessageId);
    try{this.send({type:'recording_cancel',...(session.recordingId?{recording_id:session.recordingId}:{start_message_id:session.startMessageId})});}catch{/* A page cancellation never resumes a native recording or retries an upload. */}
  }
  finishRecording(session){if(this.recordingSession!==session)return;this.recordingSession=null;this.pending.delete(session.startMessageId);if(session.stopMessageId)this.pending.delete(session.stopMessageId);}
  clearPrivateOperations(){this.cancelRecording();this.bindSession(null);for(const [id,message]of this.pending)if(message.type==='execute_action'||message.type.startsWith('recording_'))this.pending.delete(id);}
  receive(raw){
    let value;try{value=typeof raw==='string'?JSON.parse(raw):raw;}catch{return;}
    if(!validBridgeMessage(value))return;
    const sent=this.pending.get(value.message_id);if(!sent)return;
    if(value.type.startsWith('recording_')||value.type==='error'&&sent.type.startsWith('recording_')){
      const session=this.recordingSession;
      if(sent.type==='recording_cancel'){if(value.type==='recording_cancelled'||value.type==='error')this.pending.delete(value.message_id);return;}
      if(!session||![session.startMessageId,session.stopMessageId].includes(value.message_id))return;
      if(value.type==='recording_started'||value.type==='recording_progress'){
        if(sent.type!=='recording_start'||typeof value.recording_id!=='string')return;
        if(value.type==='recording_started'){if(session.recordingId&&session.recordingId!==value.recording_id)return;session.recordingId=value.recording_id;}
        else if(value.recording_id!==session.recordingId)return;
      }else if(['recording_stopping','recording_uploading','recording_uploaded'].includes(value.type)){
        if(sent.type!=='recording_stop'||value.recording_id!==session.recordingId)return;
      }else if(value.type==='recording_cancelled'){
        if(value.recording_id&&session.recordingId&&value.recording_id!==session.recordingId)return;
      }else if(value.type!=='error')return;
      if(['recording_uploaded','recording_cancelled','error'].includes(value.type))this.finishRecording(session);
      session.onEvent(value);return;
    }
    if(value.type==='ready'&&sent.type!=='hello')return;
    if(value.type==='action_result'&&(sent.type!=='execute_action'||sent.action_id!==value.action_id))return;
    if(value.type==='logged_out'&&sent.type!=='logout')return;
    this.pending.delete(value.message_id);
    if(value.type==='ready'){clearTimeout(this.helloTimer);this.capabilities=new Set(Array.isArray(value.capabilities)?value.capabilities.filter(x=>typeof x==='string'):[]);this.recording=value.recording?.protocol_version==='1'?value.recording:null;this.identity=value.identity||null;this.ready=true;this.onChange();}
    else if(value.type==='action_result')this.onResult(value);
    else if(value.type==='logged_out'){this.cancelRecording();this.pending.clear();this.ready=false;this.capabilities.clear();this.recording=null;this.identity=null;this.onLogout();this.onChange();}
    else this.onError(value.error?.message || value.message || '手機操作未完成，請重新確認。',{...value,action_id:sent.action_id,request_type:sent.type});
  }
}

import {identifier} from './state.js';
export function validBridgeMessage(value) {
  return Boolean(value && typeof value==='object' && !Array.isArray(value) && value.protocol_version==='1' && typeof value.type==='string' && ['ready','action_result','error','logged_out'].includes(value.type));
}
export class Bridge {
  constructor({onChange=()=>{},onResult=()=>{},onError=()=>{},onLogout=()=>{}}={}){this.onChange=onChange;this.onResult=onResult;this.onError=onError;this.onLogout=onLogout;this.nativePresent=false;this.ready=false;this.capabilities=new Set();this.helloTimer=null;this.pending=new Map();}
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
  execute(actionId,kind){if(!this.supports(kind))throw new Error(this.nativePresent?'手機尚未提供這項操作，請檢查 APK 版本與權限。':'手機操作需要使用 Android APK。');return this.send({type:'execute_action',action_id:actionId});}
  logout(){return this.send({type:'logout'});}
  receive(raw){
    let value;try{value=typeof raw==='string'?JSON.parse(raw):raw;}catch{return;}
    if(!validBridgeMessage(value))return;
    const sent=this.pending.get(value.message_id);if(!sent)return;
    if(value.type==='ready'&&sent.type!=='hello')return;
    if(value.type==='action_result'&&(sent.type!=='execute_action'||sent.action_id!==value.action_id))return;
    if(value.type==='logged_out'&&sent.type!=='logout')return;
    this.pending.delete(value.message_id);
    if(value.type==='ready'){clearTimeout(this.helloTimer);this.capabilities=new Set(Array.isArray(value.capabilities)?value.capabilities.filter(x=>typeof x==='string'):[]);this.ready=true;this.onChange();}
    else if(value.type==='action_result')this.onResult(value);
    else if(value.type==='logged_out'){this.pending.clear();this.ready=false;this.capabilities.clear();this.onLogout();this.onChange();}
    else this.onError(value.error?.message || value.message || '手機操作未完成，請重新確認。',{...value,action_id:sent.action_id,request_type:sent.type});
  }
}

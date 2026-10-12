// @web-revision: web-v4
import {identifier,element,errorMessage,setMessage,labelForStatus} from './state.js?rev=web-v4';
export class Chat {
  constructor({api,actions,authenticated=()=>false,onNotesChanged=()=>{},toast=()=>{}}){this.api=api;this.actions=actions;this.authenticated=authenticated;this.onNotesChanged=onNotesChanged;this.toast=toast;this.pending=null;this.busy=false;this.generation=0;this.replies=new Map();this.lastNotes=new Set();this.form=document.querySelector('#chat-form');this.input=document.querySelector('#chat-input');this.send=document.querySelector('#chat-send');this.hint=document.querySelector('#chat-hint');this.conversation=document.querySelector('#conversation');this.empty=document.querySelector('#conversation-empty');this.form.addEventListener('submit',e=>{e.preventDefault();this.submit();});this.input.addEventListener('keydown',e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();this.submit();}});for(const button of document.querySelectorAll('[data-prompt]'))button.addEventListener('click',()=>this.fill(button.dataset.prompt));}
  fill(text){this.input.value=text;this.input.focus();}
  bubble(role,text){this.empty.hidden=true;const node=element('article',`message message-${role}`);node.append(element('span','message-label',role==='user'?'你':'留白'));const body=element('p','message-body',text);node.append(body);this.conversation.append(node);return body;}
  async submit(){
    if(this.busy)return;if(!this.authenticated()){this.toast('請先完成連線配對。');return;}const text=this.input.value.trim();if(!text)return;
    if(!this.pending||this.pending.text!==text){this.pending={text,key:identifier('chat'),reply:this.bubble('assistant','正在理解你的指令…')};const replyNode=this.pending.reply.parentElement;const user=this.bubble('user',text).parentElement;replyNode.before(user);}
    const generation=this.generation;this.busy=true;this.send.disabled=true;this.input.disabled=true;this.send.textContent='處理中';setMessage(this.hint,'由私人中樞理解指令…');
    try{const record=await this.api.chat(text,this.pending.key);if(generation!==this.generation)return;this.replies.set(record.request_id,this.pending.reply);this.pending=null;this.input.value='';this.update(record);if(record.action_id){try{const full=await this.api.getRequest(record.request_id);if(generation===this.generation)this.actions.acceptRequest(full);}catch{if(generation===this.generation)this.actions.acceptRequest(record);}}else this.actions.acceptRequest(record);if(generation===this.generation)setMessage(this.hint,'理解與整理由私人中樞處理');}
    catch(e){if(generation!==this.generation)return;if(this.pending)this.pending.reply.textContent=errorMessage(e);setMessage(this.hint,'連線未完成；重試保留同一筆指令編號。',true);this.toast(errorMessage(e));}
    finally{if(generation===this.generation){this.busy=false;this.send.disabled=false;this.input.disabled=false;this.send.textContent='送出';this.input.focus();}}
  }
  update(record){
    let reply=this.replies.get(record.request_id);if(!reply){if(!record.text)return;this.bubble('user',record.text);reply=this.bubble('assistant','');this.replies.set(record.request_id,reply);}
    let message=record.error?.message || record.message || labelForStatus(record.status);
    if(record.action?.state==='expired')message='這項操作已逾時。若仍需要執行，請重新提交指令。';
    if(record.action?.state==='execution_expired')message='未收到手機的最終結果。請先檢查手機中的實際操作，避免重複新增。';
    if(record.notes?.length)message+='\n\n'+record.notes.map(n=>`${n.title || '筆記'}\n${n.content || n.preview || ''}`).join('\n\n');
    if(record.status==='completed'&&record.candidates?.length)message+='\n\n'+record.candidates.map(c=>`${c.name || '未命名'} · ${c.phone_number || ''}`).join('\n');
    if(record.note)message+=`\n\n${record.note.title}\n${record.note.content}`;
    reply.textContent=message;
    if(record.note&&!this.lastNotes.has(record.note.note_id)){this.lastNotes.add(record.note.note_id);this.onNotesChanged();}
  }
  clear(){this.generation++;this.busy=false;this.send.disabled=false;this.input.disabled=false;this.send.textContent='送出';for(const node of [...this.conversation.children])if(node!==this.empty)node.remove();this.empty.hidden=false;this.replies.clear();this.lastNotes.clear();this.pending=null;this.input.value='';}
}

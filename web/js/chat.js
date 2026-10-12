// @web-revision: web-v10
import {identifier,element,errorMessage,setMessage,labelForStatus} from './state.js?rev=web-v10';
import {uncertainResponse} from './conversation.js?rev=web-v10';
export class Chat {
  constructor({api,bridge=null,actions,conversations=null,authenticated=()=>false,onNotesChanged=()=>{},toast=()=>{}}){this.api=api;this.bridge=bridge;this.actions=actions;this.conversations=conversations;this.reservation=null;this.authenticated=authenticated;this.onNotesChanged=onNotesChanged;this.toast=toast;this.pending=null;this.busy=false;this.generation=0;this.replies=new Map();this.lastNotes=new Set();this.form=document.querySelector('#chat-form');this.input=document.querySelector('#chat-input');this.send=document.querySelector('#chat-send');this.hint=document.querySelector('#chat-hint');this.conversation=document.querySelector('#conversation');this.empty=document.querySelector('#conversation-empty');this.form.addEventListener('submit',e=>{e.preventDefault();this.submit();});this.input.addEventListener('keydown',e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();this.submit();}});for(const button of document.querySelectorAll('[data-prompt]'))button.addEventListener('click',()=>this.fill(button.dataset.prompt));}
  fill(text){this.input.value=text;this.input.focus();}
  bubble(role,text){this.empty.hidden=true;const node=element('article',`message message-${role}`);node.append(element('span','message-label',role==='user'?'你':'留白'));const body=element('p','message-body',text);node.append(body);this.conversation.append(node);return body;}
  async submit(){
    if(this.busy)return;if(!this.authenticated()){this.toast('請先完成連線配對。');return;}
    const text=this.input.value.trim();if(!text)return;
    const previous=this.pending;
    const attempt=previous&&previous.text===text?previous:{text,key:identifier('chat'),timezone:Intl.DateTimeFormat().resolvedOptions().timeZone||'Asia/Taipei',context:this.conversations?.snapshot(),reply:null};
    const token=this.conversations?.reserve('text',{attemptKey:attempt.key,context:attempt.context});
    if(this.conversations&&!token){
      const message=this.conversations.uncertain?'上一筆送出結果尚未確認。請用原句重試，或按「新對話」重新開始。':this.conversations.pending?'另一筆文字或語音指令正在回覆，請稍候。':'這筆指令屬於先前上下文。請重新送出，或按「新對話」。';
      if(!this.conversations.uncertain&&!this.conversations.pending)this.pending=null;
      this.toast(message);setMessage(this.hint,message,true);return;
    }
    this.reservation=token||null;
    if(!attempt.reply){attempt.reply=this.bubble('assistant','正在理解你的指令…');const user=this.bubble('user',text).parentElement;attempt.reply.parentElement.before(user);}
    this.pending=attempt;const generation=this.generation;
    this.busy=true;this.send.disabled=true;this.input.disabled=true;this.send.textContent='處理中';setMessage(this.hint,'由私人中樞理解指令…');
    try{
      const record=await this.api.chat(text,attempt.key,{noteTarget:'phone_first',nativeCapabilities:this.bridge?.ready?[...this.bridge.capabilities]:[],timezone:attempt.timezone,conversationId:token?.conversationId,parentRequestId:token?.parentRequestId});
      if(generation!==this.generation||(this.conversations&&!this.conversations.active(token)))return;
      if(this.conversations&&!this.conversations.adopt(token,record))throw new Error('無法核對這次對話編號，請按「新對話」重新開始。');
      this.replies.set(record.request_id,attempt.reply);this.pending=null;this.input.value='';this.update(record);
      if(record.action_id){try{const full=await this.api.getRequest(record.request_id);if(generation===this.generation)this.actions.acceptRequest(full);}catch{if(generation===this.generation)this.actions.acceptRequest(record);}}
      else this.actions.acceptRequest(record);
      if(generation===this.generation)setMessage(this.hint,'可接著補充；對話上下文由私人中樞保存。');
    }catch(error){
      if(generation!==this.generation||(token&&this.conversations&&!this.conversations.sameGeneration(token.generation)))return;
      if(token&&uncertainResponse(error))this.conversations?.markUncertain(token);
      if(this.pending)this.pending.reply.textContent=errorMessage(error);
      setMessage(this.hint,token&&this.conversations?.uncertain?'結果尚未確認；原句人工重試會沿用同一編號與上下文。也可以按「新對話」。':'請檢查訊息後再試，或按「新對話」。',true);this.toast(errorMessage(error));
    }finally{
      this.conversations?.release(token);if(this.reservation===token)this.reservation=null;
      if(generation===this.generation){this.busy=false;this.send.disabled=false;this.input.disabled=false;this.send.textContent='送出';this.input.focus();}
    }
  }
  pause(){
    if(!this.busy)return;const token=this.reservation;this.conversations?.cancel(token);this.conversations?.release(token);
    if(this.pending?.reply)this.pending.reply.textContent='已停止本頁接收這次回覆；後端工作可能仍在進行。';
    this.generation++;this.reservation=null;this.pending=null;this.busy=false;this.send.disabled=false;this.input.disabled=false;this.send.textContent='送出';
    setMessage(this.hint,'已暫停。下一筆會依目前有效的對話狀態送出；結果不明時請用「新對話」。');
  }
  update(record){
    if(this.conversations&&!this.conversations.matchesRecord(record))return;
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
  clear(){this.conversations?.cancel(this.reservation);this.conversations?.release(this.reservation);this.reservation=null;this.generation++;this.busy=false;this.send.disabled=false;this.input.disabled=false;this.send.textContent='送出';for(const node of [...this.conversation.children])if(node!==this.empty)node.remove();this.empty.hidden=false;this.replies.clear();this.lastNotes.clear();this.pending=null;this.input.value='';setMessage(this.hint,'理解與整理由私人中樞處理');}
}

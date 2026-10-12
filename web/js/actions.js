import {ACTION_LABELS,ACTIVE_ACTION_STATES,actionDetail,labelForStatus,element,errorMessage} from './state.js';
export class Actions {
  constructor({api,bridge,container,onRequest=()=>{},toast=()=>{}}){this.api=api;this.bridge=bridge;this.container=container;this.onRequest=onRequest;this.toast=toast;this.actions=new Map();this.requests=new Map();this.busy=new Set();this.refreshing=false;this.interval=null;this.generation=0;}
  async start(){const generation=this.generation;await this.refresh();if(generation===this.generation&&!this.interval)this.interval=setInterval(()=>{if(!document.hidden)this.refresh().catch(()=>{});},2000);}
  stop(){this.generation++;clearInterval(this.interval);this.interval=null;this.refreshing=false;this.actions.clear();this.requests.clear();this.busy.clear();this.render();}
  async refresh(){
    if(this.refreshing)return;this.refreshing=true;const generation=this.generation;
    try{
      const listing=await this.api.actions();if(generation!==this.generation)return;this.actions=new Map((listing.items || []).map(a=>[a.action_id,a]));
      const ids=new Set([...this.requests.values()].filter(r=>r.status==='processing'||r.status==='needs_selection'||(r.status==='awaiting_device'&&(!r.action||ACTIVE_ACTION_STATES.has(r.action.state)))).map(r=>r.request_id));
      for(const action of this.actions.values())if(ACTIVE_ACTION_STATES.has(action.state)&&action.request_id)ids.add(action.request_id);
      await Promise.all([...ids].map(async id=>{try{const request=await this.api.getRequest(id);if(generation===this.generation)this.acceptRequest(request,false);}catch(e){if(e.status===401)throw e;}}));
      if(generation===this.generation)this.render();
    }finally{if(generation===this.generation)this.refreshing=false;}
  }
  acceptRequest(record,render=true){this.requests.set(record.request_id,record);if(record.action)this.actions.set(record.action.action_id,record.action);this.onRequest(record);if(render)this.render();}
  render(){
    this.container.replaceChildren();
    for(const request of this.requests.values()){
      if(request.status!=='needs_selection')continue;
      const card=element('article','card action-card');card.append(element('h2','',request.message || '選擇聯絡人'));
      for(const candidate of request.candidates || []){const button=element('button','candidate-button',`${candidate.name || '未命名'} · ${candidate.phone_number || ''}`);button.type='button';button.disabled=this.busy.has(request.request_id);button.addEventListener('click',()=>this.select(request,candidate,button));card.append(button);}
      this.container.append(card);
    }
    for(const action of this.actions.values()){
      if(!ACTIVE_ACTION_STATES.has(action.state))continue;
      const card=element('article','card action-card');const heading=element('div','action-title');heading.append(element('span','action-kind',ACTION_LABELS[action.kind] || '手機操作'),element('span','status-pill',labelForStatus(action.state)));card.append(heading,element('p','action-detail',actionDetail(action)));
      const buttons=element('div','button-row');const execute=element('button','primary-button',action.state==='claimed'?'手機正在處理':'在手機確認');execute.type='button';execute.disabled=action.state!=='pending_confirmation'||this.busy.has(action.action_id)||!this.bridge.supports(action.kind);execute.addEventListener('click',()=>this.execute(action,execute));buttons.append(execute);
      if(action.state==='pending_confirmation'){const cancel=element('button','quiet-button','取消');cancel.type='button';cancel.disabled=this.busy.has(action.action_id);cancel.addEventListener('click',()=>this.cancel(action,cancel));buttons.append(cancel);}
      card.append(buttons);
      if(!this.bridge.nativePresent)card.append(element('p','small muted','請從已配對的 Android APK 提交這項指令；瀏覽器與 APK 的裝置身分不同。'));
      else if(!this.bridge.ready)card.append(element('p','small muted','正在連接手機功能，請稍候。'));
      if(action.state==='claimed')card.append(element('p','small muted','若結果未回報，先檢查手機；不要重複新增或撥號。'));
      this.container.append(card);
    }
  }
  async execute(action,button){const generation=this.generation;this.busy.add(action.action_id);button.disabled=true;try{this.bridge.execute(action.action_id,action.kind);this.toast('請在手機確認操作內容。');setTimeout(()=>{if(generation!==this.generation)return;this.busy.delete(action.action_id);this.refresh().catch(e=>this.toast(errorMessage(e)));},3500);}catch(e){this.busy.delete(action.action_id);this.toast(errorMessage(e));this.render();}}
  async cancel(action,button){const generation=this.generation;this.busy.add(action.action_id);button.disabled=true;try{const result=await this.api.cancelAction(action.action_id);if(generation!==this.generation)return;this.actions.set(action.action_id,result.action);if(result.request)this.acceptRequest(result.request,false);this.toast('操作已取消。');}catch(e){this.toast(errorMessage(e));}finally{if(generation===this.generation){this.busy.delete(action.action_id);this.render();}}}
  async select(request,candidate,button){const generation=this.generation;this.busy.add(request.request_id);button.disabled=true;try{const record=await this.api.selectContact(request.request_id,candidate.candidate_id);if(generation!==this.generation)return;const full=await this.api.getRequest(record.request_id);if(generation===this.generation)this.acceptRequest(full);}catch(e){this.toast(errorMessage(e));}finally{if(generation===this.generation){this.busy.delete(request.request_id);this.render();}}}
  async nativeResult(value){if(value.action_id)this.busy.delete(value.action_id);if(value.result?.request)this.acceptRequest(value.result.request);this.toast(value.message || labelForStatus(value.state));await this.refresh();}
}

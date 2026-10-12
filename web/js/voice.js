// @web-revision: web-v6
import {identifier,validateAudio,errorMessage,labelForStatus,element} from './state.js?rev=web-v6';
import {CaptureCoordinator,CaptureSession,stopTracks} from './capture.js?rev=web-v6';
import {uncertainResponse} from './conversation.js?rev=web-v6';
export {CaptureCoordinator,CaptureSession} from './capture.js?rev=web-v6';

const VOICE_BUSY=new Set(['requesting','recording','stopping','uploading','received_audio','queued','transcribing','transcribed','sending','received_request','understanding','dispatching','waiting','reading_result','sending_selection','selecting']);
const NATIVE_KINDS=new Set(['contacts.search','phone.dial','alarm.create','timer.create','calendar.create','notes.save_local','notes.share','notes.search_local','notes.update_local']);

// One owner, including while a microphone permission request is pending.
// Local amplitude gate: no cloud recognition, no speech-to-text in the browser.
export class SilenceGate {
  constructor({threshold=.025,minSpeechMs=250,silenceMs=2000,noSpeechMs=12000,maxMs=180000}={}){
    Object.assign(this,{threshold,minSpeechMs,silenceMs,noSpeechMs,maxMs});
    this.startedAt=null;this.speechStart=null;this.lastSpeech=null;this.speechSeen=false;
  }
  sample(rms,now){
    if(this.startedAt===null)this.startedAt=now;
    if(rms>=this.threshold){if(this.speechStart===null)this.speechStart=now;this.lastSpeech=now;if(now-this.speechStart>=this.minSpeechMs)this.speechSeen=true;}
    else if(!this.speechSeen)this.speechStart=null;
    if(!this.speechSeen&&now-this.startedAt>=this.noSpeechMs)return {stop:true,send:false,reason:'no_speech'};
    if(this.speechSeen&&now-this.lastSpeech>=this.silenceMs)return {stop:true,send:true,reason:'silence'};
    if(now-this.startedAt>=this.maxMs)return {stop:true,send:this.speechSeen,reason:'limit'};
    return {stop:false,speech:this.speechSeen};
  }
}

// The workflow is independent of UI/capture. It never reads action listings and
// only permits native operations tied to this page's explicit foreground run.
export class VoiceFlow {
  constructor({api,bridge,conversations=null,isAuthorized=()=>false,isForeground=()=>true,onState=()=>{},onTranscript=()=>{},onRecord=()=>{},onChoices=()=>{},onDebug=()=>{},makeId=identifier,setTimer=setTimeout,clearTimer=clearTimeout}={}){
    Object.assign(this,{api,bridge,conversations,isAuthorized,isForeground,onState,onTranscript,onRecord,onChoices,onDebug,makeId,setTimer,clearTimer});
    this.generation=0;this.run=null;this.lastRequestId=null;this.state='idle';this.debug={history:[]};this.timer=null;this.attemptedActions=new Set();
  }
  setState(state,message){this.state=state;this.debug.stage=state;const history=this.debug.history||[];this.debug.history=(history[history.length-1]===state?history:[...history,state]).slice(-24);this.onState(state,message);this.onDebug({...this.debug});}
  updateDebug(values){Object.assign(this.debug,values);this.onDebug({...this.debug});}
  begin(){
    if(VOICE_BUSY.has(this.state))return null;
    if(!this.isAuthorized()||!this.isForeground()){this.setState('idle','請先完成連線配對，再開始說話。');return null;}
    if(this.conversations&&(this.conversations.pending||this.conversations.uncertain)){this.setState('failed',this.conversations.uncertain?'上一筆指令結果尚未確認，請按「新對話」再開始。':'另一筆文字或語音指令正在回覆，請稍候。');return null;}
    const continuing=this.state==='clarify'&&this.conversations?.conversationId;
    this.clearTimer(this.timer);this.debug={history:[]};this.lastRequestId=null;const run={generation:++this.generation,chatKey:this.makeId('voice'),submitted:false,requestId:null,waiting:null,selection:null,conversationGeneration:this.conversations?.generation,conversationContext:this.conversations?.snapshot()};this.run=run;
    this.onTranscript('');if(!continuing)this.onRecord(null);this.onChoices(null,[]);this.setState('requesting','等待麥克風權限…');return run;
  }
  current(run){return this.run===run&&run.generation===this.generation&&this.isAuthorized()&&this.isForeground()&&(!this.conversations||this.conversations.sameGeneration(run.conversationGeneration));}
  recording(run){if(this.current(run))this.setState('recording','收聽中。說完可以按「結束錄音並送出」。');}
  cancel(message='已停止這次語音。'){this.conversations?.cancel(this.run?.reservation);this.conversations?.release(this.run?.reservation);if(this.run?.requestId)this.lastRequestId=this.run.requestId;this.generation++;this.run=null;this.clearTimer(this.timer);this.timer=null;this.onChoices(null,[]);this.setState('paused',message);}
  async refreshDisplay(){
    const id=this.lastRequestId,generation=this.generation;if(!id||this.run||!this.isAuthorized()||!this.isForeground())return;
    try{const record=await this.api.getRequest(id);if(generation!==this.generation||id!==this.lastRequestId||this.run||!this.isAuthorized()||!this.isForeground())return;if(this.conversations&&!this.conversations.matchesRecord(record))return;this.onRecord(record);this.setState('paused',['awaiting_device','processing','needs_selection','needs_note_selection'].includes(record.status)?'這次流程已暫停，不會自動繼續。請先確認手機的實際狀態。':record.message||labelForStatus(record.status));}catch{/* Display refresh has no execution permission and never retries an operation. */}
  }
  fail(run,error){if(!this.current(run))return;this.clearTimer(this.timer);run.waiting=null;if(error?.httpRequestId)this.updateDebug({errorHttpId:error.httpRequestId});this.setState('failed',errorMessage(error));}
  async acceptAudio(run,blob){
    if(!this.current(run)||run.audioSubmitted)return;run.audioSubmitted=true;
    try{
      const type=validateAudio(blob);this.setState('uploading','正在將語音交給私人設備…');
      const job=await this.api.uploadCommandAudio(blob,type);if(!this.current(run))return;
      if(!job.job_id)throw new Error('後端沒有回傳錄音工作編號。');run.jobId=job.job_id;this.updateDebug({jobId:job.job_id,traceId:job.trace_id||null,audioHttpId:job.http_request_id||null});this.setState(job.status==='queued'?'queued':'received_audio',job.status==='queued'?'後端已收到錄音，正在排隊；尚未開始轉錄。':'後端已收到錄音，正在查詢處理階段。');await this.pollAudio(run);
    }catch(error){this.fail(run,error);}
  }
  async pollAudio(run){
    if(!this.current(run))return;
    try{
      const job=await this.api.audioJob(run.jobId);if(!this.current(run))return;if(job.trace_id)this.updateDebug({traceId:job.trace_id});
      if(job.status==='transcribed'){
        const transcript=String(job.transcript||'').trim();if(!transcript)throw new Error('沒有辨識到語音，請再說一次。');
        this.setState('transcribed','STT 轉錄完成，已顯示辨識文字。');this.onTranscript(transcript);if(transcript.length>8000)throw new Error('這段語音超過指令上限，請用短一些的句子。');
        await this.submitTranscript(run,transcript);return;
      }
      if(['queued','transcribing'].includes(job.status)){this.setState(job.status,job.status==='queued'?'錄音仍在後端排隊，尚未開始 STT。':'後端回報：STT 正在轉錄。');this.timer=this.setTimer(()=>this.pollAudio(run),1200);return;}
      throw new Error(job.error?.message||job.message||'語音沒有完成轉錄，請檢查本地服務。');
    }catch(error){this.fail(run,error);}
  }
  async submitTranscript(run,text){
    if(!this.current(run)||run.submitted)return;
    const token=this.conversations?.reserve('voice',{attemptKey:run.chatKey,context:run.conversationContext});
    if(this.conversations&&!token){this.fail(run,new Error(this.conversations.uncertain?'上一筆指令結果尚未確認，請按「新對話」。':this.conversations.pending?'另一筆文字或語音指令正在回覆，請稍候再說一次。':'錄音期間對話已有新回覆，請完整重說這次指令，避免接到不同的上下文。'));return;}
    run.reservation=token||null;run.submitted=true;this.setState('sending','正在送出指令／等待 Agent 回覆…');
    try{
      const caps=this.bridge.ready?[...this.bridge.capabilities].filter(kind=>NATIVE_KINDS.has(kind)):[];
      const record=await this.api.chat(text,run.chatKey,{noteTarget:'phone_first',nativeCapabilities:caps,sourceJobId:run.jobId,conversationId:token?.conversationId,parentRequestId:token?.parentRequestId});
      if(!this.current(run))return;
      if(!record.request_id)throw new Error('中樞沒有回傳指令編號，請檢查後端版本。');
      if(this.conversations&&!this.conversations.adopt(token,record))throw new Error('無法核對對話編號，請按「新對話」重新開始。');
      run.requestId=record.request_id;this.updateDebug({requestId:record.request_id,conversationId:record.conversation_id||null,parentRequestId:token?.parentRequestId||null,traceId:record.trace_id||this.debug.traceId||null,chatHttpId:record.http_request_id||null});
      this.setState('received_request','中樞已回覆指令編號，正在讀取 Agent 結果。');await this.readRequest(run);
    }catch(error){if(token&&this.current(run)&&uncertainResponse(error))this.conversations?.markUncertain(token);this.fail(run,error);}
    finally{this.conversations?.release(token);}
  }
  async readRequest(run){
    if(!this.current(run)||!run.requestId)return;
    try{const record=await this.api.getRequest(run.requestId);if(!this.current(run))return;await this.processRecord(run,record);}
    catch(error){this.fail(run,error);}
  }
  async processRecord(run,record){
    if(!this.current(run)||record.request_id!==run.requestId||(this.conversations&&!this.conversations.matchesRecord(record)))return;
    this.onRecord(record);
    if(['needs_selection','needs_note_selection'].includes(record.status)){
      const kind=record.status==='needs_selection'?'contact':'note';const candidates=kind==='contact'?record.candidates:record.note_candidates;
      run.selection={kind,candidates:Array.isArray(candidates)?candidates:[],busy:false};this.onChoices(kind,run.selection.candidates);this.setState('selecting',record.message||'找到幾個相似的項目，請選一個。');return;
    }
    this.onChoices(null,[]);
    if(record.status==='awaiting_device'){
      const action=record.action;
      if(!action||action.action_id!==record.action_id||action.request_id!==run.requestId){this.fail(run,new Error('操作與這次語音不相符，已停止執行。'));return;}
      if(run.waiting?.action_id===action.action_id)return;
      if(this.attemptedActions.has(action.action_id)){this.fail(run,new Error('這個操作已送出過，請先檢查手機結果。'));return;}
      if(action.state!=='pending_confirmation'){this.fail(run,new Error('這個操作已在處理或逾時，請先檢查手機，避免重複執行。'));return;}
      if(!this.bridge.supports(action.kind)){this.setState('failed','這項操作需要已配對且支援該功能的 Android APK。');return;}
      this.attemptedActions.add(action.action_id);run.waiting={action_id:action.action_id,message_id:null};this.setState('dispatching','正在交給手機…');
      try{run.waiting.message_id=this.bridge.execute(action.action_id,action.kind);this.setState('waiting','請在手機確認這次操作。');
        this.clearTimer(this.timer);this.timer=this.setTimer(()=>{this.fail(run,new Error('沒有收到手機最終結果。請先檢查手機；這次操作不會自動重送。'));},180000);
      }catch(error){this.fail(run,error);}return;
    }
    if(record.status==='processing'){this.setState('understanding','後端回報：Agent 正在理解指令。');this.timer=this.setTimer(()=>this.readRequest(run),1200);return;}
    if(record.status==='failed'){this.fail(run,new Error(record.error?.message||record.message||'這次指令未完成。'));return;}
    const message=record.message||labelForStatus(record.status);
    this.setState(record.status==='needs_clarification'?'clarify':'completed',message);
  }
  async nativeResult(value){
    const run=this.run;if(!run||!this.current(run)||!run.waiting)return false;
    if(value.message_id!==run.waiting.message_id||value.action_id!==run.waiting.action_id)return false;
    this.clearTimer(this.timer);run.waiting=null;this.setState('reading_result','正在確認手機回報的實際結果…');await this.readRequest(run);return true;
  }
  nativeError(value,message){const run=this.run;if(!run||!this.current(run)||!run.waiting||value?.message_id!==run.waiting.message_id)return false;this.fail(run,new Error(message||'手機未完成這次操作；不會自動重試。'));return true;}
  async choose(candidateId){
    const run=this.run;if(!run||!this.current(run)||!run.selection||run.selection.busy)return;
    if(!run.selection.candidates.some(c=>c.candidate_id===candidateId))return;
    run.selection.busy=true;this.setState('sending_selection','正在送出你的選擇…');this.onChoices(null,[]);
    try{if(run.selection.kind==='contact')await this.api.selectContact(run.requestId,candidateId);else await this.api.selectNote(run.requestId,candidateId);if(this.current(run)){run.selection=null;await this.readRequest(run);}}
    catch(error){this.fail(run,error);}
  }
}

const STAGE_LABELS={idle:'準備好',requesting:'等待麥克風權限',recording:'收聽中',stopping:'錄音收尾中',uploading:'上傳錄音中',received_audio:'後端已收音訊',queued:'後端排隊中',transcribing:'STT 轉錄中',transcribed:'STT 轉錄完成',sending:'送出指令／等待 Agent',received_request:'指令編號已回覆',understanding:'Agent 理解中',dispatching:'交給手機',waiting:'等待手機確認',reading_result:'確認手機結果',sending_selection:'送出選擇',selecting:'請選擇對象',completed:'處理結果',clarify:'請補充資訊',paused:'流程已停止',failed:'未完成'};

export class Voice {
  constructor({api,bridge,capture,conversations=null,authenticated=()=>false,toast=()=>{},silenceOptions={}}){
    Object.assign(this,{capture,authenticated,toast,silenceOptions});
    this.session=null;this.recorder=null;this.clockTimer=null;this.sampleTimer=null;this.limitTimer=null;this.startedAt=0;
    this.canRecord=Boolean(globalThis.MediaRecorder&&navigator.mediaDevices?.getUserMedia);
    this.button=document.querySelector('#voice-mic');this.stopButton=document.querySelector('#voice-stop');this.cancelButton=document.querySelector('#voice-cancel');
    this.status=document.querySelector('#voice-status');this.stage=document.querySelector('#voice-stage');this.time=document.querySelector('#voice-time');this.level=document.querySelector('#voice-level');
    this.transcript=document.querySelector('#voice-transcript');this.reply=document.querySelector('#voice-reply');this.choices=document.querySelector('#voice-choices');
    this.flow=new VoiceFlow({api,bridge,conversations,isAuthorized:authenticated,isForeground:()=>!document.hidden,
      onState:(state,message)=>this.renderState(state,message),onDebug:value=>this.renderDebug(value),
      onTranscript:text=>{this.transcript.textContent=text;document.querySelector('#voice-transcript-wrap').hidden=!text;},
      onRecord:record=>this.renderRecord(record),onChoices:(kind,items)=>this.renderChoices(kind,items)});
    this.button.addEventListener('click',()=>{if(this.session?.state==='recording')this.stop(true);else this.start();});
    this.stopButton.addEventListener('click',()=>this.stop(true));
    this.cancelButton.addEventListener('click',()=>{const recording=['requesting','recording','stopping'].includes(this.flow.state);this.interrupt(recording?'已取消這次錄音，音訊沒有送出。':'已停止本頁後續處理；已送出的後端工作可能仍在進行。手機已收到的操作請自行確認。');});
    document.addEventListener('visibilitychange',()=>{if(document.hidden)this.interrupt(['requesting','recording','stopping'].includes(this.flow.state)?'已停止並捨棄這次錄音。回到畫面後，可以重新開始。':'已停止本頁後續處理；已送出的後端工作可能仍在進行。');});
    if(!this.canRecord){this.button.disabled=true;this.status.textContent='這個環境不支援錄音，請從其他工具使用文字或匯入音檔。';}
  }
  isBusy(){return VOICE_BUSY.has(this.flow.state);}
  renderState(state,message){
    const recording=state==='recording',busy=VOICE_BUSY.has(state);
    this.status.textContent=message||'點一下，開始說話。';this.stage.textContent=STAGE_LABELS[state]||'處理中';
    this.button.classList.toggle('listening',recording);this.button.classList.toggle('working',busy&&!recording);
    this.button.disabled=!this.canRecord||(busy&&!recording);this.button.setAttribute('aria-label',recording?'結束錄音並送出':'開始語音指令');this.button.setAttribute('aria-pressed',String(recording));
    this.stopButton.hidden=!recording&&state!=='stopping';this.stopButton.disabled=!recording;
    this.cancelButton.hidden=!busy;this.cancelButton.disabled=false;
    this.cancelButton.textContent=['requesting','recording','stopping'].includes(state)?'取消錄音':'停止本頁後續處理';
    document.querySelector('#voice-meter-wrap').hidden=!recording;
    document.querySelector('#voice-mic-label').textContent=recording?'收聽中 · 說完請按下方按鈕':state==='stopping'?'已結束收聽，正在收尾音訊':busy?'處理進度會顯示在下方':'點一下，開始錄音';
  }
  renderDebug(value){
    const fields={stage:STAGE_LABELS[value.stage]||value.stage||'準備好',trace:value.traceId,audio_http:value.audioHttpId,chat_http:value.chatHttpId,error_http:value.errorHttpId,job:value.jobId,request:value.requestId,conversation:value.conversationId,parent:value.parentRequestId,history:(value.history||[]).map(s=>STAGE_LABELS[s]||s).join(' → ')};
    for(const [key,text]of Object.entries(fields)){const node=document.querySelector(`#voice-debug-${key}`);if(node)node.textContent=text?String(text).slice(0,1500):'尚未取得';}
    document.querySelector('#voice-debug').hidden=!(value.history?.length||value.jobId||value.requestId);
  }
  renderRecord(record){
    if(!record){this.reply.textContent='';document.querySelector('#voice-reply-wrap').hidden=true;return;}
    let text=record.error?.message||record.message||labelForStatus(record.status);
    if(record.notes?.length)text+='\n\n'+record.notes.map(n=>`${n.title||'筆記'}${n.preview?`\n${n.preview}`:n.content?`\n${n.content}`:''}`).join('\n\n');
    if(record.note)text+=`\n\n${record.note.title||''}${record.note.content?`\n${record.note.content}`:''}`;
    if(record.storage_target)text+=record.storage_target==='phone'?'\n\n保存位置：手機':'\n\n保存位置：私人中樞';
    if(record.status==='completed'&&record.candidates?.length)text+='\n\n'+record.candidates.map(c=>`${c.name||'未命名'} · ${c.phone_number||''}`).join('\n');
    this.reply.textContent=text;document.querySelector('#voice-reply-wrap').hidden=false;
  }
  renderChoices(kind,items){this.choices.replaceChildren();for(const item of items){const text=kind==='contact'?`${item.name||'未命名'} · ${item.phone_number||''}`:`${item.title||'未命名筆記'}${item.preview?` · ${item.preview}`:''}`;const button=element('button','voice-choice',text);button.type='button';button.addEventListener('click',()=>this.flow.choose(item.candidate_id));this.choices.append(button);}}
  async start(){
    if(VOICE_BUSY.has(this.flow.state))return;if(!this.authenticated())return this.toast('請先完成連線配對。');
    const token=this.capture.acquire('voice');if(!token)return this.toast('另一段錄音正在進行，請先結束它。');
    const run=this.flow.begin();if(!run){this.capture.release(token);return;}
    let session;
    session=new CaptureSession({coordinator:this.capture,token,
      onPhase:phase=>{if(this.session!==session||!this.flow.current(run))return;if(phase==='recording')this.flow.recording(run);else if(phase==='stopping')this.flow.setState('stopping','已結束收聽，正在收尾錄音…');},
      onBlob:blob=>{if(this.session!==session||!this.flow.current(run))return;this.clearCaptureTimers(session);this.session=null;this.recorder=null;this.flow.acceptAudio(run,blob);},
      onError:error=>{if(this.session!==session)return;this.clearCaptureTimers(session);this.session=null;this.recorder=null;this.flow.fail(run,error);}});
    this.session=session;this.time.textContent='00:00';this.level.value=0;
    try{
      if(!globalThis.isSecureContext)throw new Error('語音需要 HTTPS，請使用你的安全網域。');
      const stream=await navigator.mediaDevices.getUserMedia({audio:true});
      if(this.session!==session||!this.flow.current(run)||session.finalized){stopTracks(stream);session.cancel();return;}
      session.setStream(stream);
      const type=['audio/webm;codecs=opus','audio/mp4;codecs=mp4a.40.2','audio/mp4','audio/ogg;codecs=opus','audio/webm'].find(t=>MediaRecorder.isTypeSupported(t));
      const recorder=new MediaRecorder(stream,type?{mimeType:type}:undefined);this.recorder=recorder;session.attach(stream,recorder);
      this.startedAt=performance.now();if(!session.start())return;
      // Clock starts independently: a suspended AudioContext cannot freeze UI.
      this.clockTimer=setInterval(()=>{if(this.session!==session||session.state!=='recording')return;const seconds=Math.floor((performance.now()-this.startedAt)/1000);this.time.textContent=`${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;},200);
      this.limitTimer=setTimeout(()=>{if(this.session===session)this.stop(true);},180000);
      this.startSilenceDetector(run,session,stream);
    }catch(error){
      session.cancel();if(this.session!==session)return;this.clearCaptureTimers(session);this.session=null;this.recorder=null;
      this.flow.fail(run,new Error(error.name==='NotAllowedError'?'麥克風沒有取得授權，請在 APK／瀏覽器設定允許。':errorMessage(error)));
    }
  }
  async startSilenceDetector(run,session,stream){
    try{
      const Context=globalThis.AudioContext||globalThis.webkitAudioContext;if(!Context)throw new Error('no audio context');
      const context=new Context();if(!session.setContext(context))return;
      await context.resume();if(this.session!==session||!this.flow.current(run)||session.state!=='recording')return;
      const source=context.createMediaStreamSource(stream),analyser=context.createAnalyser();analyser.fftSize=2048;source.connect(analyser);
      const values=new Float32Array(analyser.fftSize),gate=new SilenceGate(this.silenceOptions);
      this.sampleTimer=setInterval(()=>{
        if(this.session!==session||session.state!=='recording')return;if(!this.flow.current(run)){this.interrupt();return;}
        try{analyser.getFloatTimeDomainData(values);let energy=0;for(const value of values)energy+=value*value;const rms=Math.sqrt(energy/values.length);this.level.value=Math.min(1,rms*12);const decision=gate.sample(rms,performance.now());if(decision.stop){if(decision.send)this.stop(true);else this.interrupt('沒有聽到明確語音，這次錄音已捨棄。');}}
        catch{clearInterval(this.sampleTimer);this.sampleTimer=null;this.status.textContent='收聽中。音量量測暫時無法使用，請按「結束錄音並送出」。';}
      },100);
    }catch{if(this.session===session&&this.flow.current(run)&&session.state==='recording')this.status.textContent='收聽中。請按「結束錄音並送出」，不用等待自動停頓。';}
  }
  stop(send=true){
    const session=this.session;if(!session)return;
    if(!send){this.interrupt('已取消這次錄音，音訊沒有送出。');return;}
    if(session.state==='requesting'){this.interrupt('錄音尚未開始，已取消等待麥克風。');return;}
    this.clearCaptureTimers(session);session.stop(true);
  }
  clearCaptureTimers(session){if(this.session!==session)return;clearInterval(this.clockTimer);clearInterval(this.sampleTimer);clearTimeout(this.limitTimer);this.clockTimer=null;this.sampleTimer=null;this.limitTimer=null;if(this.level)this.level.value=0;}
  interrupt(message){
    const session=this.session;this.flow.cancel(message||'已停止本頁後續處理；已送出的後端工作可能仍在進行。');
    if(session){this.clearCaptureTimers(session);session.cancel();if(this.session===session)this.session=null;}
    this.recorder=null;
  }
  clear(message='請先完成連線配對。'){this.interrupt(message);this.flow.state='idle';this.renderState('idle',message);this.flow.lastRequestId=null;this.flow.debug={history:[]};this.renderDebug(this.flow.debug);this.transcript.textContent='';this.reply.textContent='';this.choices.replaceChildren();this.time.textContent='';document.querySelector('#voice-transcript-wrap').hidden=true;document.querySelector('#voice-reply-wrap').hidden=true;}
}

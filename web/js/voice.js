// @web-revision: web-v4
import {identifier,validateAudio,errorMessage,labelForStatus,element} from './state.js?rev=web-v4';

const VOICE_BUSY=new Set(['requesting','recording','uploading','transcribing','understanding','dispatching','waiting','selecting']);
const NATIVE_KINDS=new Set(['contacts.search','phone.dial','alarm.create','calendar.create','notes.save_local','notes.share','notes.search_local','notes.update_local']);

// One owner, including while a microphone permission request is pending.
export class CaptureCoordinator {
  constructor(){this.owner=null;}
  acquire(name){if(this.owner)return null;this.owner={name};return this.owner;}
  release(token){if(this.owner===token)this.owner=null;}
}

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
  constructor({api,bridge,isAuthorized=()=>false,isForeground=()=>true,onState=()=>{},onTranscript=()=>{},onRecord=()=>{},onChoices=()=>{},makeId=identifier,setTimer=setTimeout,clearTimer=clearTimeout}={}){
    Object.assign(this,{api,bridge,isAuthorized,isForeground,onState,onTranscript,onRecord,onChoices,makeId,setTimer,clearTimer});
    this.generation=0;this.run=null;this.lastRequestId=null;this.state='idle';this.timer=null;this.attemptedActions=new Set();
  }
  setState(state,message){this.state=state;this.onState(state,message);}
  begin(){
    if(VOICE_BUSY.has(this.state))return null;
    if(!this.isAuthorized()||!this.isForeground()){this.setState('idle','請先完成連線配對，再開始說話。');return null;}
    this.clearTimer(this.timer);this.lastRequestId=null;const run={generation:++this.generation,chatKey:this.makeId('voice'),submitted:false,requestId:null,waiting:null,selection:null};this.run=run;
    this.onTranscript('');this.onRecord(null);this.onChoices(null,[]);this.setState('requesting','正在取得麥克風…');return run;
  }
  current(run){return this.run===run&&run.generation===this.generation&&this.isAuthorized()&&this.isForeground();}
  recording(run){if(this.current(run))this.setState('recording','我在聽。說完停頓一下，我會接著處理。');}
  cancel(message='已停止這次語音。'){if(this.run?.requestId)this.lastRequestId=this.run.requestId;this.generation++;this.run=null;this.clearTimer(this.timer);this.timer=null;this.onChoices(null,[]);this.setState('paused',message);}
  async refreshDisplay(){
    const id=this.lastRequestId,generation=this.generation;if(!id||this.run||!this.isAuthorized()||!this.isForeground())return;
    try{const record=await this.api.getRequest(id);if(generation!==this.generation||id!==this.lastRequestId||this.run||!this.isAuthorized()||!this.isForeground())return;this.onRecord(record);this.setState('paused',['awaiting_device','processing','needs_selection','needs_note_selection'].includes(record.status)?'這次流程已暫停，不會自動繼續。請先確認手機的實際狀態。':record.message||labelForStatus(record.status));}catch{/* Display refresh has no execution permission and never retries an operation. */}
  }
  fail(run,error){if(!this.current(run))return;this.clearTimer(this.timer);run.waiting=null;this.setState('failed',errorMessage(error));}
  async acceptAudio(run,blob){
    if(!this.current(run)||run.audioSubmitted)return;run.audioSubmitted=true;
    try{
      const type=validateAudio(blob);this.setState('uploading','正在將語音交給私人設備…');
      const job=await this.api.uploadCommandAudio(blob,type);if(!this.current(run))return;
      run.jobId=job.job_id;this.setState('transcribing','正在本地轉錄…');await this.pollAudio(run);
    }catch(error){this.fail(run,error);}
  }
  async pollAudio(run){
    if(!this.current(run))return;
    try{
      const job=await this.api.audioJob(run.jobId);if(!this.current(run))return;
      if(job.status==='transcribed'){
        const transcript=String(job.transcript||'').trim();if(!transcript)throw new Error('沒有辨識到語音，請再說一次。');
        this.onTranscript(transcript);if(transcript.length>8000)throw new Error('這段語音超過指令上限，請用短一些的句子。');
        await this.submitTranscript(run,transcript);return;
      }
      if(['queued','transcribing'].includes(job.status)){this.timer=this.setTimer(()=>this.pollAudio(run),1200);return;}
      throw new Error(job.error?.message||job.message||'語音沒有完成轉錄，請檢查本地服務。');
    }catch(error){this.fail(run,error);}
  }
  async submitTranscript(run,text){
    if(!this.current(run)||run.submitted)return;
    run.submitted=true;this.setState('understanding','正在理解你想做的事…');
    try{
      const caps=this.bridge.ready?[...this.bridge.capabilities].filter(kind=>NATIVE_KINDS.has(kind)):[];
      const record=await this.api.chat(text,run.chatKey,{noteTarget:'phone_first',nativeCapabilities:caps});if(!this.current(run))return;
      if(!record.request_id)throw new Error('中樞沒有回傳指令編號，請檢查後端版本。');
      run.requestId=record.request_id;await this.readRequest(run);
    }catch(error){this.fail(run,error);}
  }
  async readRequest(run){
    if(!this.current(run)||!run.requestId)return;
    try{const record=await this.api.getRequest(run.requestId);if(!this.current(run))return;await this.processRecord(run,record);}
    catch(error){this.fail(run,error);}
  }
  async processRecord(run,record){
    if(!this.current(run)||record.request_id!==run.requestId)return;
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
    if(record.status==='processing'){this.timer=this.setTimer(()=>this.readRequest(run),1200);return;}
    if(record.status==='failed'){this.fail(run,new Error(record.error?.message||record.message||'這次指令未完成。'));return;}
    const message=record.message||labelForStatus(record.status);
    this.setState(record.status==='needs_clarification'?'clarify':'completed',message);
  }
  async nativeResult(value){
    const run=this.run;if(!run||!this.current(run)||!run.waiting)return false;
    if(value.message_id!==run.waiting.message_id||value.action_id!==run.waiting.action_id)return false;
    this.clearTimer(this.timer);run.waiting=null;this.setState('understanding','正在確認手機的實際結果…');await this.readRequest(run);return true;
  }
  nativeError(value,message){const run=this.run;if(!run||!this.current(run)||!run.waiting||value?.message_id!==run.waiting.message_id)return false;this.fail(run,new Error(message||'手機未完成這次操作；不會自動重試。'));return true;}
  async choose(candidateId){
    const run=this.run;if(!run||!this.current(run)||!run.selection||run.selection.busy)return;
    if(!run.selection.candidates.some(c=>c.candidate_id===candidateId))return;
    run.selection.busy=true;this.setState('understanding','正在確認你的選擇…');this.onChoices(null,[]);
    try{if(run.selection.kind==='contact')await this.api.selectContact(run.requestId,candidateId);else await this.api.selectNote(run.requestId,candidateId);if(this.current(run)){run.selection=null;await this.readRequest(run);}}
    catch(error){this.fail(run,error);}
  }
}

export class Voice {
  constructor({api,bridge,capture,authenticated=()=>false,toast=()=>{},silenceOptions={}}){
    Object.assign(this,{capture,authenticated,toast,silenceOptions});this.stream=null;this.recorder=null;this.captureToken=null;this.context=null;this.sampleTimer=null;this.limitTimer=null;this.captureRun=null;this.interrupted=false;this.chunks=[];this.byteCount=0;this.startedAt=0;this.canRecord=Boolean(globalThis.MediaRecorder&&navigator.mediaDevices?.getUserMedia);
    this.button=document.querySelector('#voice-mic');this.status=document.querySelector('#voice-status');this.time=document.querySelector('#voice-time');this.transcript=document.querySelector('#voice-transcript');this.reply=document.querySelector('#voice-reply');this.choices=document.querySelector('#voice-choices');
    this.flow=new VoiceFlow({api,bridge,isAuthorized:authenticated,isForeground:()=>!document.hidden,onState:(state,message)=>this.renderState(state,message),onTranscript:text=>{this.transcript.textContent=text;document.querySelector('#voice-transcript-wrap').hidden=!text;},onRecord:record=>this.renderRecord(record),onChoices:(kind,items)=>this.renderChoices(kind,items)});
    this.button.addEventListener('click',()=>{if(this.recorder?.state==='recording')this.stop(true);else this.start();});
    document.addEventListener('visibilitychange',()=>{if(document.hidden)this.interrupt('已暫停這次語音。回到畫面後，可以重新說一次。');});
    if(!globalThis.MediaRecorder||!navigator.mediaDevices?.getUserMedia){this.button.disabled=true;this.status.textContent='這個環境不支援錄音，請從其他工具使用文字或匯入音檔。';}
  }
  renderState(state,message){this.status.textContent=message||'點一下，開始說話。';this.button.classList.toggle('listening',state==='recording');this.button.classList.toggle('working',VOICE_BUSY.has(state)&&state!=='recording');this.button.disabled=!this.canRecord||(VOICE_BUSY.has(state)&&state!=='recording');this.button.setAttribute('aria-label',state==='recording'?'結束錄音並送出':'開始語音指令');this.button.setAttribute('aria-pressed',String(state==='recording'));document.querySelector('#voice-mic-label').textContent=state==='recording'?'說完停頓，或再點一下結束':VOICE_BUSY.has(state)?'交給我處理…':'點一下，說說你想做的事';}
  renderRecord(record){if(!record){this.reply.textContent='';document.querySelector('#voice-reply-wrap').hidden=true;return;}let text=record.error?.message||record.message||labelForStatus(record.status);if(record.notes?.length)text+='\n\n'+record.notes.map(n=>`${n.title||'筆記'}${n.preview?`\n${n.preview}`:n.content?`\n${n.content}`:''}`).join('\n\n');if(record.note)text+=`\n\n${record.note.title||''}${record.note.content?`\n${record.note.content}`:''}`;if(record.storage_target)text+=record.storage_target==='phone'?'\n\n保存位置：手機':'\n\n保存位置：私人中樞';if(record.status==='completed'&&record.candidates?.length)text+='\n\n'+record.candidates.map(c=>`${c.name||'未命名'} · ${c.phone_number||''}`).join('\n');this.reply.textContent=text;document.querySelector('#voice-reply-wrap').hidden=false;}
  renderChoices(kind,items){this.choices.replaceChildren();for(const item of items){const text=kind==='contact'?`${item.name||'未命名'} · ${item.phone_number||''}`:`${item.title||'未命名筆記'}${item.preview?` · ${item.preview}`:''}`;const button=element('button','voice-choice',text);button.type='button';button.addEventListener('click',()=>this.flow.choose(item.candidate_id));this.choices.append(button);}}
  async start(){
    if(VOICE_BUSY.has(this.flow.state))return;if(!this.authenticated())return this.toast('請先完成連線配對。');
    const token=this.capture.acquire('voice');if(!token)return this.toast('另一段錄音正在進行，請先結束它。');
    const run=this.flow.begin();if(!run){this.capture.release(token);return;}this.captureToken=token;this.captureRun=run;this.interrupted=false;this.chunks=[];this.byteCount=0;this.time.textContent='';
    try{
      if(!globalThis.isSecureContext)throw new Error('語音需要 HTTPS，請使用你的安全網域。');
      const stream=await navigator.mediaDevices.getUserMedia({audio:true});
      if(!this.flow.current(run)){for(const track of stream.getTracks())track.stop();this.capture.release(token);return;}
      this.stream=stream;const type=['audio/webm;codecs=opus','audio/mp4','audio/ogg;codecs=opus','audio/webm'].find(t=>MediaRecorder.isTypeSupported(t));
      const recorder=new MediaRecorder(stream,type?{mimeType:type}:undefined);this.recorder=recorder;
      recorder.addEventListener('dataavailable',event=>{if(this.captureRun!==run||this.interrupted)return;if(event.data.size){this.chunks.push(event.data);this.byteCount+=event.data.size;if(this.byteCount>10*1024*1024)this.stop(false,'錄音超過大小上限，請用短一些的指令。');}});
      recorder.addEventListener('error',()=>{if(this.captureRun===run)this.stop(false,'錄音未完成，請再試一次。');});
      recorder.addEventListener('stop',()=>{
        if(this.captureRun!==run)return;const send=!this.interrupted&&this.flow.current(run);const chunks=this.chunks;this.chunks=[];this.releaseCapture(token);
        if(send){const blob=new Blob(chunks,{type:recorder.mimeType||type||'audio/webm'});this.flow.acceptAudio(run,blob);}else this.captureRun=null;
      });
      this.startedAt=performance.now();recorder.start(250);this.flow.recording(run);this.limitTimer=setTimeout(()=>this.stop(true),180000);await this.startSilenceDetector(run,stream);
    }catch(error){if(this.flow.current(run)){this.releaseCapture(token);this.flow.fail(run,new Error(error.name==='NotAllowedError'?'麥克風沒有取得授權，請在 APK／瀏覽器設定允許。':errorMessage(error)));}}
  }
  async startSilenceDetector(run,stream){
    try{
      const Context=globalThis.AudioContext||globalThis.webkitAudioContext;if(!Context)throw new Error('no audio context');
      const context=new Context();this.context=context;await context.resume();if(!this.flow.current(run)||this.recorder?.state!=='recording'){context.close().catch(()=>{});return;}
      const source=context.createMediaStreamSource(stream),analyser=context.createAnalyser();analyser.fftSize=2048;source.connect(analyser);const values=new Float32Array(analyser.fftSize),gate=new SilenceGate(this.silenceOptions);
      this.sampleTimer=setInterval(()=>{if(!this.flow.current(run)){this.interrupt();return;}analyser.getFloatTimeDomainData(values);let energy=0;for(const value of values)energy+=value*value;const now=performance.now();this.time.textContent=`${Math.floor((now-this.startedAt)/1000)} 秒`;const decision=gate.sample(Math.sqrt(energy/values.length),now);if(decision.stop)this.stop(decision.send,decision.reason==='no_speech'?'沒有聽到明確語音，這次錄音已捨棄。':undefined);},100);
    }catch{if(this.flow.current(run)&&this.recorder?.state==='recording')this.status.textContent='我在聽。這台裝置請再點一下，結束並送出。';}
  }
  stop(send,message){if(!send){this.interrupted=true;this.flow.cancel(message||'這次錄音已停止，不會送出。');}if(this.recorder?.state==='recording')this.recorder.stop();else this.releaseCapture(this.captureToken);clearInterval(this.sampleTimer);clearTimeout(this.limitTimer);}
  releaseCapture(token){clearInterval(this.sampleTimer);clearTimeout(this.limitTimer);this.sampleTimer=null;this.limitTimer=null;for(const track of this.stream?.getTracks()||[])track.stop();this.stream=null;if(this.context){this.context.close().catch(()=>{});this.context=null;}this.capture.release(token);if(this.captureToken===token)this.captureToken=null;}
  interrupt(message){this.interrupted=true;this.flow.cancel(message||'已停止這次語音。');if(this.recorder?.state==='recording')this.recorder.stop();this.releaseCapture(this.captureToken);this.captureRun=null;this.chunks=[];}
  clear(){this.interrupt('請先完成連線配對。');this.flow.lastRequestId=null;this.transcript.textContent='';this.reply.textContent='';this.choices.replaceChildren();this.time.textContent='';document.querySelector('#voice-transcript-wrap').hidden=true;document.querySelector('#voice-reply-wrap').hidden=true;}
}

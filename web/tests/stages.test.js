import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {VoiceFlow} from '../js/voice.js?rev=web-v7';
import {CaptureCoordinator,CaptureSession} from '../js/capture.js?rev=web-v7';

function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
test('音訊 202 queued 不宣稱 STT 已開始，只有 job.status 才推進階段',async()=>{
  const snapshots=[{status:'queued'},{status:'transcribing'},{status:'transcribed',transcript:'幫我記下今天的想法'}];
  const waitingChat=deferred(),states=[],transcripts=[];let next,chatOptions;
  const api={uploadCommandAudio:async()=>({job_id:'job1',status:'queued',trace_id:'upload_trace',http_request_id:'upload_http'}),audioJob:async()=>snapshots.shift(),chat:async(_,__,options)=>{chatOptions=options;return waitingChat.promise;},getRequest:async()=>({request_id:'req1',status:'completed',message:'已完成'})};
  const flow=new VoiceFlow({api,bridge:{ready:false},isAuthorized:()=>true,isForeground:()=>true,onState:state=>states.push(state),onTranscript:text=>transcripts.push(text),setTimer:fn=>{next=fn;return 0;},clearTimer:()=>{}});
  const run=flow.begin();await flow.acceptAudio(run,new Blob(['voice'],{type:'audio/webm'}));
  assert.equal(flow.state,'queued');assert.equal(states.includes('transcribing'),false);assert.equal(states.includes('understanding'),false);
  await next();assert.equal(flow.state,'transcribing');const pending=next();await Promise.resolve();await Promise.resolve();
  assert.equal(flow.state,'sending');assert.ok(states.includes('transcribed'));assert.equal(transcripts.at(-1),'幫我記下今天的想法');assert.equal(chatOptions.sourceJobId,'job1');
  assert.equal(states.includes('received_request'),false);waitingChat.resolve({request_id:'req1',trace_id:'upload_trace',http_request_id:'chat_http'});await pending;
  assert.ok(states.includes('received_request'));assert.equal(flow.debug.traceId,'upload_trace');assert.equal(flow.debug.audioHttpId,'upload_http');assert.equal(flow.debug.chatHttpId,'chat_http');assert.equal(flow.debug.jobId,'job1');assert.equal(flow.debug.requestId,'req1');assert.equal(flow.state,'completed');
});
test('只有後端 request processing 才顯示 Agent 理解中',async()=>{const states=[];const flow=new VoiceFlow({api:{},bridge:{},isAuthorized:()=>true,isForeground:()=>true,onState:s=>states.push(s),setTimer:()=>0,clearTimer:()=>{}});const run=flow.begin();run.requestId='req1';await flow.processRecord(run,{request_id:'req1',status:'processing'});assert.equal(flow.state,'understanding');assert.ok(states.includes('understanding'));});
test('失敗時保留 server HTTP ID 到折疊診斷，不重新送錄音或指令',()=>{const flow=new VoiceFlow({isAuthorized:()=>true,isForeground:()=>true});const run=flow.begin();flow.fail(run,{message:'轉錄服務未配置',httpRequestId:'server_error_trace'});assert.equal(flow.state,'failed');assert.equal(flow.debug.errorHttpId,'server_error_trace');assert.equal(run.audioSubmitted,undefined);assert.equal(run.submitted,false);});
test('重複排隊輪詢不把整個診斷流程洗成重複排隊文字',()=>{const flow=new VoiceFlow({isAuthorized:()=>true,isForeground:()=>true});flow.begin();flow.setState('uploading');flow.setState('queued');for(let i=0;i<40;i++)flow.setState('queued');assert.deepEqual(flow.debug.history,['requesting','uploading','queued']);});
test('UI 提供獨立結束與取消、時間、音量、主狀態；ID 只放折疊資訊',async()=>{const html=await readFile(new URL('../index.html',import.meta.url),'utf8'),main=await readFile(new URL('../js/main.js',import.meta.url),'utf8');assert.match(html,/id="voice-stop"[^>]*>結束錄音並送出/);assert.match(html,/id="voice-cancel"/);assert.match(html,/<meter id="voice-level"/);assert.match(html,/id="voice-stage"/);assert.match(html,/<details id="voice-debug"/);assert.match(main,/voice\?\.isBusy\(\)/);});
test('錄音器在 start 同步回報 error 時不能再次標記收聽或啟動計時',()=>{const coordinator=new CaptureCoordinator(),token=coordinator.acquire('voice'),events=new Map(),phases=[];const recorder={state:'inactive',addEventListener:(name,fn)=>events.set(name,fn),start(){events.get('error')();},stop(){}};const session=new CaptureSession({coordinator,token,onPhase:state=>phases.push(state)});session.attach({getTracks:()=>[]},recorder);assert.equal(session.start(),false);assert.equal(coordinator.owner,null);assert.equal(session.state,'failed');assert.equal(phases.includes('recording'),false);});

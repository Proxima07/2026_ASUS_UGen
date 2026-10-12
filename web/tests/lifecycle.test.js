import test from 'node:test';
import assert from 'node:assert/strict';
import {Actions} from '../js/actions.js?rev=web-v7';
import {Notes} from '../js/notes.js?rev=web-v7';
import {Chat} from '../js/chat.js?rev=web-v7';
import {Recorder} from '../js/recorder.js?rev=web-v7';

function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
const textNode=()=>({textContent:'',classList:{toggle(){}}});
test('登出後才抵達的 action 列表不重新填入畫面',async()=>{const job=deferred();let renders=0;const fake={refreshing:false,generation:1,api:{actions:()=>job.promise},actions:new Map(),requests:new Map(),render:()=>{renders++;}};const pending=Actions.prototype.refresh.call(fake);fake.generation++;job.resolve({items:[{action_id:'private',state:'pending_confirmation'}]});await pending;assert.equal(fake.actions.size,0);assert.equal(renders,0);});
test('登出後才抵達的筆記列表被序號失效機制丟棄',async()=>{const job=deferred();let renders=0;const fake={authenticated:()=>true,loadSequence:0,search:{value:''},api:{notes:()=>job.promise},items:[],render:()=>{renders++;},message:textNode()};const pending=Notes.prototype.load.call(fake);fake.loadSequence++;job.resolve({items:[{title:'私人筆記',content:'不應出現在登出畫面'}]});await pending;assert.equal(fake.items.length,0);assert.equal(renders,0);});
test('登出後才抵達的 LLM 回應不追加私人對話或手機操作',async()=>{const job=deferred();let updates=0;let actions=0;const fake={busy:false,authenticated:()=>true,input:{value:'幫我設鬧鐘'},pending:{text:'幫我設鬧鐘',key:'same-key',reply:textNode()},generation:0,send:{},hint:textNode(),api:{chat:()=>job.promise},replies:new Map(),update:()=>{updates++;},actions:{acceptRequest:()=>{actions++;}},toast:()=>{}};const pending=Chat.prototype.submit.call(fake);fake.generation++;job.resolve({request_id:'private',message:'你的私人行程'});await pending;assert.equal(updates,0);assert.equal(actions,0);assert.equal(fake.replies.size,0);});
test('登出後才抵達的音訊上傳回應不恢復 job 與輪詢',async()=>{const job=deferred();let polled=false;const fake={uploading:false,authenticated:()=>true,blob:new Blob(['audio'],{type:'audio/webm'}),setRecording(){},jobTimer:null,generation:0,message:textNode(),result:{},api:{uploadAudio:()=>job.promise},activeJob:null,poll:async()=>{polled=true;},finishUpload(){}};const pending=Recorder.prototype.upload.call(fake);fake.generation++;job.resolve({job_id:'private-job'});await pending;assert.equal(fake.activeJob,null);assert.equal(polled,false);});

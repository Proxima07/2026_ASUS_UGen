import test from 'node:test';
import assert from 'node:assert/strict';
import {ConversationCoordinator} from '../js/conversation.js?rev=web-v9';
import {Chat} from '../js/chat.js?rev=web-v9';
import {Api,ApiError} from '../js/api.js?rev=web-v9';
import {VoiceFlow} from '../js/voice.js?rev=web-v9';
import {Actions} from '../js/actions.js?rev=web-v9';

const accepted=(requestId='req_b10c9e70eac38f0db3af650f84b1c824',conversationId='conv_a190f1720b1bcc66fe17e6bf74b11c6f',status='completed')=>({
  request_id:requestId,conversation_id:conversationId,status
});

test('v6 review: text 和 voice 共用同一個 pending reservation，不能同時送出兩個回合',()=>{
  const conversation=new ConversationCoordinator();
  const text=conversation.reserve('text',{attemptKey:'text-1'});
  assert.ok(text);assert.equal(conversation.reserve('voice',{attemptKey:'voice-1'}),null);
  assert.equal(conversation.snapshot().conversationId,'new');
  conversation.release(text);
  const voice=conversation.reserve('voice',{attemptKey:'voice-1'});
  assert.ok(voice);assert.equal(conversation.reserve('text',{attemptKey:'text-2'}),null);
});

test('v6 review: 新會話丟棄舊回應，舊 finally 不能解除新回合 reservation',()=>{
  const conversation=new ConversationCoordinator();
  const old=conversation.reserve('text',{attemptKey:'old'}),oldSnapshot=conversation.snapshot();
  conversation.reset();
  const fresh=conversation.reserve('voice',{attemptKey:'fresh'});
  assert.equal(conversation.adopt(old,accepted('req_9bffecd2ade6badbdddcfd839605a48b','conv_3bb59abc6e20b834cbb2269f28880895')),false);
  conversation.release(old);assert.equal(conversation.active(fresh),true);
  assert.equal(conversation.sameGeneration(oldSnapshot.generation),false);
  assert.equal(conversation.ownsRequest('req_9bffecd2ade6badbdddcfd839605a48b'),false);
  assert.equal(conversation.adopt(fresh,accepted('req_6cb8a8a4cb12b8128b8874973f270165','conv_2d1b1a96e3e08f2cd43c0cc4b695ac5d')),true);
  assert.deepEqual(conversation.snapshot(),{
    generation:1,conversationId:'conv_2d1b1a96e3e08f2cd43c0cc4b695ac5d',parentRequestId:'req_6cb8a8a4cb12b8128b8874973f270165'
  });
});

test('v6 review: 取消尚未收到 POST 回覆的 token 使晚到成功和錯誤失效',()=>{
  const conversation=new ConversationCoordinator();
  const stale=conversation.reserve('voice',{attemptKey:'voice-1'});
  assert.equal(conversation.cancel(stale),true);
  const next=conversation.reserve('text',{attemptKey:'text-1'});
  assert.equal(conversation.active(stale),false);
  assert.equal(conversation.adopt(stale,accepted()),false);
  assert.equal(conversation.markUncertain(stale),false);
  assert.equal(conversation.cancel(stale),false);
  conversation.release(stale);assert.equal(conversation.active(next),true);
  assert.equal(conversation.snapshot().conversationId,'new');
});

test('v6 review: 登出／切到背景後 reset 不讓舊會話的 ID 和 request 再進入目前狀態',()=>{
  const conversation=new ConversationCoordinator();
  const first=conversation.reserve('voice',{attemptKey:'first'});
  conversation.adopt(first,accepted('req_e3c2c5e07975d43832775856bfa6d643'));conversation.release(first);
  const pending=conversation.reserve('text',{attemptKey:'follow-up'});
  conversation.reset();
  assert.equal(conversation.adopt(pending,accepted('req_07ee2b56b8ce3cdeeb2efa275e12a34e')),false);
  assert.equal(conversation.matchesRecord(accepted('req_e3c2c5e07975d43832775856bfa6d643')),false);
  assert.equal(conversation.matchesRecord(accepted('req_07ee2b56b8ce3cdeeb2efa275e12a34e')),false);
  assert.deepEqual(conversation.snapshot(),{generation:1,conversationId:'new',parentRequestId:null});
});

test('v6 review: 只採納格式正確的 server ID，HTTP 200 的 failed 回合仍提交會話 head',()=>{
  const conversation=new ConversationCoordinator();
  const token=conversation.reserve('text',{attemptKey:'first'});
  for(const record of [
    accepted('req_f54ffc6321f6a8565c861db686e9c0b6','https://other.example/private'),
    accepted('../private','conv_dbb8b733fdfaca2c150b42317d3829f6'),
    accepted('req_f54ffc6321f6a8565c861db686e9c0b6','conv_'+'x'.repeat(121)),
    accepted('req_f54ffc6321f6a8565c861db686e9c0b6','conv_'+'a'.repeat(31)),
    accepted('req_'+'a'.repeat(33),'conv_dbb8b733fdfaca2c150b42317d3829f6'),
    accepted('req_f54ffc6321f6a8565c861db686e9c0b6','conv_'+'g'.repeat(32)),
    accepted('req_'+'A'.repeat(32),'conv_dbb8b733fdfaca2c150b42317d3829f6'),
    {request_id:'req_f54ffc6321f6a8565c861db686e9c0b6',status:'completed'},
    {conversation_id:'conv_dbb8b733fdfaca2c150b42317d3829f6',status:'completed'},
    null
  ])assert.equal(conversation.adopt(token,record),false);
  assert.deepEqual(conversation.snapshot(),{generation:0,conversationId:'new',parentRequestId:null});
  assert.equal(conversation.ownsRequest('req_f54ffc6321f6a8565c861db686e9c0b6'),false);
  assert.equal(conversation.adopt(token,accepted('req_f54ffc6321f6a8565c861db686e9c0b6','conv_dbb8b733fdfaca2c150b42317d3829f6','failed')),true);
  assert.deepEqual(conversation.snapshot(),{generation:0,conversationId:'conv_dbb8b733fdfaca2c150b42317d3829f6',parentRequestId:'req_f54ffc6321f6a8565c861db686e9c0b6'});
});

test('v6 review: 語音澄清後下一次文字／語音保留 conversation 與 parent request',()=>{
  const conversation=new ConversationCoordinator();
  const first=conversation.reserve('voice',{attemptKey:'voice-first'});
  assert.equal(conversation.adopt(first,accepted('req_216bb1013c190c9746a16bb4a0966578','conv_d6bd2b7bf928e0fe9784159a3a3d1595','needs_clarification')),true);
  conversation.release(first);
  const followUp=conversation.reserve('text',{attemptKey:'text-detail',context:conversation.snapshot()});
  assert.equal(followUp.conversationId,'conv_d6bd2b7bf928e0fe9784159a3a3d1595');
  assert.equal(followUp.parentRequestId,'req_216bb1013c190c9746a16bb4a0966578');
  assert.equal(conversation.adopt(followUp,accepted('req_b3a795f8afd0e9d7a3df08dd317a1c58','conv_d6bd2b7bf928e0fe9784159a3a3d1595')),true);
  conversation.release(followUp);
  const voice=conversation.reserve('voice',{attemptKey:'voice-next'});
  assert.equal(voice.conversationId,'conv_d6bd2b7bf928e0fe9784159a3a3d1595');assert.equal(voice.parentRequestId,'req_b3a795f8afd0e9d7a3df08dd317a1c58');
});

test('v6 review: 不同會話回覆與歷史列表不能冒充目前會話的 request',()=>{
  const conversation=new ConversationCoordinator();
  const first=conversation.reserve('text',{attemptKey:'first'});
  conversation.adopt(first,accepted('req_57507dc9958b7a0de52360d518490bd8','conv_c687fae2e6612da25acea69f6604c44f'));conversation.release(first);
  assert.equal(conversation.matchesRecord(accepted('req_20553e00b51d9e3578847b8556c0b363','conv_c687fae2e6612da25acea69f6604c44f')),false);
  assert.equal(conversation.matchesRecord(accepted('req_57507dc9958b7a0de52360d518490bd8','conv_aef8aa8b6e9cf6eda406cb88cf33708c')),false);
  assert.equal(conversation.matchesRecord(accepted('req_57507dc9958b7a0de52360d518490bd8','conv_c687fae2e6612da25acea69f6604c44f')),true);
  // Earlier API versions may omit conversation_id when returning an already-owned request.
  assert.equal(conversation.matchesRecord({request_id:'req_57507dc9958b7a0de52360d518490bd8'}),true);
  const continuation=conversation.reserve('voice',{attemptKey:'next'});
  assert.equal(conversation.adopt(continuation,accepted('req_2c2b3205995f7f83402b8060f20612c7','conv_aef8aa8b6e9cf6eda406cb88cf33708c')),false);
  assert.equal(conversation.snapshot().parentRequestId,'req_57507dc9958b7a0de52360d518490bd8');
});

test('v6 review: timeout 後只允許原 owner 和同一 attempt key 明確重試',()=>{
  const conversation=new ConversationCoordinator();
  const initial=conversation.reserve('text',{attemptKey:'same-key'}),context=conversation.snapshot();
  assert.equal(conversation.markUncertain(initial),true);
  assert.equal(conversation.active(initial),false);
  assert.equal(conversation.reserve('voice',{attemptKey:'same-key'}),null);
  assert.equal(conversation.reserve('text',{attemptKey:'different-key'}),null);
  assert.equal(conversation.reserve('text'),null);
  const retry=conversation.reserve('text',{attemptKey:'same-key',context});
  assert.ok(retry);assert.equal(retry.conversationId,initial.conversationId);
  assert.equal(retry.parentRequestId,initial.parentRequestId);
  assert.equal(conversation.adopt(initial,accepted('req_07ee2b56b8ce3cdeeb2efa275e12a34e','conv_cf8ce05594c0f3d2995c916af73a34ec')),false);
  conversation.release(initial);assert.equal(conversation.active(retry),true);
  conversation.adopt(retry,accepted('req_0484cd043ca25322a2a40012b0672365','conv_4bf6390046e3fee42d3ca3d478c0f65e'));conversation.release(retry);
  assert.ok(conversation.reserve('voice',{attemptKey:'new-voice'}));
});

test('v6 review: 舊的重試快照不能套用到已延續或已重開的會話',()=>{
  const conversation=new ConversationCoordinator(),empty=conversation.snapshot();
  const first=conversation.reserve('text',{attemptKey:'first'});
  conversation.adopt(first,accepted());conversation.release(first);
  assert.equal(conversation.reserve('text',{attemptKey:'retry-empty',context:empty}),null);
  const oldHead=conversation.snapshot(),second=conversation.reserve('voice',{attemptKey:'second'});
  conversation.adopt(second,accepted('req_5767fcd603eee1b83dee5c4da9516a80'));conversation.release(second);
  assert.equal(conversation.reserve('text',{attemptKey:'retry-first',context:oldHead}),null);
  const oldGeneration=conversation.snapshot();conversation.reset();
  assert.equal(conversation.reserve('text',{attemptKey:'retry-old',context:oldGeneration}),null);
});

test('v6 review: 已接受的回合不因一般 cancel 或重複 release 遺失延續上下文',()=>{
  const conversation=new ConversationCoordinator();
  const first=conversation.reserve('voice',{attemptKey:'first'});
  conversation.adopt(first,accepted('req_7940b00b2a66fdafae355e9b4e0f8d0a','conv_a8261fc5c5fa57ed8c9822dd4d2d6464'));
  assert.equal(conversation.cancel(first),false);conversation.release(first);
  const next=conversation.reserve('text',{attemptKey:'next'});
  conversation.release(first);conversation.release(first);
  assert.equal(conversation.active(next),true);
  assert.equal(next.conversationId,'conv_a8261fc5c5fa57ed8c9822dd4d2d6464');assert.equal(next.parentRequestId,'req_7940b00b2a66fdafae355e9b4e0f8d0a');
});

test('v6 review: 同一 reservation 的二次採納不能將 head 變成其他 request',()=>{
  const conversation=new ConversationCoordinator(),token=conversation.reserve('text',{attemptKey:'one-post'});
  assert.equal(conversation.adopt(token,accepted('req_a8ae4ccd871ab2b56e660154348d5550','conv_157b4dc3e201a0182fcf5620bee2bf9a')),true);
  assert.equal(conversation.adopt(token,accepted('req_bbd47a0417bb20f1a00c03f21dc3bb7c','conv_157b4dc3e201a0182fcf5620bee2bf9a')),false);
  assert.equal(conversation.snapshot().parentRequestId,'req_a8ae4ccd871ab2b56e660154348d5550');
  assert.equal(conversation.ownsRequest('req_bbd47a0417bb20f1a00c03f21dc3bb7c'),false);
});

function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
class Node {
  constructor(){this.children=[];this.textContent='';this.value='';this.hidden=false;this.disabled=false;this.parentElement=null;this.listeners=new Map();this.classList={toggle(){}};}
  addEventListener(name,listener){this.listeners.set(name,listener);}
  append(...children){for(const child of children){child.remove();child.parentElement=this;this.children.push(child);}}
  remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(child=>child!==this);this.parentElement=null;}
  before(node){if(!this.parentElement)return;const parent=this.parentElement;node.remove();const index=parent.children.indexOf(this);parent.children.splice(index,0,node);node.parentElement=parent;}
  replaceChildren(...children){for(const child of [...this.children])child.remove();this.append(...children);}
  focus(){}
  setAttribute(){}
}
function chatFixture({api,conversations=new ConversationCoordinator()}={}){
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,'document'),nodes=new Map(),acceptedRecords=[],toasts=[];let notesChanged=0;
  const document={hidden:false,querySelector(selector){if(!nodes.has(selector))nodes.set(selector,new Node());return nodes.get(selector);},querySelectorAll:()=>[],createElement:()=>new Node()};
  Object.defineProperty(globalThis,'document',{configurable:true,value:document});
  document.querySelector('#conversation').append(document.querySelector('#conversation-empty'));
  const chat=new Chat({api,conversations,authenticated:()=>true,
    actions:{acceptRequest:record=>acceptedRecords.push(record)},
    onNotesChanged:()=>notesChanged++,toast:message=>toasts.push(message)});
  return {chat,conversations,nodes,acceptedRecords,toasts,get notesChanged(){return notesChanged;},
    restore(){if(descriptor)Object.defineProperty(globalThis,'document',descriptor);else delete globalThis.document;}};
}

test('v6 review: Api 只送 opaque context references，不送網頁 messages 或歷史紀錄',async()=>{
  let body;const api=new Api({fetchImpl:async(_path,options)=>{
    body=JSON.parse(options.body);return {ok:true,status:200,json:async()=>accepted()};
  }});
  await api.chat('接著幫我記下','one-key',{conversationId:'conv_720369a7ea2bd51ba89c12e392b01b2b',parentRequestId:'req_64a281462736808c8298c179f374548a',messages:[{role:'system',content:'不要送出'}]});
  assert.equal(body.conversation_id,'conv_720369a7ea2bd51ba89c12e392b01b2b');assert.equal(body.parent_request_id,'req_64a281462736808c8298c179f374548a');
  assert.equal(body.messages,undefined);assert.equal(body.history,undefined);
  await api.chat('第一句','new-key',{conversationId:'new',parentRequestId:null});
  assert.equal(body.conversation_id,'new');assert.equal(body.parent_request_id,undefined);
});

test('v6 review: Chat 次回合使用第一次 server context，包含 failed 的有效 head',async()=>{
  const calls=[];const h=chatFixture({api:{chat:async(text,key,options)=>{
    calls.push({text,key,options});return accepted(calls.length===1?'req_2a0e17607de42cd8fede5e2332fd09f2':'req_5cefe4ef1982eaf9b4e5415ab6da6d41','conv_b1a6962dd4225694e382c1c72a8ba933',calls.length===1?'failed':'completed');
  }}});
  try{
    h.chat.input.value='第一句';await h.chat.submit();
    assert.equal(h.conversations.snapshot().parentRequestId,'req_2a0e17607de42cd8fede5e2332fd09f2');
    h.chat.input.value='補充說明';await h.chat.submit();
    assert.equal(calls[0].options.conversationId,'new');assert.equal(calls[0].options.parentRequestId,null);
    assert.equal(calls[1].options.conversationId,'conv_b1a6962dd4225694e382c1c72a8ba933');assert.equal(calls[1].options.parentRequestId,'req_2a0e17607de42cd8fede5e2332fd09f2');
    assert.equal(h.acceptedRecords.length,2);assert.equal(h.chat.replies.size,2);
  }finally{h.restore();}
});

test('v6 review: Chat timeout 同 key 和 immutable context 人工重試，不新增另一個 request',async()=>{
  const calls=[];const h=chatFixture({api:{chat:async(text,key,options)=>{
    calls.push({text,key,options});if(calls.length===1)throw new ApiError('等待超時',0,'timeout');
    return accepted('req_edcd1865f98b27c31eb06bfc4971be1b','conv_0acc7ef14f4b379c166c75ebfc7f0ee4');
  }}});
  try{
    h.chat.input.value='幫我記下今天';await h.chat.submit();
    assert.ok(h.conversations.uncertain);assert.equal(h.chat.busy,false);
    assert.equal(h.conversations.reserve('voice',{attemptKey:'voice-new'}),null);
    h.chat.input.value='更改內容';await h.chat.submit();assert.equal(calls.length,1);
    h.chat.input.value='幫我記下今天';await h.chat.submit();
    assert.equal(calls.length,2);assert.equal(calls[0].key,calls[1].key);assert.deepEqual(calls[0].options,calls[1].options);
    assert.equal(h.conversations.uncertain,null);assert.equal(h.chat.replies.size,1);
  }finally{h.restore();}
});

test('v6 review: Chat 暫停後的晚到 POST 不更新畫面、pending 或新會話 reservation',async()=>{
  const old=deferred(),fresh=deferred();let calls=0;
  const h=chatFixture({api:{chat:()=>++calls===1?old.promise:fresh.promise}});
  try{
    h.chat.input.value='舊指令';const oldSubmission=h.chat.submit();assert.equal(h.chat.busy,true);
    h.chat.pause();h.conversations.reset();h.chat.clear();
    h.chat.input.value='新指令';const newSubmission=h.chat.submit(),freshToken=h.conversations.pending;
    old.resolve(accepted('req_9bffecd2ade6badbdddcfd839605a48b','conv_3bb59abc6e20b834cbb2269f28880895'));await oldSubmission;
    assert.equal(h.chat.busy,true);assert.equal(h.conversations.active(freshToken),true);
    assert.equal(h.chat.pending.text,'新指令');assert.equal(h.chat.replies.size,0);assert.equal(h.acceptedRecords.length,0);
    fresh.resolve(accepted('req_668842604fe1c0305da1aba3117e28ec','conv_19f000886345b9519ac5977b97d3a795'));await newSubmission;
    assert.equal(h.chat.busy,false);assert.equal(h.conversations.snapshot().conversationId,'conv_19f000886345b9519ac5977b97d3a795');
    assert.equal(h.acceptedRecords.length,1);assert.equal(h.chat.replies.has('req_9bffecd2ade6badbdddcfd839605a48b'),false);
  }finally{h.restore();}
});

test('v6 review: Chat 不渲染未知 history，不因 new chat 清除已保存的 notes',async()=>{
  const h=chatFixture({api:{chat:async()=>({...accepted('req_7be6640d383158e3f0d679182bd20c51','conv_c3bf05b92fd5a7b5dc96f51e1be2b627'),note:{note_id:'note_keep',title:'已保存',content:'保留內容'}})}});
  try{
    h.chat.input.value='保存筆記';await h.chat.submit();assert.equal(h.notesChanged,1);
    const count=h.chat.conversation.children.length;
    h.chat.update({...accepted('req_20553e00b51d9e3578847b8556c0b363','conv_c3bf05b92fd5a7b5dc96f51e1be2b627'),text:'伺服器歷史',note:{note_id:'note_unknown',title:'陌生',content:'不應顯示'}});
    assert.equal(h.chat.conversation.children.length,count);assert.equal(h.notesChanged,1);
    h.conversations.reset();h.chat.clear();
    h.chat.update({...accepted('req_7be6640d383158e3f0d679182bd20c51','conv_c3bf05b92fd5a7b5dc96f51e1be2b627'),text:'晚到舊筆記',note:{note_id:'note_keep',title:'舊',content:'忽略'}});
    assert.equal(h.chat.replies.size,0);assert.equal(h.chat.conversation.children.length,1);assert.equal(h.notesChanged,1);
  }finally{h.restore();}
});

function voiceFixture({api,conversations=new ConversationCoordinator()}={}){
  const records=[],states=[],executed=[];let sequence=0;
  const bridge={ready:true,capabilities:new Set(['alarm.create']),supports:()=>true,
    execute:(actionId,kind)=>{executed.push({actionId,kind});return 'native-message';}};
  const flow=new VoiceFlow({api,bridge,conversations,isAuthorized:()=>true,isForeground:()=>true,
    onRecord:record=>records.push(record),onState:(state,message)=>states.push({state,message}),
    makeId:prefix=>`${prefix}-${++sequence}`,setTimer:()=>0,clearTimer:()=>{}});
  return {flow,conversations,records,states,executed};
}

test('v6 review: VoiceFlow 和 Chat 真正共用 send reservation，兩個方向都不發第二 POST',async()=>{
  const pendingText=deferred(),pendingVoice=deferred();let postCount=0;
  const conversations=new ConversationCoordinator(),h=chatFixture({conversations,api:{chat:()=>{postCount++;return pendingText.promise;}}});
  const voice=voiceFixture({conversations,api:{chat:()=>{postCount++;return pendingVoice.promise;},getRequest:async()=>accepted('req_fa42291a7a9c623109da7fe219e8e31f','conv_99df86502da719adff1277a2349d3ddd')}});
  try{
    h.chat.input.value='文字指令';const textJob=h.chat.submit();
    assert.equal(voice.flow.begin(),null);assert.equal(postCount,1);
    pendingText.resolve(accepted('req_59fa01d7057316e78150bdbe3c50f75b','conv_99df86502da719adff1277a2349d3ddd'));await textJob;
    const run=voice.flow.begin();assert.ok(run);const voiceJob=voice.flow.submitTranscript(run,'語音指令');
    assert.equal(postCount,2);h.chat.input.value='另一句文字';await h.chat.submit();assert.equal(postCount,2);
    pendingVoice.resolve(accepted('req_fa42291a7a9c623109da7fe219e8e31f','conv_99df86502da719adff1277a2349d3ddd'));await voiceJob;
    assert.equal(voice.flow.state,'completed');assert.equal(conversations.snapshot().parentRequestId,'req_fa42291a7a9c623109da7fe219e8e31f');
  }finally{h.restore();}
});

test('v6 review: Voice 先錄音但文字先送出時，語音不得另外發送 concurrent POST',async()=>{
  const pendingText=deferred();let voicePosts=0;
  const conversations=new ConversationCoordinator(),h=chatFixture({conversations,api:{chat:()=>pendingText.promise}});
  const voice=voiceFixture({conversations,api:{chat:async()=>{voicePosts++;return accepted();}}});
  try{
    const run=voice.flow.begin();assert.ok(run);
    h.chat.input.value='文字先送';const pending=h.chat.submit();
    await voice.flow.submitTranscript(run,'晚到轉錄');assert.equal(voicePosts,0);assert.equal(voice.flow.state,'failed');
    pendingText.resolve(accepted());await pending;
  }finally{h.restore();}
});

test('v6 review: VoiceFlow 澄清後下一句沿用 context 和 parent，保留上一個澄清提示',async()=>{
  const posts=[];const records=new Map([
    ['req_216bb1013c190c9746a16bb4a0966578',{...accepted('req_216bb1013c190c9746a16bb4a0966578','conv_99df86502da719adff1277a2349d3ddd','needs_clarification'),message:'請告訴我幾點'}],
    ['req_1a0cfa827437be6a31e0ea68001d5060',{...accepted('req_1a0cfa827437be6a31e0ea68001d5060','conv_99df86502da719adff1277a2349d3ddd'),message:'已完成'}]
  ]);
  const h=voiceFixture({api:{chat:async(text,key,options)=>{
    posts.push({text,key,options});return records.get(posts.length===1?'req_216bb1013c190c9746a16bb4a0966578':'req_1a0cfa827437be6a31e0ea68001d5060');
  },getRequest:async id=>records.get(id)}});
  const first=h.flow.begin();await h.flow.submitTranscript(first,'幫我設定鬧鐘');assert.equal(h.flow.state,'clarify');
  const resetCount=h.records.filter(record=>record===null).length;
  const next=h.flow.begin();assert.ok(next);assert.equal(h.records.filter(record=>record===null).length,resetCount);
  await h.flow.submitTranscript(next,'明天七點');
  assert.equal(posts[0].options.conversationId,'new');assert.equal(posts[0].options.parentRequestId,null);
  assert.equal(posts[1].options.conversationId,'conv_99df86502da719adff1277a2349d3ddd');assert.equal(posts[1].options.parentRequestId,'req_216bb1013c190c9746a16bb4a0966578');
  assert.equal(h.flow.state,'completed');assert.equal(h.conversations.snapshot().parentRequestId,'req_1a0cfa827437be6a31e0ea68001d5060');
});

test('v6 review: cancel in-flight voice POST 之後 text 開新會話，晚到語音不讀取或 dispatch',async()=>{
  const lateVoice=deferred();let gets=0;
  const conversations=new ConversationCoordinator(),voice=voiceFixture({conversations,api:{
    chat:()=>lateVoice.promise,getRequest:async()=>{gets++;return accepted('req_9bffecd2ade6badbdddcfd839605a48b','conv_3bb59abc6e20b834cbb2269f28880895');}
  }});
  const h=chatFixture({conversations,api:{chat:async()=>accepted('req_668842604fe1c0305da1aba3117e28ec','conv_19f000886345b9519ac5977b97d3a795')}});
  try{
    const run=voice.flow.begin(),pending=voice.flow.submitTranscript(run,'舊鬧鐘');
    voice.flow.cancel();assert.equal(conversations.snapshot().conversationId,'new');
    h.chat.input.value='新的文字';await h.chat.submit();
    lateVoice.resolve(accepted('req_9bffecd2ade6badbdddcfd839605a48b','conv_3bb59abc6e20b834cbb2269f28880895'));await pending;
    assert.equal(gets,0);assert.equal(voice.executed.length,0);assert.equal(voice.flow.state,'paused');
    assert.equal(conversations.snapshot().parentRequestId,'req_668842604fe1c0305da1aba3117e28ec');assert.equal(conversations.ownsRequest('req_9bffecd2ade6badbdddcfd839605a48b'),false);
  }finally{h.restore();}
});

test('v6 review: VoiceFlow 不因 server history 或不同 conversation 的 action 自動執行',async()=>{
  const h=voiceFixture({api:{chat:async()=>accepted('req_57507dc9958b7a0de52360d518490bd8','conv_c687fae2e6612da25acea69f6604c44f'),getRequest:async()=>({
    ...accepted('req_57507dc9958b7a0de52360d518490bd8','conv_20de53e2da3413590a2cc2513befcf0d','awaiting_device'),action_id:'act_history',
    action:{action_id:'act_history',request_id:'req_57507dc9958b7a0de52360d518490bd8',state:'pending_confirmation',kind:'alarm.create'}
  })}});
  const run=h.flow.begin();await h.flow.submitTranscript(run,'目前指令');
  assert.equal(h.executed.length,0);assert.equal(h.records.filter(Boolean).length,0);
  await h.flow.processRecord(run,{
    ...accepted('req_20553e00b51d9e3578847b8556c0b363','conv_c687fae2e6612da25acea69f6604c44f','awaiting_device'),action_id:'act_history',
    action:{action_id:'act_history',request_id:'req_20553e00b51d9e3578847b8556c0b363',state:'pending_confirmation',kind:'alarm.create'}
  });
  assert.equal(h.executed.length,0);assert.equal(h.records.filter(Boolean).length,0);
});

test('v6 review: Actions 列表過濾歷史 request，不能重新帶回新對話或 replay native action',async()=>{
  const conversation=new ConversationCoordinator(),token=conversation.reserve('text',{attemptKey:'first'});
  conversation.adopt(token,accepted('req_a07f8da6219fb90beb8a076f80486050','conv_b1e5c306b88830815ed20a9605ae53ca'));conversation.release(token);
  const h=chatFixture({conversations:conversation,api:{}}),requested=[],updates=[];let executions=0;
  const action=(id,requestId)=>({action_id:id,request_id:requestId,state:'pending_confirmation',kind:'alarm.create',payload:{hour:7,minute:0}});
  const actions=new Actions({api:{actions:async()=>({items:[action('act_visible','req_a07f8da6219fb90beb8a076f80486050'),action('act_history','req_20553e00b51d9e3578847b8556c0b363')]}),
    getRequest:async id=>{requested.push(id);return {...accepted(id,'conv_b1e5c306b88830815ed20a9605ae53ca','awaiting_device'),action:action('act_visible',id)};}},
    bridge:{nativePresent:true,ready:true,supports:()=>true,execute:()=>executions++},container:new Node(),
    isRequestVisible:id=>conversation.ownsRequest(id),onRequest:record=>updates.push(record)});
  try{
    await actions.refresh();assert.deepEqual(requested,['req_a07f8da6219fb90beb8a076f80486050']);assert.equal(actions.actions.has('act_history'),false);
    assert.equal(updates.length,1);assert.equal(executions,0);
    conversation.reset();actions.stop();await actions.refresh();
    assert.equal(actions.actions.size,0);assert.equal(actions.requests.size,0);assert.equal(updates.length,1);assert.equal(executions,0);
  }finally{actions.stop();h.restore();}
});

test('v6 review: STT 等待期間文字已提交新 head，晚到轉錄不能悄悄套用新上下文',async()=>{
  const stt=deferred();let voicePosts=0;
  const conversations=new ConversationCoordinator(),voice=voiceFixture({conversations,api:{
    uploadCommandAudio:async()=>({job_id:'job_voice'}),audioJob:()=>stt.promise,
    chat:async()=>{voicePosts++;return accepted('req_fa42291a7a9c623109da7fe219e8e31f','conv_b1a6962dd4225694e382c1c72a8ba933');}
  }}),h=chatFixture({conversations,api:{chat:async()=>accepted('req_59fa01d7057316e78150bdbe3c50f75b','conv_b1a6962dd4225694e382c1c72a8ba933')}});
  try{
    const run=voice.flow.begin(),audio=voice.flow.acceptAudio(run,new Blob(['audio'],{type:'audio/webm'}));
    await Promise.resolve();await Promise.resolve();
    h.chat.input.value='更新目前話題';await h.chat.submit();
    stt.resolve({status:'transcribed',transcript:'那就明天七點'});await audio;
    assert.equal(voicePosts,0);assert.equal(voice.flow.state,'failed');
    assert.match(voice.states.at(-1).message,/對話已有新回覆/);
    assert.equal(conversations.snapshot().parentRequestId,'req_59fa01d7057316e78150bdbe3c50f75b');
  }finally{h.restore();}
});

test('v6 review: Chat 新會話後晚到 timeout 不標記 uncertain，也不覆寫新 pending 的錯誤',async()=>{
  const stale=deferred(),fresh=deferred();let calls=0;
  const h=chatFixture({api:{chat:()=>++calls===1?stale.promise:fresh.promise}});
  try{
    h.chat.input.value='先前指令';const old=h.chat.submit();h.conversations.reset();h.chat.clear();
    h.chat.input.value='現在指令';const current=h.chat.submit(),token=h.conversations.pending,reply=h.chat.pending.reply;
    stale.reject(new ApiError('舊請求逾時',0,'timeout'));await old;
    assert.equal(h.conversations.uncertain,null);assert.equal(h.conversations.active(token),true);
    assert.equal(h.chat.pending.reply,reply);assert.doesNotMatch(reply.textContent,/舊請求逾時/);assert.equal(h.chat.busy,true);
    fresh.resolve(accepted('req_2966925ba4e556abf42dfd1c3c3cecbb','conv_7ac0c9282f7100d36e0b016c28284513'));await current;
    assert.equal(h.conversations.snapshot().parentRequestId,'req_2966925ba4e556abf42dfd1c3c3cecbb');
  }finally{h.restore();}
});

test('v6 review: Voice 新會話後晚到 5xx 不污染新 coordinator head 或 uncertain 狀態',async()=>{
  const stale=deferred(),conversations=new ConversationCoordinator();
  const voice=voiceFixture({conversations,api:{chat:()=>stale.promise}});
  const run=voice.flow.begin(),pending=voice.flow.submitTranscript(run,'舊語音');
  conversations.reset();voice.flow.cancel();
  const current=conversations.reserve('text',{attemptKey:'new-text'});
  conversations.adopt(current,accepted('req_2966925ba4e556abf42dfd1c3c3cecbb','conv_7ac0c9282f7100d36e0b016c28284513'));conversations.release(current);
  stale.reject(new ApiError('舊服務失敗',503,'unavailable'));await pending;
  assert.equal(conversations.uncertain,null);assert.equal(conversations.snapshot().parentRequestId,'req_2966925ba4e556abf42dfd1c3c3cecbb');
  assert.equal(voice.flow.state,'paused');assert.equal(voice.executed.length,0);
});

// @web-revision: web-v8
export class ApiError extends Error {
  constructor(message, status=0, code='request_failed',httpRequestId=null) {super(message);this.name='ApiError';this.status=status;this.code=code;this.httpRequestId=httpRequestId;}
}
export class Api {
  constructor({fetchImpl=globalThis.fetch.bind(globalThis), onUnauthorized=()=>{}}={}) {this.fetchImpl=fetchImpl;this.onUnauthorized=onUnauthorized;this.authEpoch=0;this.controllers=new Set();}
  invalidateSession(){this.authEpoch++;for(const controller of this.controllers)controller.abort();this.controllers.clear();}
  async request(path,{method='GET',body,headers={},timeout=120000,notifyUnauthorized=true}={}) {
    if(!path.startsWith('/v1/') || path.includes('://')) throw new ApiError('只允許同來源 API。',0,'invalid_path');
    const epoch=this.authEpoch,controller=new AbortController();this.controllers.add(controller);const timer=setTimeout(()=>controller.abort(),timeout);
    try {
      const options={method,credentials:'same-origin',cache:'no-store',redirect:'error',signal:controller.signal,headers:{Accept:'application/json',...headers}};
      if(body!==undefined){if(body instanceof Blob){options.body=body;}else{options.headers['Content-Type']='application/json';options.body=JSON.stringify(body);}}
      const response=await this.fetchImpl(path,options);let data;const httpRequestId=response.headers?.get?.('X-Request-ID')||null;
      try{data=await response.json();}catch{throw new ApiError('伺服器未回傳有效 API 內容，請檢查網址與 Tunnel 設定。',response.status,'invalid_response',httpRequestId);}
      if(epoch!==this.authEpoch)throw new ApiError('登入身分已更新，這筆舊回覆已捨棄。',0,'stale_session');
      if(!response.ok){const e=data.error || data.detail || {};if(response.status===401&&notifyUnauthorized)this.onUnauthorized({status:401,code:e.code||'unauthorized',httpRequestId});throw new ApiError(typeof e.message==='string'?e.message:'請求未完成，請檢查登入或服務設定。',response.status,e.code || 'request_failed',httpRequestId);}
      if(httpRequestId&&data&&typeof data==='object'&&!Array.isArray(data))data.http_request_id=httpRequestId;
      return data;
    }catch(error){if(epoch!==this.authEpoch)throw new ApiError('登入身分已更新，這筆舊回覆已捨棄。',0,'stale_session');if(error instanceof ApiError)throw error;if(error?.name==='AbortError')throw new ApiError('等待服務超時；已送出的操作可能仍在處理，請先更新狀態。',0,'timeout');throw new ApiError('連線中斷，請確認私人中樞與網路後再試。',0,'network_error');}finally{clearTimeout(timer);this.controllers.delete(controller);}
  }
  me(){return this.request('/v1/auth/me',{timeout:15000,notifyUnauthorized:false});}
  async pair(code,label){
    // A browser receives a device credential once, exchanges it for an HttpOnly
    // session, and never writes it to storage or exposes it to the DOM.
    let paired=await this.request('/v1/auth/pair',{method:'POST',body:{code,label},timeout:15000});
    try{return await this.request('/v1/auth/session',{method:'POST',headers:{Authorization:`Bearer ${paired.token}`},timeout:15000});}
    finally{delete paired.token;paired=null;}
  }
  logout(){return this.request('/v1/auth/logout',{method:'POST',timeout:15000});}
  chat(text,idempotencyKey,{noteTarget='phone_first',nativeCapabilities=[],sourceJobId,conversationId,parentRequestId,timezone}={}){const body={text,timezone:timezone||Intl.DateTimeFormat().resolvedOptions().timeZone||'Asia/Taipei',idempotency_key:idempotencyKey,note_target:noteTarget,native_capabilities:nativeCapabilities};if(sourceJobId)body.source_job_id=sourceJobId;if(conversationId)body.conversation_id=conversationId;if(parentRequestId)body.parent_request_id=parentRequestId;return this.request('/v1/chat',{method:'POST',body});}
  getRequest(id){return this.request(`/v1/requests/${encodeURIComponent(id)}`,{timeout:20000});}
  selectContact(id,candidateId){return this.request(`/v1/requests/${encodeURIComponent(id)}/select-contact`,{method:'POST',body:{candidate_id:candidateId}});}
  selectNote(id,candidateId){return this.request(`/v1/requests/${encodeURIComponent(id)}/select-note`,{method:'POST',body:{candidate_id:candidateId}});}
  actions(){return this.request('/v1/actions',{timeout:20000});}
  cancelAction(id){return this.request(`/v1/actions/${encodeURIComponent(id)}/cancel`,{method:'POST'});}
  notes(query=''){return this.request(`/v1/notes?q=${encodeURIComponent(query)}`,{timeout:20000});}
  createNote(note){return this.request('/v1/notes',{method:'POST',body:note});}
  createNativeNoteAction(note){return this.request('/v1/notes/native-actions',{method:'POST',body:note});}
  updateNote(id,note){return this.request(`/v1/notes/${encodeURIComponent(id)}`,{method:'PUT',body:note});}
  deleteNote(id){return this.request(`/v1/notes/${encodeURIComponent(id)}`,{method:'DELETE'});}
  noteAction(id,kind,key){return this.request(`/v1/notes/${encodeURIComponent(id)}/actions`,{method:'POST',body:{kind,idempotency_key:key}});}
  uploadAudio(blob,type){return this.request('/v1/audio',{method:'POST',body:blob,headers:{'Content-Type':type}});}
  uploadCommandAudio(blob,type){return this.request('/v1/audio?purpose=command',{method:'POST',body:blob,headers:{'Content-Type':type}});}
  audioJob(id){return this.request(`/v1/audio/${encodeURIComponent(id)}`,{timeout:20000});}
}

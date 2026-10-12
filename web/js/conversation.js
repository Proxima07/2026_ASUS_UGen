// @web-revision: web-v9
// Only opaque server identifiers live here. User/assistant history is assembled
// by the server, never accepted from the browser as authority.
export class ConversationCoordinator {
  constructor(){this.generation=0;this.sequence=0;this.conversationId=null;this.parentRequestId=null;this.pending=null;this.uncertain=null;this.requestIds=new Set();}
  snapshot(){return {generation:this.generation,conversationId:this.conversationId||'new',parentRequestId:this.parentRequestId};}
  reserve(owner,{attemptKey,context}={}){
    if(this.pending)return null;
    if(this.uncertain&&(!attemptKey||this.uncertain.owner!==owner||this.uncertain.attemptKey!==attemptKey))return null;
    const current=this.snapshot();
    if(context&&(context.generation!==current.generation||context.conversationId!==current.conversationId||context.parentRequestId!==current.parentRequestId))return null;
    const token={...current,owner,attemptKey,sequence:++this.sequence,accepted:false};this.pending=token;return token;
  }
  active(token){return Boolean(token&&this.pending===token&&token.generation===this.generation);}
  sameGeneration(generation){return generation===this.generation;}
  adopt(token,record){
    if(!this.active(token)||!record)return false;
    if(token.accepted)return record.request_id===token.requestId&&record.conversation_id===this.conversationId;
    const conversationId=record.conversation_id,requestId=record.request_id;
    if(typeof conversationId!=='string'||!/^conv_[0-9a-f]{32}$/.test(conversationId)||typeof requestId!=='string'||!/^req_[0-9a-f]{32}$/.test(requestId))return false;
    if(token.conversationId!=='new'&&token.conversationId!==conversationId)return false;
    this.conversationId=conversationId;this.parentRequestId=requestId;this.requestIds.add(requestId);this.uncertain=null;token.accepted=true;token.requestId=requestId;return true;
  }
  release(token){if(this.pending===token)this.pending=null;}
  markUncertain(token){if(!this.active(token)||token.accepted)return false;this.uncertain={owner:token.owner,attemptKey:token.attemptKey};this.release(token);return true;}
  cancel(token){if(!this.active(token)||token.accepted)return false;this.reset();return true;}
  ownsRequest(requestId){return this.requestIds.has(requestId);}
  matchesRecord(record){return this.ownsRequest(record?.request_id)&&(!record.conversation_id||record.conversation_id===this.conversationId);}
  reset(){this.generation++;this.conversationId=null;this.parentRequestId=null;this.pending=null;this.uncertain=null;this.requestIds.clear();}
}
export function uncertainResponse(error){return error?.code==='invalid_response'||typeof error?.status!=='number'||error.status===0||error.status>=500;}

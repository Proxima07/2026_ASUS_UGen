import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// Mount controls from the shipped HTML: missing IDs return null instead of
// inventing elements. This exercises main.js wiring, not isolated prototypes.
class Element {
  constructor(tag,attributes={}){
    this.tag=tag;this.attributes=new Map(Object.entries(attributes));this.children=[];this.listeners=new Map();this.parentElement=null;this.textContent='';this.value='';this.files=[];this.hidden='hidden'in attributes;this.disabled='disabled'in attributes;this.open=false;
    this.dataset=Object.fromEntries(Object.entries(attributes).filter(([key])=>key.startsWith('data-')).map(([key,value])=>[key.slice(5),value]));
    this.classes=new Set((attributes.class||'').split(/\s+/));this.classList={toggle:(name,active)=>active?this.classes.add(name):this.classes.delete(name),contains:name=>this.classes.has(name)};
  }
  addEventListener(type,callback){const values=this.listeners.get(type)||[];values.push(callback);this.listeners.set(type,values);}
  async emit(type){await Promise.all((this.listeners.get(type)||[]).map(callback=>callback({preventDefault(){},target:this})));}
  setAttribute(name,value){this.attributes.set(name,value);}
  removeAttribute(name){this.attributes.delete(name);}
  append(...nodes){for(const node of nodes){node.parentElement=this;this.children.push(node);}}
  replaceChildren(...nodes){for(const node of this.children)node.parentElement=null;this.children=[];this.append(...nodes);}
  remove(){const list=this.parentElement?.children;if(list){const index=list.indexOf(this);if(index>=0)list.splice(index,1);}this.parentElement=null;}
  before(node){const parent=this.parentElement;if(!parent)return;node.remove();const index=parent.children.indexOf(this);parent.children.splice(index,0,node);node.parentElement=parent;}
  focus(){}scrollIntoView(){}
}
function mount(html){
  const all=[],stack=[],events=new Map();
  for(const token of html.match(/<!--[\s\S]*?-->|<[^>]+>|[^<]+/g)||[]){
    if(token.startsWith('<!--')||token.startsWith('<!'))continue;
    if(token.startsWith('</')){stack.pop();continue;}
    if(token.startsWith('<')){
      const tag=token.match(/^<([\w-]+)/)?.[1];if(!tag)continue;const attributes={};
      for(const [,key,quoted,bare]of token.matchAll(/\s+([\w-]+)(?:="([^"]*)"|=([^\s>]+))?/g))attributes[key]=quoted??bare??'';
      const element=new Element(tag,attributes);all.push(element);stack.at(-1)?.append(element);
      if(!['meta','link','input','br','hr','img','source','path','rect'].includes(tag)&&!token.endsWith('/>'))stack.push(element);
    }else if(stack.length)stack.at(-1).textContent+=token.trim();
  }
  function matches(node,selector){if(selector.startsWith('#'))return node.attributes.get('id')===selector.slice(1);if(selector.startsWith('.'))return node.classes.has(selector.slice(1));if(selector.startsWith('['))return node.attributes.has(selector.slice(1,-1));return node.tag===selector;}
  return {hidden:false,querySelector:selector=>all.find(node=>matches(node,selector))||null,querySelectorAll:selector=>all.filter(node=>matches(node,selector)),createElement:tag=>new Element(tag),
    addEventListener(type,callback){const list=events.get(type)||[];list.push(callback);events.set(type,list);},async emit(type){await Promise.all((events.get(type)||[]).map(callback=>callback()));}};
}
const deferred=()=>{let resolve;const promise=new Promise(ok=>resolve=ok);return {promise,resolve};};
const settle=async()=>{for(let count=0;count<30;count++)await Promise.resolve();};
const json=value=>({ok:true,status:200,headers:{get:()=>null},json:async()=>value});

test('完整 HTML + main 初始化：主麥克風可取消等待、紅色收聽／時間更新、切換身分清除舊筆記',async()=>{
  const html=await readFile(new URL('../index.html',import.meta.url),'utf8'),document=mount(html);
  const keys=['document','navigator','location','NativeBridge','MediaRecorder','AudioContext','webkitAudioContext','isSecureContext','performance','fetch','setTimeout','clearTimeout','setInterval','clearInterval'];
  const descriptors=new Map(keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  const intervals=new Map(),timeouts=new Map(),permission=deferred(),oldNotes=deferred();let now=0,timerId=0,permissions=0,stopped=0,principal='A',notesPending=false;
  const stream=()=>({getTracks:()=>[{stop:()=>stopped++}]});
  class Recorder {
    static isTypeSupported(){return true;}constructor(){this.state='inactive';this.mimeType='audio/webm';this.events=new Map();}
    addEventListener(type,callback){this.events.set(type,callback);}start(){this.state='recording';}stop(){this.state='inactive';this.events.get('stop')?.();}
  }
  const replace=(key,value)=>Object.defineProperty(globalThis,key,{configurable:true,value});
  replace('document',document);replace('navigator',{mediaDevices:{getUserMedia:()=>++permissions===1?permission.promise:Promise.resolve(stream())}});replace('location',{protocol:'https:'});replace('NativeBridge',undefined);replace('MediaRecorder',Recorder);replace('AudioContext',undefined);replace('webkitAudioContext',undefined);replace('isSecureContext',true);replace('performance',{now:()=>now});
  replace('setTimeout',(fn,ms)=>{const id=++timerId;timeouts.set(id,{fn,ms});return id;});replace('clearTimeout',id=>timeouts.delete(id));replace('setInterval',(fn,ms)=>{const id=++timerId;intervals.set(id,{fn,ms});return id;});replace('clearInterval',id=>intervals.delete(id));
  replace('fetch',async path=>{
    if(path==='/v1/auth/me')return json({user_id:`user_${principal}`,device_id:`dev_${principal}`,label:principal});
    if(path==='/v1/actions')return json({items:[]});
    if(path.startsWith('/v1/notes?')){if(notesPending){notesPending=false;return oldNotes.promise;}return json({items:[{note_id:`note_${principal}`,title:`${principal} only`,content:`${principal} private`,updated_at:1}]});}
    throw new Error(`unexpected request ${path}`);
  });
  try{
    await import('../js/main.js?mounted-v7');await settle();
    const mic=document.querySelector('#voice-mic'),cancel=document.querySelector('#voice-cancel'),stop=document.querySelector('#voice-stop');
    assert.equal(document.querySelector('#session-description').textContent,'已連接 · A');
    let failSetup=true,transcriptHidden=false;Object.defineProperty(document.querySelector('#voice-transcript-wrap'),'hidden',{configurable:true,get:()=>transcriptHidden,set:value=>{if(failSetup){failSetup=false;throw new Error('setup render failure');}transcriptHidden=value;}});
    await mic.emit('click');await settle();assert.equal(document.querySelector('#voice-stage').textContent,'未完成');
    await mic.emit('click');await settle();assert.equal(document.querySelector('#voice-stage').textContent,'等待麥克風權限');assert.equal(mic.disabled,false);assert.equal(cancel.hidden,false);assert.equal(cancel.classList.contains('capture-cancel'),true);
    await mic.emit('click');await settle();assert.equal(document.querySelector('#voice-stage').textContent,'流程已停止');permission.resolve(stream());await settle();assert.equal(stopped,1);
    await mic.emit('click');await settle();assert.equal(document.querySelector('#voice-stage').textContent,'收聽中');assert.equal(mic.classList.contains('listening'),true);assert.equal(stop.hidden,false);assert.equal(stop.disabled,false);assert.equal(stop.classList.contains('capture-stop'),true);
    now=2400;for(const timer of intervals.values())if(timer.ms===200)timer.fn();assert.equal(document.querySelector('#voice-time').textContent,'00:02');
    await cancel.emit('click');await settle();assert.equal(stopped,2);assert.equal(document.querySelector('#voice-stage').textContent,'流程已停止');
    notesPending=true;await document.querySelector('#tab-notes').emit('click');principal='B';document.hidden=false;await document.emit('visibilitychange');await settle();
    assert.equal(document.querySelector('#session-description').textContent,'已連接 · B');
    oldNotes.resolve(json({items:[{note_id:'note_A',title:'A secret',content:'A private'}]}));await settle();
    const cards=document.querySelector('#notes-list').children;assert.equal(cards.length,1);assert.equal(cards[0].children[0].textContent,'B only');assert.equal(document.querySelector('#note-content').value,'');assert.equal(document.querySelector('#voice-transcript').textContent,'');
  }finally{for(const [key,descriptor]of descriptors){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

import {mount,deferred,settle,json} from './dom-fixture.js';

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

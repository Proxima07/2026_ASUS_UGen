import test from 'node:test';
import assert from 'node:assert/strict';
import {actionDetail,audioType,validateAudio,displayDate,labelForStatus} from '../js/state.js';

test('鬧鐘日期依 Android Calendar 1=週日，且不顯示模型不存在的星期',()=>{
  const text=actionDetail({kind:'alarm.create',payload:{hour:7,minute:5,label:'起床',weekdays:[1,2,7,99]}});
  assert.match(text,/07:05/);assert.match(text,/週日、週一、週六/);assert.doesNotMatch(text,/undefined/);assert.match(text,/確認實際設定/);
});
test('撥號與分享不宣稱電話接通或記事完成',()=>{assert.match(actionDetail({kind:'phone.dial',payload:{name:'媽媽',phone_number:'0912345678'}}),/由你按下通話/);assert.notEqual(labelForStatus('opened'),'已完成');assert.notEqual(labelForStatus('handed_off'),'已完成');});
test('未知狀態與非法時間不直接呈現原始伺服器輸入',()=>{assert.equal(labelForStatus('<script>'),'狀態待確認');assert.equal(displayDate('not a date'),'時間待確認');});
test('已宣告不支援的 MIME 不以副檔名繞過',()=>{assert.equal(audioType({type:'text/html',name:'secret.mp3'}),null);assert.equal(audioType({type:'',name:'note.m4a'}),'audio/mp4');assert.equal(audioType({type:'audio/webm;codecs=opus'}),'audio/webm');});
test('空音檔、超限與不支援類型皆在傳送前阻擋',()=>{assert.throws(()=>validateAudio({size:0,type:'audio/webm'}),/先錄音/);assert.throws(()=>validateAudio({size:10*1024*1024+1,type:'audio/webm'}),/超過/);assert.throws(()=>validateAudio({size:100,type:'text/html'}),/選擇/);assert.equal(validateAudio({size:10*1024*1024,type:'audio/wav'}),'audio/wav');});

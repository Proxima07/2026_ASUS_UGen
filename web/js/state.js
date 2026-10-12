export const STATUS_LABELS = Object.freeze({processing:'理解中',awaiting_device:'等待手機確認',needs_selection:'請選擇聯絡人',needs_clarification:'需要補充資訊',pending_confirmation:'等待確認',claimed:'手機正在處理',completed:'已完成',opened:'已開啟手機介面',handed_off:'已交給手機 App',cancelled:'已取消',permission_denied:'未取得權限',unsupported:'手機不支援',failed:'未完成',expired:'操作已逾時',execution_expired:'執行結果待查核',queued:'等待轉錄',transcribing:'正在轉錄',summarizing:'正在整理筆記',ready:'筆記草稿完成',transcribed:'逐字稿完成',interrupted:'處理已中斷'});
export const ACTION_LABELS = Object.freeze({'contacts.search':'查找手機聯絡人','phone.dial':'開啟撥號介面','alarm.create':'設定手機鬧鐘','calendar.create':'新增手機日曆','notes.save_local':'保存到手機筆記','notes.share':'分享至記事 App','notes.search_local':'查詢手機筆記','notes.update_local':'更新手機筆記'});
export const ACTIVE_ACTION_STATES = new Set(['pending_confirmation','claimed']);
export const AUDIO_PENDING_STATES = new Set(['queued','transcribing','summarizing']);
export function labelForStatus(state) { return STATUS_LABELS[state] || '狀態待確認'; }
export function identifier(prefix = 'web') {
  if (globalThis.crypto?.randomUUID) return `${prefix}_${globalThis.crypto.randomUUID()}`;
  const bytes = new Uint8Array(16); globalThis.crypto.getRandomValues(bytes);
  return `${prefix}_${Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('')}`;
}
export function errorMessage(error) { return typeof error?.message === 'string' && error.message ? error.message : '操作未完成，請稍後再試。'; }
export function displayDate(value) {
  const date = new Date(typeof value === 'number' ? value * 1000 : value);
  if (Number.isNaN(date.getTime())) return '時間待確認';
  return date.toLocaleString('zh-TW',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false});
}
export function actionDetail(action) {
  const p = action?.payload || {};
  switch(action?.kind) {
    case 'contacts.search': return `搜尋「${p.query || ''}」\n僅回傳符合的聯絡人，不上傳整份通訊錄。`;
    case 'phone.dial': return `${p.name || '指定號碼'}\n${p.phone_number || ''}\n開啟後，由你按下通話。`;
    case 'alarm.create': {
      const dayNames=['週日','週一','週二','週三','週四','週五','週六'];
      const days=Array.isArray(p.weekdays)?p.weekdays.filter(d=>Number.isInteger(d)&&d>=1&&d<=7).map(d=>dayNames[d-1]).join('、'):'';
      return `${String(p.hour??'').padStart(2,'0')}:${String(p.minute??'').padStart(2,'0')} · ${p.label || '提醒'}\n${days ? `重複：${days}` : '單次鬧鐘'}\n交給時鐘 App 後，請確認實際設定。`;
    }
    case 'calendar.create': return `${p.title || ''}\n${displayDate(p.start)} → ${displayDate(p.end)}${p.location?`\n地點：${p.location}`:''}\n提醒：${p.reminder_minutes ?? 10} 分鐘前`;
    case 'notes.save_local': case 'notes.share': case 'notes.update_local': return `${p.title || '筆記'}\n${p.content || ''}`;
    case 'notes.search_local': return `搜尋「${p.query || ''}」\n僅查詢這個 APK 自己保存的手機筆記。`;
    default: return '請在手機確認操作內容。';
  }
}
export function audioType(file) {
  const given=(file.type || '').split(';')[0].toLowerCase();
  const allowed=new Set(['audio/webm','audio/wav','audio/x-wav','audio/mpeg','audio/mp4','audio/ogg','audio/aac','audio/flac']);
  if (allowed.has(given)) return given;
  if (given && given!=='application/octet-stream') return null;
  const extension=(file.name || '').split('.').pop()?.toLowerCase();
  return ({webm:'audio/webm',wav:'audio/wav',mp3:'audio/mpeg',m4a:'audio/mp4',ogg:'audio/ogg',aac:'audio/aac',flac:'audio/flac'})[extension] || null;
}
export function validateAudio(file, maxBytes=10*1024*1024) {
  if (!file || !file.size) throw new Error('請先錄音或選擇音檔。');
  if(file.size>maxBytes) throw new Error('音檔超過 10 MiB，請縮短或分段錄音。');
  const type=audioType(file);if(!type) throw new Error('請選擇 WebM、WAV、MP3、M4A、OGG、AAC 或 FLAC 音檔。');
  return type;
}
export function setMessage(element, message, isError=false) { element.textContent=message; element.classList.toggle('error',isError); }
export function element(tag, className, text) { const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node; }

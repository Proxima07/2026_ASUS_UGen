# 網頁子項目 web_v6

版本：6。更新日期：2026-10-12。

web_v6 新增文字／語音共用的多輪對話與倒數計時器，相對 web_v5 提供更新。保留 v5 收聽／停止、真實 STT 階段與追蹤，以及 v4 載入診斷，不需要重新安裝前端依賴。文字、筆記與音檔工具仍在「其他工具」。本版先更新 backend_v5，手機倒數則需 android_v4。

這份網頁是手機優先的個人助理介面，包含對話、筆記、錄音整理。所有資源隨檔案提供，不使用 CDN、第三方分析、雲端語音辨識或瀏覽器 Web Speech API。文字、逐字稿與模型回覆均以 `textContent` 顯示。

## 安裝與開啟

1. 將 `web_v1.zip` 解壓至專案上層，得到 `local-assistant/web/`，與既有 `backend/` 並列。後續差異包依序覆蓋至 web_v6；ZIP 裡已有 local-assistant 外層，解壓到現有 local-assistant 的上一層。
2. 在既有後端上依序套用更新至 `backend_v5.zip`。新版 conversation 欄位及倒數需 v5；原 v3／v4 的語音、筆記與追蹤保留。以 android_v4 APK 更新安裝以支援 timer.create；沒有該能力時不能宣稱已執行手機倒數。
3. 設定後端 `.env` 的 `PUBLIC_BASE_URL=https://你的子網域`。後端由此推導允許的來源與主機名稱。`WEB_DIR` 預設指向與 backend 並列的 web；自訂時填這個目錄的絕對路徑。
4. 更改 .env／WEB_DIR 或首次加入網站後，完整關閉並重新啟動後端。已掛載的 web 目錄內新增檔案能直接供應；重啟不能修復放錯資料夾的檔案。
5. 使用你既有的 cloudflared 即可，不必套用專案的 Tunnel 範例或建立第二份 connector。該子網域指向同一個 FastAPI 服務；網頁、`/v1/*` 與 API 必須同來源，整個 hostname 轉到後端。
6. 用 `https://你的子網域/` 開啟。一般瀏覽器輸入管理者產生的一次性配對碼；APK 先在原生連線頁配對，由 APK 注入 HttpOnly Cookie 後載入網頁。

網頁無須 npm install 或 build。不建議單獨以 `python -m http.server` 展示，因為沒有後端 API、同來源 Cookie 與 HTTPS 錄音條件。

## 功能與操作

### 語音首頁：正常使用只需點一下，說出指令

1. 點麥克風開始，取得手機／瀏覽器授權後說話。
2. 以手機本地 Web Audio 音量偵測，在已偵測到語音後停頓約 2 秒，自動停止。也可再點一次手動結束。
3. 自動以 raw 音訊呼叫 `/v1/audio?purpose=command`，僅在私人設備轉錄，不先做摘要、不先建立平台筆記。
4. 完成轉錄後，自動送一次 `/v1/chat`。助理判斷要打電話、設定鬧鐘、安排日曆，或保存／查詢／修改筆記。
5. 此次語音對應的手機操作會自動交給 APK；原生畫面確認實際內容與權限。首頁不需要再按上傳、分析或執行。
6. 同名聯絡人或多筆相似筆記時，才顯示精簡候選項目。選定後繼續同一請求，不需要自己選「功能類型」。

語音路由以 `note_target:phone_first` 與已握手的原生能力為提示。手機具備能力時，新增／搜尋／更新先使用 APK 自己的加密筆記；不預先建立平台副本。手機能力不足或明確回覆不支援時，後端退回私人中樞，並在結果顯示實際保存位置。手機筆記是我們自己的筆記區，不是任意品牌內建記事本。

自動操作僅限這個頁面剛剛由你開始、且仍在前景的語音。每個 action ID 至多送一次；首頁不會自動重播後端列表、重新整理前的待處理操作或結果不確定的執行。電話／日曆等外部 App 返回後，只更新實際結果，不重新開啟或繼續操作。

離開前景、切換進階工具、登出／解除配對時會取消本次語音授權，關閉麥克風；中斷的錄音不自動送出。已送到後端的工作可能繼續完成，但遲到結果不能再觸發手機操作。

本地音量偵測預設 RMS 閾值 0.025、連續語音 250 ms、停頓 2000 ms、無語音 12000 ms。沒有明確語音時捨棄錄音；單次最多 180 秒與 10 MiB。這是簡單音量門檻，不是語音辨識模型；嘈雜、輕聲、不同麥克風增益可能影響自動停止，尚需真機調整。若裝置不支援 Web Audio，就保留「再點一下結束」備援；沒有使用雲端 Web Speech API。

### 收聽、手動結束與發送確認

收聽時有明確文字、秒數與可用音量回饋；計時不再等待音訊分析器啟動。獨立「結束錄音並送出」可手動結束；收尾中暫停重複送出，麥克風鎖不依賴 stop 回呼才能釋放。停止或分析器錯誤不會把下一段錄音的鎖誤刪，遲到回呼也不能再次上傳。

畫面依實際階段顯示：收聽 → 收尾 → 上傳 → 後端已收到／排隊 → STT 轉錄 → 辨識文字 → 送出指令／等待 Agent 回應 → 已回覆 request ID → 手機確認／結果。若 STT 很快完成，可能直接看到辨識文字，不會為了動畫假裝仍在轉錄。

錄音時取消會捨棄未送出的音訊；送出後取消只停止本頁後續處理，後端工作或已確認手機動作可能繼續。切換工具／背景及登出仍會中止本頁自動交接。除錯資訊收在可展開區，可將 trace／job／request ID 與 backend_v4 終端機紀錄對照。

### 其他工具

點右上角「其他工具」開啟原本的文字、平台筆記、錄音整理；「返回語音」回到首頁。進階文字與手動筆記預設保存在私人中樞，手機功能仍可明確交接。以下為進階工具的操作方式。

### 對話

本頁文字與語音使用同一段後端對話：追問後只需補缺少條件。例如先說「明天十點的會議」，若被追問時長，再說「持續三十分鐘」會附上同一段歷史供模型理解。最新句仍是本次指令，先前操作不是重新執行的授權。

「新對話」清除本頁訊息與對話關聯，下一句開始新範圍；不刪手機／平台筆記。對話 ID 僅留在頁面記憶體，刷新／關閉後以新對話開始；沒有永久對話列表介面。

同頁送出有順序鎖及上下文快照，文字回覆若在錄音期間改變前文，該段語音不會接到錯誤話題。結果不明時，只允許人工重試同一編號／上下文，或點新對話；不會自動重做手機操作。

- 可以輸入生活指令，例如「幫我記下週五開會要帶報告」、「幫我打電話給媽媽」、「幫我設定每天早上七點的鬧鐘」。
- 每次送出有 idempotency key；同一輸入因連線失敗重試時沿用原 key，避免重複建立操作。
- 模型產生的手機操作會顯示內容卡片。按「在手機確認」只送出 action ID；APK 自行取得後端簽派的操作內容、顯示原生確認、取得權限並回報。
- 通訊錄多個候選人時，使用者先選人，再確認撥號。
- 開啟撥號畫面、交接時鐘或分享面板，均依實際結果顯示，沒有宣稱電話已接通或第三方記事已保存。
- 普通瀏覽器不能使用 APK 的原生能力，網站也不會假裝操作成功。APK 與瀏覽器的配對身分不同；欲操作手機，請在 APK 中提交指令。

### 筆記

- 支援列表、內容搜尋、新增、編輯、刪除。刪除需要再次按確認；保存到既有後端加密內容欄位。
- 「保存到手機」使用 `notes.save_local`，保存到我們 APK 自己的加密筆記區。
- 「分享」使用 `notes.share`，呼叫 Android 分享面板。其他記事 App 是否接收與保存由對方決定。
- 一般瀏覽器若支援 Web Share，也能由使用者點擊分享；不能直接存入任意內建記事本。

### 錄音整理

- HTTPS 麥克風授權後，以 MediaRecorder 錄音；單段上限 3 分鐘。離開前景時停止錄音，不背景監聽。
- 停止後可先播放。使用者按「轉錄並整理」才上傳到自己的後端。
- 也可匯入 WebM、WAV、MP3、M4A、OGG、AAC、FLAC；網頁預設上限 10 MiB，後端若設更小以後端為準。
- 以音訊 raw body 呼叫 `/v1/audio`，由後端配置的本地 STT 與 OpenAI 相容本地 LLM 處理。
- 逐字稿與摘要可修正；「保存到筆記」才建立筆記。摘要失敗但逐字稿成功時，仍能自己編輯保存。
- 「帶入對話」只填入輸入欄，使用者修正／送出後才交給 Agent 判斷操作。

## 安全與資料流

- 每個 API 使用同來源 Cookie。網站不將裝置 token 保存到 localStorage、sessionStorage、IndexedDB 或 DOM。
- 普通瀏覽器的首次配對短暫取得裝置 token，只用於交換 HttpOnly session，交換後從程式物件移除。
- 瀏覽器 session 到期需新配對碼；APK 按原生「同步」以其保護的裝置憑證更新網頁 session。
- 使用外部 HTTPS 網址，並維持 backend 的 CSP。沒有內嵌 script/style、`eval` 或 `innerHTML` 插入模型內容。
- 沒有 Service Worker、離線網站快取或在瀏覽器永久保存私人內容。對話只暫存在目前頁面；重新整理不恢復完整對話歷史。
- 登出時清除畫面與錄音，遲到的網路回應不恢復私人資料。重新整理仍可由後端讀取筆記與未處理操作。
- Cloudflare Tunnel 為分段 TLS，Cloudflare 可解密經過的流量。LLM 與 STT 仍在私人設備；網頁本身未實作從手機到後端的應用層端對端加密。

## 原生橋接 v1

```json
{"protocol_version":"1","message_id":"msg_unique","type":"execute_action","action_id":"act_from_backend"}
```

橋接物件為 `NativeBridge`，送出方法 `postMessage(JSON.stringify(message))`，接收為 `NativeBridge.onmessage = event => ...`。初次送 `hello`，等待 `ready` 與 `capabilities`，再啟用相應功能。每個回覆須匹配已送出的 message ID；操作結果也須匹配 action ID，未知／錯配／重複訊息一律忽略。`action_result` 只作通知，網站重新查後端的實際結果。`logout` 由 APK 撤銷憑證並移除 Cookie；APK 回 `logged_out` 後回到原生配對畫面。

可使用的 API 與欄位請對照共用 `contracts/`。網頁不呼叫 `/confirm`、`/result`，也不持有 execution token。

## 檢查與測試

```bash
cd local-assistant/web
node --test tests/*.test.js
```

當前 117 項 Node 內建測試已通過，不需要套件下載；涵蓋多輪接續、同頁順序與重試、遲到回應、新對話、timer API／顯示及既有錄音／原生邊界。另用本地後端及 mock LLM 驗證 13 個執行資源、會議追問接續、倒數及日曆預設。模擬及本地整合不代表已驗證真實模型品質、手機或公開網域。

## 已有 Tunnel 的連線排錯

1. 覆蓋 web_v6 後，用 Ctrl+Shift+R 強制重新整理；DevTools 開啟時可先勾 Disable cache。
2. 開啟 `https://你的實際子網域/health`，預期是後端 JSON 且 status=ok；健康檢查不會呼叫模型。
3. 開啟同網域 `/v1/auth/me`：未配對時應是 401 JSON，表示 API 已到達；登入後應是 200 JSON。
4. 若仍顯示 network_error，在 Network 選 Fetch/XHR，檢查上述 API 的狀態。301／302／307／308 會被本版禁止重新導向政策拒絕；需修正原始網址／規則，或依部署需求正式整合 Access，不以放寬程式限制代替修正。
5. 若 backend/.env 的 PUBLIC_BASE_URL 不等於實際 HTTPS 網站來源，修改後重啟後端。既有 Tunnel 的 service URL 對齊同機 `http://127.0.0.1:8000` 或實際 PORT。

`static.cloudflareinsights.com/beacon.min.js` 是 Cloudflare Web Analytics 的統計腳本。它被 script-src 'self' 阻擋不等同 API 失敗；專案本身不依賴該腳本。若不要統計注入，至 Cloudflare Web Analytics 找該 hostname，Manage site 選 Disable；維持本專案原有 CSP。

專案沒有呼叫 Chrome LanguageDetector；其他腳本的 Built-In AI 提示不是這個本地 LLM 的設定。來源需查看 DevTools 的腳本 URL，不能僅依 content_main.js 檔名判定是哪個擴充套件。

官方參考：[Cloudflare Web Analytics 設定](https://developers.cloudflare.com/web-analytics/get-started/)、[Web IDL operation 接收者規則](https://webidl.spec.whatwg.org/#es-operations)。

## web_v4 載入診斷與 404

麥克風圖示直接放在 HTML，無須另外下載 microphone.svg。獨立 bootstrap 先檢查 CSS、全部執行時 JavaScript 的 HTTP 狀態、MIME 與現行 web-v6 版本標記，再啟動助理；所有模組使用同一 revision 查詢，避免新舊檔混用。

載入不完整時，頁面列出缺少／版本不符的路徑，保留原生「連線設定」展開與重新載入入口。配對與功能在完整啟動前維持停用；不會以預設表單提交配對碼，也不會因檔案檢查呼叫模型或手機操作。重試使用整頁重新載入。

若 bootstrap 本身也缺檔／被阻擋，HTML 仍顯示未完成提示與可展開的設定；此情況無法列出詳細 HTTP 狀態，需確認實際檔案位置。

交付的 web_v3.zip 有 voice.js 與 microphone.svg。兩者在公開站台 404 時，優先確認後端實際 WEB_DIR 與解壓位置，接著比較本機與公開網址。新網域 `https://2026-asus-ugen.aphelion.tw` 對應設定及排錯順序見 `docs/web_v4.md`。本次先有 backend_v5，倒數更新 android_v4；既有 cloudflared 仍可沿用。

實機驗收與尚未完善項目見 `STATUS.md`，版本更新見 `CHANGELOG.md`。

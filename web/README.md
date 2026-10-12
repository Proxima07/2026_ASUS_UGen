# 網頁子項目 web_v2

版本：2。更新日期：2026-10-12。

web_v2 為 web_v1 的差異更新；先有 v1，再覆蓋本版。修正原生 fetch 綁定錯誤，避免 API 請求尚未送出就顯示「連線中斷」。詳見 CHANGELOG.md。

這份網頁是手機優先的個人助理介面，包含對話、筆記、錄音整理。所有資源隨檔案提供，不使用 CDN、第三方分析、雲端語音辨識或瀏覽器 Web Speech API。文字、逐字稿與模型回覆均以 `textContent` 顯示。

## 安裝與開啟

1. 將 `web_v1.zip` 解壓至專案上層，得到 `local-assistant/web/`，與既有 `backend/` 並列。
2. 先安裝 `backend_v1.zip`，再套用本次 `backend_v2.zip` 後端更新。v2 新增「已存在筆記 → 手機保存／分享」的確定性 API；v1 也能使用對話、筆記 CRUD 與錄音功能。
3. 設定後端 `.env` 的 `PUBLIC_BASE_URL=https://你的子網域`。後端由此推導允許的來源與主機名稱。`WEB_DIR` 預設指向與 backend 並列的 web；自訂時填這個目錄的絕對路徑。
4. 完整關閉後重新啟動後端。後端在啟動時偵測 `index.html`；只解壓、不重啟，既有程序不會自動掛載網站。
5. 使用你既有的 cloudflared 即可，不必套用專案的 Tunnel 範例或建立第二份 connector。該子網域指向同一個 FastAPI 服務；網頁、`/v1/*` 與 API 必須同來源，整個 hostname 轉到後端。
6. 用 `https://你的子網域/` 開啟。一般瀏覽器輸入管理者產生的一次性配對碼；APK 先在原生連線頁配對，由 APK 注入 HttpOnly Cookie 後載入網頁。

網頁無須 npm install 或 build。不建議單獨以 `python -m http.server` 展示，因為沒有後端 API、同來源 Cookie 與 HTTPS 錄音條件。

## 功能與操作

### 對話

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

橋接物件為 `NativeBridge`，送出方法 `postMessage(JSON.stringify(message))`，接收為 `NativeBridge.onmessage = event => ...`。初次送 `hello`，等待 `ready` 與 `capabilities`，再啟用相應功能。`action_result` 只作通知，網站重新查後端的實際結果。`logout` 由 APK 撤銷憑證並移除 Cookie；APK 回 `logged_out` 後回到原生配對畫面。

可使用的 API 與欄位請對照共用 `contracts/`。網頁不呼叫 `/confirm`、`/result`，也不持有 execution token。

## 檢查與測試

```bash
cd local-assistant/web
node --test tests/*.test.js
```

21 項 Node 內建測試已通過，不需要套件下載，涵蓋瀏覽器 fetch 接收者、API、原生握手、音訊限制、狀態誠實顯示、登出與遲到回應。模擬測試不代表已驗證真機麥克風、通訊錄、日曆、鬧鐘或 Cloudflare 網域。

## 已有 Tunnel 的連線排錯

1. 覆蓋 web_v2 後，用 Ctrl+Shift+R 強制重新整理；DevTools 開啟時可先勾 Disable cache。
2. 開啟 `https://你的實際子網域/health`，預期是後端 JSON 且 status=ok；健康檢查不會呼叫模型。
3. 開啟同網域 `/v1/auth/me`：未配對時應是 401 JSON，表示 API 已到達；登入後應是 200 JSON。
4. 若仍顯示 network_error，在 Network 選 Fetch/XHR，檢查上述 API 的狀態。301／302／307／308 會被本版禁止重新導向政策拒絕；需修正原始網址／規則，或依部署需求正式整合 Access，不以放寬程式限制代替修正。
5. 若 backend/.env 的 PUBLIC_BASE_URL 不等於實際 HTTPS 網站來源，修改後重啟後端。既有 Tunnel 的 service URL 對齊同機 `http://127.0.0.1:8000` 或實際 PORT。

`static.cloudflareinsights.com/beacon.min.js` 是 Cloudflare Web Analytics 的統計腳本。它被 script-src 'self' 阻擋不等同 API 失敗；專案本身不依賴該腳本。若不要統計注入，至 Cloudflare Web Analytics 找該 hostname，Manage site 選 Disable；維持本專案原有 CSP。

專案沒有呼叫 Chrome LanguageDetector；其他腳本的 Built-In AI 提示不是這個本地 LLM 的設定。來源需查看 DevTools 的腳本 URL，不能僅依 content_main.js 檔名判定是哪個擴充套件。

官方參考：[Cloudflare Web Analytics 設定](https://developers.cloudflare.com/web-analytics/get-started/)、[Web IDL operation 接收者規則](https://webidl.spec.whatwg.org/#es-operations)。

實機驗收與尚未完善項目見 `STATUS.md`，版本更新見 `CHANGELOG.md`。

# 語音助理網頁 web_v7

v7 是 web_v6 的差異更新，搭配 backend_v6／android_v5。APK 語音首頁改用手機原生錄音，停止後上傳完整檔案；畫面明確呈現收聽、經過時間、紅色結束／取消、STT 與 Agent 階段。手機記事本指手機安裝的記事本 App，平台筆記則採用後端修正後的裝置隔離。

本專案是原生 HTML／CSS／JavaScript，不需要 npm install 或前端 build。圖示與資源由同一網站提供，不使用 CDN、第三方分析、Web Speech API 或雲端語音辨識。

## 安裝與開啟

1. 保留 local-assistant/web 與 backend 並列的結構，差異包依序覆蓋至 web_v7；ZIP 已包含 local-assistant 外層，解壓到它的上一層。
2. 後端更新至 backend_v6，APK 更新 android_v5。原生錄音不能只靠更新網頁取得；需要新 APK 能力握手。
3. 既有 .env 配置實際 PUBLIC_BASE_URL，例如 https://2026-asus-ugen.aphelion.tw。WEB_DIR=../web 相對 backend，或填實際目錄的絕對路徑。
4. 重啟後端，沿用已配置的 cloudflared。整個 hostname 的網站、/health、/v1/* 指向同一後端，不需要第二個 connector。
5. 強制重新整理一般瀏覽器，或重新開啟 APK。Chrome 配對需一組新碼；APK 由原生配對後注入 HttpOnly Cookie。

後端提供網站與 API，不能以 python -m http.server 取代整個服務。

## 語音首頁

1. 點麥克風、完成權限後說話；實際錄音開始才顯示「收聽中」及持續經過時間。
2. 按「結束錄音並送出」或再次點麥克風結束本次錄音。紅色取消控制捨棄尚未送出的錄音。
3. APK 原生錄音收尾為完整 .m4a，透過原生 HTTPS 送至 /v1/audio?purpose=command；一般 Chrome 仍使用瀏覽器錄音，停止後送完整音訊 Blob。
4. 畫面依後端真實回覆呈現收到音訊／排隊／STT 轉錄，完成後顯示逐字稿，自動送一次 /v1/chat 給本地 Agent。
5. Agent 決定手機操作，語音流程自動交接 APK。原生確認顯示實際內容，使用者確認後執行；同名聯絡人才需先選候選人。

兩條錄音路徑都是停止後上傳完整檔案，STT 無須支援即時串流。若權限、初始化或上傳失敗，顯示明確狀態並釋放本次錄音；遲到回覆不能把舊錄音接到新對話。APK 內主語音路徑不依賴 WebView MediaRecorder。

取消、離開前景、切換工具、新對話或登出會停止本頁後續自動交接；尚未送出的音訊捨棄。已送達後端的工作仍可能完成，已確認手機操作不會因此被撤銷。沒有把「取消本頁」表示為手機／後端已取消。

錄音、上傳、STT、Agent 與手機確認分開顯示。可展開的除錯資訊有 job／request／trace ID，能對照後端終端機。快速完成的 STT 不會為了動畫假裝仍在轉錄。

## 手機記事本與平台備忘錄

日常語音與文字指令預設交接手機記事本。新 APK 支援 notes.create_native，開啟能處理建立筆記的 App；沒有直接支援時使用文字分享選擇器。顯示「已交給記事本，請在 App 內確認儲存」，不把開啟介面當作已保存。

Android 沒有供所有記事本 App 共用的查詢／讀取／更新 API。本版可以交接新筆記，不能通用讀取或追加既有手機預設筆記；遇到不支援會說明，不用另一個筆記區冒充系統記事本。舊 APK 自建加密筆記保留，但新版不再提供其能力或入口。

純瀏覽器、舊 APK 或能力不足時，日常手機筆記明確回報未保存，不默默改存平台。若要平台保存，可在「其他工具」明確選用平台備忘錄。平台筆記仍提供新增、內容搜尋、編輯、刪除；所有內容由 backend_v6 驗證目前使用者與原始建立裝置。

配對、登出和切換身分時，頁面清除舊筆記、選取和遲到結果。前端清理是防止畫面殘留，真正權限檢查在後端。新配對裝置不能自動繼承舊裝置資料。

## 多輪對話與其他工具

文字與語音共用本頁 conversation ID；追問後補條件會接續真實前文，歷史不是重新執行舊動作的授權。同頁只接受一筆 Agent 請求，重試沿用原編號與上下文，結果不明時不自動重做手機動作。

「新對話」清除目前頁面訊息與對話關聯，不刪除已保存筆記或日曆。ID 只留頁面記憶體，刷新或關閉後開始新對話；後端仍加密保存對話記錄。

「其他工具」保留文字、平台備忘錄、錄音整理和音檔匯入。錄音整理可先播放，再按「轉錄並整理」上傳；匯入支援 WebM、WAV、MP3、M4A、OGG、AAC、FLAC，預設 10 MiB，上限以後端配置為準。整理結果需使用者明確保存到平台備忘錄，不冒稱保存至手機記事本。

倒數使用 timer.create，固定時刻用鬧鐘／日曆。電話畫面 opened、時鐘或記事本 handed_off 都依實際狀態顯示，不宣稱電話已接通或外部 App 已保存。

## 載入、連線與隱私

bootstrap 先驗證 CSS／JavaScript 的 HTTP、MIME 和 web-v7 版本標記；檔案缺少或混版時列出路徑，保留連線設定與重新載入，不啟動半套功能。麥克風圖示內嵌於 HTML。404 時先檢查實際 WEB_DIR 與解壓位置，再看 Tunnel 路由／快取。

連線排錯先開 /health；應為 status=ok 的後端 JSON。未配對時 /v1/auth/me 回 401 JSON，表示 API 已到達。轉址、403 或 HTML 可能來自 Cloudflare Access／WAF／路由，APK 不共用 Chrome 登入 Cookie；不以略過 TLS 修正。

Cloudflare Analytics beacon 被 script-src 'self' 阻擋，不等於 API 失敗；專案不依賴該腳本。可在 Cloudflare 關閉該 hostname 的 Web Analytics，保持 CSP。專案也不呼叫 Chrome LanguageDetector。

私密內容以 textContent 顯示，沒有 innerHTML 插入模型輸出；裝置 bearer 不進 localStorage，普通瀏覽器配對只短暫使用 token 換 HttpOnly session。沒有 Service Worker 或私密內容永久網站快取。

API 使用 HTTPS，Cloudflare edge 可處理流量明文；本版未實作應用層端對端加密。LLM／STT 仍在私人設備，手機記事本的同步與保存由該 App 設定處理。

## 測試與版本記錄

```bash
cd local-assistant/web
node --test tests/*.test.js
```

測試數量與目標手機界線見 STATUS.md；mock 測試通過不代表真實麥克風、STT 或廠牌記事本已驗收。更新內容見 CHANGELOG.md 與 docs/web_v7.md。

本版全部127項Node測試通過；另以本地後端驗證有效.m4a、mock STT／Agent、記事本handed_off與跨裝置隔離。

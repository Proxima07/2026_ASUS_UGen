# web_v4 靜態資源與載入診斷

日期：2026-10-12。本版更新網頁，保留 web_v3 語音首頁、私人 STT／Agent 與手機優先筆記流程。後端及 APK 不需要因本次靜態檔修正而重新更新。

## 問題原因

使用者回報 `/js/voice.js` 與 `/assets/microphone.svg` 是 HTTP 404。`main.js` 的靜態模組依賴載入失敗時，整個入口不會執行，連線／其他工具的按鈕因此無反應。圖示的 404 則讓麥克風圖片無法顯示。

已核對：交付的 web_v3.zip 內有這兩個新增檔案；後端把實際 WEB_DIR 整個掛載，沒有檔名白名單。以本地後端測試，啟動後新增檔案可以由 404 變成 200。故需優先核對正在運作的服務使用哪個 web 目錄、是否完整覆蓋新增檔案，以及公開 Tunnel 是否指向同一服務；不能僅以首頁更新成功判定所有檔案已部署。

改為不含底線的網域是 Android 原生連線的另一個排查項目，不會自動補齊網站缺檔。所有網頁與 API 都以當前同來源路徑請求，本版沒有硬編碼舊網址。

## 本版修正

- 麥克風改為 HTML 內建 SVG，不依賴原來的圖片檔。
- 獨立 bootstrap 先檢查樣式與全部執行時 JavaScript；HTTP、MIME 或版本不符會列出路徑，停用未完整的功能。
- 連線設定採 HTML details，主程式或 bootstrap 缺檔時仍可展開；詳細缺檔列表需要 bootstrap 成功載入。
- 初始配對表單與功能停用，完整啟動才開放；表單另用 POST 防止意外 GET 提交。資源檢查不傳配對碼、不呼叫模型、不觸發手機動作。
- 全部 CSS／JS 使用一致的 web-v4 標記與 revision；本包納入更新後的 voice.js。重新嘗試採整頁載入，同頁主程式只啟動一次。

## 套用與路徑

本包是 web_v3 的差異更新。來源需依序套用 web_v1 → web_v2 → web_v3 → web_v4；每次在既有 local-assistant 的上一層解壓，覆蓋同一資料夾。自行建立新的 web 目錄時，也必須先有完整前版來源。

實際位置應是：

| 檔案 | 位置 |
|---|---|
| 後端設定 | local-assistant/backend/.env |
| 網頁首頁 | local-assistant/web/index.html |
| 語音程式 | local-assistant/web/js/voice.js |
| 主入口 | local-assistant/web/js/main.js |
| 樣式 | local-assistant/web/css/app.css |

本次使用的新網址為 `https://2026-asus-ugen.aphelion.tw`。後端 `.env`：

```dotenv
PUBLIC_BASE_URL=https://2026-asus-ugen.aphelion.tw
WEB_DIR=../web
```

WEB_DIR 的相對路徑以 backend 目錄為準，與 PyCharm 的 working directory 無關；同名系統環境變數優先於 .env。使用你既有的 cloudflared，整個 hostname 仍指向同一後端；不需要切換到專案的 Tunnel 範例。

更改 PUBLIC_BASE_URL 或 WEB_DIR 後，完整停止並重新啟動後端。在新網址開啟頁面，使用 Ctrl+Shift+R 強制更新；手機可關閉舊分頁後重新開啟。舊底線網址的 Console 日誌不能用來驗證新來源。

## 查出正在使用的 web 目錄

在正在執行後端的同一虛擬環境、相同環境變數下，從 local-assistant/backend 執行：

```bash
python -c "from app.config import Settings; s=Settings.from_env(); print('WEB_DIR=', s.web_dir); print('PUBLIC_BASE_URL=', s.public_base_url); print([(p, (s.web_dir/p).is_file()) for p in ['index.html','js/bootstrap.js','js/main.js','js/voice.js']])"
```

輸出要指向你剛更新的 web，列出的檔案皆為 True。若路徑不同，將更新放到該實際目錄，或修正 WEB_DIR；若 PyCharm Run Configuration 設了環境變數，也要同步檢查。

接著比較同機服務與公開新網域：

```bash
curl -i http://127.0.0.1:8000/js/voice.js
curl -i https://2026-asus-ugen.aphelion.tw/js/voice.js
```

Windows PowerShell 使用 `curl.exe`，服務若採其他 PORT 請替換 8000。本機也 404 時，先修正實際目錄／檔案；本機 200 而公開 404 時，再檢查既有 Tunnel 的 service URL、其他代理與 Cloudflare 快取規則。

## 其他 Console 訊息

- `static.cloudflareinsights.com/beacon.min.js` 是 Cloudflare 的分析注入，不是本站模組依賴。被 `script-src 'self'` 擋下與 voice.js 的 404 是不同問題。若不需要分析，在 Cloudflare Web Analytics 的該站 Manage site 選 Disable；本版維持原 CSP，不為統計腳本放寬外部來源。
- 本專案沒有呼叫 Chrome LanguageDetector。要從 DevTools 的腳本來源確認 content_main.js 是哪個來源，不能將該訊息直接當作本地 LLM 錯誤。

官方參考：[Cloudflare Web Analytics 設定](https://developers.cloudflare.com/web-analytics/get-started/)。

## 驗證範圍

50 項 Node 測試通過，包含完整模組依賴圖、載入失敗與安全初始狀態。本地後端確認首頁與 11 個帶 revision 的執行資源全部 200，MIME、no-store 與 CSP 正確；/health 正常，未登入 API 回 401。詳細結果記錄在 web/STATUS.md；功能更新見 web/CHANGELOG.md。

尚未在使用者實際 Cloudflare 站台、Chrome 或 Android WebView 驗收，不能宣稱已確認現場的檔案落點或代理設定。

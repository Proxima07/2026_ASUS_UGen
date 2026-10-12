# web_v1 交付紀錄

日期：2026-10-12。語言：HTML、CSS、JavaScript ES modules。這是完整網頁子專案，無 npm 依賴、CDN 或前端建置步驟。

## 資料夾與功能

- `web/index.html`、`web/css/`、`web/assets/`：繁體中文手機介面。
- `web/js/`：配對、對話、待確認手機操作、筆記 CRUD 與搜尋、錄音、音檔匯入、本地轉錄工作及草稿整理。
- `web/tests/`：Node 內建測試；20 項已通過。
- `web/README.md`：設定與使用方式。
- `web/CHANGELOG.md`、`web/STATUS.md`：本版更新及未完成項目。
- `web/PACKAGE_MANIFEST.json`：交付內容與 SHA-256；由封裝工具產生。

## 與另外兩段整合

先解壓 backend_v1，再覆蓋 backend_v2；本包解壓到相同上層，三段共用 `local-assistant/`。設定後端 `.env` 的 `PUBLIC_BASE_URL=https://你的子網域`，Tunnel 指向整個同機 API 服務，最後重啟後端。首頁與 `/v1/*` 使用同一來源。

管理端於 `backend/` 使用已安裝依賴的 Python 執行 `python examples/create_pairing_code.py`。一般瀏覽器輸入一次性碼；APK 使用原生配對畫面，建立登入 cookie 後開啟網頁。瀏覽器裝置與 APK 裝置各自配對；手機操作請在 APK 內提出。

現有筆記的「保存到手機」與「分享」依賴 backend_v2，並由 android_v1 取得參數、確認及回報。純網頁沒有任意手機日曆、時鐘或通訊錄的直接權限。

## 驗證與未完善項目

20 項測試涵蓋 API、原生橋接、音訊限制、狀態顯示與登出後遲到回應；另已檢查 JavaScript 語法與本地資源引用。後端整合測試包含實際網頁掛載與 API 路由不被首頁遮蔽。

尚未執行瀏覽器視覺驗收或 Android WebView 真機測試；實際模型、STT、Tunnel 網域、麥克風與系統 App 需在你的設備驗收。沒有持久聊天歷史、背景錄音、錄音工作自動恢復或應用層端對端加密。完整清單見 `web/STATUS.md`。

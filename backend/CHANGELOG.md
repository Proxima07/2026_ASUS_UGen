# Backend 版本更新記錄

## v2 — 2026-10-12

### 新增與調整

- `POST /v1/notes/{note_id}/actions`：由已保存筆記直接建立 `notes.save_local` 或 `notes.share` 操作，驗證身分、綁定裝置並支援冪等鍵，不需 LLM 猜測 ID。
- 共用橋接規格加入 hello／ready、執行結果、錯誤與登出訊息，對齊 web_v1／android_v1。
- ZIP 封裝工具支援 backend、web、android，各子專案保存自己的 manifest。
- `.env.example` 建議手機執行期限 600 秒；既有 `.env` 需自行調整，不由更新包覆蓋。
- 加入一次性配對碼 CLI，讓管理者在 Pi 上取得手機配對碼，不需把管理金鑰填進 APK。
- 維持原有 OpenAI 相容配置與資料表，無資料遷移。

### 使用條件

- 先有 backend_v1，再覆蓋 backend_v2 的變動檔案；web_v1 與 android_v1 各自解壓到同一專案根目錄。
- Android 功能需要真實手機權限與支援的系統 App；本地模型／轉錄服務仍由使用者提供。

## v1 — 2026-10-12

首次交付 `backend_v1.zip`。維持 `local-assistant/backend` 的子專案結構。

### 新增

- Python／FastAPI 本地中樞與 `.env` 設定。
- OpenAI 相容聊天模型介接，可設定模型名稱、API 根位址、key、逾時、CA 與輸出模式。
- 結構化指令規劃與操作白名單；手機能力以操作資料交給未來 APK 執行。
- 一次性配對碼、裝置 token、網頁安全 session。
- 操作確認、短效執行憑證、實際結果回報與重試處理。
- 本地 SQLite 保存敏感內容加密資料；筆記新增、查詢、修改與刪除 API。
- 選配 OpenAI 相容語音轉錄端點；錄音轉錄後再由本地 LLM 整理。
- 三段共用 JSON 合約、Cloudflare Tunnel 與 systemd 設定範例。
- 依檔案雜湊產生完整版／變更版 ZIP 與 manifest 的工具。
- API 與主要資料邊界的自動測試。

### 本版界線

- 不含網頁介面、可安裝 APK、Android 權限或實機測試。
- 不內附 LLM、Whisper 模型或語音轉錄服務；需自行提供本地模型端點。
- 不提供可直接使用的 Cloudflare Tunnel credentials。
- 不代表電話、鬧鐘或日曆操作已在手機完成；本版處理的是操作流程與結果格式。
- 加密涵蓋保存的敏感內容，不等於所有 SQLite metadata、主機與備份均已完整加密。

後續版僅提供變動檔案；版本號以子專案維護，例如 `backend_v2.zip`、`web_v1.zip`、`android_v1.zip`。

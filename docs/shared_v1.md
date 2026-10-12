# shared_v1 根目錄共用設定

日期：2026-10-12。此 ZIP 只新增共用檔案，保留 `local-assistant/` 結構；不重送 backend、web 或 android 原始碼。

## 新增內容

- `local-assistant/.gitignore`：三段共用，排除私人設定、憑證、資料庫、執行資料、依賴、建置與二進位交付物。
- `local-assistant/STARTUP.md`：Windows PowerShell 與 Linux／Pi／macOS 首次安裝、.env 設定、API／網頁啟動、Tunnel、配對、日常操作與排錯。
- `local-assistant/docs/shared_v1.md`：本版功能、驗證與未完成紀錄。

## 套用方式

將 shared_v1.zip 解壓至既有 local-assistant 的上層目錄；三個新增檔案落入原專案。不變更既有 .env、私人資料、模型或簽章。

後續共用檔案的更新使用 shared_v2.zip 等名稱。共用更新不需要重建 APK，也不需要重啟 API；若依指南改了 .env 或 web 安裝位置，才需要重啟 API。

## 驗證與尚未完成

已對照目前 backend_v2／web_v1／android_v1 的來源與設定；以 Git 原生命令檢查忽略規則，確認私人／生成檔被忽略，必要來源及範例仍可追蹤。

本版不新增功能程式或部署腳本，不自動建立 Git 倉庫、安裝常駐服務、啟動模型或改動 Tunnel。Windows 命令已核對用法，尚未在使用者的 Windows／Pi 上執行。端到端模型、手機與實際網域驗收仍依各子專案 STATUS.md 記錄。

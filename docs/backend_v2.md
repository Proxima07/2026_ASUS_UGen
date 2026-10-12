# backend_v2 網頁與 APK 相容更新

日期：2026-10-12。此包是 backend_v1 的差異更新，不是完整安裝包。

## 更新內容

新增 `POST /v1/notes/{note_id}/actions`，請求格式如下：

```json
{"kind":"notes.save_local","idempotency_key":"save-note-001"}
```

`kind` 只允許 `notes.save_local`／`notes.share`。後端驗證筆記使用者、取得筆記快照、建立綁定目前裝置的待確認操作；重送相同內容與冪等鍵取得原操作。網頁不能直接標記手機完成，APK 須依既有 confirm／result 流程執行。

橋接規格補上 hello／ready、error、action_result、logout／logged_out，仍使用 protocol_version=1。網頁只送操作 ID，APK 透過裝置 token 領取真正參數。這些共用 Schema 是開發約定，不會替代 APK 的來源與權限驗證。

## 套用順序

1. 已解壓 backend_v1 的 `local-assistant/` 保留原位。
2. 在相同上層目錄解壓 backend_v2，覆蓋有變動的原始碼與文件。
3. 解壓 web_v1 到同一上層目錄，得到 `local-assistant/web/index.html`。
4. 後端重新啟動；既有 Tunnel 繼續指向同機 `127.0.0.1:8000`。
5. Android 安裝包與原始碼在 android_v1，開啟 App 填入 PUBLIC_BASE_URL 對應的 HTTPS origin 與一次性配對碼。

無資料表遷移，也不覆蓋 `.env`／資料庫／金鑰。前端與後端必須同來源，不能只用 `file://` 開 HTML。

手機權限與日曆選擇可能耗時；建議把既有 `.env` 的 `ACTION_LEASE_SECONDS` 設為600（上限）。過期結果會被拒絕，可能已執行的手機操作要先查看，不能自動重做。

## 版本紀錄與驗證

- backend_v2 只包含相對 backend_v1 的更新檔案。
- 封裝工具支援三子專案；每包 manifest 分別放在 backend、web、android 內，避免互相覆蓋。
- 根目錄的初版 `PACKAGE_MANIFEST.json` 仍是歷史 v1 紀錄，後續以各子專案自己的 manifest 為準。
- 48 項後端離線測試已通過（包含 web_v1 掛載）；實際模型、Tunnel 網域與手機權限操作仍需在使用者設備驗證。

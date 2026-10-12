# web_v2 連線修正

日期：2026-10-12。相對 web_v1 的差異更新；只有網頁及其相關文件／封裝工具變更。

## 問題與修正

v1 的 API 類別將 globalThis.fetch 保存為屬性，呼叫時把 Api 物件當成 this 接收者。瀏覽器原生 fetch 要求合適的全域接收者，可能拋出 TypeError／Illegal invocation；例外被前端統一顯示為「連線中斷」，即使中樞和 Tunnel 已啟動也可能尚未送出任何請求。

v2 在預設 fetch 上使用 `.bind(globalThis)`，保留同來源、cookie、禁止重新導向與 CSP 政策。已有 cloudflared 繼續使用，不需要套用專案 Tunnel 範例。

## 套用

1. 將 web_v2.zip 解壓到既有 local-assistant 的上層目錄，覆蓋變動檔案。
2. 網頁本來已由後端提供的話，此次只是更新靜態 JS；不用重啟後端或重裝 APK。
3. 瀏覽器按 Ctrl+Shift+R 強制重新整理；必要時 DevTools 勾 Disable cache。APK 可按「同步」重新載入網站。
4. 在同一個 HTTPS hostname 開 /health，應取得 status=ok JSON；未配對時 /v1/auth/me 應回 401 JSON，登入後是 200。

## 其他 Console 訊息

- Cloudflare Web Analytics beacon 被 script-src 'self' 拒絕是第三方統計腳本，專案不依賴它。可至該 hostname 的 Web Analytics → Manage site 選 Disable，維持本地 CSP。
- 專案沒有使用 Chrome LanguageDetector；其他腳本的 Built-In AI 提示不能直接認定為本地 LLM 或 API 故障。
- 若更新後仍出現 network_error，需查看 Network 中 /v1 請求是否重新導向、遭 Access 攔截或真的傳輸失敗；不能僅靠這兩行 Console 確定現場根因。

## 驗證與未完善

原版已用會檢查 fetch 接收者的替身重現 network_error；修正後該回歸測試成功。全部 21 項 Node 測試通過。這項驗證模擬瀏覽器 Web IDL 接收者限制，沒有宣稱已在使用者的 Chrome／手機／Tunnel 真機驗收。

官方規格：[Web IDL operations](https://webidl.spec.whatwg.org/#es-operations)、[Fetch methods](https://fetch.spec.whatwg.org/#fetch-method)、[Web Analytics 設定](https://developers.cloudflare.com/web-analytics/get-started/)。

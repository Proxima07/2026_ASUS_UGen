# android_v3 原生配對診斷

日期：2026-10-12。本包只更新 Android 子專案，來源為相對 android_v2 的差異更新。保留 web_v3 語音交接與手機加密筆記功能，不更新後端或網站。

## 本次問題與調整

Chrome 配對成功而 APK 失敗，舊版把原生 HTTP／TLS、配對回應及本機憑證保存問題都顯示成同一句話，無法從畫面確認失敗階段。v3 新增原生連線檢查與階段分類，不記錄或顯示 token、配對碼、原始伺服器內容及原始例外文字。

「檢查後端連線」只需網址，使用 `GET /health`、不附 token，不會呼叫配對 API。只接受正常後端 JSON；HTTP 200 的 HTML 登入頁不算通過。檢查與配對不會同時啟動。

配對碼同時有有效期限與一次性限制。若 Chrome 已用某組碼，APK 必須產生另一組，不能僅以未過期判斷可用。若後端已回傳有效裝置憑證但 Keystore 保存失敗，該碼已消耗；若已保存憑證而網頁登入失敗，保留憑證並從設定返回助理重試。

## 使用順序

1. 將包內 `android/releases/local-assistant-debug.apk` 更新安裝到原 APK。可直接從 v1 更新到 v3，不需先安裝 v2，也不需解除安裝。
2. 在配對／設定畫面輸入相同 HTTPS 根網址，先按「檢查後端連線」。網址尾端 `/` 可以，其他子路徑不可。
3. 若檢查通過，於後端產生一組尚未使用的配對碼，只在 APK 使用，再進行配對。
4. 若失敗，以畫面顯示的階段與分類排查。HTTP 轉址／403／非 JSON 要查代理與授權；TLS、DNS、逾時則查原生連線。
5. 若登入階段失敗，使用「返回已配對助理」重試。不要為每次登入失敗重新配對。

若要更新來源後自行建置，請先在 android_v1 上套用 android_v2，再套用本包 android_v3；差異包不包含前版已更新但這次沒變的檔案。只安裝包內編譯好的 APK 時，可直接從舊版更新。

## 主機名稱含 `_` 的相容性排查

部分 Android TLS/SNI 實作可能拒絕含底線的主機名稱，Chrome 成功不能排除此問題。Android 官方 SNIHostName 的字串建構使用 STD3 主機名稱規則；本地 JDK 17 自檢也拒絕含 `_` 的樣本、接受相對應的 `-` 樣本。但這不能代替目標手機的錯誤診斷，不代表已確認本次失敗唯一原因。

建議在使用者已配置的 Cloudflare Tunnel 增加一個僅含英文字母、數字及連字號的子網域，指向原後端，例如 `https://assistant-demo.example.com`。這個範例網址需自行配置，程式不會自動建立 DNS 或 Tunnel 設定。

配置完成後，修改 `backend/.env`：

```dotenv
PUBLIC_BASE_URL=https://assistant-demo.example.com
```

重新啟動後端，在 APK 填入新網址，先檢查連線，再產生新碼配對。Cloudflare 原有 cloudflared 可沿用；不需要切換到專案提供的 Tunnel 範例文件。既有筆記在 APK 中保留，切換來源後舊操作收據不會送給新的來源。

本版仍要求 HTTPS、受信任憑證、固定 API 路徑並拒絕重新導向。Cloudflare Access 互動式登入尚未整合，APK 不共用 Chrome cookies；不能以停用 TLS 驗證來繞過問題。

## 驗證範圍

來源為 Kotlin／Android SDK 專案。基本 `/health`、配對與登入沿用 backend_v1–v3；語音自動交接與手機筆記搜尋／更新仍需 backend_v3、web_v3。

建置、簽章及分類自檢結果見 `android/STATUS.md`；APK 雜湊見 `android/releases/README.md`。尚未在使用者手機覆蓋安裝、實際 Tunnel、Android Keystore 或 WebView 上驗收，也未取得本次原生錯誤內容。

官方依據：[Android SNIHostName](https://developer.android.com/reference/javax/net/ssl/SNIHostName)。

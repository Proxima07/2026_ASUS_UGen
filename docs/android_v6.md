# android_v6：證明網頁 Cookie 登入及安全診斷

日期：2026-10-12。本包相對android_v5，配合web_v8；backend_v6、`.env`、資料、金鑰及既有cloudflared保留。本版不需要後端更新包。

## 本次修正

APK存在「返回已配對助理」表示手機保存了裝置憑證，不代表網站已登入。截圖中的網站未連線與已保存入口能確認這兩個狀態不一致，不能單獨證明失敗是Cookie、時序或代理造成。

舊程式只以CookieManager接受寫入的回呼當成網頁登入成功，缺少後端對該Cookie的驗證。新流程區分裝置憑證與網頁session，補上Cookie-only證明與失敗階段，不把這次程式修正冒稱成目標手機根因已實測。

## 新流程

| 步驟 | 驗證 | 通過條件 |
|---|---|---|
| 原生Bearer GET /v1/auth/me | 已保存裝置憑證 | auth_kind=device與已保存device_id相符，取得user_id |
| POST /v1/auth/session | 新Cookie的來源與安全設定 | 回覆裝置相符，唯一有效Secure／HttpOnly session Cookie |
| CookieManager安裝／讀回 | WebView目前實際Cookie | 確認新值已保存，不只相信accepted回呼 |
| Cookie-only GET /v1/auth/me | 後端是否接受該Cookie | 完全不帶Bearer，auth_kind=session與同user/device |
| load／ready及web_v8 /me | 網站自身的Cookie登入 | 同身分後才顯示私人資料、啟用錄音與操作 |

三個HTTP步驟各15秒，Web8 hello等待期限60秒。驗證不放寬HTTPS、轉址或身分規則，不因登入問題接受任意已有Cookie。Cookie寫入及結果保留畫面／session／憑證世代檢查，舊畫面完成回覆不能讓新帳號載入舊登入。

## 不消耗配對碼的診斷與重試

設定顯示「已保存配對資料」，提供「檢查已配對登入」。此按鈕只執行Bearer /me和目前Cookie /me；不POST/session、不寫／清Cookie、不修改憑證，也不兌換配對碼。

診斷區分APK裝置驗證、session建立、Cookie安裝與Cookie後端驗證，顯示固定安全訊息、實際可用HTTP和格式已驗證的request ID。沒有token、Cookie值、配對碼或原始服務回應；橋接沿用既有error.code／message。

若原生Bearer通過、Cookie失敗，已保存憑證保留。選「返回已配對助理」、APK「同步」或Web8「重新建立登入」才重建session，不必重新輸入一次性碼。只有原生裝置憑證驗證遭拒絕，才請管理者確認裝置狀態後決定是否重配對。

先更新並看診斷階段，不先清App資料、解除配對或改Tunnel配置。同步只處理登入與原有結果重送，不重新執行已確認的手機動作。

## 更新與驗證

使用android/releases/local-assistant-debug.apk覆蓋安裝；版本1.5／code6，精確簽章與APK雜湊見releases/README.md。自行建置來源依差異包順序覆蓋到v6。

同時套用web_v8、重開APK；後端維持v6，既有`.env`、runtime與cloudflared沿用。原生完整檔案錄音、手機記事本、日曆、電話、鬧鐘、倒數與結果收據保留。

最終建置和自檢結果記於android/STATUS.md。尚未在截圖手機驗證Cookie實際傳送、登入恢復或覆蓋安裝；需以新版診斷定位根因。

最終來源compileReleaseKotlin成功，72項純JVM自檢及獨立安全審查通過；不能據此宣稱目標手機登入已成功。

最終assembleDebug成功，APK v2簽章有效且與舊版同憑證；版本1.5／code6、min29／target35，大小4,786,934 bytes，精確SHA-256見releases/README.md。

本地後端TestClient已驗證Cookie-only需為session且同user／device，錯Cookie401與不同帳號Cookie可區別。Bearer A＋Cookie B會採A的行為已重現，因此Cookie驗證不帶Bearer。這不是目標WebView CookieManager的實機測試，後端原始碼也沒有在本版修改。

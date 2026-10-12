# web_v8：區分 APK 配對與網頁 Cookie 登入

日期：2026-10-12。本包相對 web_v7，配合 android_v6；backend_v6、既有 `.env` 與 cloudflared 保留。本次不需要後端更新包。

## 問題與證據

截圖顯示 APK 有「返回已配對助理」入口，網站卻仍提示先配對／同步。這代表手機已保存憑證，但不能單憑截圖判定後端目前接受該憑證，也不能確認實機原因是 Cookie、時序、Tunnel 或代理。

舊版程式確認有兩個不足：WebView 接受 setCookie 回呼就當成網頁登入完成；網頁提示未清楚區分 APK 配對、Cookie 安裝與後端認證。本版補驗證與診斷，不宣稱已從截圖找出實體手機根因。

## 新登入流程

APK 先核對已保存的 bearer 身分，建立 session、安裝到 CookieManager，再以實際讀回的 Cookie、不帶 bearer，呼叫 GET /v1/auth/me 確認。網站等待 hello／ready 後，才以自己的同來源 Cookie 驗證 /me。

網站回覆須為 auth_kind=session，且 user_id、device_id 與 APK ready 完全相同。未通過、缺少身分或身分不一致時不載入筆記／私人操作，也不啟用錄音。登入更新會清掉舊畫面與未完成請求，遲到舊回覆不能覆蓋新的身分。

Cookie HTTP401 每頁最多觸發一次自動 hello 同步，成功也不重設預算。持續401時留下狀態，由使用者按「重新建立登入」或 APK「同步」再試。未完成的握手合併處理，60秒期限後顯示逾時；網路、HTML、轉址或其他錯誤不觸發重新配對循環。

只有確認原生裝置失效時，才提示配對失效。網站Cookie失效則顯示登入尚未同步，保留原生憑證，無須再兌換一次性碼。一般Chrome仍採原本瀏覽器配對，不假裝有APK可代為同步。

## 介面與排錯

登入設定提供「重新建立登入」及摺疊的「連線處理資訊」：APK／網頁階段、HTTP、安全錯誤碼與request ID。沒有cookie、token、配對碼或原始服務回應。

HTTP與request ID以網頁API實際回應為準；原生橋接沿用既有error.code／message，缺少HTTP欄位時顯示尚未取得。本版沒有為診斷新增共用協定欄位。

同步只恢復登入，不重新送出對話、錄音或已執行手機動作。先更新兩個子專案並用診斷找出失敗階段；不要因網站Cookie錯誤先清除App資料或解除配對。

## 更新與驗證

1. 在 web_v7 上覆蓋 web_v8，來源仍在 local-assistant/web。
2. 用 android_v6 內附 APK 覆蓋安裝，保留App資料與已保存憑證。
3. 保留 backend_v6、`.env`、runtime及既有cloudflared；若來源目錄仍是原本掛載位置，網頁資源更新不需重建Tunnel。
4. 強制重新整理／重開App，確認登入核對狀態和失敗時的安全診斷。

全部134項Node測試通過，其中7項新增登入同步回歸。這些是本地模擬與程式驗證；尚未在截圖所示手機驗證Cookie傳送、WebView或代理行為。舊的原生音檔錄音、筆記隔離與記事本交接保留。

另以本地backend_v6 TestClient確認device／session登入種類與確切身分、無效Cookie401和request ID，13個web-v8資源均200。Bearer A＋他人Cookie B仍顯示A的行為也已重現，證明驗Cookie時必須省略Bearer；不能將此API測試當作手機Cookie實況。

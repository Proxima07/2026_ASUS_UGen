# Android APK v6：驗證 APK 配對與網頁登入

本子專案使用 Kotlin＋Android SDK＋WebView。日常對話介面由你的網站提供，APK 負責配對、原生錄音、授權、確認及手機操作，沒有內建 LLM；模型與 STT 仍由私人後端處理。

v6 是 android_v5 的來源差異更新，配合既有 backend_v6／web_v8。這次補上真正的Cookie後端驗證，區分已保存配對、原生憑證可用與網站已登入，並提供不消耗配對碼的登入診斷。保留原生錄音、手機記事本與既有操作；保留App資料，APK覆蓋安裝即可。

## 使用條件與功能

- Android 10 以上（API29），有效且受系統信任的 HTTPS 根網址。
- 後端至 backend_v6、網頁至 web_v8，同一 HTTPS origin，沿用已配置的 cloudflared。
- 本地 LLM／STT、API 與儲存由使用者的設備處理；APK 不執行模型。

| 功能 | 實際行為 | 結果界線 |
|---|---|---|
| 原生錄音 | 權限後 MediaRecorder 錄完整 .m4a，停止後由原生 HTTPS 上傳 | 不需要 STT 即時串流；逐字稿由後端取得 |
| 通訊錄 | 原生確認與讀取權限後搜尋姓名，最多20筆 | 回傳受限候選人 |
| 撥號 | 開啟已填號碼的電話畫面，由使用者按通話 | opened 不代表已接通 |
| 定點鬧鐘 | 時間與名稱交給支援的時鐘 App | handed_off／opened，不宣稱已保存 |
| 倒數計時器 | 確認1–86400秒與名稱，交給手機時鐘 | handed_off，請在時鐘查看開始結果 |
| 日曆 | 選已有可寫日曆，確認帳號與時間，再寫事件及提醒 | 成功才回 completed＋event_id |
| 手機記事本 | 已驗證標題與內容交給支援的記事本或文字分享選擇器 | handed_off，使用者在記事本內確認保存 |
| 筆記分享 | 開啟文字分享面板，由使用者選目標 App | 不宣稱對方已保存 |

電話號碼不由模型猜測。姓名撥號先查聯絡人，同名先選人；日曆確認仍顯示實際時間、提醒與採用的預設說明。

## 原生錄音與暫存

語音首頁經受信任 origin／主框架的橋接請求 APK 錄音。開始前核對預期 user／device 與原生 /me 身分，取得 RECORD_AUDIO 權限；獨立15秒啟動／權限期限防止一直卡住。

MediaRecorder 使用 MIC → MPEG_4／AAC，audio/mp4 .m4a，96kbps、44.1kHz。檔案位於 App 沙盒的 cacheDir/pending_voice，隨機檔名；網站沒有 bearer token 或私有檔案路徑。

錄音中每250ms回報經過時間與音量。網站顯示收聽中、跳動時間、紅色結束與取消。按結束釋放錄音器並收尾檔案，再以完整 raw body 原生 HTTPS POST /v1/audio?purpose=command；只回傳 job／trace／status 資訊給網站，由網站查STT與自動送Agent。原生主路徑不依賴 WebView MediaRecorder。

單次上限180秒與8MiB，到達上限會取消並捨棄，不自動上傳。取消、離開前景、頁面離開與 Activity 銷毀均停止本次錄音並清理；啟動也會清掉孤立暫存檔。成功／失敗後刪除暫存，沒有背景麥克風服務。

取消上傳會取消HTTP call，但後端可能已收到音訊；不自動重傳，不宣稱已撤回後端工作。一般Chrome保留瀏覽器完整Blob上傳路徑。

暫存是 App 私有且短暫的音訊檔，未額外AES加密，不能描述為永久加密音訊庫。對外傳輸使用HTTPS；TLS憑證驗證與拒絕明文政策保留。

## 手機預設記事本

新能力 notes.create_native 先用 Android 常見 CREATE_NOTE Intent，text/plain，傳入標題與內容；沒有支援者則開啟文字分享選擇器。使用者可選手機安裝的記事本，仍須在該 App 內確認保存。

Android 沒有跨廠牌的預設記事本資料介面；可能沒有能處理CREATE_NOTE的App，也可能需選擇器，不能保證無提示地指定某一個廠牌App。只有開啟／交接成功才回 handed_off，沒有可處理App回 unsupported。

本版不宣告通用記事本讀取／搜尋／追加／更新能力。不再使用 APK 自建加密筆記冒充預設記事本，其工具列入口與原生能力已停用；舊檔與金鑰保留，未自動刪除／搬移／匯出。若需要平台備忘錄，須在「其他工具」明確選用。

記事本或日曆如何保存、雲端同步與分享依該 App／帳號設定，不屬於後端AES加密範圍。

## 安裝、配對與排錯

直接使用 android/releases/local-assistant-debug.apk 覆蓋安裝。精確版本、雜湊與簽章見 releases/README.md；不要解除安裝再安裝。既有憑證可沿用。

本版versionName1.5／versionCode6，最終assembleDebug成功，APK v2簽章有效且與舊版同憑證。APK雜湊見 releases/README.md。尚未在目標手機實際覆蓋安裝或確認Cookie失敗原因。

1. 啟動後端與既有Tunnel，填入實際HTTPS根網址，例如 https://2026-asus-ugen.aphelion.tw。
2. 用後端 examples/create_pairing_code.py 產生一次性碼，填入APK原生畫面；管理憑證不交給APK。
3. 原生 /v1/auth/pair 取得加密保存的裝置token。後端驗證原生憑證與實際Cookie同身分後才載入網站，不以本機安裝Cookie回呼當作已登入。

Chrome與APK需要不同配對碼，碼使用一次即失效，即使尚未到期也不得重用。backend_v6 的每張新碼預設獨立使用者；私人平台筆記也鎖定原始建立裝置。重新配對不自動繼承舊裝置筆記。

### 已保存配對，網站仍要求登入

「已保存配對資料」與「返回已配對助理」只代表手機有保存憑證，不能單憑入口宣稱後端接受該憑證。APK bearer配對與WebView Cookie登入分開驗證：

1. Bearer GET /v1/auth/me，確認auth_kind=device及device_id等於已保存裝置，取得目前user_id。
2. 以原生憑證POST /v1/auth/session，核對裝置與唯一、安全的Set-Cookie。
3. CookieManager安裝後讀回實際Cookie，確認是這次新建立的值；accepted回呼只代表本機接受寫入。
4. 只帶該Cookie、不帶Authorization，GET /v1/auth/me；要求auth_kind=session，user_id與device_id都和原生身分一致。
5. 通過後才load網頁／回ready；web_v8再用網站自己的Cookie核對一次才載入私人資料與啟用麥克風。

三個原生HTTP步驟各有15秒期限，網頁hello等待上限60秒；沒有把有效bearer一起附到Cookie驗證，避免bearer遮蔽失效或錯帳號Cookie。失敗呈現APK裝置驗證／網頁登入／Cookie安裝／Cookie後端驗證階段，附實際可用的HTTP、安全錯誤碼與已驗證request ID，沒有秘密或原始服務回應。

設定的「檢查已配對登入」只用Bearer GET /me與目前Cookie GET /me，沒有POST/session、Cookie寫入／清除、配對碼兌換或憑證修改。用它先確認哪一階段失敗；網站登入重建另用「返回已配對助理」、APK「同步」或網頁「重新建立登入」。

Cookie缺少、未更新、HTTP401或身分不一致時都保留原生憑證，不自動解除配對。只有原生憑證驗證被拒絕，才請管理者確認是否需重新配對；網頁登入失敗不用反覆輸入一次性碼。同步不重播指令／手機動作。

截圖只顯示已保存配對入口與網站未登入，不能確認實機Cookie、時序或代理根因。不要先清App資料或解除配對，以新診斷顯示的階段和request ID對照後端。

「檢查後端連線」只呼叫 GET /health，不送配對碼或token。連線成功仍需要一組未用碼。失敗畫面區分HTTP、TLS、DNS、逾時、Keystore與Cookie階段，不顯示原始服務內容、秘密或原始例外。若原生網頁登入失敗，已保存憑證保留，可返回助理重試。

HTTPS網址不能包含帳密、子路徑、查詢或fragment。含底線hostname可能有Android SNI相容問題，新網址使用連字號。APK不共用Chrome的Cloudflare Access Cookie，本版未整合互動式Access登入；轉址／403／HTML需依實際規則排查，不略過TLS驗證。

上方「同步」更新網站Cookie並重送已保存結果，不再次執行手機動作。解除配對須由後端撤銷成功後清除token／Cookie；失敗保留憑證稍後重試。

## 建置

Android Studio Open 開啟 local-assistant/android。使用JDK17、AndroidSDK Platform35、BuildTools34.0.0；AGP8.7.3、Gradle8.10.2、Kotlin2.0.21、AndroidXWebKit1.12.1、OkHttp4.12.0。

Linux／macOS：

```bash
cd local-assistant/android
chmod +x gradlew
./gradlew assembleDebug
```

Windows PowerShell：

```powershell
cd local-assistant\android
.\gradlew.bat assembleDebug
```

產物 app/build/outputs/apk/debug/app-debug.apk。Debug包供測試，正式發布要維持自己的簽章金鑰；ZIP不包含SDK、私鑰或電腦local.properties。

## 原生橋接與資料保護

NativeBridge 只允許指定HTTPS origin與主框架。手機操作只接action ID，APK自行從後端取得完整內容、確認、領取短效執行憑證與回報；JavaScript不能指定任意Intent或帶入 bearer。

錄音橋接帶獨立 recording ID 與預期身分，只允許固定錄音流程，不接受任意檔案／上傳網址。ready握手、進度、終止與job回覆綁定同次錄音，舊回覆不得接到新流程。

token與操作收據使用Keystore AES-256-GCM，無法確定是否執行過的動作不自動重做。「同步」只重送結果；receipt依origin與裝置分隔。

禁用明文、混合內容、第三方Cookie、任意檔案來源與WebView偵錯；不略過SSL。禁用App備份／裝置轉移。HTTPS會在Cloudflare edge終止，非Cloudflare無法讀取的應用層端對端加密；本版未配置mTLS。

## 驗證與版本記錄

完整編譯與簽章結果見 STATUS.md／releases/README.md。真機優先驗收：啟動權限、紅色停止／取消、錄音時鐘、.m4a轉錄、背景釋放、網路失敗可重錄、記事本交接與保存，以及兩組配對裝置平台筆記隔離。

尚未取得目標手機，不能以成功建置宣稱該手機已可錄音／已存記事本。版本修改與界線詳見 CHANGELOG.md、docs/android_v6.md。

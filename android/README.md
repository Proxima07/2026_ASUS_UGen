# Android APK v1：本地助理手機操作橋接

本子專案使用 **Kotlin＋Android SDK＋WebView**。聊天與筆記介面由你的 Pi 網站提供；APK 負責裝置配對、授權、原生確認及手機操作，沒有內建 LLM，也不會呼叫第三方 AI。

## 使用條件

- Android 10 以上（API 29），已更新 Android System WebView。
- HTTPS 根網址，例如 `https://assistant.example.com`；必須使用有效、受系統信任的憑證。
- 既有 `backend_v1` 加上 `backend_v2` 的更新，以及 `web_v1`，三者部署在相同來源。
- 手機能連到該網址；Cloudflare Tunnel 只提供網路路徑，不會替你執行 LLM。
- 模型、轉錄、記憶與 API 由使用者控制的設備處理。

## 本版可用功能

| 功能 | 實際行為 | 後端結果 |
|---|---|---|
| 通訊錄搜尋 | 原生確認與讀取權限後，依姓名查最多 20 筆匹配資料 | `completed`，包含候選聯絡人 |
| 撥號 | 開啟已填號碼的電話畫面；使用者按下通話 | `opened`，不宣稱通話已接通 |
| 鬧鐘 | 將時間與名稱交給支援的時鐘 App，保留時鐘確認畫面 | `handed_off`／`opened`，不宣稱鬧鐘一定已保存 |
| 日曆 | 使用者選擇已有可寫日曆、確認事件與帳號，再直接寫入事件及提醒 | `completed`＋`event_id` |
| 手機加密筆記 | 將指定筆記保存至本 APK 自己的加密儲存 | `completed` |
| 筆記分享 | 開啟系統分享面板，選擇接受文字的記事 App | `handed_off`，不宣稱已寫入其他 App |
| 錄音轉筆記 | WebView 授權麥克風；網站錄音或選擇音訊檔，送私人設備轉錄 | 由網站／後端處理 |

電話號碼不由模型自行猜測。姓名撥號先查手機通訊錄；同名時使用網站提供的候選選擇。含分機、暫停碼或服務碼的資料不會直接改寫成另一個號碼。

記事本沒有跨廠牌共通的直接寫入介面。本版的「保存到手機」是保存至本 APK；「分享」才是交給其他記事 App。

## 建置

建議使用 Android Studio，選擇 **Open** 開啟 `local-assistant/android/`。安裝 JDK 17、Android SDK Platform 35；AGP 8.7.3 會使用 Build Tools 34.0.0。

版本：AGP 8.7.3、Gradle 8.10.2、Kotlin 2.0.21、AndroidX WebKit 1.12.1、OkHttp 4.12.0。`minSdk=29`、`targetSdk=35`。

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

輸出位置：`app/build/outputs/apk/debug/app-debug.apk`。

若版本包附已建置的測試 APK，可直接使用 `releases/local-assistant-debug.apk`，不需先在自己的電腦建置。來源仍保留完整 Gradle 專案。

連接手機並啟用 USB 偵錯後，可安裝：

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

首次用 Gradle 建置需要下載依賴及 SDK；完成後才可採用快取離線建置。Debug APK 適合這次測試，正式發布要使用自己的簽章金鑰並持續保存。來源 ZIP 不含私鑰、正式簽章設定或電腦 SDK 路徑。

## 配對步驟

1. 啟動後端並透過 Tunnel 提供你的 HTTPS 網址，網站使用相同來源。
2. 依 `backend/README.md` 使用初始化管理憑證產生一次性配對碼。管理憑證留在管理端，不輸入 APK。
3. 開啟 APK，填寫 HTTPS 根網址、裝置名稱及配對碼。
4. APK 原生呼叫 `/v1/auth/pair`，取得裝置 token；token 加密保存。
5. APK 使用該 token 呼叫 `/v1/auth/session`，將後端回傳的 Secure／HttpOnly cookie 交給 WebView，再載入網站。

網址不能包含帳密、子路徑、查詢或 fragment。`https://assistant.example.com` 可以；`http://...`、`https://.../app/` 不接受。

若網站顯示登入已過期，按 APK 上方「同步」即可更新網頁登入、重送已保存的操作結果並重新整理頁面。此按鈕不會再次執行手機動作。

「設定 → 停用裝置並解除配對」及網頁登出會通知後端撤銷裝置，再清除裝置憑證與 WebView cookie；本機筆記仍保留。若後端無法連線，撤銷失敗會保留憑證，稍後再試。

## 介面與責任

APK 只有原生配對畫面、上方「設定／同步／手機筆記」工具列及操作確認。日常對話、筆記、錄音介面維護在 `web/`，APK 不需跟著每一次版面修改重新打包。

`NativeBridge` 僅注入指定 HTTPS origin。網站透過 `postMessage` 傳操作 ID；APK 自己領取已驗證的完整操作，不接受 JavaScript 傳入電話、任意 Intent 或 Android 類別名稱。用戶端 bearer 不交給 JavaScript。

## 原生橋接協定

網站發送：

```json
{"protocol_version":"1","message_id":"msg_1","type":"hello"}
```

原生回應 `type=ready`，附 `capabilities` 及 `uncertain_actions`。

執行手機動作：

```json
{"protocol_version":"1","message_id":"msg_2","type":"execute_action","action_id":"act_xxx"}
```

完整流程：`GET action → 原生確認 → POST confirm → 保存執行憑證 → 手機操作 → 加密保存結果 → POST result`。回覆 `type=action_result`，包含 `action_id`、`state`、`message`、後端 `result`。失敗使用 `type=error`，附 `error.code/message`。

解除配對：`type=logout`，成功回覆 `type=logged_out`，然後返回原生配對畫面。

## 執行防重複

- 發出領取請求前，先加密保存 `preparing` 收據，避免網路逾時後再次啟動同一動作。
- 取得 `execution_token` 後，先保存 `claimed` 收據，再執行手機動作。
- 結果回傳失敗，保留原始 token、狀態及結果；「同步」只重送這些已保存結果。
- 收據依 HTTPS origin 與裝置 ID 分開保存；切換伺服器或重新配對，不會把舊操作結果傳給新的中樞。
- 發生當機或斷線而無法確定是否已執行時，同一 action ID 不會再次執行。先查看手機與後端，再建立新的指令。
- 若後端執行期限已過，結果同步可能被拒絕；本版不自動重設或重做動作。

展示時可於後端 `.env` 設定 `ACTION_LEASE_SECONDS=600`（上限 10 分鐘），預留手機授權與日曆選擇時間。手機操作仍須在執行期限內完成；過期結果須人工檢查。

## 資料與連線

- 手機 ↔ API 使用 HTTPS/TLS；本版不需要 mTLS，因為目前需求是避免明文傳輸。
- 裝置 token 與執行收據採 Android Keystore AES-256-GCM；筆記使用另一個 Keystore AES-256-GCM 金鑰。
- 裝置加密金鑰不包在 APK／來源 ZIP 中；啟動後於裝置上產生。此處的 AES 金鑰不是 APK 簽章金鑰，也不是 mTLS 用戶端憑證。
- WebView 短效 session cookie 由 WebView 於 App 沙盒維護，非本程式自訂 AES 檔；bearer token 不進入網頁 localStorage。
- 禁用明文、混合內容、任意檔案來源、第三方 cookie、外部子資源及網頁偵錯。不略過 SSL 驗證。
- 禁用 App 備份／裝置轉移。為支援這次 PoC 展示，本版允許手機截圖與螢幕錄影，畫面內容由使用者自行管理；資料卸載後不可依賴備份還原。
- 日曆與使用者指定的其他 App 仍依原有規則同步；它們不屬於本地 LLM 中樞的保護範圍。
- Cloudflare Tunnel 的 TLS 會在 Cloudflare 終止；不能把本版宣稱成 Cloudflare 無法讀取的應用層端到端加密。Cloudflare Access 若增加互動式登入，需另外整合，不使用帳密／service token 內嵌方式略過。

## 資料夾

| 路徑 | 用途 |
|---|---|
| `app/src/main/java/com/proxima/localassistant/MainActivity.kt` | 配對、登入 cookie、WebView、錄音／檔案權限 |
| `bridge/BridgeController.kt` | 接收操作 ID、確認、領取、防重複與回報 |
| `network/NativeApiClient.kt` | 固定 HTTPS API 路徑，拒絕重新導向 |
| `security/` | 裝置 token、AES 檔案、執行收據 |
| `web/TrustedWebViewClient.kt` | 網站來源與憑證限制 |
| `actions/` | 通訊錄、電話、鬧鐘、日曆、筆記 |
| `permissions/` | 原生執行期權限 |
| `storage/` | 手機加密筆記 |
| `ui/` | 操作確認與離線筆記檢視 |
| `app/src/main/res/xml/` | 網路、備份及轉移設定 |

## 尚待實機驗收

完整清單見 `STATUS.md`。必須用目標手機確認：通訊錄授權、同名選擇、預設電話／時鐘、可寫日曆與提醒、錄音、音訊匯入、斷線後結果同步，以及未配對手機無法執行操作。

官方參考：

- [Android 常見 Intent](https://developer.android.com/guide/components/intents-common)
- [Calendar Provider](https://developer.android.com/guide/topics/providers/calendar-provider)
- [Contacts Provider](https://developer.android.com/guide/topics/providers/contacts-provider)
- [Android Keystore](https://developer.android.com/privacy-and-security/keystore)
- [WebView 原生橋接風險與來源限制](https://developer.android.com/privacy-and-security/risks/insecure-webview-native-bridges)
- [AndroidX WebViewCompat](https://developer.android.com/reference/androidx/webkit/WebViewCompat)

# android_v1 交付紀錄

日期：2026-10-12。語言：Kotlin，採 Android SDK、WebView 與 Gradle。Android 10 以上（min API 29），target API 35。

## 交付內容

`android_v1.zip` 是完整手機子專案，保留 `local-assistant/android/` 結構。隨附可直接安裝的測試版本：

`android/releases/local-assistant-debug.apk`

- 套件：`com.proxima.localassistant`。
- 版本：`1.0`，versionCode `1`。
- APK 大小：4,695,876 bytes。
- APK SHA-256：`9bb4500022f1b382a5291b853254d330fda6cc02bc10695afd97acc67dfe7f4c`。
- `assembleDebug` 成功，APK v2 簽章驗證通過。
- Debug APK 用於測試；正式發布使用自己的持久簽章金鑰。ZIP 不含簽章私鑰、SDK、建置快取或本機 SDK 路徑。

來源可用 Android Studio 開啟，亦可用 JDK 17 及 Android SDK Platform 35 執行 `./gradlew assembleDebug`。完整步驟見 `android/README.md`。

## 本版功能

HTTPS 配對、加密裝置憑證、限定來源原生橋接、WebView 登入、通訊錄姓名搜尋、開啟撥號、系統鬧鐘交接、選擇日曆後寫入事件及提醒、自己的加密手機筆記及離線閱讀、分享文字至其他 App、網頁麥克風授權、音訊檔案選擇、操作確認、防重複、結果重送及解除配對。

「開啟電話」、「交接時鐘」及「交接分享」不代表外部 App 最後完成；寫入其他品牌內建記事 App 使用分享介面。錄音轉錄與模型判斷由私人後端處理，APK 沒有內建模型。

## 安裝與依賴

1. 保留 backend_v1，覆蓋 backend_v2，並解壓 web_v1 到同一 `local-assistant/`。
2. 設定後端 `.env` 的 `PUBLIC_BASE_URL`、OpenAI 相容本地模型 URL／模型名稱；轉錄需另設定 STT。
3. Tunnel 指向同機後端，重啟後端。
4. 安裝隨附 APK；管理端於 `backend/` 執行 `python examples/create_pairing_code.py` 產生一次性碼。
5. 手機填寫 HTTPS 根網址、裝置名稱、配對碼。管理憑證不交給手機。

## 尚未完善

尚未執行 Android Lint、模擬器或實體手機驗收；不同品牌電話／時鐘、日曆帳號、麥克風、權限及斷線需實測。未提供 iOS、QR 配對、Cloudflare Access 互動登入、手機筆記刪除／備份 UI、mTLS 或應用層端對端加密。

Cloudflare Tunnel 使用分段 TLS，Cloudflare 可解密流量；模型與後端加密內容保留在私人設備。完整功能與驗收清單見 `android/STATUS.md`，本版更新見 `android/CHANGELOG.md`。

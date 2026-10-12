# 測試 APK

`local-assistant-debug.apk` 由 android_v5 的完整來源建置，包含手機原生錄音、手機記事本交接及身分隔離防護。Android 10 以上，套件 `com.proxima.localassistant`，版本 1.4／versionCode 5；大小 4,746,762 bytes。

SHA-256：`adc2e19be936e18037f1a520e2b3c171b3273b6cbffab5ba2b8866e4349e906c`

簽署憑證 SHA-256：`df9e62c3c1275a5bdad01ec9b50394e339dc2371fc1f846354bb8df8a63c3404`，與前版相同。最終離線 assembleDebug 編譯成功，APK v2 簽章驗證通過，minSdk 29／targetSdk 35、RECORD_AUDIO 權限及版本已檢查。

可直接更新安裝舊 APK，不需先安裝中間版或解除安裝。解除安裝會清除 App 私有資料。本版停用舊 APK 自建加密筆記的入口與能力，保留原有檔案；不自動將其歸給目前或新配對使用者。

更新至 backend_v6／web_v7，重啟後端，再安裝本 APK 並重新開啟。既有 .env 與 cloudflared 可以沿用。首次錄音需允許 APK 麥克風權限；等待超過 15 秒時會取消，完成權限後請重新點錄音。錄音後按紅色「結束錄音並送出」，或按「取消錄音」捨棄。手機記事本交接後仍需在該 App 確認保存。

可下載或複製到 Android 手機後，允許該檔案來源安裝。也可使用 `adb install -r releases/local-assistant-debug.apk`。來源差異包需要依序套用前版；內附 APK 是完整安裝檔。

目標手機的麥克風、記事本、帳號切換、實際 Tunnel 與覆蓋安裝仍需驗收；程式及簽章檢查不能代替真機測試。正式發布應使用自己的固定 release 簽章金鑰。

配對與使用見上一層 README.md，驗證及未完善項目見 STATUS.md。

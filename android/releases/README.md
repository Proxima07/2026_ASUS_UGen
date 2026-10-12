# 測試 APK

`local-assistant-debug.apk` 是 android_v6 的完整安裝檔，修正已保存配對但網頁登入未通過驗證的銜接與提示。搭配 backend_v6／web_v8；本次後端不需新版本。

套件 `com.proxima.localassistant`，版本 1.5／versionCode 6，Android 10 以上（minSdk 29／targetSdk 35）。大小 4,786,934 bytes。

SHA-256：`8331df4a560dc7cfad5f8f462ebc4aa8d729ebee53e61d75f284ad897136f146`

簽署憑證 SHA-256：`df9e62c3c1275a5bdad01ec9b50394e339dc2371fc1f846354bb8df8a63c3404`，與前版一致。最終離線 assembleDebug 成功，APK v2 簽章、套件、版本及 SDK 已驗證。可直接更新安裝舊 APK，不需解除安裝或清除 App 資料。

先覆蓋 web_v8，安裝本 APK，重新開啟 App。有效的已保存配對可沿用；網頁登入失敗會保留裝置憑證，不用反覆耗用配對碼。若仍未登入，到「設定 → 檢查已配對登入」查看原生憑證／Cookie 驗證階段、HTTP 狀態、錯誤代碼與安全請求 ID。這個檢查只讀取既有狀態，不產生配對碼、不建立 session，也不改寫 Cookie 或憑證；重新建立登入請用「返回已配對助理」、上方「同步」或網頁「重新建立登入」。

Cookie 系統操作逾時時，保持安全鎖定並提示完整關閉 App 後重開；沒有自動清除配對資料或強制解鎖舊的 Cookie 操作。僅後端確認原生裝置憑證不被接受時，才提示管理者確認並重新配對。代理／網路錯誤會另外顯示。

也可用 `adb install -r releases/local-assistant-debug.apk`。來源差異包須依序套用前版，內附 APK 可直接安裝。實際目標手機、公開 Tunnel 與覆蓋安裝尚未驗收；正式發布應使用自己的固定 release 簽章。

功能、驗證範圍與未完善項目見上一層 README.md、STATUS.md，以及 docs/android_v6.md。

# android_v2 手機筆記更新

日期：2026-10-12。本包是 android_v1 的差異更新，配合 backend_v3 與 web_v3。

## 新增功能

新增 APK 手機加密筆記搜尋、既有筆記取代與追加。搜尋最多 20 筆，只回傳 note_id、title 與最多 300 字元的 preview，結果限制在 28 KB 內。更新不存在的 ID 會失敗，不會暗中建立另一筆；追加後也遵守 16000 字元上限。

web_v3 語音首頁自動送來已驗證的 action ID；APK 從後端取得實際參數、顯示原生確認、取得執行憑證後再操作。網頁不能自行提供任意 Intent 或略過手機權限。

目前可通用保證的手機筆記是本 APK 自己的本機加密筆記區。各品牌內建記事 App 使用既有文字分享介面，無法通用保證自動寫入。

## 安裝與驗證

覆蓋 android_v1 的變動來源，從 `android/releases/local-assistant-debug.apk` 更新安裝。APK 套件 com.proxima.localassistant、版本 1.1、versionCode 2；與原版使用相同簽署憑證。

- assembleDebug 成功，APK v2 簽章通過。
- APK 大小：4,710,288 bytes。
- SHA-256：`04285fb1f16bc544e0da653ff74b8d5df7cf8a1089926e3154a8b2d8f0cbc0c6`。
- 簽署憑證 SHA-256：`df9e62c3c1275a5bdad01ec9b50394e339dc2371fc1f846354bb8df8a63c3404`。

具備原版覆蓋更新的套件、簽章與版本條件；尚未執行目標手機安裝與操作測試。首次安裝、Keystore、語音停頓判斷、權限、預設時鐘與日曆仍需真機驗收。完整清單見 android/STATUS.md。

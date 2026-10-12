# android_v4 倒數計時器

日期：2026-10-12。本包是 android_v3 的來源差異更新，配合 backend_v5／web_v6。編譯好的 APK 可直接覆蓋既有舊版，不需解除安裝。

## 新增功能

新增 timer.create，與定點 alarm.create 分開：

| 指令 | 手機操作 |
|---|---|
| 幫我計時 10 分鐘 | 倒數 600 秒 |
| 倒數 30 秒 | 倒數 30 秒 |
| 半小時後提醒我看鍋子 | 倒數 1800 秒，附名稱 |
| 明早七點的鬧鐘 | 原本的定點時鐘鬧鐘流程 |

timer.create 接收 duration_seconds（整數 1–86400）與 label（最多 200 字元）。APK 從後端取得已驗證操作，原生確認顯示實際倒數長度與名稱，再使用 Android AlarmClock.ACTION_SET_TIMER、EXTRA_LENGTH、EXTRA_MESSAGE，保留 EXTRA_SKIP_UI=false。

手機需有支援此 Intent 的時鐘 App。交接成功只回報 handed_off，不能把開啟介面當作已確認開始倒數；使用者應在時鐘 App 查看結果。沒有支援時鐘時回 unsupported。本版不在 APK 另開背景計時服務，也不以固定時刻鬧鐘假裝倒數。

日曆原生確認也會顯示 backend_v5 提供的 defaults_notice，保留標題、開始／結束、提醒、日曆帳號及實際參數。缺少、空白或 null 的預設說明不顯示，最多呈現 500 字元。

## 安裝與來源

使用 android/releases/local-assistant-debug.apk 更新安裝。套件仍是 com.proxima.localassistant，versionName 1.3、versionCode 4；使用與 v1／v2／v3 相同的簽署憑證，具備直接覆蓋更新條件。

自行建置來源時，先有 android_v1，再依序覆蓋 v2 → v3 → v4；差異包不包含這次沒變動的舊來源。單純安裝內附 APK 不需先安裝中間版本。

本次 APK 不改配對、Keystore、WebView 網路政策、原生確認或執行收據機制。既有本機筆記仍保留；不需要清除 App 資料。手機授權與外部時鐘行為仍依系統處理。

## 驗證範圍

TimerHandler、ActionDispatcher、原生確認與 Manifest 已完成程式檢查及 Kotlin／Android 35 SDK 編譯。最終 APK 版本、簽章與雜湊見 android/releases/README.md；完整界線見 android/STATUS.md。尚未在目標手機的時鐘 App 上實際測試倒數。

官方參考：[Android 建立計時器](https://developer.android.com/guide/components/intents-common#CreateTimer)、[AlarmClock.EXTRA_LENGTH](https://developer.android.com/reference/android/provider/AlarmClock#EXTRA_LENGTH)。

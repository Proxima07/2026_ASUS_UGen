# 測試 APK

`local-assistant-debug.apk` 由本版完整來源建置，APK v2 簽章驗證通過。Android 10 以上，套件 `com.proxima.localassistant`，版本 1.1／code 2。

SHA-256：`04285fb1f16bc544e0da653ff74b8d5df7cf8a1089926e3154a8b2d8f0cbc0c6`

簽署憑證 SHA-256：`df9e62c3c1275a5bdad01ec9b50394e339dc2371fc1f846354bb8df8a63c3404`，與交付 v1 相同。請更新安裝；解除安裝會清除原手機加密資料，並非此次更新所需步驟。

可在 Android 手機下載或複製後，允許該檔案來源安裝並開啟。也可使用 `adb install -r releases/local-assistant-debug.apk`。實際手機尚未驗收；正式發布請改用自己的固定 release 簽章金鑰。

配對與使用步驟見上一層 `README.md`，建置及功能狀態見 `STATUS.md`。

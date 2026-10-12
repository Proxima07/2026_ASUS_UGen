# 測試 APK

`local-assistant-debug.apk` 由本版完整來源建置，含倒數與日曆預設確認；APK v2 簽章驗證通過。Android 10 以上，套件 com.proxima.localassistant，版本 1.3／code 4；大小 4,746,476 bytes。

SHA-256：`a2de730bac36cf80ef99729c0f0079a1adf9debbd112df2a8ea470b408d607ac`

簽署憑證 SHA-256：`df9e62c3c1275a5bdad01ec9b50394e339dc2371fc1f846354bb8df8a63c3404`，與 v1／v2／v3 相同。可直接更新舊 APK 到 v4；解除安裝會清除手機加密資料，並非本次更新所需步驟。

可在 Android 手機下載或複製後，允許該檔案來源安裝並開啟。也可使用 `adb install -r releases/local-assistant-debug.apk`。實際手機與時鐘尚未驗收；正式發布請用自己的固定 release 簽章金鑰。

配對與使用步驟見上一層 README.md，建置及功能狀態見 STATUS.md。自行建置來源請先依序套用前版差異更新；單純安裝此 APK 不需先安裝中間版。

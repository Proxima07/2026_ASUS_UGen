# Android v6 功能與驗證狀態

更新：2026-10-12。搭配 backend_v6／web_v8。本文件區分已寫程式、已編譯與目標手機驗收。

| 項目 | 本版狀態 | 還需確認 |
|---|---|---|
| 原生憑證驗證 | Bearer/me auth_kind=device與saved device一致 | 已保存入口不等於後端已接受 |
| Cookie後端證明 | CookieManager實際新值，只帶Cookie/me | auth_kind=session＋同user/device才load／ready |
| 唯讀登入診斷 | Bearer/me與目前Cookie/me | 不兌換碼、不建session、不寫Cookie或修改憑證 |
| 分階段失敗 | 保留憑證，安全phase／HTTP／request ID | 不能以截圖猜實機Cookie／代理根因 |
| 原生MediaRecorder | MIC→MPEG_4/AAC .m4a，完整音檔 | 目標手機權限、編碼器與實際聲音 |
| 原生錄音限制 | 180秒／8MiB，啟動／權限15秒 | 到上限捨棄、背景釋放、再次錄音 |
| 原生HTTPS上傳 | 固定/v1/audio?purpose=command，Bearer不交網頁 | 實際Tunnel與STT接.m4a |
| 暫存清理 | App私有cache，成功／取消／錯誤／啟動清孤立檔 | 無永久音訊庫；未額外AES加密 |
| 錄音橋接 | origin／主框架、錄音ID及expected身分 | 跨身分／遲到事件不能接錯工作 |
| 手機記事本新筆記 | CREATE_NOTE，無支援則文字分享選擇器 | 目標記事本是否接受內容、使用者保存 |
| 手機記事本讀取／更新 | 未提供通用能力 | 廠牌App沒有共用內容介面 |
| 舊自建加密筆記 | 資料保留，入口與能力停用 | 無自動刪除／搬移／匯出 |
| 電話、鬧鐘、倒數、日曆 | 保留原能力與確認 | 真實權限／時鐘／日曆帳號 |
| 配對與安全診斷 | 原生HTTPS／Keystore／session保留 | 實際host、TLS、登入與Cookie |
| 收據與同步 | 防重複與只重送結果 | 斷網／當機／過期人工確認 |
| 正式模型與STT | 私人後端配置 | APK不保證模型推論品質 |
| 實機驗收 | 未取得目標手機 | 編譯不代表錄音／記事本已成功 |

## 建置驗證紀錄

最終v6完整assembleDebug成功，APK v2簽章有效並與舊版同憑證。versionName1.5／versionCode6，仍是com.proxima.localassistant、min29／target35；具備覆蓋更新條件。APK大小4,786,934 bytes，SHA-256：8331df4a560dc7cfad5f8f462ebc4aa8d729ebee53e61d75f284ad897136f146。完整交付資料見 releases/README.md。

尚未在目標手機做登入、錄音、記事本或覆蓋安裝驗收；相同簽章與較高版本不代表已實際覆蓋安裝。

最終來源compileReleaseKotlin成功，72項純JVM自檢通過，涵蓋Cookie安全欄位、缺少／重複／舊值、階段錯誤與敏感內容處理；獨立安全審查通過。這些是本地程式驗證，不是CookieManager或手機實測。

## 本次登入驗收

1. 更新web_v8與android_v6，既有backend_v6、.env、runtime與cloudflared保留；APK覆蓋安裝，不清App資料。
2. 已保存配對先用「檢查已配對登入」核對Bearer與Cookie；此檢查不建新session或消耗配對碼。
3. 「返回已配對助理」通過Cookie-only後端身分證明才載頁；Web8再確認session與APK身分相同。
4. Cookie401、缺少、未更新、錯身分與原生憑證401分階段呈現，失敗仍保留憑證；手動重試不重新兌換碼。
5. 網頁失敗時查看安全階段／HTTP／request ID，對照後端紀錄；不要以入口或截圖推論確切Cookie根因。
6. 同步與返回助理不重播舊指令；不同裝置身分不得誤載私人資料。

## 既有功能驗收

1. 非信任origin不得操作；錄音expected身分與/me一致。
2. 首次錄音權限、拒絕、15秒期限、取消與背景往返後確認麥克風釋放。
3. 點錄音看到時鐘與紅色控制，手動結束後端接完整.m4a並顯示audio.received／STT。
4. 取消未上傳音訊不得建立工作；已送達工作不宣稱撤回，網路逾時不自動重傳。
5. notes.create_native確認內容、開記事本／選擇器，使用者在記事本保存，網頁只顯示handed_off。
6. 沒有可處理App時unsupported；搜尋／更新不冒稱通用可用，不退回自建筆記。
7. A／B配對平台筆記隔離；舊token可看該裝置原筆記，新配對不自動繼承。
8. 原電話、鬧鐘、倒數、日曆與結果同步回歸，不重複動作。

## 未完成界線

沒有通用廠牌記事本讀取／更新、系統預設記事本固定指定、舊自建資料搬移、QR配對、正式簽章發布、互動式Cloudflare Access、mTLS與應用層端對端加密。系統記事本同步與儲存依其App設定；Cloudflare TLS在edge終止。

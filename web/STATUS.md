# web_v10 功能與驗證狀態

更新：2026-10-12。搭配 backend_v6／android_v6。

| 項目 | 程式狀態 | 實際界線 |
|---|---|---|
| 瀏覽器計時函式接收者 | VoiceFlow／CaptureSession／NativeCaptureSession預設透過globalThis呼叫 | 修正clear_voice與錄音計時器TypeError，保留注入測試能力 |
| 登入後清理失敗 | 同次登入例外不再誤當過期回覆忽略，撤銷權限並嘗試全部清理 | 清理失敗隱藏私人主畫面；成功清理／核對才能恢復 |
| 網頁登入進度與期限 | 核對、清理與啟用身分分階段追蹤，/me驗證20秒等待上限 | 逾時web_session_timeout；原API期限15秒；重試不重播操作 |
| APK登入握手 | 等hello ready後才首次/me | 60秒期限，不並行提前驗證 |
| Cookie與身分驗證 | auth_kind=session且user/device與APK一致 | 不一致不得載入私人資料或執行操作 |
| Cookie401恢復 | 每頁最多一次自動hello，另有手動重新建立登入 | 成功不重設自動預算；不重兌換配對碼 |
| 分階段診斷 | 前端版本、APK、網頁處理階段、HTTP、安全錯誤碼與request ID | 失敗自動展開；HTTP200後前端失敗仍保留200，不顯示憑證／私人內容 |
| 麥克風未授權提示 | 使用目前連線警告 | 不把所有網頁失敗當成尚未配對 |
| APK原生錄音首頁 | 優先使用受信任原生橋接 | 需要android_v6與身分一致握手 |
| 收聽中／時鐘／音量 | 真實開始後呈現，獨立計時 | 不等待WebAudio才啟動時間 |
| 紅色停止／取消 | 可手動結束、捨棄未送出的音訊 | 等待／收尾中的主麥克風可取消 |
| 完整檔案上傳 | APK原生.m4a或Chrome完整Blob | 不需要即時STT串流 |
| 等待權限／逾時 | 15秒期限，遲到stream釋放 | 不留卡住的錄音鎖，不自動替APK改用WebView錄音 |
| STT／Agent進度 | 依後端job／request狀態 | queued不冒稱transcribing |
| 手機記事本 | notes.create_native交接，使用者在App保存 | 不宣稱外部儲存已完成，無通用讀取／更新 |
| 錄音草稿匯出 | 直接建立手機記事本操作 | 不先偷偷建立平台副本 |
| 平台備忘錄 | 顯式選用，依user＋device隔離 | 伺服器權限檢查，前端清理防舊畫面殘留 |
| 身分切換／遲到回覆 | 清私人畫面與請求epoch | 舊回覆不得恢復前一身分資料 |
| 多輪對話／倒數 | 保留v6 | 依確切頁面conversation/head；原生確認保留 |
| 載入完整性 | web-v10各runtime版本一致 | 套用整個差異包；缺檔／混版有明確路徑提示 |
| 真實手機與公開站台 | 尚未驗收 | Node／mock測試不是麥克風硬體結果 |

## 驗證紀錄

全部145項Node測試通過，包含5項本次新增回歸與原有140項測試。本次要求計時函式接收者為globalThis，載入隨專案提供的HTML／main.js。原web_v9先重現HTTP200、clear_voice與login_state_reset_failed；修正後同一條登入路徑通過。

統一web-v10版本後再次執行全部145項測試通過，28個JavaScript檔語法檢查通過。

5項新增案例涵蓋：登入清理、原生收聽／進度／手動停止後接queued STT／取消與再錄、瀏覽器完整Blob收尾、權限取消後遲到stream釋放、原生180秒期限與遲到上傳回覆不得恢復舊流程。

最新目標手機截圖已由web_v9診斷確認失敗階段為「清除舊語音指令」，Cookie API回HTTP200。本地找到VoiceFlow保存未綁定clearTimeout，經this.clearTimer呼叫而使用錯誤接收者的確切缺陷，嚴格接收者模擬重現同一階段；CaptureSession／NativeCaptureSession同類預設計時器也已修正。以前Node計時器／箭頭函式測試忽略接收者，因此沒抓到此差異。

本次驗證是Node DOM模擬、嚴格計時函式接收者與舊版失敗對照，仍未在真實Chromium、WebView、目標手機或公開站台完成驗收；不代表實際麥克風或上傳硬體已通過。

上一版的本地backend_v6 TestClient驗證：Bearer /me回device，Cookie-only /me回同身分session；他人Cookie會回不同ID，無效Cookie401附有效X-Request-ID。Bearer A與Cookie B同時送出時採A，重現Cookie驗證不可附Bearer；當時13個web-v8執行資源200。這是本地API／檔案整合，不是公開hostname或手機WebView測試。

## 本次登入驗收

1. 在web_v9上覆蓋web_v10，保留android_v6、backend_v6、.env、runtime與cloudflared；不需重新配對、清App資料或清快取。
2. 確認連線處理資訊顯示web-v10；已配對手機重開後先看到登入核對，Cookie同身分且頁面清理完成才顯示已連接。
3. 網頁401至多自動同步一次；手動「重新建立登入」可再試，不再輸入已用配對碼。
4. Cookie、代理、頁面清理或登入啟用失敗顯示具體階段；原生憑證失效與網頁失敗區別呈現，不留無期限核對中。
5. 兩個不同裝置身分不可誤載私人資料；同步後不重播舊指令。

## 既有功能驗收

1. 新APK內點麥克風，完成首次權限後確認收聽中、經過時間與音量持續更新。
2. 再點主麥克風或紅色結束，查看上傳、STT與逐字稿；取消則不送未上傳音訊。
3. 權限拒絕／等待15秒／錄音錯誤／背景往返後可以重新操作，不留「前一段正在進行」。
4. 上傳失敗與取消後不自動重傳；已收到後端job不宣稱撤回。
5. 開啟手機記事本需在對方App保存；未支援時清楚告知，不默默另存平台。
6. 使用兩組配對裝置驗證平台筆記不可互看，重新登入／切身分不留舊內容。
7. 一般Chrome完整Blob錄音、草稿明確平台保存與原生匯出分別驗收。

尚未完善：目標手機本次登入狀態驗收、特定廠牌預設記事本整合、通用讀取／更新、跨頁永久對話UI、互動式Cloudflare Access、應用層端對端加密。詳細說明見 docs/web_v10.md。

# web_v10：修正語音清理與錄音計時器接收者

日期：2026-10-12。本包相對web_v9，只更新網頁。保留backend_v6、android_v6、`.env`、配對資料與既有cloudflared。

## 實際失敗與根因

最新web_v9截圖顯示網頁HTTP200，失敗階段「清除舊語音指令」，安全代碼login_state_reset_failed。這表示Cookie API已通過，網站在啟用登入前的語音狀態清理失敗，無須重新配對。

VoiceFlow原本將瀏覽器的clearTimeout保存為clearTimer，再以this.clearTimer(...)呼叫。此呼叫的接收者成為VoiceFlow，而非瀏覽器globalThis；瀏覽器會因接收者不符拋出TypeError。登入清理即使沒有進行中的錄音，也經過Voice.clear → interrupt → cancel並呼叫此函式，所以每次驗證HTTP200後仍可能在clear_voice失敗。

CaptureSession與NativeCaptureSession預設setTimeout／clearTimeout同樣保存未綁定函式，會在錄音權限等待、收尾、取消與期限處理遇到相同缺陷。

## 修正與前後差異

這三個元件的預設setTimer／clearTimer改以包裝函式呼叫globalThis.setTimeout／globalThis.clearTimeout，保留正確的瀏覽器接收者。原有可注入計時器的測試介面、錄音期限與取消規則保留。

修改前，原web_v9搭配要求正確接收者的計時函式，直接載入本專案HTML與main.js，可重現HTTP200＋clear_voice＋login_state_reset_failed。修改後同一路徑完成清理，網站可建立已核對的登入身分；錄音開始、手動停止、取消與再錄的計時器也不再因接收者錯誤中斷。

以前Node計時器／箭頭函式測試沒有檢查接收者，所以未能重現瀏覽器的限制。本版新增嚴格接收者回歸；它模擬該限制，不代表已在實際手機WebView驗收。

web_v9的分階段診斷繼續保留。HTTP200表示API成功回覆，仍須核對登入身分並完成私人狀態清理及身分啟用；若其他元件失敗，仍停止私人功能，顯示具體階段，不重播對話或手機操作。

## 套用與現場驗收

1. 在現有web_v9上覆蓋整個web_v10差異包。ZIP外層是local-assistant，解壓到原local-assistant的上一層，確認是執行中後端WEB_DIR指向的web。
2. 不只替換voice.js；HTML、CSS與JavaScript須使用一致web-v10標記，否則載入檢查會提示混版。
3. 保留backend_v6／android_v6、App資料與既有cloudflared；不需重建或重裝APK、重新配對、清App資料或清快取。
4. 關閉後重新開啟APK，或重新整理一般瀏覽器；確認「連線處理資訊」的網頁版本是web-v10。
5. 登入應通過「清除舊語音指令」並顯示已連接，再測麥克風收聽、手動停止、STT與取消後再錄。若失敗，提供階段、安全錯誤碼、HTTP與追蹤ID，不提供token或cookie。

## 驗證與界線

全部145項Node測試通過，包含原有140項及5項新增回歸：

- 隨附HTML／main.js登入清理，要求計時函式正確接收者。
- 原生錄音開始與進度、手動停止後接queued STT、取消與再次錄音。
- 瀏覽器錄音收尾為完整Blob。
- 取消權限等待後釋放遲到stream。
- 原生180秒期限及遲到上傳回覆不得恢復舊流程。

舊版失敗對照與修正版均在本地Node模擬執行。尚未在實際Chromium、WebView、目標手機、公開Tunnel、本地STT或麥克風硬體完成端到端驗收。完整功能狀態見web/STATUS.md。

執行資源統一web-v10後，全部145項測試再次通過；28個JavaScript檔語法檢查通過。

## 技術參考

- [HTML標準：Timers](https://html.spec.whatwg.org/multipage/timers-and-user-prompts.html)
- [Web IDL標準：Operations](https://webidl.spec.whatwg.org/#es-operations)

以上標準供計時函式與介面接收者規則參考；此專案的呼叫鏈與前後差異由本地原始碼及回歸測試確認。

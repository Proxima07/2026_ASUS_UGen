# backend_v6 功能與驗證狀態

更新：2026-10-12。搭配 web_v7／android_v5。

| 項目 | 本版狀態 | 驗證與界線 |
|---|---|---|
| 配對使用者 | 新碼預設獨立 usr_ 身分，管理端可明確指定 | 未登入配對不能指定其他帳號 |
| 平台筆記存取 | 使用者＋原始建立裝置隔離 | 列表、搜尋、直接ID、修改、刪除、匯出與Agent查詢均驗證 |
| 舊部署資料 | 原AES身分、金鑰、token、session與筆記保留 | schema1升至2；同poc-user舊裝置也各自隔離 |
| 舊筆記快照 | 啟動隔離可辨識的跨裝置／已刪除筆記快照 | requests/actions/history；停用舊自建筆記待執行動作 |
| 手機記事本建立 | notes.create_native 交給APK | 只交接，不能宣稱外部App已保存 |
| 手機記事本查詢／更新 | 明確不支援通用操作 | 各廠牌沒有共通API；不拿自建筆記冒充 |
| 平台備忘錄 | 明確選用後新增、查詢、修改、刪除 | 不再自動以平台替代手機記事本 |
| 原生錄音音檔 | 完整audio/mp4／.m4a接既有command音訊API | raw body；不需STT即時串流 |
| 多輪對話／日曆預設／倒數 | 保留v5 | 後端歷史有界、同裝置、狀態真實；仍需本地模型品質驗收 |
| JSON除錯事件 | 保留v4 | 預設不輸出token、Cookie、音訊或完整對話 |
| 目標手機／STT／LLM | 尚未實機驗收 | mock整合不代替真實服務／外部App結果 |

## 已執行驗證

完整98項後端測試通過。新增／調整回歸涵蓋：

- 不同配對碼產生不同使用者；管理端明確使用者欄位須通過bootstrap驗證。
- 舊版同poc-user裝置的筆記列表、q搜尋、GET／PUT／DELETE、匯出與Agent查詢均不得跨裝置。
- requests、actions、jobs、source_job_id、conversations與bearer／cookie保持確切裝置邊界。
- schema1→2保留原金鑰、token、session與自己筆記，舊未用碼綁定獨立使用者。
- 可辨識的跨裝置歷史筆記快照隔離，舊自建筆記待執行動作停止。
- 手機記事本僅handed_off，不接受虛假completed，不自動平台備援；直接STT草稿匯出不先建平台筆記。
- 原生檔案錄音橋接格式有界，完整音檔仍交給既有STT流程。

本版沒有實際部署端、公開hostname、真實模型或目標手機驗收；以實際驗收更新紀錄後再宣稱完成。

另有本地整合：有效1184bytes／1秒.m4a，驗證raw audio/mp4 → mock STT multipart recording.m4a → Agent notes.create_native → handed_off，無平台副本，trace相符。不同使用者讀另一裝置job／request／action，以及筆記GET／PUT／DELETE均404；7種原生錄音bridge訊息通過嚴格Schema。固定檔與mock驗證不等於目標手機錄音或真實STT品質。

## 尚未完善

1. 預設記事本跨廠牌查詢／更新無共通介面，需要特定App正式整合。
2. 沒有帳號合併、跨裝置私密筆記共享或舊資料搬移UI；重新配對不自動繼承舊資料。
3. 先前已顯示／複製的資料無法收回。沒有來源ID的舊自由文字回覆或使用者轉貼內容無法可靠判定原始筆記歸屬；不宣稱已回溯消除所有外洩。
4. 外部電話／時鐘／記事本沒有共通最後保存證明，只回報真實opened／handed_off。
5. mTLS、應用層端對端加密、互動式Cloudflare Access、正式帳號管理與正式簽章發布未完成。

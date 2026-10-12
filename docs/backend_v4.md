# backend_v4 STT／Agent 除錯紀錄

日期：2026-10-12。本包是相對 backend_v3 的差異更新，配合 web_v5 顯示語音處理階段與追蹤資訊；Android APK 沒有本次修改。

## 可看到的資訊

後端使用 Python logging 輸出 JSON 事件至終端機，PyCharm 的 Run／Console 可以直接查看。預設 INFO 不開啟含完整 query string 的 Uvicorn access log。

紀錄涵蓋啟動、HTTP 接收與完成、音訊收到與建立工作、STT 開始／完成／失敗、指令轉錄就緒、聊天收到、Agent 開始／完成／失敗。內容包含可對照的 ID、狀態、音訊大小、文字長度、操作種類、耗時及安全錯誤碼；不印音訊、憑證或服務商原始錯誤內容。每秒輪詢的正常 HTTP 紀錄歸 DEBUG，避免 INFO 被輪詢淹沒。

HTTP 回應的 X-Request-ID 由後端產生。音訊的 trace_id 也保存於工作中；web_v5 以 source_job_id 連結已轉錄的同裝置指令工作，Agent 請求沿用該 pipeline trace。HTTP 本身各自有獨立 ID，與整段語音的 trace 並非相同用途。

## 設定與啟動

在既有 backend/.env 追加：

```dotenv
LOG_LEVEL=INFO
LOG_COMMAND_TEXT=false
```

INFO 已是預設值，更新後即有事件紀錄。若要在本機除錯時看到實際指令文字，可設定 LOG_COMMAND_TEXT=true；文字會有限長度且以 JSON 跳脫。此選項不會記錄配對碼、Authorization、Cookie 或模型服務原始內容。除錯完可再設回 false。

保存後停止並重新啟動後端；從 local-assistant/backend 執行：

```bash
python -m app.run
```

既有 LLM_BASE_URL／LLM_MODEL／STT_BASE_URL 等設定繼續沿用，沒有重新配置模型、轉錄服務或 cloudflared 的要求。來源包只提供更新的 .env.example，不覆蓋你的 .env。

## 如何判斷停在哪裡

常用事件名稱可直接在 Console 搜尋：

| 事件 | 意義 |
|---|---|
| backend.ready | 後端啟動完成 |
| audio.received／audio.accepted | 音訊請求進入／檢查完成並建立工作 |
| stt.started／stt.completed／stt.failed | 轉錄開始／完成／失敗 |
| command.transcribed | 指令文字已就緒，等待前端交給 Agent |
| chat.received | 已建立或找到該次指令請求 |
| agent.started／agent.completed／agent.failed | 規劃開始／完成／失敗 |
| chat.replayed | 已有結果的同一指令重送，沿用原結果 |
| http.rejected／http.failed | 請求拒絕或安全的內部錯誤紀錄 |

例如下列事件只是格式示例，ID 與時間會由你的服務產生：

```json
{"event":"stt.started","trace_id":"http_00000000000000000000000000000000","job_id":"job_00000000000000000000000000000000","bytes":42000,"content_type":"audio/webm"}
{"event":"agent.completed","trace_id":"http_00000000000000000000000000000000","request_id":"req_00000000000000000000000000000000","plan_kind":"tool","kind":"alarm.create","state":"awaiting_device","duration_ms":850}
```

| 畫面／終端機狀態 | 代表的階段 |
|---|---|
| 收聽中，沒有後端音訊事件 | 音訊還在手機，尚未上傳 |
| 畫面上傳中，後端 HTTP／音訊事件 | 後端已開始接收請求；留意狀態碼與大小 |
| 已回 job ID，狀態 queued | 音訊工作已建立，尚不能宣稱已開始轉錄 |
| STT 開始事件／job transcribing | 正在呼叫 .env 指定的轉錄服務 |
| STT 完成／job transcribed | 已得到文字，下一步由前端送 Agent |
| Agent 開始事件 | 後端收到指令，開始規劃 |
| Agent 完成事件 | 已得到規劃與結果／待手機操作，不代表外部 App 操作已完成 |
| 失敗事件 | 用 trace ID、job／request ID 和錯誤碼找對應階段 |

如果 STT 已完成卻沒有收到 /chat，先查網頁 Console／Network 與該次語音是否被取消或切到背景；若有 Agent 開始但遲遲未完成，查本地模型服務與 timeout。請求送出逾時不代表後端一定沒收到，不能用逾時訊息自動重做手機操作。

## 相容性與驗證

source_job_id 是選填欄位；舊文字用戶端仍可使用既有 API。提供此欄位時，後端必須驗證工作屬於同裝置，且為就緒的語音指令；不可任意引用其他裝置工作。追蹤資訊不改變配對、原生確認或執行憑證的授權要求。

本版不新增資料表遷移，不將錄音寫入除錯檔案，也不建立遠端分析服務。7 項新增觀測／整合測試與全部 75 項後端測試通過。實際 STT／模型、公開網域與手機仍需目標設備驗收；完整測試結果記錄於 backend/STATUS.md。

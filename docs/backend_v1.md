# backend_v1：介接與功能紀錄

## 系統責任

本版本交付 Python 中樞；Pi 上提供 API、個人上下文、加密筆記與操作狀態。自有模型主機提供 OpenAI 相容聊天端點，可選擇另外提供語音轉錄端點。

網頁負責互動介面；APK 負責手機能力。三段共享 `contracts/` 中的操作與結果格式。

## 已提供 API

| 路由 | 用途 | 呼叫者 |
|---|---|---|
| `GET /health` | 存活檢查，不呼叫模型 | 本機／Tunnel 檢查 |
| `POST /v1/auth/pairing-codes` | 產生短效一次性配對碼 | 管理端，使用 `X-Bootstrap-Token` |
| `POST /v1/auth/pair` | 以配對碼與裝置標籤取得裝置 token | 首次配對的裝置 |
| `POST /v1/auth/session` | 裝置 bearer token 換取網頁 session cookie | App／配對流程 |
| `POST /v1/chat` | 提交文字，產生回答、澄清或待確認操作 | 已驗證的使用者 |
| `POST /v1/actions/{id}/confirm` | APK 原生確認指定操作，取得短效 execution token | 裝置 bearer token |
| `POST /v1/actions/{id}/result` | 回傳實際狀態與資料 | 執行操作的 APK |
| `POST /v1/actions/{id}/cancel` | 尚未領取執行 token 前取消操作 | 已驗證的使用者 |
| `POST /v1/requests/{request_id}/select-contact` | 同名候選人中選定一位 | 已驗證的使用者 |
| `/v1/notes` | 筆記列表與新增 | 已驗證的使用者 |
| `/v1/notes/{id}` | 筆記讀取／修改／刪除 | 已驗證的使用者 |
| `POST /v1/audio` | 建立轉錄工作 | 已驗證的使用者 |
| `GET /v1/audio/{id}` | 取得工作狀態與轉錄整理結果 | 工作所屬使用者 |

請求與欄位由 `backend/app/schemas.py` 及合約定義。開發時可設 `ENABLE_API_DOCS=true` 查看實際 API Schema；手機公開測試環境預設關閉。

## 操作流程

1. 裝置以配對碼取得 token。
2. 使用者提交文字與時區；後端使用自己的當前時間，呼叫設定的本地模型。
3. 後端驗證操作白名單與欄位，建立唯一 action ID。
4. 使用者確認；後端給短效執行 token。
5. APK 根據合約呼叫手機 API。
6. APK 回傳 `execution_token`、`state` 與 `result`；中樞記錄實際結果。

請求使用 `idempotency_key`，以便網路重試時取回既有請求。操作執行與回報使用 action ID；手機新增日曆等動作仍需在 APK 層處理重複點擊與中斷後恢復。

聊天請求範例：

```json
{
  "text": "幫我明天早上七點設定起床鬧鐘",
  "timezone": "Asia/Taipei",
  "idempotency_key": "demo-alarm-001"
}
```

操作確認不需要 request body。原生 APK 領到 token 後，回報格式如下；此例代表開啟畫面，不宣稱通話已接通：

```json
{
  "execution_token": "REPLACE_WITH_RETURNED_EXECUTION_TOKEN",
  "state": "opened",
  "result": {}
}
```

聯絡人搜尋結果由 APK 回傳，零筆需詢問使用者，一筆可產生後續撥號操作，多筆則由使用者選定候選 ID。電話號碼不是由 LLM 自行猜測。

以下狀態的語意必須分開：

| 狀態 | 可以宣稱的結果 |
|---|---|
| `completed` | 可驗證的操作確實完成，例如自己的筆記已寫入 |
| `opened` | 原生介面已開啟，例如帶入號碼的撥號畫面 |
| `handed_off` | 已交給另一個 App；後端未取得最終完成證據 |

此外支援 `cancelled`、`permission_denied`、`unsupported`、`failed`，用於如實呈現取消、拒絕權限、未支援操作與錯誤。

`opened`／`handed_off` 不能由文字回覆升級成「電話已接通」「鬧鐘已確定建立」或「日曆已保存」。

## 錄音轉筆記

`POST /v1/audio` 接收 **原始音訊 body**，不是瀏覽器 `multipart/form-data`。上傳時設定實際音訊的 Content-Type；支援 `audio/webm`、`audio/wav`、`audio/x-wav`、`audio/mpeg`、`audio/mp4`、`audio/ogg`、`audio/aac`、`audio/flac`。後端依 MIME 類型建立固定檔名，不使用用戶提供的檔名或路徑。

下列是 Linux／macOS 的 bearer 呼叫範例；裝置 token 從配對 API 取得，輸入時不回顯：

```bash
read -rsp "Device token: " DEVICE_TOKEN
curl --request POST "https://assistant.example.com/v1/audio" \
  --header "Authorization: Bearer ${DEVICE_TOKEN}" \
  --header "Content-Type: audio/wav" \
  --data-binary @recording.wav
unset DEVICE_TOKEN
```

改成你的網域，並先準備 `recording.wav`。指令只示範 API 格式；不在這裡保存 token。

取得 job ID 後用 `GET /v1/audio/{id}` 查詢。狀態會依流程包含 `queued`、`transcribing`、`summarizing`、`ready`；若轉錄成功但摘要失敗，會呈現 `transcribed`，仍能查看逐字稿。錯誤／重啟中斷分別為 `failed`／`interrupted`。

原始音訊只在處理程序記憶體中保留；逐字稿與筆記草稿加密保存。工作不是持久任務佇列，處理時重啟無法恢復原始錄音，使用者需重新上傳。未設定 `STT_BASE_URL` 時回傳功能未啟用（503），不會自動上傳第三方轉錄服務。

## 模型配置與本地邊界

- `.env` 控制 API 根位址與模型名稱。
- `LLM_OUTPUT_MODE` 可依服務使用 JSON object、JSON Schema 或普通輸出；後端仍檢查輸出內容。
- 服務應在使用者掌控的設備。私人位址驗證是防呆，不能證明某台主機的所有權或其內部分流。
- 除同機 loopback，使用 HTTPS 並驗證 CA；不配置 `verify=false`。
- 語音轉錄服務也是同一個邊界；若用第三方雲端 STT，錄音會離開私人設備，不符合本專案設定的 AI 中樞主張。
- 模型／STT 發生錯誤時回傳失敗，不自行改用雲端模型。

本版預設所有配對裝置共用 `DEFAULT_USER_ID` 的同一組筆記；操作與請求綁定原始裝置。這適合一位使用者的多裝置 PoC，不是多人獨立帳號入口。

本版本不提供模型下載、GPU 驅動或 STT 模型安裝。這些設備與服務可以獨立更換，API 與手機合約維持一致。

## 保存與加密

敏感 payload 在寫入 SQLite 前加密；API 需要使用時才於中樞記憶體中解密。這保護的是靜態保存內容；操作 ID、狀態等非敏感 metadata 可能仍為可讀欄位，完整資料庫磁碟加密另行處理。

`DATA_DIR/data.key` 首次建立 32-byte 金鑰，資料庫為 `DATA_DIR/assistant.sqlite3`。預設以檔案權限保護同一資料目錄中的兩個獨立檔案；自行備份時分開保管。舊資料庫存在而金鑰遺失時，不重新產生金鑰覆蓋。

模型推論時需處理明文內容，故應管理設備登入、檔案權限與金鑰。`.env`、runtime、金鑰及錄音不應加入 ZIP 或公開原始碼。

## Cloudflare 連線

用戶使用你指定的 `https://sub.domain`。Cloudflare Tunnel 將流量帶回 Pi 的 `127.0.0.1:8000`。

這兩段在網路上加密，但在 Cloudflare edge 會終止 HTTPS。LLM／個人記憶留在私人設備與「所有傳輸內容只由兩端解密」是不同主張；本部署採前者，並明確記錄中間的 TLS termination。

## 版本與 ZIP 規則

第一版 `backend_v1.zip` 包含完整 backend 與本版關聯文件。此後以 `backend_v2.zip` 等命名，僅放相對上一版更動的檔案；各子專案維護自己的數字版本。

首次封裝，在 `local-assistant` 根目錄執行：

```bash
python scripts/package_updates.py --component backend --version 1 --output ../backend_v1.zip
```

後續更新：

若取得的是本次提供的 ZIP，解壓後的根目錄已有 `PACKAGE_MANIFEST.json`。在覆蓋下一版之前，先保存它作為基準；在 `local-assistant/` 內執行：

```bash
cp PACKAGE_MANIFEST.json ../backend_v1.manifest.json
```

Windows PowerShell 對應為 `Copy-Item PACKAGE_MANIFEST.json ../backend_v1.manifest.json`。由本工具自行封裝時，旁邊會直接產生這個獨立 manifest。

```bash
python scripts/package_updates.py --component backend --version 2 --baseline ../backend_v1.manifest.json --output ../backend_v2.zip
```

工具同時寫出 ZIP 與獨立 `.manifest.json`。每個 manifest 保存目前整個子專案 snapshot 的 SHA-256，`included_paths` 是本次包含的路徑，`deleted_paths` 是新版不再提供的路徑。

ZIP 保留 `local-assistant/` 根目錄；新的檔案直接覆蓋相同路徑。工具只產生檔案，不部署、不刪除既有系統檔案、不更新服務。SHA-256 用於核對內容與變更，不是發布者數字簽章。

## 本版本驗收

- 不提供管理憑證的請求無法生成配對碼。
- 未配對裝置無法查閱筆記或執行操作。
- LLM 使用 `.env` 指定的 OpenAI 相容服務。
- 機密筆記不以原文儲存在 SQLite payload。
- 同一 idempotency key 不重複建立操作。
- 過期／錯誤的 execution token 不接受結果。
- 未配置 STT 時清楚回報未啟用。
- 手機動作的交接／完成狀態有區別。
- ZIP 不包含 `.env`、runtime、私鑰或模型資料。

實際模型、Tunnel 網域、Android APK 和各手機預設 App 是下一段驗收；本版的程式測試不能替代這些實機結果。

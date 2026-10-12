# Python 本地中樞 backend_v6

Python／FastAPI 中樞使用你在 `.env` 配置的 OpenAI 相容本地 LLM 與 STT，負責理解指令、保存加密對話、簽派手機操作及驗證實際結果。網站由同一個服務提供；使用你已配置的 cloudflared，不需要改用專案 Tunnel 範例。

v6 是 backend_v5 的差異更新，搭配 web_v7／android_v5。修正共用 PoC 身分導致的平台筆記跨裝置可見，並將日常筆記改為交接手機自己的記事本 App。APK 原生錄成完整音訊檔後上傳，後端仍使用原有檔案轉錄 API。

## 安裝與啟動

ZIP 保留 `local-assistant/` 根目錄；解壓到現有 local-assistant 的上一層，讓 backend、web、android 並列。來源差異包需依序覆蓋；本版不包含未更新的舊檔。

需要 Python 3.11 以上。首次安裝在 local-assistant/backend 執行：

```bash
python -m venv .venv
```

Windows PowerShell：

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
Copy-Item .env.example .env
.\.venv\Scripts\python.exe -c "import secrets; print(secrets.token_urlsafe(48))"
```

Linux／macOS：

```bash
source .venv/bin/activate
python -m pip install -r requirements.txt
cp .env.example .env
python -c "import secrets; print(secrets.token_urlsafe(48))"
```

將產生的隨機值填入 .env 的 ADMIN_BOOTSTRAP_TOKEN。既有部署保留原 .env，不用範例覆蓋配置。

工作目錄設為 local-assistant/backend，以目前 Python 環境啟動：

```bash
python -m app.run
```

PyCharm 的 Run Configuration 選 **Module name：app.run**，Working directory 指向實際 local-assistant/backend，Interpreter 選已安裝 requirements 的環境。不必輸入完整專案路徑；直接執行深層 app/run.py 可能因匯入路徑不同而失敗。

後端只監聽 127.0.0.1:8000，埠號可用 PORT 設定。既有 cloudflared 的該 hostname 指向同機此服務；網頁、/health、/v1/* 需一起到達同一後端。

## .env 配置

完整欄位見 .env.example。主要設定：

| 設定 | 用途 |
|---|---|
| LLM_BASE_URL／LLM_MODEL／LLM_API_KEY | OpenAI 相容服務根網址、實際模型名稱與該服務憑證 |
| LLM_OUTPUT_MODE | 模型支援的 json_object、json_schema 或 none |
| LLM_CA_BUNDLE／LLM_ALLOW_NONLOCAL | 私人 CA；預設限制模型端點為本地／私人服務 |
| STT_BASE_URL／STT_MODEL／STT_API_KEY | 你已提供的 OpenAI 相容音檔轉錄服務 |
| STT_CA_BUNDLE／STT_ALLOW_NONLOCAL | STT 憑證與端點限制 |
| PUBLIC_BASE_URL | 實際 HTTPS origin，例如 https://2026-asus-ugen.aphelion.tw |
| WEB_DIR | 預設 ../web；相對路徑以 backend 為基準 |
| DATA_DIR | SQLite／金鑰所在目錄，預設 runtime |
| TIMEZONE | 預設 Asia/Taipei |
| ADMIN_BOOTSTRAP_TOKEN | 管理端產生配對碼，至少 32 字元；不交給手機或前端 |
| ACTION_LEASE_SECONDS | 建議 600 秒，讓手機確認與授權有足夠時間 |
| MAX_AUDIO_BYTES | 單段音訊上限，預設 10 MiB |
| LOG_LEVEL／LOG_COMMAND_TEXT | 預設 INFO；預設不輸出指令文字 |
| CONVERSATION_MAX_MESSAGES／CONVERSATION_MAX_CHARS | 預設 12 則歷史訊息／16000 字元 |
| DEFAULT_USER_ID | 僅相容舊配置；新配對不再使用這個共用身分 |

同機模型可使用 http://127.0.0.1:11434/v1；跨機模型／STT 使用可驗證的 HTTPS。私人 IP 本身不代表加密，不略過 TLS 驗證。模型名稱只是配置，不由這份專案自動下載。

## 配對與筆記隔離

啟動後，在另一個終端機、相同 backend 目錄與 Python 環境執行：

```bash
python examples/create_pairing_code.py
```

每次產生的碼短效且只能使用一次，預設綁定由後端產生的獨立使用者。Chrome 與 APK 需使用不同碼；已在 Chrome 使用的碼即使未過期也不能給 APK 重用。裝置名稱不決定帳號，未登入的 /pair 不能自行選擇他人的使用者。

**v6 修正舊版共用 poc-user 與只依 user_id 查筆記的授權錯誤。** 所有平台筆記存取及由筆記衍生的手機動作均需符合目前使用者與原始建立裝置。既有裝置憑證保留，可讀自己的舊筆記；資料庫內容、原本加密身分與金鑰保留，不把舊資料全部分配給新裝置。

重新配對會產生新的裝置，不能自動繼承舊筆記。管理端即使明確把多個裝置加入同一使用者，私人筆記仍依裝置隔離。本版沒有跨裝置共享、資料搬移或帳號合併介面。

啟動自動升級 schema，為舊未兌換配對碼加入獨立使用者。已兌換或過期碼仍無效。曾經顯示／被複製的資料無法透過修正收回；不能由目前阻擋測試推論過去未被讀取。細節見 docs/backend_v6.md。

管理者若有明確需求，可用 create_pairing_code.py --user-id 指定既有使用者，但私人筆記仍鎖定建立裝置。啟動也隔離能辨識來源ID的跨裝置／已刪除筆記快照，停止舊自建筆記待執行操作；沒有來源ID的歷史自由文字不能可靠歸屬，不宣稱已回溯消除所有資料暴露。

## 日常功能

- 文字與語音可共用加密的多輪上下文，後端只採自己已驗證的歷史；最新輸入與原生確認仍是本次操作依據。
- 通訊錄、撥號、定點鬧鐘、倒數計時器、日曆由已配對 APK 執行。日曆預設 30 分鐘、提前 10 分鐘提醒，仍需要足夠開始日期與時間。
- 日常筆記預設交給手機記事本：notes.create_native 開啟支援的記事本／文字分享選擇器，使用者在該 App 確認保存。handed_off 不代表已儲存。
- 不再以 APK 自建加密筆記區冒充手機預設記事本，不默默建立平台副本。純瀏覽器或舊 APK 缺少能力時清楚回報；平台備忘錄可在「其他工具」明確選用。
- 所有廠牌記事本沒有通用的搜尋／讀取／更新介面。手機記事本查詢或更新會回報限制；平台筆記在明確選用平台後仍可查詢、修改與刪除。
- POST /v1/audio?purpose=command 接完整 raw 音檔，僅轉錄、不先建立筆記，再送 /v1/chat。purpose=note 是原本的錄音整理模式。外層不是 multipart；後端再依 STT 協定傳送音檔。

舊動作格式的相容處理仍保留，但新 APK 不宣告自建筆記保存／搜尋／更新能力。舊 APK 自建筆記資料保留，不自動遷移到其他記事本。

## 除錯與驗證

/health 不會呼叫模型；先確認本機 http://127.0.0.1:8000/health，再測公開 HTTPS hostname。

PyCharm Console／終端機預設顯示 INFO JSON 事件：audio.received／audio.accepted、stt.started／stt.completed／stt.failed、chat.received、agent.started／agent.completed／agent.failed。每個 HTTP 回覆有 X-Request-ID；音訊工作與聊天可透過 trace／job／request ID 對照。排隊不等於 STT 已開始。

預設不輸出配對碼、token、Cookie、音訊或模型服務原始錯誤；LOG_COMMAND_TEXT=true 才會在本機終端機輸出最多 200 字元的當句指令。正常 GET 輪詢事件是 DEBUG。

```bash
python -m unittest discover -s tests -v
```

最終測試與實際設備界線見 STATUS.md；本地 mock 模型通過不代表目標手機、記事本或真實 STT／LLM 已完成驗收。

本地整合另以有效1秒.m4a檔驗證 raw audio/mp4 → STT multipart recording.m4a → Agent notes.create_native → handed_off，沒有平台副本，trace ID可接續；跨裝置音訊工作／指令／動作／筆記操作遭404。這是固定音檔與mock服務整合，不是目標手機實錄或真實模型測試。

## 更新與資料保護

差異包不覆蓋 .env、runtime、模型、金鑰或現有 cloudflared。停止後端後備份資料庫與原始 data.key，再覆蓋來源並重啟；金鑰遺失不能重新產生來恢復舊密文。SQLite 備份需包含一致的 WAL 狀態。

敏感資料使用 AES-256-GCM 保存，metadata 並非全部加密。網站／手機到 Cloudflare 及 Tunnel 有傳輸加密，但 HTTPS 在 Cloudflare edge 終止，Cloudflare 可處理明文；本版沒有應用層端對端加密或 mTLS。系統記事本與日曆由該 App／帳號依原設定保存與同步，不屬於中樞 AES 範圍。

各包 manifest 位於子專案 PACKAGE_MANIFEST.json，若列出 deleted_paths 需核對後手動處理；解壓不會自動刪除舊來源。歷史版本詳見 CHANGELOG.md 與 docs/backend_v1.md 至 docs/backend_v6.md。

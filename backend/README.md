# Python 本地中樞 backend_v2

本版本先交付三段架構中的 **Python 中樞**。它透過 OpenAI 相容 API 呼叫你自己的模型，建立結構化操作、保存加密筆記，以及接收手機端的實際操作結果。

網頁與 APK 會接相同 API，但 **本 ZIP 尚未包含可使用的網頁或 APK**。日曆／電話服務維持原本的同步行為；保護範圍是 LLM 的理解、上下文、記憶與決策鏈。

v2 是套用在 backend_v1 上的差異更新，加入網頁筆記按鈕的原生操作 API，與 web_v1／android_v1 一起使用。解壓 web_v1 到相同 `local-assistant/` 後重新啟動後端，就能由原本 Tunnel 網域開啟首頁。

## 1. 目錄

ZIP 內保留 `local-assistant/` 根目錄，子路徑如下：

| 路徑 | 用途 |
| --- | --- |
| `backend/` | Python API、Agent 與加密儲存 |
| `contracts/` | 共用操作格式 |
| `deploy/pi/` | Cloudflare Tunnel 與啟動範例 |
| `docs/backend_v1.md` | 版本功能與驗收 |
| `scripts/` | 共用協定匯出與差異封裝 |

解壓縮後保留 `local-assistant/` 根目錄，不要把每個檔案拆到不同位置。

## 2. 安裝與設定

環境：Python 3.11 或以上。Pi 使用 64 位元 Linux；本 API 本身不需要 GPU。

Linux／macOS，在 `local-assistant/backend` 中執行：

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
cp .env.example .env
python -c "import secrets; print(secrets.token_urlsafe(48))"
```

Windows PowerShell：

```powershell
py -3 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
Copy-Item .env.example .env
.\.venv\Scripts\python.exe -c "import secrets; print(secrets.token_urlsafe(48))"
```

將最後產生的隨機值填入 `.env` 的 `ADMIN_BOOTSTRAP_TOKEN`，並將 `.env` 留在本機。Linux 建議執行 `chmod 600 .env`。

主要設定如下；完整欄位以 `.env.example` 為準：

| 變數 | 用途 |
|---|---|
| `LLM_BASE_URL` | OpenAI 相容服務的 API 根位址，通常包含 `/v1` |
| `LLM_MODEL` | 服務端實際可用的模型名稱，不由本程式下載模型 |
| `LLM_API_KEY` | 該服務要求的 API key；本地無驗證服務可用其接受的占位值 |
| `LLM_OUTPUT_MODE` | `json_object`、`json_schema` 或 `none`；依模型服務支援選擇 |
| `LLM_CA_BUNDLE` | 自簽 CA／私人 CA 的 PEM 檔案路徑，驗證 HTTPS 憑證 |
| `LLM_ALLOW_NONLOCAL` | 預設 `false`，避免誤接公開遠端模型；放寬會改變資料邊界 |
| `STT_BASE_URL` | 選配 OpenAI 相容語音轉錄 API；空值代表錄音轉錄尚未啟用 |
| `STT_MODEL` | 轉錄服務提供的模型名稱 |
| `PUBLIC_BASE_URL` | 手機使用的完整 HTTPS 網址，例如 `https://assistant.example.com` |
| `ADMIN_BOOTSTRAP_TOKEN` | 產生一次性配對碼的管理憑證，至少 32 字元，不交給一般使用者 |
| `DATA_DIR` | SQLite 與執行資料目錄；相對路徑以 `backend/` 為基準 |
| `SESSION_TTL_SECONDS` | 網頁 session 有效時間 |
| `ACTION_TTL_SECONDS` | 尚未執行操作的有效時間 |
| `ACTION_LEASE_SECONDS` | 確認後執行憑證的有效時間 |
| `ENABLE_API_DOCS` | 開啟 `/docs` 本機路由列表及 `/openapi.json`；不使用外部 CDN 或互動 Swagger |

模型端必須已啟動並具備你填寫的模型。`qwen3:4b` 等名稱只是設定範例，並非本 ZIP 已內附的模型。

中樞到模型若為 **同機 loopback**，可使用 `http://127.0.0.1:11434/v1`。若模型在另一台私人主機，使用可驗證 CA 的 HTTPS；不以略過憑證驗證處理問題。私人 IP 位址也不代表加密。

## 3. 啟動

Linux／macOS：

```bash
python -m app.run
```

Windows PowerShell：

```powershell
.\.venv\Scripts\python.exe -m app.run
```

API 只綁定 `127.0.0.1:8000`；可以在 `.env` 設定 `PORT`。手機不直接連這個 loopback，而是連到同機 `cloudflared` 對外提供的 HTTPS 網域。

可先在 Pi 本機檢查存活狀態；這個檢查不會呼叫模型：

```bash
curl http://127.0.0.1:8000/health
```

## 4. Cloudflare Tunnel

先在 Cloudflare 建立 Tunnel 與 DNS 指向；將 `deploy/pi/cloudflared.example.yml` 複製到實際設定位置，填寫：

- Tunnel UUID。
- **實際存於該 Pi 的** credentials JSON 路徑。
- `assistant.example.com` 換成你的 `sub.domain`。

範例 origin 是 `http://127.0.0.1:8000`，只在 cloudflared 與 API **同一台 Pi** 的 loopback 使用。網頁與 API 之後共用這個 HTTPS origin；不需要為網頁與 `/v1` 各開一個網域。

手機到 Cloudflare 使用 HTTPS，Cloudflare 到 cloudflared 的 Tunnel 另外加密。**HTTPS 在 Cloudflare edge 終止，因此 Cloudflare 可處理解密後的請求內容。** 這個配置能避免外部網路明文傳輸，不能稱為「只有手機與 Pi 能解密」；LLM 推論與加密記憶仍在你的私人設備執行和保存。

第一版以 HTTPS 加裝置 token／安全 session 驗證，不實作用戶端憑證 mTLS。這符合目前「避免明文 API 傳輸」的要求；若之後加 mTLS，另以獨立版本交付。

## 5. 配對與測試

配對順序：管理端產生短效一次性碼 → 裝置兌換碼取得 token → 原生 APK 使用 bearer token；網頁則換成 `HttpOnly`、`Secure`、`SameSite=Strict` 的 session cookie。

後端啟動後，在同一台 Pi 的另一個終端機、相同 backend 目錄及 Python 環境執行：

```bash
python examples/create_pairing_code.py
```

將印出的短效碼填入手機 APK，網站網址則填 `.env` 的 `PUBLIC_BASE_URL`。一般瀏覽器也可以在網頁登入介面輸入此碼；兩者需分別產生不同碼。此工具不列印初始化管理憑證。

`ADMIN_BOOTSTRAP_TOKEN` 只給管理端，不能放入 JavaScript、APK 或分享給測試者。裝置 token 不應記錄在畫面截圖或日誌中。

正式操作以 **後端產生的 action ID** 為識別：確認 → 領取短效執行憑證 → 手機執行 → 回報結果。撥號畫面「已開啟」不等於「電話已接通」；第三方日曆新增畫面「已交接」也不等於「已儲存」。

詳細路由與驗收見 `docs/backend_v1.md`，此次相容更新見 `docs/backend_v2.md`。API／Agent 測試以本地 mock 模型執行，通過測試不代表你的實際模型與手機已完成整合。

API 啟動後，在另一個終端機、相同 backend 目錄及虛擬環境中執行：

```bash
python examples/poc_client.py --text "幫我記下明天要帶轉接頭"
```

此程式讀取 `.env` 的管理設定，建立一個暫時裝置，再呼叫你配置的實際模型；最後撤銷測試裝置，不列印憑證。筆記仍保存在同一個 PoC 使用者下。測試 Tunnel 時加入 `--base-url https://你的子網域`。電話或鬧鐘只會建立待執行操作，CLI 不回報模擬成功。

離線驗證可使用 `python -m unittest discover -s tests -v`。`requirements-tested.txt` 記錄本次 Python 3.12 測試環境的套件版本；它不是 Pi 的硬體／驅動安裝清單。

## 6. 長期執行與更新

`deploy/pi/local-assistant.service` 提供 systemd 範例。其工作目錄為 `/opt/local-assistant/backend`，使用專用 `localassistant` 帳號；資料路徑請設定為 `/var/lib/local-assistant`，確保該帳號有權讀寫。啟用前先完成虛擬環境與 `.env` 設定。

更新 ZIP 時，只覆蓋原始碼與文件；`.env`、runtime 資料、模型與金鑰不在更新 ZIP 中。每次先查看 `CHANGELOG.md`、`STATUS.md` 以及 `PACKAGE_MANIFEST.json`。若有 `deleted_paths`，核對後手動移除列出的舊原始碼；封裝工具不自動刪除檔案。

從 v2 封裝工具起，每個子專案的 manifest 放在各自目錄，例如 `backend/PACKAGE_MANIFEST.json`、`web/PACKAGE_MANIFEST.json`、`android/PACKAGE_MANIFEST.json`，避免三包互相覆蓋版本資訊。初版根目錄 manifest 保留作為舊版紀錄。

手機權限與日曆選擇可能超過原本 120 秒執行期限，建議在既有 `.env` 手動設定 `ACTION_LEASE_SECONDS=600`。更新包不會替你覆蓋 `.env`；超時後仍須查看手機與操作狀態，不自動重做。

首次啟動在 `DATA_DIR` 建立 `assistant.sqlite3` 及 `data.key`；敏感內容使用 AES-256-GCM 加密。金鑰是獨立檔案，預設仍與資料庫在同一資料目錄，並非硬體隔離保管。

**加密金鑰與加密資料需分開備份。** 停止 API 後再備份資料庫與原始 `data.key`，或使用 SQLite 一致性備份流程，避免漏掉 WAL 中的變更。遺失金鑰就無法解密既有筆記；存在資料庫卻缺少金鑰時，程式會停止，不能用重新產生金鑰恢復舊資料。

## 7. 版本記錄

- `CHANGELOG.md`：每版新增與修改。
- `STATUS.md`：功能完成度、已知限制與未完成項目。
- `docs/backend_v1.md`：本次對外介接與展示範圍。

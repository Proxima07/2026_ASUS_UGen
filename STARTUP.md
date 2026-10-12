# local-assistant 啟動指南

對應版本：backend_v2（先有 backend_v1）、web_v1、android_v1。更新日期：2026-10-12。

## 需要啟動哪些部分

| 部分 | 執行位置 | 如何啟動 |
|---|---|---|
| 本地 LLM | 你的模型主機 | 啟動既有 OpenAI 相容模型服務；本專案不下載或自動啟動模型 |
| 本地 STT | 你的模型主機，選配 | 啟動 OpenAI 相容語音轉錄服務；要展示錄音轉筆記才需配置 |
| Python API 與網頁 | 同一台主機 | 在 backend 執行 `python -m app.run`；網頁由 API 一起提供 |
| Cloudflare Tunnel | 與 Python API 同機 | 保持 cloudflared connector 運作，將你的子網域指向 `http://127.0.0.1:8000` |
| Android APK | 手機 | 安裝測試 APK，輸入 HTTPS 網址與一次性碼 |

本版不用在 web 執行 npm install、npm run dev 或另開靜態伺服器。Android 原始碼也不用作為伺服器啟動。

## 1. 確認解壓位置

三個子專案並列於同一個 `local-assistant/`，不是各自多包一層 local-assistant。必要檔案如下：

| 路徑 | 用途 |
|---|---|
| `backend/app/run.py` | API 啟動入口 |
| `backend/.env.example` | 本地設定範例 |
| `web/index.html` | 網頁入口 |
| `android/releases/local-assistant-debug.apk` | 可直接安裝的 Debug APK |
| `contracts/` | 共用協定 |
| `.gitignore` | 本次新增的共用忽略規則 |

backend_v2 是 backend_v1 的差異更新；若只有 v2，不是完整後端。依序解壓 v1、覆蓋 v2，再解壓 web_v1、android_v1 到相同上層目錄。

## 2. 首次安裝 Python 依賴

使用 Python 3.11 以上。以下命令從 `local-assistant/` 根目錄開始，只選你的作業系統那一段。

### Windows PowerShell

```powershell
cd backend
py -3 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
.\.venv\Scripts\python.exe -c "import secrets; print(secrets.token_urlsafe(48))"
notepad .env
```

此方式直接使用虛擬環境的 Python，不需要修改 PowerShell 執行政策或執行 Activate.ps1。若 `py` 不存在但 `python --version` 顯示 3.11 以上，可將建立虛擬環境的一行改為 `python -m venv .venv`。

### Linux／Raspberry Pi／macOS

```bash
cd backend
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
if [ ! -f .env ]; then
  cp .env.example .env
fi
.venv/bin/python -c "import secrets; print(secrets.token_urlsafe(48))"
chmod 600 .env
nano .env
```

若 Debian／Raspberry Pi OS 顯示缺少 venv，先安裝系統的 `python3-venv` 套件再重試。依賴安裝需網路。已配置好的 `.env` 不會被以上複製步驟覆蓋。

## 3. 編輯 backend/.env

將剛剛產生的隨機值填入 `ADMIN_BOOTSTRAP_TOKEN`。模型名稱與 URL 需換成你已啟動服務的實際值；以下只有範例：

```dotenv
PUBLIC_BASE_URL=https://assistant.example.com
ADMIN_BOOTSTRAP_TOKEN=CHANGE_TO_YOUR_GENERATED_RANDOM_TOKEN

LLM_BASE_URL=http://127.0.0.1:11434/v1
LLM_MODEL=your-actual-local-model
LLM_API_KEY=local-unused
LLM_OUTPUT_MODE=json_object
LLM_ALLOW_NONLOCAL=false

WEB_DIR=../web
DATA_DIR=runtime
TIMEZONE=Asia/Taipei
PORT=8000
ACTION_LEASE_SECONDS=600

STT_BASE_URL=
```

`CHANGE_...` 及模型名稱是待替換的占位字；不能照原樣啟動。API key 依模型服務規則填寫。模型若不支援 JSON response format，將 `LLM_OUTPUT_MODE` 改為 `none`，並實測其能否產生正確結構化操作。

`PUBLIC_BASE_URL` 必須是實際 HTTPS 根網址，與 Tunnel、APK 一致。`WEB_DIR`、`DATA_DIR` 的相對路徑以 backend 為基準；不用移動 `.env` 到專案根目錄。

同機 loopback 模型允許 HTTP。模型在另一台私人主機時，使用 HTTPS 及可驗證憑證，必要時設定 `LLM_CA_BUNDLE`。若你使用的網址解析到公開 IP，需先確認它是你控制的服務，才設定 `LLM_ALLOW_NONLOCAL=true`；這個開關不會替遠端服務提供本地推論保證。

要啟用錄音轉錄，另外設定 `STT_BASE_URL`、`STT_MODEL`、`STT_API_KEY`，必要時設定 `STT_CA_BUNDLE`。STT 空白時其他功能仍可用，轉錄 API 會回報尚未配置。STT 也沒有雲端備援。

## 4. 啟動 API 與網頁

從 `local-assistant/backend/` 執行，終端保持開啟。

Windows PowerShell：

```powershell
.\.venv\Scripts\python.exe -m app.run
```

Linux／Raspberry Pi／macOS：

```bash
.venv/bin/python -m app.run
```

另開終端，在主機本機檢查：

Windows PowerShell：

```powershell
Invoke-RestMethod http://127.0.0.1:8000/health
```

Linux／macOS：

```bash
curl http://127.0.0.1:8000/health
```

預期回應包含 `status: ok`；這只確認 API 存活，不會測模型。正式網頁登入與麥克風請使用公開 HTTPS 網址。API 只綁定 127.0.0.1，不要在手機填這個位址。

啟動器的日誌較少，不一定顯示一般 Uvicorn 啟動橫幅；以 /health 判斷。程式啟動時才檢查 web/index.html，解壓或改變 WEB_DIR 後需重啟 API。

## 5. Cloudflare Tunnel

已有 Tunnel 的話，只需確保 connector 運作，為該子網域設定同一個 origin：

| 設定 | 範例 |
|---|---|
| 公開 hostname | `assistant.example.com` |
| Service type | `HTTP` |
| Service URL | `127.0.0.1:8000` |

整個 hostname 都轉到這個服務，包含 `/`、靜態資源與 `/v1/*`。cloudflared 必須和 API 同機；不要把網頁與 API 拆成兩個來源。

如果是 Cloudflare 後台管理的 Tunnel，依後台提供的作業系統安裝指令啟動 connector；已安裝成服務時保持該服務運作即可，不需再啟動第二份。

如果使用既有本地 YAML 設定，範例位於 `deploy/pi/cloudflared.example.yml`。把實際檔案與憑證放在自己的本機設定位置，填入 UUID、憑證路徑與 hostname；從專案根目錄可參考：

```bash
cloudflared tunnel --config /absolute/path/to/config.yml run YOUR_TUNNEL_UUID
```

將範例的絕對路徑與 UUID 換成你的值。兩種管理方式選既有的一種即可；Tunnel 的憑證／token 不加入 Git。

若採 Docker 跑 cloudflared，容器內的 127.0.0.1 指的是容器自身，不能直接套用同機原生程序的連線方式；本指南按 API 與 cloudflared 原生執行來說明。

現在用手機開啟你的 `https://assistant.example.com/`，應看到我們的配對頁。Cloudflare Tunnel 是分段 TLS，Cloudflare 可解密流量；本版沒有應用層端對端加密。

官方參考：[Tunnel 設定](https://developers.cloudflare.com/tunnel/get-started/)、[Routing](https://developers.cloudflare.com/tunnel/concepts/routing/)、[Tunnel tokens](https://developers.cloudflare.com/tunnel/reference/tunnel-tokens/)。

## 6. 配對瀏覽器或 APK

另開終端，進入 `local-assistant/backend/`。

Windows PowerShell：

```powershell
.\.venv\Scripts\python.exe examples/create_pairing_code.py
```

Linux／Raspberry Pi／macOS：

```bash
.venv/bin/python examples/create_pairing_code.py
```

管理憑證從 backend/.env 讀取；只把輸出的短效一次性碼填入前端。每個瀏覽器／APK 分別配對，使用過的碼不能重用。

安裝 `android/releases/local-assistant-debug.apk`；開啟後填入 HTTPS 根網址、裝置名稱與配對碼，按「配對並開啟助理」。在 APK 內的網頁提出指令，才可呼叫手機通訊錄、電話、鬧鐘、日曆及本機筆記。

普通瀏覽器可使用聊天、後端筆記及已配置的錄音轉錄；沒有 APK 原生橋接。APK 登入過期時，按上方「同步」更新 session，並重送已保存的結果。

## 7. 後續日常啟動與停止

首次依賴安裝與配對不必每次重做。日常依序確認：模型服務運作 → API 啟動 → cloudflared 運作 → 手機開 APK。

前景 API 以 Ctrl+C 正常停止；前景 cloudflared 也可 Ctrl+C，若它是背景系統服務則用對應服務管理方式。模型服務依你的部署方式停止。修改 backend/.env 後需重啟 API。

Pi 的常駐服務範例為 `deploy/pi/local-assistant.service`，需先改帳號、安裝路徑與 DATA_DIR。該範例指定 `Environment=PORT=8000`，會覆蓋 .env；自訂 PORT 時需一起調整。範例 DATA_DIR 應設為 `/var/lib/local-assistant`，對齊它的 ReadWritePaths。此指南先使用前景啟動驗證，不會替你安裝服務。

## 8. 常見排錯

| 現象 | 檢查位置 |
|---|---|
| 找不到 app 模組 | 是否在 backend 目錄執行，是否使用該虛擬環境的 Python |
| 啟動直接顯示 ValueError | .env 管理金鑰、HTTPS 根網址、模型 URL、CA 或其他設定是否合法 |
| /health 無法連線 | API 是否在執行，PORT 是否改過或與其他程序衝突 |
| /health 正常但網站 404 | web/index.html 是否與 backend 並列，WEB_DIR 是否正確；重啟 API |
| 網址 502 | Tunnel 是否能連到 API，service URL／port 是否一致 |
| 網址 1033 | cloudflared connector 是否已連線 |
| 配對失敗 | .env、APK、Tunnel 網址是否一致，配對碼是否過期或已用過 |
| 對話失敗但 /health 正常 | 模型服務是否啟動，模型名稱、API key、/v1 前綴及輸出模式是否符合服務 |
| 轉錄顯示未配置 | 另配置本地 STT；不是只填 LLM 就有語音轉錄 |
| 純瀏覽器沒有手機確認能力 | 在已配對的 APK 內開網頁提出指令 |

若將 PORT 改為其他值，Tunnel service URL、health 檢查與配對碼 CLI 都要一起改，例如配對 CLI 加上 `--base-url http://127.0.0.1:9000`。本版 /health 不代表真機、模型或轉錄端到端驗收通過。

## 9. Git 使用

`.gitignore` 位於 local-assistant 根目錄，同時涵蓋 backend、web、android。保留 .env.example、contracts JSON、Gradle wrapper JAR、README、版本文件與所有原始碼；忽略 APK／壓縮包等二進位交付物。

在 local-assistant 執行 `git status --short` 查看將提交的內容。若尚未建立倉庫，可先 `git init`，再查看狀態與加入所需原始碼。

`.gitignore` 不影響已經被 Git 追蹤的檔案。若確認 backend/.env 已被追蹤，可用 `git rm --cached -- backend/.env`；確認 backend/runtime 已被追蹤時，可用 `git rm -r --cached -- backend/runtime`。這兩個命令只移除 Git 索引，不刪本機檔案。

自訂 DATA_DIR 到 Git 倉庫內其他位置，需補上對應忽略路徑；倉庫外檔案不屬於該倉庫。*.pem 採保守忽略，若公共 CA 憑證需要版本管理，先確認只含公開憑證，再為那個檔案加精確例外。

加密資料庫與原始 data.key 留在本機；Git 忽略不是備份，已有資料不可隨意刪除金鑰。

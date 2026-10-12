"""Use the real configured API/model from a terminal; no simulated phone results."""
import argparse
import json
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import httpx
from app.config import Settings, validate_model_url


def main():
    parser = argparse.ArgumentParser(description="建立暫時測試裝置，呼叫本地中樞後撤銷該裝置")
    parser.add_argument("--base-url", default="http://127.0.0.1:8000", help="本機原站或你的 HTTPS Tunnel 網址")
    parser.add_argument("--text", default="幫我記下明天要帶轉接頭")
    args = parser.parse_args()
    settings = Settings.from_env()
    validate_model_url(args.base_url, allow_nonlocal=True)
    with httpx.Client(base_url=args.base_url.rstrip("/"), trust_env=False, follow_redirects=False, timeout=120) as client:
        token = None
        try:
            response = client.post("/v1/auth/pairing-codes", headers={"X-Bootstrap-Token": settings.admin_bootstrap_token})
            response.raise_for_status()
            code = response.json()["code"]
            response = client.post("/v1/auth/pair", json={"code": code, "label": "terminal-poc"})
            response.raise_for_status()
            token = response.json()["token"]
            client.headers["Authorization"] = "Bearer " + token
            response = client.post("/v1/chat", json={"text": args.text, "timezone": settings.timezone, "idempotency_key": uuid.uuid4().hex})
            response.raise_for_status()
            record = response.json()
            print(json.dumps(record, ensure_ascii=False, indent=2))
            if record.get("action_id"):
                print("這是待手機執行的操作；此 CLI 不呼叫手機、也不回報模擬成功。")
            if record.get("status") == "failed":
                return 1
        except (httpx.HTTPError, KeyError, ValueError):
            print("測試請求失敗；請檢查 API、配對設定與模型服務。憑證不會列印。", file=sys.stderr)
            return 1
        finally:
            if token:
                try:
                    client.post("/v1/auth/revoke-device")
                except httpx.HTTPError:
                    print("測試装置撤銷未完成，請檢查服務。", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

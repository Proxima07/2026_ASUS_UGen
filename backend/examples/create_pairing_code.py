"""Print only a short-lived pairing code, never the administrator credential."""
import argparse
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import httpx
from app.config import Settings, validate_model_url


def main():
    parser = argparse.ArgumentParser(description="產生手機／網頁的一次性配對碼")
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    parser.add_argument("--user-id", help="管理者明確指定既有使用者；未指定時每個配對碼建立獨立使用者")
    args = parser.parse_args()
    settings = Settings.from_env()
    validate_model_url(args.base_url, allow_nonlocal=True)
    try:
        with httpx.Client(trust_env=False, follow_redirects=False, timeout=15) as client:
            response = client.post(args.base_url.rstrip("/") + "/v1/auth/pairing-codes",
                headers={"X-Bootstrap-Token": settings.admin_bootstrap_token},
                json={"user_id": args.user_id} if args.user_id is not None else None)
            response.raise_for_status()
            data = response.json()
        print("一次性配對碼：", data["code"])
        print("有效至：", datetime.fromtimestamp(data["expires_at"]).astimezone().isoformat())
        print("在手機 APK 或網頁輸入此碼；使用一次後即失效。不要把 .env 或管理金鑰交給手機。")
        return 0
    except (httpx.HTTPError, ValueError, KeyError):
        print("配對碼建立失敗；請檢查 API 是否啟動及 .env 的管理設定。", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

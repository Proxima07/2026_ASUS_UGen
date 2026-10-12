"""Run a loopback origin suitable for a same-machine Cloudflare Tunnel."""
import uvicorn
from app.config import Settings

if __name__ == "__main__":
    settings = Settings.from_env()
    uvicorn.run("app.main:app", host="127.0.0.1", port=settings.port, workers=1,
                proxy_headers=False, access_log=False, log_level="warning")

"""Environment configuration. Never choose an implicit cloud model endpoint."""
from __future__ import annotations

import ipaddress
import os
import socket
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

from dotenv import dotenv_values

BACKEND_DIR = Path(__file__).resolve().parents[1]


def validate_model_url(url: str, allow_nonlocal: bool = False) -> None:
    parsed = urlsplit(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("模型網址必須是有效的 http/https API 前綴，例如 http://127.0.0.1:11434/v1")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("模型網址不能包含帳密、查詢字串或 fragment；金鑰請使用獨立設定")
    host = parsed.hostname
    try:
        addresses = [ipaddress.ip_address(host)]
    except ValueError:
        try:
            addresses = list({ipaddress.ip_address(item[4][0]) for item in socket.getaddrinfo(host, parsed.port or 443)})
        except OSError as exc:
            raise ValueError("無法解析模型主機名稱，請檢查本機 DNS 或設定") from exc
    loopback = bool(addresses) and all(a.is_loopback for a in addresses)
    if parsed.scheme == "http" and not loopback:
        raise ValueError("跨設備模型 API 必須使用 HTTPS；HTTP 只允許 loopback")
    private_networks = tuple(ipaddress.ip_network(n) for n in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"))
    private = bool(addresses) and all(a.is_loopback or any(a.version == n.version and a in n for n in private_networks) for a in addresses)
    if not private and not allow_nonlocal:
        raise ValueError("模型網址解析到公開網路；若確認是你控制的服務，需明確開啟 ALLOW_NONLOCAL。公開服務不自動代表本地推論")


@dataclass
class Settings:
    public_base_url: str = "https://assistant.example.com"
    admin_bootstrap_token: str = field(default="", repr=False)
    default_user_id: str = "poc-user"
    data_dir: Path = field(default_factory=lambda: BACKEND_DIR / "runtime")
    web_dir: Path = field(default_factory=lambda: BACKEND_DIR.parent / "web")
    llm_base_url: str = "http://127.0.0.1:11434/v1"
    llm_model: str = "your-local-model"
    llm_api_key: str = field(default="local-unused", repr=False)
    llm_output_mode: str = "json_object"
    llm_timeout_seconds: float = 90
    llm_max_tokens: int = 1024
    llm_temperature: float = 0
    llm_ca_bundle: str = ""
    llm_allow_nonlocal: bool = False
    stt_base_url: str = ""
    stt_model: str = "whisper-1"
    stt_api_key: str = field(default="", repr=False)
    stt_timeout_seconds: float = 120
    stt_ca_bundle: str = ""
    stt_allow_nonlocal: bool = False
    session_ttl_seconds: int = 3600
    action_ttl_seconds: int = 300
    action_lease_seconds: int = 120
    max_audio_bytes: int = 10 * 1024 * 1024
    max_text_chars: int = 8000
    max_audio_jobs: int = 2
    enable_api_docs: bool = False
    log_level: str = "INFO"
    log_command_text: bool = False
    conversation_max_messages: int = 12
    conversation_max_chars: int = 16000
    timezone: str = "Asia/Taipei"
    host: str = "127.0.0.1"
    port: int = 8000

    @classmethod
    def from_env(cls, env_file: Path | str | None = None) -> "Settings":
        values = {**dotenv_values(env_file or BACKEND_DIR / ".env"), **os.environ}
        def value(name: str, default):
            raw = values.get(name)
            return default if raw is None else raw
        def boolean(name: str, default: bool = False) -> bool:
            raw = str(value(name, str(default))).lower()
            if raw not in {"true", "false", "1", "0", "yes", "no"}:
                raise ValueError(f"{name} 必須是 true 或 false")
            return raw in {"true", "1", "yes"}
        def path(name: str, default: Path) -> Path:
            p = Path(str(value(name, str(default)))).expanduser()
            return p if p.is_absolute() else (BACKEND_DIR / p).resolve()
        settings = cls(
            public_base_url=str(value("PUBLIC_BASE_URL", cls.public_base_url)).rstrip("/"),
            admin_bootstrap_token=str(value("ADMIN_BOOTSTRAP_TOKEN", "")),
            default_user_id=str(value("DEFAULT_USER_ID", "poc-user")),
            data_dir=path("DATA_DIR", BACKEND_DIR / "runtime"),
            web_dir=path("WEB_DIR", BACKEND_DIR.parent / "web"),
            llm_base_url=str(value("LLM_BASE_URL", cls.llm_base_url)).rstrip("/"),
            llm_model=str(value("LLM_MODEL", cls.llm_model)),
            llm_api_key=str(value("LLM_API_KEY", "local-unused")),
            llm_output_mode=str(value("LLM_OUTPUT_MODE", "json_object")),
            llm_timeout_seconds=float(value("LLM_TIMEOUT_SECONDS", 90)),
            llm_max_tokens=int(value("LLM_MAX_TOKENS", 1024)),
            llm_temperature=float(value("LLM_TEMPERATURE", 0)),
            llm_ca_bundle=str(value("LLM_CA_BUNDLE", "")),
            llm_allow_nonlocal=boolean("LLM_ALLOW_NONLOCAL"),
            stt_base_url=str(value("STT_BASE_URL", "")).rstrip("/"),
            stt_model=str(value("STT_MODEL", "whisper-1")),
            stt_api_key=str(value("STT_API_KEY", "")),
            stt_timeout_seconds=float(value("STT_TIMEOUT_SECONDS", 120)),
            stt_ca_bundle=str(value("STT_CA_BUNDLE", "")),
            stt_allow_nonlocal=boolean("STT_ALLOW_NONLOCAL"),
            session_ttl_seconds=int(value("SESSION_TTL_SECONDS", 3600)),
            action_ttl_seconds=int(value("ACTION_TTL_SECONDS", 300)),
            action_lease_seconds=int(value("ACTION_LEASE_SECONDS", 120)),
            max_audio_bytes=int(value("MAX_AUDIO_BYTES", 10485760)),
            max_text_chars=int(value("MAX_TEXT_CHARS", 8000)),
            max_audio_jobs=int(value("MAX_AUDIO_JOBS", 2)),
            enable_api_docs=boolean("ENABLE_API_DOCS"),
            log_level=str(value("LOG_LEVEL", "INFO")).upper(),
            log_command_text=boolean("LOG_COMMAND_TEXT"),
            conversation_max_messages=int(value("CONVERSATION_MAX_MESSAGES", 12)),
            conversation_max_chars=int(value("CONVERSATION_MAX_CHARS", 16000)),
            timezone=str(value("TIMEZONE", "Asia/Taipei")),
            port=int(value("PORT", 8000)),
        )
        settings.validate()
        return settings

    def validate(self) -> None:
        if len(self.admin_bootstrap_token) < 32 or self.admin_bootstrap_token.startswith("CHANGE_"):
            raise ValueError("請在 .env 設定至少 32 字元的隨機 ADMIN_BOOTSTRAP_TOKEN")
        parsed = urlsplit(self.public_base_url)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
            raise ValueError("PUBLIC_BASE_URL 必須是 HTTPS 網站來源，例如 https://assistant.example.com")
        if self.llm_output_mode not in {"json_schema", "json_object", "none"}:
            raise ValueError("LLM_OUTPUT_MODE 必須是 json_schema/json_object/none")
        if self.log_level not in {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}:
            raise ValueError("LOG_LEVEL 必須是 DEBUG/INFO/WARNING/ERROR/CRITICAL")
        if not 2 <= self.conversation_max_messages <= 40 or not 2000 <= self.conversation_max_chars <= 48000:
            raise ValueError("CONVERSATION_MAX_MESSAGES 必須2至40；CONVERSATION_MAX_CHARS 必須2000至48000")
        if not self.llm_model.strip():
            raise ValueError("LLM_MODEL 不可空白")
        validate_model_url(self.llm_base_url, self.llm_allow_nonlocal)
        if self.stt_base_url:
            validate_model_url(self.stt_base_url, self.stt_allow_nonlocal)
        for name in ("llm_ca_bundle", "stt_ca_bundle"):
            ca = getattr(self, name)
            if ca and not Path(ca).is_file():
                raise ValueError(f"{name} 指定的 CA 檔不存在")
        if self.host != "127.0.0.1":
            raise ValueError("本版本供同機 cloudflared 使用，原站只綁定 127.0.0.1")
        for n in (self.llm_timeout_seconds, self.stt_timeout_seconds, self.max_text_chars, self.max_audio_bytes, self.max_audio_jobs, self.session_ttl_seconds, self.action_ttl_seconds, self.action_lease_seconds, self.llm_max_tokens):
            if n <= 0:
                raise ValueError("時間與容量設定必須大於零")
        if not 1 <= self.port <= 65535:
            raise ValueError("PORT 不合法")
        if self.session_ttl_seconds > 604800 or self.action_ttl_seconds > 3600 or self.action_lease_seconds > 600:
            raise ValueError("SESSION_TTL_SECONDS 最大604800、ACTION_TTL_SECONDS 最大3600、ACTION_LEASE_SECONDS 最大600")
        if not 0 <= self.llm_temperature <= 2:
            raise ValueError("LLM_TEMPERATURE 必須在0至2之間")
        ZoneInfo(self.timezone)

    @property
    def allowed_origin(self) -> str:
        return self.public_base_url.rstrip("/")

    @property
    def trusted_hosts(self) -> list[str]:
        return list({"localhost", "127.0.0.1", urlsplit(self.public_base_url).hostname or ""})

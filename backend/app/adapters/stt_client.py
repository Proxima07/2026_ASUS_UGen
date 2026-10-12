"""Optional private OpenAI-compatible audio transcription adapter."""

from __future__ import annotations

import re
from typing import Any, Protocol

import httpx

from .llm_client import STTError, _endpoint, _headers, _request_json, _tls_context


class STTSettings(Protocol):
    stt_base_url: str
    stt_model: str
    stt_api_key: str
    stt_timeout_seconds: float
    stt_ca_bundle: str | None


class STTClient:
    """Upload audio only to the transcription endpoint chosen in .env.

    This adapter does not download a model or call a fallback cloud service.
    A model-serving process must already be running on the private model host.
    """

    def __init__(
        self,
        settings: STTSettings,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.settings = settings
        self.enabled = bool(settings.stt_base_url and settings.stt_model)
        self.url = _endpoint(settings.stt_base_url, "audio/transcriptions") if self.enabled else ""
        self.client = httpx.AsyncClient(
            headers=_headers(settings.stt_api_key),
            timeout=settings.stt_timeout_seconds,
            verify=_tls_context(settings.stt_ca_bundle, STTError),
            trust_env=False,
            follow_redirects=False,
            transport=transport,
            limits=httpx.Limits(max_connections=4, max_keepalive_connections=2),
        )

    async def transcribe(
        self,
        audio: bytes,
        filename: str,
        content_type: str | None = None,
    ) -> str:
        if not self.enabled:
            raise STTError("stt_disabled", "尚未設定本地語音轉錄服務，請先完成 STT 設定。")
        if not audio:
            raise STTError("empty_audio", "錄音內容為空。")
        # The name is only metadata for the private endpoint, never a local
        # filesystem path. Strip directory components and header characters.
        safe_name = re.sub(r"[^A-Za-z0-9._-]", "_", filename.replace("\\", "/").rsplit("/", 1)[-1])[:128]
        if not safe_name:
            safe_name = "recording.webm"
        mime = content_type or "application/octet-stream"
        if "\r" in mime or "\n" in mime:
            raise STTError("invalid_audio_type", "錄音格式無效。")
        parsed = await _request_json(
            self.client,
            self.url,
            error_class=STTError,
            files={"file": (safe_name, audio, mime)},
            data={"model": self.settings.stt_model, "response_format": "json"},
        )
        transcript = parsed.get("text")
        if not isinstance(transcript, str) or not transcript.strip():
            raise STTError("stt_empty_text", "轉錄服務未辨識到可用的文字。")
        return transcript.strip()

    async def aclose(self) -> None:
        await self.client.aclose()

    async def __aenter__(self) -> STTClient:
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.aclose()

"""Private, OpenAI-compatible model transport.

The configured URL is the only destination. This module never selects an
external provider, follows a redirect, or falls back to another model endpoint.
"""

from __future__ import annotations

import json
import ssl
from collections.abc import Mapping, Sequence
from typing import Any, Protocol, TypeVar

import httpx


MAX_RESPONSE_BYTES = 2 * 1024 * 1024


class AdapterError(RuntimeError):
    """An error safe to display without exposing provider bodies or secrets."""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(message)


class LLMError(AdapterError):
    """The configured language-model service did not complete a request."""


class STTError(AdapterError):
    """The configured transcription service did not complete a request."""


class LLMSettings(Protocol):
    llm_base_url: str
    llm_model: str
    llm_api_key: str
    llm_output_mode: str
    llm_timeout_seconds: float
    llm_max_tokens: int
    llm_temperature: float
    llm_ca_bundle: str | None


ErrorT = TypeVar("ErrorT", bound=AdapterError)


def _tls_context(ca_bundle: str | None, error_class: type[ErrorT]) -> ssl.SSLContext:
    """Use system certificate roots, or an explicitly configured private CA."""
    try:
        return ssl.create_default_context(cafile=ca_bundle or None)
    except (OSError, ssl.SSLError):
        raise error_class("invalid_ca_bundle", "模型服務的 CA 憑證設定無法載入。") from None


def _endpoint(base_url: str, path: str) -> str:
    """Append to the configured API prefix, e.g. /v1/chat/completions."""
    return base_url.rstrip("/") + "/" + path.lstrip("/")


def _headers(api_key: str) -> dict[str, str]:
    headers = {"Accept": "application/json"}
    if api_key:
        headers["Authorization"] = "Bearer " + api_key
    return headers


async def _request_json(
    client: httpx.AsyncClient,
    url: str,
    *,
    error_class: type[ErrorT],
    **kwargs: Any,
) -> dict[str, Any]:
    """Read a bounded response and deliberately discard upstream error bodies."""
    try:
        async with client.stream("POST", url, **kwargs) as response:
            if 300 <= response.status_code < 400:
                raise error_class("upstream_redirect", "模型服務要求重新導向；請檢查設定的 API 網址。")
            if response.status_code in (401, 403):
                raise error_class("upstream_auth", "模型服務拒絕驗證；請檢查 API 金鑰與服務權限。")
            if response.status_code == 429:
                raise error_class("upstream_busy", "模型服務目前忙碌，請稍後再試。")
            if not 200 <= response.status_code < 300:
                raise error_class("upstream_http", "模型服務未能完成請求；請檢查服務設定與狀態。")

            content_length = response.headers.get("content-length", "")
            if content_length.isdecimal() and int(content_length) > MAX_RESPONSE_BYTES:
                raise error_class("upstream_too_large", "模型服務回應超過允許大小。")

            body = bytearray()
            async for chunk in response.aiter_bytes():
                body.extend(chunk)
                if len(body) > MAX_RESPONSE_BYTES:
                    raise error_class("upstream_too_large", "模型服務回應超過允許大小。")
    except httpx.TimeoutException:
        raise error_class("upstream_timeout", "模型服務回應逾時，請稍後再試。") from None
    except httpx.HTTPError:
        raise error_class("upstream_connection", "無法連線至設定的模型服務；請檢查連線與 TLS 憑證。") from None

    try:
        parsed = json.loads(body)
    except (ValueError, UnicodeDecodeError):
        raise error_class("upstream_invalid_json", "模型服務未回傳有效的 JSON 回應。") from None
    if not isinstance(parsed, dict):
        raise error_class("upstream_invalid_json", "模型服務的回應結構不符合 API 格式。")
    return parsed


class LLMClient:
    """Call the single .env-configured Chat Completions endpoint.

    ``llm_base_url`` is an API prefix such as ``https://model.private/v1``.
    TLS verification is always enabled; settings must validate that plain HTTP
    is limited to loopback. The optional transport argument is for offline tests.
    """

    def __init__(
        self,
        settings: LLMSettings,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.settings = settings
        self.url = _endpoint(settings.llm_base_url, "chat/completions")
        self.client = httpx.AsyncClient(
            headers=_headers(settings.llm_api_key),
            timeout=settings.llm_timeout_seconds,
            verify=_tls_context(settings.llm_ca_bundle, LLMError),
            trust_env=False,
            follow_redirects=False,
            transport=transport,
            limits=httpx.Limits(max_connections=8, max_keepalive_connections=4),
        )

    async def complete(
        self,
        messages: Sequence[Mapping[str, Any]],
        json_schema: dict[str, Any] | None = None,
    ) -> str:
        payload: dict[str, Any] = {
            "model": self.settings.llm_model,
            "messages": [dict(message) for message in messages],
            "temperature": self.settings.llm_temperature,
            "max_tokens": self.settings.llm_max_tokens,
            "stream": False,
        }
        if json_schema is not None:
            mode = self.settings.llm_output_mode
            if mode == "json_schema":
                payload["response_format"] = {
                    "type": "json_schema",
                    "json_schema": {
                        "name": "agent_response",
                        # Planner schemas can contain optional properties and
                        # open argument dictionaries. They do not necessarily
                        # fit the narrower strict-schema provider subset.
                        # The planner validates the decoded result itself.
                        "strict": False,
                        "schema": json_schema,
                    },
                }
            elif mode == "json_object":
                payload["response_format"] = {"type": "json_object"}
            elif mode != "none":
                raise LLMError("invalid_output_mode", "LLM 輸出模式設定無效。")
            # Also tell providers without schema support the exact requested
            # shape. Output validation belongs to the planner, not this client.
            payload["messages"].insert(
                0,
                {
                    "role": "system",
                    "content": "Return only a JSON object matching this JSON Schema: "
                    + json.dumps(json_schema, ensure_ascii=False, separators=(",", ":")),
                },
            )

        parsed = await _request_json(self.client, self.url, error_class=LLMError, json=payload)
        try:
            choice = parsed["choices"][0]
            if choice.get("finish_reason") == "length":
                raise LLMError("upstream_truncated", "模型輸出被截斷；請縮短輸入或調整輸出 token 上限。")
            message = choice["message"]
            content = message.get("content")
            if isinstance(content, list):
                # A few compatible implementations return OpenAI text blocks.
                content = "".join(
                    block.get("text", "")
                    for block in content
                    if isinstance(block, dict)
                    and block.get("type") == "text"
                    and isinstance(block.get("text"), str)
                )
            if not isinstance(content, str) or not content.strip():
                raise LLMError("upstream_empty", "模型未提供可用的回答。")
        except (KeyError, IndexError, TypeError, AttributeError):
            raise LLMError("upstream_invalid_shape", "模型服務的回應不符合 Chat Completions 格式。") from None
        return content.strip()

    async def aclose(self) -> None:
        await self.client.aclose()

    async def __aenter__(self) -> LLMClient:
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.aclose()

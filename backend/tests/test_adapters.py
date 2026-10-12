"""Offline transport tests; these do not call any model or external service."""

from __future__ import annotations

import json
import unittest
from types import SimpleNamespace

import httpx

from app.adapters.llm_client import LLMClient, LLMError, MAX_RESPONSE_BYTES
from app.adapters.stt_client import STTClient, STTError


def settings(**overrides):
    values = {
        "llm_base_url": "https://model.private/v1/",
        "llm_model": "private-model",
        "llm_api_key": "private-key",
        "llm_output_mode": "json_object",
        "llm_timeout_seconds": 60,
        "llm_max_tokens": 1024,
        "llm_temperature": 0,
        "llm_ca_bundle": None,
        "stt_base_url": "https://stt.private/v1",
        "stt_model": "whisper-private",
        "stt_api_key": "stt-private-key",
        "stt_timeout_seconds": 120,
        "stt_ca_bundle": None,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


class AdapterTests(unittest.IsolatedAsyncioTestCase):
    async def test_chat_uses_configured_prefix_model_and_json_mode(self):
        observed = []

        def handle(request):
            observed.append(request)
            return httpx.Response(200, json={"choices": [{"message": {"content": '{"ok":true}'}}]})

        input_messages = [{"role": "user", "content": "建立筆記"}]
        schema = {"type": "object", "properties": {"ok": {"type": "boolean"}}, "required": ["ok"]}
        async with LLMClient(settings(), transport=httpx.MockTransport(handle)) as client:
            result = await client.complete(input_messages, schema)
        self.assertEqual(result, '{"ok":true}')
        self.assertEqual(str(observed[0].url), "https://model.private/v1/chat/completions")
        self.assertEqual(observed[0].headers["authorization"], "Bearer private-key")
        body = json.loads(observed[0].content)
        self.assertEqual(body["model"], "private-model")
        self.assertEqual(body["response_format"], {"type": "json_object"})
        self.assertFalse(body["stream"])
        self.assertEqual(body["messages"][-1], input_messages[0])
        self.assertEqual(len(input_messages), 1, "The adapter must not mutate planner messages")

    async def test_schema_mode_and_provider_without_response_format(self):
        for mode in ("json_schema", "none"):
            with self.subTest(mode=mode):
                observed = []

                def handle(request):
                    observed.append(json.loads(request.content))
                    return httpx.Response(200, json={"choices": [{"message": {"content": "{}"}}]})

                schema = {"type": "object", "properties": {}, "additionalProperties": False}
                async with LLMClient(settings(llm_output_mode=mode), transport=httpx.MockTransport(handle)) as client:
                    await client.complete([{"role": "user", "content": "hello"}], schema)
                if mode == "json_schema":
                    self.assertEqual(observed[0]["response_format"]["json_schema"]["schema"], schema)
                    self.assertFalse(observed[0]["response_format"]["json_schema"]["strict"])
                else:
                    self.assertNotIn("response_format", observed[0])

    async def test_plain_text_request_does_not_force_json(self):
        def handle(request):
            self.assertNotIn("response_format", json.loads(request.content))
            return httpx.Response(200, json={"choices": [{"message": {"content": " 整理好的筆記 "}}]})

        async with LLMClient(settings(), transport=httpx.MockTransport(handle)) as client:
            self.assertEqual(await client.complete([{"role": "user", "content": "hello"}]), "整理好的筆記")

    async def test_text_blocks_are_supported_without_exposing_reasoning(self):
        def handle(request):
            return httpx.Response(200, json={"choices": [{"message": {
                "content": [{"type": "text", "text": "筆記"}, {"type": "text", "text": "內容"}],
                "reasoning_content": "private reasoning must not appear",
            }}]})

        async with LLMClient(settings(), transport=httpx.MockTransport(handle)) as client:
            self.assertEqual(await client.complete([]), "筆記內容")

    async def test_http_errors_and_redirects_are_sanitized_without_retry(self):
        for status, expected in ((302, "upstream_redirect"), (401, "upstream_auth"), (403, "upstream_auth"),
                                 (429, "upstream_busy"), (500, "upstream_http"), (400, "upstream_http")):
            with self.subTest(status=status):
                calls = []

                def handle(request):
                    calls.append(request)
                    return httpx.Response(status, headers={"location": "https://external.example/collect"},
                                          text="SENSITIVE transcript private-key")

                async with LLMClient(settings(), transport=httpx.MockTransport(handle)) as client:
                    with self.assertRaises(LLMError) as raised:
                        await client.complete([])
                self.assertEqual(raised.exception.code, expected)
                self.assertNotIn("SENSITIVE", str(raised.exception))
                self.assertNotIn("private-key", str(raised.exception))
                self.assertEqual(len(calls), 1)

    async def test_network_errors_do_not_expose_url_or_key(self):
        for kind, expected in ((httpx.ReadTimeout, "upstream_timeout"), (httpx.ConnectError, "upstream_connection")):
            with self.subTest(kind=kind):
                def handle(request):
                    raise kind("private-key https://secret-host private prompt", request=request)

                async with LLMClient(settings(), transport=httpx.MockTransport(handle)) as client:
                    with self.assertRaises(LLMError) as raised:
                        await client.complete([])
                self.assertEqual(raised.exception.code, expected)
                self.assertNotIn("private-key", str(raised.exception))
                self.assertNotIn("secret-host", str(raised.exception))

    async def test_malformed_and_truncated_responses_fail_cleanly(self):
        cases = [
            (httpx.Response(200, text="private invalid response"), "upstream_invalid_json"),
            (httpx.Response(200, json=[]), "upstream_invalid_json"),
            (httpx.Response(200, json={"choices": []}), "upstream_invalid_shape"),
            (httpx.Response(200, json={"choices": [{"message": {"content": ""}}]}), "upstream_empty"),
            (httpx.Response(200, json={"choices": [{"finish_reason": "length", "message": {"content": "half"}}]}),
             "upstream_truncated"),
        ]
        for response, expected in cases:
            with self.subTest(expected=expected):
                async with LLMClient(settings(), transport=httpx.MockTransport(lambda request: response)) as client:
                    with self.assertRaises(LLMError) as raised:
                        await client.complete([])
                self.assertEqual(raised.exception.code, expected)

    async def test_response_size_limit(self):
        def handle(request):
            return httpx.Response(200, content=b"x" * (MAX_RESPONSE_BYTES + 1))

        async with LLMClient(settings(), transport=httpx.MockTransport(handle)) as client:
            with self.assertRaises(LLMError) as raised:
                await client.complete([])
        self.assertEqual(raised.exception.code, "upstream_too_large")

    async def test_stt_upload_is_multipart_and_uses_configured_endpoint(self):
        observed = []

        def handle(request):
            observed.append(request)
            return httpx.Response(200, json={"text": " 今天要繳電費。 "})

        async with STTClient(settings(), transport=httpx.MockTransport(handle)) as client:
            text = await client.transcribe(b"private-audio-bytes", "../recording.webm", "audio/webm")
        self.assertEqual(text, "今天要繳電費。")
        self.assertEqual(str(observed[0].url), "https://stt.private/v1/audio/transcriptions")
        self.assertTrue(observed[0].headers["content-type"].startswith("multipart/form-data;"))
        self.assertEqual(observed[0].headers["authorization"], "Bearer stt-private-key")
        self.assertIn(b"whisper-private", observed[0].content)
        self.assertIn(b"private-audio-bytes", observed[0].content)
        self.assertIn(b'filename="recording.webm"', observed[0].content)

    async def test_stt_disabled_does_not_call_network(self):
        def handle(request):
            self.fail("A disabled transcription service must not issue requests")

        async with STTClient(settings(stt_base_url="", stt_model=""), transport=httpx.MockTransport(handle)) as client:
            with self.assertRaises(STTError) as raised:
                await client.transcribe(b"audio", "recording.webm")
        self.assertEqual(raised.exception.code, "stt_disabled")

    async def test_stt_invalid_input_and_empty_result(self):
        async with STTClient(settings(), transport=httpx.MockTransport(lambda request: httpx.Response(200, json={"text": ""}))) as client:
            with self.assertRaises(STTError) as raised:
                await client.transcribe(b"", "recording.webm")
            self.assertEqual(raised.exception.code, "empty_audio")
            with self.assertRaises(STTError) as raised:
                await client.transcribe(b"audio", "recording.webm")
            self.assertEqual(raised.exception.code, "stt_empty_text")

    async def test_missing_api_key_does_not_send_authorization(self):
        def handle(request):
            self.assertNotIn("authorization", request.headers)
            return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}]})

        async with LLMClient(settings(llm_api_key=""), transport=httpx.MockTransport(handle)) as client:
            self.assertEqual(await client.complete([]), "ok")


if __name__ == "__main__":
    unittest.main()

"""End-to-end API checks with offline OpenAI-compatible model fixtures."""
import json
import tempfile
import time
import unittest
from pathlib import Path

import httpx
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


class APIIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.calls = []
        self.settings = Settings(admin_bootstrap_token="test-bootstrap-" + "x" * 48,
                                 data_dir=Path(self.tmp.name), public_base_url="https://assistant.example.com")
        self.app = create_app(self.settings, llm_transport=httpx.MockTransport(self.model))
        self.client = TestClient(self.app, base_url=self.settings.public_base_url)
        self.client.__enter__()
        self.token = self.pair("Phone A")
        self.headers = {"Authorization": "Bearer " + self.token}

    def tearDown(self):
        self.client.__exit__(None, None, None)
        self.tmp.cleanup()

    def model(self, request):
        self.calls.append(request)
        body = json.loads(request.content)
        text = body["messages"][-1]["content"]
        if "媽媽" in text:
            plan = {"kind": "tool", "message": "查找媽媽", "tool": "contacts.search", "args": {"query": "媽媽", "purpose": "dial"}}
        elif "鬧鐘" in text:
            plan = {"kind": "tool", "message": "設定早上七點", "tool": "alarm.create", "args": {"hour": 7, "minute": 0, "label": "起床"}}
        elif "猜電話" in text:
            plan = {"kind": "tool", "message": "打電話", "tool": "phone.dial", "args": {"name": "朋友", "phone_number": "0912345678"}}
        elif "非法工具" in text:
            plan = {"kind": "tool", "message": "執行", "tool": "shell.exec", "args": {"cmd": "bad"}}
        elif "記下" in text:
            plan = {"kind": "tool", "message": "記錄", "tool": "notes.create", "args": {"title": "明日備忘", "content": "明天帶轉接頭"}}
        else:
            plan = {"kind": "reply", "message": "收到", "tool": None, "args": {}}
        return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps(plan, ensure_ascii=False)}}]})

    def pair(self, label):
        code = self.client.post("/v1/auth/pairing-codes", headers={"X-Bootstrap-Token": self.settings.admin_bootstrap_token})
        self.assertEqual(code.status_code, 200, code.text)
        paired = self.client.post("/v1/auth/pair", json={"code": code.json()["code"], "label": label})
        self.assertEqual(paired.status_code, 200, paired.text)
        return paired.json()["token"]

    def chat(self, text, key="request-1"):
        response = self.client.post("/v1/chat", headers=self.headers, json={"text": text, "idempotency_key": key, "note_target": "platform"})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def confirm(self, action_id):
        response = self.client.post(f"/v1/actions/{action_id}/confirm", headers=self.headers)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["execution_token"]

    def test_auth_required_and_health_no_model_call(self):
        self.assertEqual(self.client.get("/health").status_code, 200)
        self.assertEqual(self.client.get("/v1/notes").status_code, 401)
        self.assertEqual(self.calls, [])
        self.assertEqual(self.client.get("/docs").status_code, 404)

    def test_note_creation_replay_and_plaintext_absent_from_database(self):
        record = self.chat("記下明天帶轉接頭")
        replay = self.chat("記下明天帶轉接頭")
        self.assertEqual(record["request_id"], replay["request_id"])
        self.assertEqual(len(self.calls), 1)
        items = self.client.get("/v1/notes", headers=self.headers).json()["items"]
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["content"], "明天帶轉接頭")
        for p in Path(self.tmp.name).glob("*.sqlite3*"):
            self.assertNotIn("明天帶轉接頭".encode(), p.read_bytes())

    def test_same_idempotency_key_different_input_conflicts(self):
        self.chat("記下明天帶轉接頭")
        response = self.client.post("/v1/chat", headers=self.headers, json={"text": "其他內容", "idempotency_key": "request-1"})
        self.assertEqual(response.status_code, 409)

    def test_unknown_tool_and_invented_phone_rejected_without_action(self):
        for i, text in enumerate(("非法工具", "猜電話")):
            record = self.chat(text, f"bad-{i}")
            self.assertEqual(record["status"], "failed")
        self.assertEqual(self.client.get("/v1/actions", headers=self.headers).json()["items"], [])

    def test_contacts_lookup_to_dial_and_result_replay(self):
        record = self.chat("幫我打電話給媽媽")
        action_id = record["action_id"]
        token = self.confirm(action_id)
        body = {"execution_token": token, "state": "completed", "result": {"contacts": [{"name": "媽媽", "phone_number": "0912345678"}]}}
        result = self.client.post(f"/v1/actions/{action_id}/result", headers=self.headers, json=body)
        self.assertEqual(result.status_code, 200, result.text)
        dial_id = result.json()["request"]["action_id"]
        dial = self.client.get(f"/v1/actions/{dial_id}", headers=self.headers).json()
        self.assertEqual(dial["kind"], "phone.dial")
        self.assertEqual(dial["payload"]["phone_number"], "0912345678")
        replay = self.client.post(f"/v1/actions/{action_id}/result", headers=self.headers, json=body)
        self.assertEqual(replay.json()["request"]["action_id"], dial_id)
        dial_token = self.confirm(dial_id)
        false_completion = self.client.post(f"/v1/actions/{dial_id}/result", headers=self.headers,
            json={"execution_token": dial_token, "state": "completed", "result": {}})
        self.assertEqual(false_completion.status_code, 422)
        opened = self.client.post(f"/v1/actions/{dial_id}/result", headers=self.headers,
            json={"execution_token": dial_token, "state": "opened", "result": {}})
        self.assertEqual(opened.status_code, 200)
        self.assertEqual(opened.json()["request"]["status"], "opened")
        old_replay = self.client.post(f"/v1/actions/{action_id}/result", headers=self.headers, json=body)
        self.assertEqual(old_replay.json()["request"]["status"], "opened")
        self.assertEqual(old_replay.json()["request"]["action_id"], dial_id)

    def test_multiple_contacts_require_selection_and_validate_candidate(self):
        record = self.chat("打電話給媽媽")
        action_id = record["action_id"]
        response = self.client.post(f"/v1/actions/{action_id}/result", headers=self.headers,
            json={"execution_token": self.confirm(action_id), "state": "completed", "result": {"contacts": [
                {"name": "媽媽", "phone_number": "0912345678"}, {"name": "媽媽", "phone_number": "0987654321"}]}})
        current = response.json()["request"]
        self.assertEqual(current["status"], "needs_selection")
        url = f"/v1/requests/{record['request_id']}/select-contact"
        self.assertEqual(self.client.post(url, headers=self.headers, json={"candidate_id": "fake"}).status_code, 422)
        selected = self.client.post(url, headers=self.headers, json={"candidate_id": current["candidates"][1]["candidate_id"]})
        self.assertEqual(selected.status_code, 200)
        self.assertEqual(selected.json()["status"], "awaiting_device")

    def test_atomic_claim_then_permission_denied(self):
        record = self.chat("設定鬧鐘")
        action_id = record["action_id"]
        token = self.confirm(action_id)
        self.assertEqual(self.client.post(f"/v1/actions/{action_id}/confirm", headers=self.headers).status_code, 409)
        response = self.client.post(f"/v1/actions/{action_id}/result", headers=self.headers,
            json={"execution_token": token, "state": "permission_denied", "result": {}})
        self.assertEqual(response.status_code, 200, response.text)

    def test_devices_cannot_claim_each_others_actions(self):
        record = self.chat("設定鬧鐘")
        other = {"Authorization": "Bearer " + self.pair("Phone B")}
        response = self.client.get(f"/v1/actions/{record['action_id']}", headers=other)
        self.assertEqual(response.status_code, 404)
        self.assertEqual(self.client.get(f"/v1/requests/{record['request_id']}", headers=other).status_code, 404)

    def test_cookie_session_origin_and_native_auth(self):
        response = self.client.post("/v1/auth/session", headers=self.headers)
        cookie = response.headers["set-cookie"].lower()
        self.assertIn("httponly", cookie)
        self.assertIn("secure", cookie)
        self.assertIn("samesite=strict", cookie)
        body = {"title": "私人", "content": "內容"}
        self.assertEqual(self.client.post("/v1/notes", json=body).status_code, 403)
        self.assertEqual(self.client.post("/v1/notes", json=body, headers={"Origin": "https://evil.example"}).status_code, 403)
        valid = self.client.post("/v1/notes", json=body, headers={"Origin": self.settings.public_base_url})
        self.assertEqual(valid.status_code, 200)
        self.assertEqual(self.client.post("/v1/auth/session", headers={"Origin": self.settings.public_base_url}).status_code, 403)

    def test_validation_errors_do_not_echo_private_input(self):
        response = self.client.post("/v1/notes", headers=self.headers,
            json={"title": "secret-PRIVATE-INPUT", "content": "x", "unexpected": "secret-PRIVATE-INPUT"})
        self.assertEqual(response.status_code, 422)
        self.assertNotIn("secret-PRIVATE-INPUT", response.text)

    def test_disabled_audio_and_cache_headers(self):
        response = self.client.post("/v1/audio", headers={**self.headers, "Content-Type": "audio/wav"}, content=b"audio")
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["error"]["code"], "stt_disabled")
        self.assertEqual(response.headers["cache-control"], "no-store")

    def test_note_update_and_delete(self):
        note = self.client.post("/v1/notes", headers=self.headers, json={"title": "備忘", "content": "原內容"}).json()
        url = f"/v1/notes/{note['note_id']}"
        updated = self.client.put(url, headers=self.headers, json={"title": "更新", "content": "新的內容"})
        self.assertEqual(updated.status_code, 200, updated.text)
        self.assertEqual(self.client.get(url, headers=self.headers).json()["content"], "新的內容")
        self.assertEqual(self.client.delete(url, headers=self.headers).status_code, 200)
        self.assertEqual(self.client.get(url, headers=self.headers).status_code, 404)

    def test_note_native_actions_are_deterministic_and_owned(self):
        note = self.client.post("/v1/notes", headers=self.headers, json={"title": "筆記", "content": "另存手机內容"}).json()
        url = f"/v1/notes/{note['note_id']}/actions"
        body = {"kind": "notes.save_local", "idempotency_key": "save-note-1"}
        action = self.client.post(url, headers=self.headers, json=body)
        self.assertEqual(action.status_code, 200, action.text)
        self.assertEqual(action.json()["payload"]["content"], "另存手机內容")
        self.assertEqual(action.json()["state"], "pending_confirmation")
        retry = self.client.post(url, headers=self.headers, json=body)
        self.assertEqual(retry.json()["action_id"], action.json()["action_id"])
        self.assertEqual(self.calls, [])
        other = self.app.state.repo.create_device("other-user", "other")
        response = self.client.post(url, headers={"Authorization": "Bearer " + other["token"]}, json=body)
        self.assertEqual(response.status_code, 404)

    def test_note_action_does_not_allow_arbitrary_tool(self):
        note = self.client.post("/v1/notes", headers=self.headers, json={"title": "筆記", "content": "內容"}).json()
        response = self.client.post(f"/v1/notes/{note['note_id']}/actions", headers=self.headers,
            json={"kind": "phone.dial", "idempotency_key": "bad-tool"})
        self.assertEqual(response.status_code, 422)

    def test_web_files_are_served_without_shadowing_authenticated_api(self):
        if not (self.settings.web_dir / "index.html").is_file():
            self.skipTest("Install web_v1 to verify the actual static website integration")
        index = self.client.get("/")
        self.assertEqual(index.status_code, 200)
        self.assertIn('type="module"', index.text)
        script = self.client.get("/js/main.js")
        self.assertEqual(script.status_code, 200)
        self.assertIn("Bridge", script.text)
        self.assertEqual(self.client.get("/v1/notes").status_code, 401)
        self.assertEqual(self.client.get("/v1/notes", headers=self.headers).status_code, 200)

    def test_cancel_before_claim(self):
        record = self.chat("設定鬧鐘")
        response = self.client.post(f"/v1/actions/{record['action_id']}/cancel", headers=self.headers)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["request"]["status"], "cancelled")
        self.assertEqual(self.client.post(f"/v1/actions/{record['action_id']}/confirm", headers=self.headers).status_code, 409)

    def test_invalid_nonfinite_result_rejected_safely(self):
        record = self.chat("設定鬧鐘")
        token = self.confirm(record["action_id"])
        body = json.dumps({"execution_token": token, "state": "handed_off", "result": {"value": float("nan")}})
        response = self.client.post(f"/v1/actions/{record['action_id']}/result", headers={**self.headers, "Content-Type": "application/json"}, content=body)
        self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(response.json()["error"]["code"], "invalid_result_json")

    def test_optional_docs_are_self_contained(self):
        self.client.__exit__(None, None, None)
        self.settings.enable_api_docs = True
        self.app = create_app(self.settings, llm_transport=httpx.MockTransport(self.model))
        self.client = TestClient(self.app, base_url=self.settings.public_base_url)
        self.client.__enter__()
        docs = self.client.get("/docs")
        self.assertEqual(docs.status_code, 200)
        self.assertNotIn("<script", docs.text)
        self.assertNotIn("cdn.", docs.text)
        self.assertEqual(self.client.get("/openapi.json").status_code, 200)

    def test_chunked_request_size_is_bounded(self):
        response = self.client.post("/v1/chat", headers={**self.headers, "Content-Type": "application/json"},
            content=(b"x" * 100000 for _ in range(2)))
        self.assertEqual(response.status_code, 413, response.text)
        self.assertEqual(response.json()["error"]["code"], "body_too_large")
        self.assertEqual(self.calls, [])

    def test_audio_optional_endpoint_to_encrypted_draft(self):
        self.client.__exit__(None, None, None)
        self.settings.stt_base_url = "http://127.0.0.1:8081/v1"
        def model(req):
            return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps({"title": "錄音摘要", "content": "明天帶轉接頭"})}}]})
        self.app = create_app(self.settings, llm_transport=httpx.MockTransport(model),
            stt_transport=httpx.MockTransport(lambda req: httpx.Response(200, json={"text": "明天帶轉接頭"})))
        self.client = TestClient(self.app, base_url=self.settings.public_base_url)
        self.client.__enter__()
        response = self.client.post("/v1/audio", headers={**self.headers, "Content-Type": "audio/wav"}, content=b"sample-audio-bytes")
        self.assertEqual(response.status_code, 202, response.text)
        job_id = response.json()["job_id"]
        for _ in range(100):
            job = self.client.get(f"/v1/audio/{job_id}", headers=self.headers).json()
            if job["status"] in {"ready", "failed", "transcribed"}:
                break
            time.sleep(0.01)
        self.assertEqual(job["status"], "ready", job)
        self.assertEqual(job["draft"]["content"], "明天帶轉接頭")
        self.assertEqual(self.client.get("/v1/notes", headers=self.headers).json()["items"], [])
        for p in Path(self.tmp.name).glob("*.sqlite3*"):
            self.assertNotIn("明天帶轉接頭".encode(), p.read_bytes())


if __name__ == "__main__":
    unittest.main()

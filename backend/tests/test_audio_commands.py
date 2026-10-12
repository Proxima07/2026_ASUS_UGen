"""Command transcription must not summarize or execute an inferred action."""
import asyncio
import json
import tempfile
import time
from pathlib import Path
from types import SimpleNamespace
import unittest

import httpx
from fastapi.testclient import TestClient

from app.api.audio import process_audio
from app.config import Settings
from app.main import create_app
from app.schemas import NoteCreate


class MemoryJobs:
    def __init__(self):
        self.jobs = {"job-one": {"status": "queued"}}

    def update_job(self, identity, job_id, changes):
        self.jobs[job_id].update(changes)


class AudioCommandTests(unittest.IsolatedAsyncioTestCase):
    def state(self, transcript):
        async def transcribe(*args):
            return transcript

        class Planner:
            def __init__(self):
                self.calls = 0

            async def summarize(self, text):
                self.calls += 1
                return NoteCreate(title="草稿", content=text)

        return SimpleNamespace(repo=MemoryJobs(), stt=SimpleNamespace(transcribe=transcribe),
            planner=Planner(), model_semaphore=asyncio.Semaphore(1),
            settings=SimpleNamespace(max_text_chars=8000))

    async def test_command_returns_transcript_without_summary_or_action(self):
        state = self.state("幫我設定明早七點的鬧鐘")
        await process_audio(state, None, "job-one", b"sample", "audio/webm", "command")
        job = state.repo.jobs["job-one"]
        self.assertEqual(job["status"], "transcribed")
        self.assertEqual(job["transcript"], "幫我設定明早七點的鬧鐘")
        self.assertNotIn("draft", job)
        self.assertNotIn("action_id", job)
        self.assertEqual(state.planner.calls, 0)

    async def test_advanced_note_mode_still_summarizes(self):
        state = self.state("下週帶報告")
        await process_audio(state, None, "job-one", b"sample", "audio/webm")
        self.assertEqual(state.repo.jobs["job-one"]["status"], "ready")
        self.assertEqual(state.planner.calls, 1)

    async def test_overlong_command_is_not_sent_to_planner(self):
        state = self.state("長" * 8001)
        await process_audio(state, None, "job-one", b"sample", "audio/webm", "command")
        self.assertEqual(state.repo.jobs["job-one"]["status"], "failed")
        self.assertEqual(state.repo.jobs["job-one"]["error"]["code"], "command_too_long")
        self.assertEqual(state.planner.calls, 0)

    async def test_empty_transcript_does_not_generate_command(self):
        state = self.state("  ")
        await process_audio(state, None, "job-one", b"sample", "audio/webm", "command")
        self.assertEqual(state.repo.jobs["job-one"]["status"], "failed")
        self.assertNotIn("draft", state.repo.jobs["job-one"])
        self.assertEqual(state.planner.calls, 0)


class CommandAudioAPITests(unittest.TestCase):
    def test_raw_command_endpoint_skips_summary_and_keeps_device_auth(self):
        llm_calls = []
        def model(request):
            llm_calls.append(request)
            return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps({
                "kind": "tool", "message": "記下牛奶", "tool": "notes.create",
                "args": {"title": "採買清單", "content": "買牛奶"}}, ensure_ascii=False)}}]})
        with tempfile.TemporaryDirectory() as directory:
            settings = Settings(admin_bootstrap_token="fixture-admin-" + "x" * 40,
                public_base_url="https://assistant.example.com", data_dir=Path(directory),
                stt_base_url="https://127.0.0.1:9001/v1", stt_model="local-stt")
            app = create_app(settings, llm_transport=httpx.MockTransport(model),
                stt_transport=httpx.MockTransport(lambda request: httpx.Response(200,
                    json={"text": "幫我設定明天早上七點的鬧鐘"})))
            with TestClient(app, base_url=settings.public_base_url) as client:
                device = app.state.repo.create_device("poc-user", "phone")
                headers = {"Authorization": "Bearer " + device["token"], "Content-Type": "audio/webm"}
                response = client.post("/v1/audio?purpose=command", headers=headers, content=b"sample-audio")
                self.assertEqual(response.status_code, 202, response.text)
                self.assertEqual(response.json()["purpose"], "command")
                job_id = response.json()["job_id"]
                for _ in range(50):
                    job = client.get("/v1/audio/" + job_id, headers=headers).json()
                    if job["status"] in {"transcribed", "failed"}:
                        break
                    time.sleep(0.01)
                self.assertEqual(job["status"], "transcribed", job)
                self.assertIn("七點", job["transcript"])
                self.assertNotIn("draft", job)
                self.assertEqual(llm_calls, [])
                self.assertEqual(client.get("/v1/audio/" + job_id).status_code, 401)
                self.assertEqual(client.get("/v1/actions", headers=headers).json()["items"], [])
                self.assertEqual(client.post("/v1/audio?purpose=arbitrary", headers=headers,
                    content=b"sample").status_code, 422)
                # Continue the real API contract from STT to Agent to native result.
                auth = {"Authorization": "Bearer " + device["token"]}
                command = {"text": job["transcript"], "timezone": "Asia/Taipei",
                    "idempotency_key": "voice-pipeline-one", "note_target": "phone_first",
                    "native_capabilities": ["notes.save_local"]}
                planned = client.post("/v1/chat", headers=auth, json=command)
                self.assertEqual(planned.status_code, 200, planned.text)
                request_id = planned.json()["request_id"]
                action_id = planned.json()["action_id"]
                action = client.get("/v1/actions/" + action_id, headers=auth).json()
                self.assertEqual(action["kind"], "notes.save_local")
                self.assertEqual(action["request_id"], request_id)
                self.assertEqual(client.get("/v1/notes", headers=auth).json()["items"], [])
                claimed = client.post("/v1/actions/" + action_id + "/confirm", headers=auth).json()
                result = client.post("/v1/actions/" + action_id + "/result", headers=auth,
                    json={"execution_token": claimed["execution_token"], "state": "completed",
                          "result": {"note_id": action["payload"]["note_id"]}})
                self.assertEqual(result.status_code, 200, result.text)
                finished = client.get("/v1/requests/" + request_id, headers=auth).json()
                self.assertEqual(finished["status"], "completed")
                self.assertEqual(finished["storage_target"], "phone")
                self.assertFalse(finished["fallback"])
                self.assertEqual(client.get("/v1/notes", headers=auth).json()["items"], [])
                self.assertEqual(client.post("/v1/chat", headers=auth, json=command).json()["request_id"], request_id)
                self.assertEqual(len(llm_calls), 1)

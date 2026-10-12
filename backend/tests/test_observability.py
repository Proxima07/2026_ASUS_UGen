"""Real pipeline stage events, trace linkage, and default log privacy."""
import asyncio
import io
import json
import logging
import tempfile
import threading
import time
import unittest
from contextlib import contextmanager, redirect_stderr
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.observability import event


class ObservabilityTests(unittest.TestCase):
    @contextmanager
    def scenario(self, *, command_text=False, log_level="INFO", hold_stt=None,
                 stt_response=None, model_response=None):
        calls = []
        async def transcribe(request):
            if hold_stt:
                while not hold_stt.is_set():
                    await asyncio.sleep(0.005)
            return stt_response or httpx.Response(200, json={"text":" PRIVATE_TRANSCRIPT\n幫我記錄牛奶 "})
        def model(request):
            calls.append(request)
            return model_response or httpx.Response(200, json={"choices":[{"message":{"content":json.dumps({
                "kind":"tool","tool":"notes.create","args":{"title":"採買","content":"牛奶"}}, ensure_ascii=False)}}]})
        with tempfile.TemporaryDirectory() as folder:
            settings = Settings(admin_bootstrap_token="PRIVATE_ADMIN_TOKEN_"+"x"*40,
                data_dir=Path(folder), web_dir=Path(folder)/"missing", log_level=log_level,
                log_command_text=command_text, stt_base_url="https://127.0.0.1:9001/v1",
                llm_api_key="PRIVATE_MODEL_KEY", stt_api_key="PRIVATE_STT_KEY")
            app=create_app(settings,llm_transport=httpx.MockTransport(model),stt_transport=httpx.MockTransport(transcribe))
            stream=io.StringIO()
            with redirect_stderr(stream):
                with TestClient(app,base_url=settings.public_base_url) as client:
                    device=app.state.repo.create_device("poc-user","phone")
                    headers={"Authorization":"Bearer "+device["token"]}
                    yield app,client,headers,device,stream,calls

    def records(self, stream):
        return [json.loads(line) for line in stream.getvalue().splitlines() if line.startswith('{"time":')]

    def upload(self,client,headers,purpose="command"):
        result=client.post("/v1/audio?purpose="+purpose,headers={**headers,"Content-Type":"audio/webm",
            "X-Request-ID":"PRIVATE_INCOMING_TRACE"},content=b"PRIVATE_AUDIO_BYTES")
        self.assertEqual(202,result.status_code,result.text)
        return result

    def poll(self,client,headers,job_id):
        for _ in range(100):
            job=client.get("/v1/audio/"+job_id,headers=headers).json()
            if job["status"] not in {"queued","transcribing","summarizing"}:return job
            time.sleep(0.005)
        self.fail("job did not complete")

    def test_default_metadata_pipeline_and_live_stt_state(self):
        release=threading.Event()
        try:
            with self.scenario(hold_stt=release) as (app,client,headers,device,stream,calls):
                upload=self.upload(client,headers);accepted=upload.json()
                self.assertEqual(upload.headers["x-request-id"],accepted["trace_id"])
                self.assertRegex(accepted["trace_id"],r"^http_[0-9a-f]{32}$")
                for _ in range(100):
                    pending=client.get("/v1/audio/"+accepted["job_id"],headers=headers).json()
                    if pending["status"]=="transcribing":break
                    time.sleep(0.005)
                self.assertEqual("transcribing",pending["status"])
                self.assertEqual([],calls)
                release.set();job=self.poll(client,headers,accepted["job_id"])
                self.assertEqual("transcribed",job["status"])
                body={"text":job["transcript"].strip(),"source_job_id":job["job_id"],"idempotency_key":"one-voice"}
                first=client.post("/v1/chat",headers=headers,json=body)
                second=client.post("/v1/chat",headers=headers,json=body)
                self.assertEqual(200,first.status_code,first.text)
                self.assertEqual(accepted["trace_id"],first.json()["trace_id"])
                self.assertEqual(first.json()["trace_id"],second.json()["trace_id"])
                self.assertNotEqual(first.headers["x-request-id"],second.headers["x-request-id"])
                self.assertEqual(first.json()["request_id"],second.json()["request_id"])
                self.assertEqual(1,len(calls))
                records=self.records(stream);names=[r["event"] for r in records]
                for name in ("backend.starting","backend.ready","audio.received","audio.accepted",
                             "stt.started","stt.completed","command.transcribed","chat.received",
                             "agent.started","agent.completed","chat.replayed"):
                    self.assertIn(name,names)
                self.assertEqual(1,names.count("agent.started"))
                agent=next(r for r in records if r["event"]=="agent.completed")
                self.assertEqual("tool",agent["plan_kind"]);self.assertEqual("notes.create",agent["kind"])
                self.assertEqual("completed",agent["state"])
                self.assertEqual(job["trace_id"],agent["trace_id"])
                self.assertTrue(all(r.get("method")!="GET" for r in records))
                text=stream.getvalue()
                for forbidden in (device["token"],"PRIVATE_TRANSCRIPT","PRIVATE_AUDIO_BYTES","PRIVATE_MODEL_KEY",
                                  "PRIVATE_STT_KEY","PRIVATE_ADMIN_TOKEN","PRIVATE_INCOMING_TRACE"):
                    self.assertNotIn(forbidden,text)
        finally:release.set()

    def test_source_job_requires_owner_ready_purpose_and_matching_text(self):
        with self.scenario() as (app,client,headers,device,stream,calls):
            job=self.poll(client,headers,self.upload(client,headers).json()["job_id"])
            second=app.state.repo.create_device("poc-user","other-phone")
            body={"text":job["transcript"].strip(),"source_job_id":job["job_id"]}
            foreign=client.post("/v1/chat",headers={"Authorization":"Bearer "+second["token"]},json=body)
            self.assertEqual(404,foreign.status_code)
            wrong=client.post("/v1/chat",headers=headers,json={**body,"text":"different"})
            self.assertEqual(422,wrong.status_code)
            identity=app.state.repo.authenticate_device(device["token"])
            for status,purpose in (("queued","command"),("transcribing","command"),("transcribed","note")):
                app.state.repo.update_job(identity,job["job_id"],{"status":status,"purpose":purpose})
                response=client.post("/v1/chat",headers=headers,json=body)
                self.assertEqual(409,response.status_code,response.text)
            self.assertEqual([],calls)
            self.assertNotIn("agent.started",[r["event"] for r in self.records(stream)])

    def test_stt_failure_logs_safe_code_without_provider_error_body(self):
        response=httpx.Response(500,text="PRIVATE_PROVIDER_AUDIO_ERROR PRIVATE_MODEL_KEY")
        with self.scenario(stt_response=response) as (app,client,headers,device,stream,calls):
            job=self.poll(client,headers,self.upload(client,headers).json()["job_id"])
            self.assertEqual("failed",job["status"])
            failed=next(r for r in self.records(stream) if r["event"]=="stt.failed")
            self.assertEqual("upstream_http",failed["code"])
            self.assertIn("duration_ms",failed)
            self.assertNotIn("PRIVATE_PROVIDER_AUDIO_ERROR",stream.getvalue())
            self.assertNotIn("Traceback",stream.getvalue())
            self.assertEqual([],calls)

    def test_agent_failure_and_unexpected_exception_are_sanitized(self):
        with self.scenario(model_response=httpx.Response(500,text="PRIVATE_PROVIDER_MODEL_ERROR")) as (app,client,headers,device,stream,calls):
            response=client.post("/v1/chat",headers=headers,json={"text":"PRIVATE_COMMAND"})
            self.assertEqual("failed",response.json()["status"])
            failed=next(r for r in self.records(stream) if r["event"]=="agent.failed")
            self.assertEqual("upstream_http",failed["code"])
            self.assertNotIn("PRIVATE_PROVIDER_MODEL_ERROR",stream.getvalue())
            class BrokenPlanner:
                async def plan(self,*args):raise RuntimeError("PRIVATE_RAW_EXCEPTION")
            app.state.planner=BrokenPlanner()
            failed_http=client.post("/v1/chat",headers=headers,json={"text":"new PRIVATE_COMMAND"})
            self.assertEqual(500,failed_http.status_code)
            self.assertRegex(failed_http.headers["x-request-id"],r"^http_[0-9a-f]{32}$")
            self.assertNotIn("PRIVATE_RAW_EXCEPTION",stream.getvalue())
            self.assertNotIn("PRIVATE_RAW_EXCEPTION",failed_http.text)
            self.assertNotIn("Traceback",stream.getvalue())

    def test_opt_in_text_is_bounded_and_json_escaped(self):
        command='line one\n{"event":"forged"}\r\n'+"字"*250
        with self.scenario(command_text=True) as (app,client,headers,device,stream,calls):
            response=client.post("/v1/chat",headers=headers,json={"text":command})
            self.assertEqual(200,response.status_code)
            records=self.records(stream)
            received=next(r for r in records if r["event"]=="chat.received")
            self.assertEqual(command[:200],received["command_text"])
            self.assertTrue(received["command_text_truncated"])
            self.assertNotIn("forged",[r["event"] for r in records])
            for line in stream.getvalue().splitlines():
                if line.startswith('{"time":'):json.loads(line)
            event(app.state,"security.probe",authorization=device["token"],cookie="COOKIE_SECRET",
                  token=device["token"],headers={"secret":"HEADER_SECRET"},provider_error="RAW_ERROR")
            probe=next(r for r in self.records(stream) if r["event"]=="security.probe")
            self.assertEqual({"time","level","event"},set(probe))

    def test_debug_polling_and_unknown_url_never_log_queries(self):
        with self.scenario(log_level="DEBUG") as (app,client,headers,device,stream,calls):
            response=client.get("/health?token=PRIVATE_QUERY",headers={"Cookie":"PRIVATE_COOKIE",
                                "X-Request-ID":"PRIVATE_REQUEST_ID"})
            self.assertEqual(200,response.status_code)
            self.assertNotIn("PRIVATE_REQUEST_ID",response.headers["x-request-id"])
            client.get("/PRIVATE_UNKNOWN_PATH?apikey=PRIVATE_QUERY")
            events=self.records(stream)
            self.assertTrue(any(r.get("method")=="GET" and r["event"]=="http.received" for r in events))
            self.assertTrue(any(r.get("route")=="unmatched" for r in events))
            for marker in ("PRIVATE_QUERY","PRIVATE_COOKIE","PRIVATE_REQUEST_ID","PRIVATE_UNKNOWN_PATH"):
                self.assertNotIn(marker,stream.getvalue())

    def test_env_logging_config_is_read_without_rewriting_file(self):
        with tempfile.TemporaryDirectory() as directory:
            env=Path(directory)/"settings.env"
            original="ADMIN_BOOTSTRAP_TOKEN="+"a"*48+"\nLOG_LEVEL=warning\nLOG_COMMAND_TEXT=true\n"
            env.write_text(original)
            with patch.dict("os.environ",{},clear=True):cfg=Settings.from_env(env)
            self.assertEqual("WARNING",cfg.log_level);self.assertTrue(cfg.log_command_text)
            self.assertEqual(original,env.read_text())
            cfg.log_level="RAW_BODY"
            with self.assertRaises(ValueError):cfg.validate()

if __name__=="__main__":unittest.main()

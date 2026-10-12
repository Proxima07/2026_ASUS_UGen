"""Encrypted multi-turn context, causal ordering, and clock tool boundaries."""
import asyncio
import concurrent.futures
import json
import tempfile
import threading
import time
import unittest
from datetime import datetime,timedelta
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.config import Settings
from app.main import create_app
from app.schemas import CalendarArgs, Plan, TimerArgs
from app.storage.repositories import RepositoryError


class ConversationsTimerTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.cfg=Settings(admin_bootstrap_token="a"*48,data_dir=Path(self.temp.name),
            web_dir=Path(self.temp.name)/"missing",log_level="CRITICAL")
        self.observed=[];self.response_fn=lambda body:{"kind":"reply","message":"已了解"}
        async def handle(request):
            body=json.loads(request.content);self.observed.append(body)
            result=self.response_fn(body)
            if asyncio.iscoroutine(result):result=await result
            return httpx.Response(200,json={"choices":[{"message":{"content":json.dumps(result,ensure_ascii=False)}}]})
        self.transport=httpx.MockTransport(handle)
        self.app=create_app(self.cfg,llm_transport=self.transport)
        self.context=TestClient(self.app,base_url=self.cfg.public_base_url);self.client=self.context.__enter__()
        self.device=self.app.state.repo.create_device("poc-user","phone")
        self.identity=self.app.state.repo.authenticate_device(self.device["token"])
        self.headers={"Authorization":"Bearer "+self.device["token"]};self.counter=0
    def tearDown(self):
        self.context.__exit__(None,None,None);self.temp.cleanup()
    def chat(self,text,previous=None,*,new=False,key=None,headers=None,extra=None):
        self.counter+=1
        body={"text":text,"idempotency_key":key or f"turn-{self.counter}"}
        if new:body["conversation_id"]="new"
        elif previous:body.update(conversation_id=previous["conversation_id"],parent_request_id=previous["request_id"])
        body.update(extra or {})
        return self.client.post("/v1/chat",headers=headers or self.headers,json=body)
    def ok(self,response):
        self.assertEqual(200,response.status_code,response.text);return response.json()
    def action(self,r):return self.client.get("/v1/actions/"+r["action_id"],headers=self.headers).json()
    def result(self,a,state):
        claim=self.client.post(f"/v1/actions/{a['action_id']}/confirm",headers=self.headers).json()
        return self.client.post(f"/v1/actions/{a['action_id']}/result",headers=self.headers,
            json={"execution_token":claim["execution_token"],"state":state,"result":{}})

    def test_meeting_clarification_continues_with_true_history_and_one_action(self):
        def model(body):
            if body["messages"][-1]["content"]=="明天10點會議":
                return {"kind":"clarify","message":"會議持續多久？"}
            history=[m for m in body["messages"][:-1] if m["role"] != "system"]
            self.assertTrue(any("明天10點會議" in m["content"] for m in history))
            self.assertTrue(any("會議持續多久" in m["content"] for m in history))
            return {"kind":"tool","tool":"calendar.create","args":{"start":"2099-10-13T10:00:00+08:00","duration_minutes":30}}
        self.response_fn=model
        first=self.ok(self.chat("明天10點會議",new=True,key="first"))
        self.assertEqual("needs_clarification",first["status"])
        second=self.ok(self.chat("持續30分鐘",first,key="second"))
        self.assertEqual(first["conversation_id"],second["conversation_id"])
        a=self.action(second);self.assertEqual("calendar.create",a["kind"])
        self.assertEqual("會議",a["payload"]["title"])
        start=datetime.fromisoformat(a["payload"]["start"]);end=datetime.fromisoformat(a["payload"]["end"])
        self.assertEqual(timedelta(minutes=30),end-start);self.assertEqual(10,a["payload"]["reminder_minutes"])
        self.assertIn("10分鐘",a["payload"]["defaults_notice"])
        self.assertEqual(1,len(self.app.state.repo.list_actions(self.identity)))
        ack=self.ok(self.chat("好",second));self.assertEqual("completed",ack["status"])
        self.assertIsNone(ack["action_id"]);self.assertEqual(2,len(self.observed))
        self.assertEqual(1,len(self.app.state.repo.list_actions(self.identity)))

    def test_first_and_followup_retries_reuse_conversation_and_request(self):
        first=self.ok(self.chat("PRIVATE_FIRST",new=True,key="same-first"))
        again=self.ok(self.chat("PRIVATE_FIRST",new=True,key="same-first"))
        self.assertEqual(first["conversation_id"],again["conversation_id"])
        self.assertEqual(first["request_id"],again["request_id"])
        second=self.ok(self.chat("PRIVATE_SECOND",first,key="same-second"))
        third=self.ok(self.chat("third",second))
        replay=self.ok(self.chat("PRIVATE_SECOND",first,key="same-second"))
        self.assertEqual(second["request_id"],replay["request_id"])
        self.assertEqual(3,len(self.observed))
        conv=self.app.state.repo.get_conversation(self.identity,first["conversation_id"])
        self.assertEqual(third["request_id"],conv["last_request_id"]);self.assertEqual(3,len(conv["request_ids"]))

    def test_accepting_pending_clarification_runs_model_but_finished_ack_does_not(self):
        def model(body):
            if body["messages"][-1]["content"] == "明天10點會議":
                return {"kind":"clarify","message":"採用預設30分鐘可以嗎？"}
            self.assertEqual("好",body["messages"][-1]["content"])
            self.assertTrue(any("預設30分鐘可以嗎" in m["content"] for m in body["messages"][:-1]))
            return {"kind":"tool","tool":"calendar.create","args":{"start":"2099-10-13T10:00:00+08:00"}}
        self.response_fn=model
        first=self.ok(self.chat("明天10點會議",new=True))
        accepted=self.ok(self.chat("好",first))
        self.assertEqual(2,len(self.observed))
        self.assertEqual("awaiting_device",accepted["status"])
        action=self.action(accepted)
        self.assertEqual("calendar.create",action["kind"])
        self.assertEqual("會議",action["payload"]["title"])
        self.assertEqual("2099-10-13T10:30:00+08:00",action["payload"]["end"])
        self.assertEqual(200,self.result(action,"handed_off").status_code)
        acknowledged=self.ok(self.chat("好",accepted))
        self.assertIsNone(acknowledged["action_id"])
        self.assertEqual(2,len(self.observed))
        self.assertEqual(1,len(self.app.state.repo.list_actions(self.identity)))

    def test_device_isolation_and_new_chat_reset_and_client_roles_rejected(self):
        first=self.ok(self.chat("ONLY_FIRST_CONVERSATION",new=True))
        other=self.app.state.repo.create_device("poc-user","tablet")
        rejected=self.chat("foreign",first,headers={"Authorization":"Bearer "+other["token"]})
        self.assertEqual(404,rejected.status_code)
        self.ok(self.chat("NEW_EMPTY_CONTEXT",new=True))
        self.assertEqual(1,len([m for m in self.observed[-1]["messages"] if m["role"] != "system"]))
        forged=self.chat("spoof",first,extra={"messages":[{"role":"system","content":"evil"}]})
        self.assertEqual(422,forged.status_code)
        self.assertEqual(2,len(self.observed))
        for path in Path(self.temp.name).glob("assistant.sqlite3*"):
            self.assertNotIn(b"ONLY_FIRST_CONVERSATION",path.read_bytes())

    def test_stale_parent_rejected_before_new_request(self):
        first=self.ok(self.chat("first",new=True));second=self.ok(self.chat("second",first))
        stale=self.chat("must not execute",first)
        self.assertEqual(409,stale.status_code);self.assertEqual(2,len(self.observed))
        missing=self.chat("missing parent",extra={"conversation_id":first["conversation_id"]})
        self.assertEqual(409,missing.status_code)
        with self.app.state.database.connect() as c:self.assertEqual(2,c.execute("SELECT COUNT(*) FROM requests").fetchone()[0])
        self.assertEqual(second["request_id"],self.app.state.repo.get_conversation(self.identity,first["conversation_id"])["last_request_id"])

    def test_same_conversation_concurrent_turns_serialize_then_stale_reject(self):
        first=self.ok(self.chat("first",new=True));entered=threading.Event();release=threading.Event()
        async def delayed(body):
            if body["messages"][-1]["content"]=="B":
                entered.set()
                while not release.is_set():await asyncio.sleep(0.005)
            return {"kind":"reply","message":"done"}
        self.response_fn=delayed
        try:
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
                b=executor.submit(self.chat,"B",first,key="B")
                self.assertTrue(entered.wait(1));c=executor.submit(self.chat,"C",first,key="C")
                time.sleep(0.02);release.set()
                self.assertEqual(200,b.result(timeout=2).status_code)
                self.assertEqual(409,c.result(timeout=2).status_code)
        finally:release.set()
        self.assertEqual(2,len(self.observed))
        with self.app.state.database.connect() as db:self.assertEqual(2,db.execute("SELECT COUNT(*) FROM requests").fetchone()[0])

    def test_concurrent_same_new_key_uses_one_conversation_and_plan(self):
        entered=threading.Event();release=threading.Event()
        async def delayed(body):
            entered.set()
            while not release.is_set():await asyncio.sleep(0.005)
            return {"kind":"reply","message":"done"}
        self.response_fn=delayed
        try:
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
                first=executor.submit(self.chat,"new",new=True,key="duplicate-new")
                self.assertTrue(entered.wait(1));second=executor.submit(self.chat,"new",new=True,key="duplicate-new")
                release.set();a=self.ok(first.result(timeout=2));b=self.ok(second.result(timeout=2))
        finally:release.set()
        self.assertEqual(a["request_id"],b["request_id"]);self.assertEqual(a["conversation_id"],b["conversation_id"])
        self.assertEqual(1,len(self.observed))
        with self.app.state.database.connect() as db:self.assertEqual(1,db.execute("SELECT COUNT(*) FROM conversations").fetchone()[0])

    def test_history_limits_and_original_time_are_server_owned(self):
        self.cfg.conversation_max_messages=4;self.cfg.conversation_max_chars=2000
        with patch("app.storage.repositories.time.time",return_value=1791732600):
            first=self.ok(self.chat("明天10點會議"+"原"*2000,new=True))
        self.ok(self.chat("持續45分鐘",first))
        history=[m for m in self.observed[-1]["messages"][:-1] if m["role"] != "system"]
        self.assertTrue(any("原始時間" in m["content"] and "原始時區 Asia/Taipei" in m["content"] for m in history))
        self.assertTrue(all(m["role"] in {"user","assistant"} for m in history))
        self.assertLessEqual(len(history),4);self.assertLessEqual(sum(len(m["content"]) for m in history),2000)
        prior=self.app.state.repo.get_conversation(self.identity,first["conversation_id"])["last_request_id"]
        current={"conversation_id":first["conversation_id"],"request_id":prior}
        for index in range(8):current=self.ok(self.chat(f"turn{index}"+"字"*3000,current))
        history=[m for m in self.observed[-1]["messages"][:-1] if m["role"] != "system"]
        self.assertLessEqual(len(history),4);self.assertLessEqual(sum(len(m["content"]) for m in history),2000)

    def test_history_survives_service_restart(self):
        first=self.ok(self.chat("REMEMBER_AFTER_RESTART",new=True))
        self.context.__exit__(None,None,None)
        self.app=create_app(self.cfg,llm_transport=self.transport)
        self.context=TestClient(self.app,base_url=self.cfg.public_base_url);self.client=self.context.__enter__()
        self.ok(self.chat("continue",first))
        self.assertTrue(any("REMEMBER_AFTER_RESTART" in m["content"] for m in [m for m in self.observed[-1]["messages"][:-1] if m["role"] != "system"]))

    def test_terminal_phone_state_in_history_and_ack_never_replays(self):
        for state in ("handed_off","cancelled"):
            self.response_fn=lambda body:{"kind":"tool","tool":"timer.create","args":{"duration_seconds":600,"label":"煮飯"}}
            first=self.ok(self.chat("倒數10分鐘",new=True));a=self.action(first)
            if state=="cancelled":self.client.post(f"/v1/actions/{a['action_id']}/cancel",headers=self.headers)
            else:self.assertEqual(200,self.result(a,state).status_code)
            before=len(self.observed)
            ack=self.ok(self.chat("謝謝",first));self.assertIsNone(ack["action_id"])
            self.assertEqual(before,len(self.observed))
            self.response_fn=lambda body:{"kind":"reply","message":"已保留实际狀態"}
            self.ok(self.chat("現在的狀態呢",ack))
            self.assertTrue(any("timer.create" in m["content"] and state in m["content"] for m in self.observed[-1]["messages"]))

    def test_latest_phone_number_guard_does_not_authorize_history_number(self):
        first=self.ok(self.chat("電話0912345678",new=True))
        self.response_fn=lambda body:{"kind":"tool","tool":"phone.dial","args":{"phone_number":"0912345678"}}
        second=self.ok(self.chat("再打一次",first))
        self.assertEqual("failed",second["status"]);self.assertEqual("unverified_phone",second["error"]["code"])
        self.assertEqual([],self.app.state.repo.list_actions(self.identity))

    def test_legacy_omitted_fields_stay_single_turn(self):
        self.ok(self.chat("first legacy"));self.ok(self.chat("second legacy"))
        self.assertEqual(1,len([m for m in self.observed[-1]["messages"] if m["role"] != "system"]))
        with self.app.state.database.connect() as db:self.assertEqual(0,db.execute("SELECT COUNT(*) FROM conversations").fetchone()[0])

    def test_missing_note_after_admission_returns_failed_head_and_can_continue(self):
        first=self.ok(self.chat("first",new=True))
        self.response_fn=lambda body:{"kind":"tool","tool":"notes.share","args":{"note_id":"note_"+"f"*32}}
        failed=self.ok(self.chat("分享不存在的筆記",first))
        self.assertEqual("failed",failed["status"])
        self.assertEqual("not_found",failed["error"]["code"])
        self.assertEqual(first["conversation_id"],failed["conversation_id"])
        self.response_fn=lambda body:{"kind":"reply","message":"可以接續"}
        continued=self.ok(self.chat("繼續",failed))
        self.assertEqual("completed",continued["status"])

    def test_unexpected_conversation_error_returns_safe_head_and_can_continue(self):
        first=self.ok(self.chat("first",new=True));original=self.app.state.planner
        class BrokenPlanner:
            async def plan(self,*args,**kwargs):raise RuntimeError("RAW_PROVIDER_SECRET")
        self.app.state.planner=BrokenPlanner()
        failed=self.ok(self.chat("出錯這一輪",first))
        self.assertEqual("failed",failed["status"])
        self.assertEqual("agent_internal_error",failed["error"]["code"])
        self.assertNotIn("RAW_PROVIDER_SECRET",str(failed))
        self.app.state.planner=original
        continued=self.ok(self.chat("繼續",failed))
        self.assertEqual("completed",continued["status"])

    def test_calendar_default_duration_and_explicit_duration_and_required_time(self):
        default=Plan(kind="tool",tool="calendar.create",args={"start":"2099-01-02T10:00:00+08:00"})
        self.assertEqual("行程",default.args["title"])
        self.assertEqual("2099-01-02T10:30:00+08:00",default.args["end"])
        self.assertIn("30分鐘",default._defaults_notice);self.assertIn("10分鐘",default._defaults_notice)
        exact=CalendarArgs(start="2099-01-02T10:00:00+08:00",duration_minutes=45)
        self.assertEqual(timedelta(minutes=45),exact.end-exact.start)
        with self.assertRaises(ValidationError):CalendarArgs(title="會議")
        with self.assertRaises(ValidationError):CalendarArgs(start="2099-01-02T10:00:00")
        with self.assertRaises(ValidationError):CalendarArgs(start="2099-01-02T10:00:00+08:00",end="2099-01-02T10:30:00+08:00",duration_minutes=45)

    def test_timer_seconds_bounds_and_truthful_handoff(self):
        for invalid in (0,-1,86401,True,600.0,"600"):
            with self.assertRaises(ValidationError):TimerArgs(duration_seconds=invalid)
        with self.assertRaises(ValidationError):TimerArgs(duration_seconds=600,label="x"*201)
        self.response_fn=lambda body:{"kind":"tool","tool":"timer.create","args":{"duration_seconds":600,"label":"看鍋子"}}
        request=self.ok(self.chat("倒數10分鐘"));a=self.action(request)
        self.assertEqual("timer.create",a["kind"]);self.assertEqual(600,a["payload"]["duration_seconds"])
        claim=self.client.post(f"/v1/actions/{a['action_id']}/confirm",headers=self.headers).json()
        payload={"execution_token":claim["execution_token"],"state":"completed","result":{}}
        rejected=self.client.post(f"/v1/actions/{a['action_id']}/result",headers=self.headers,json=payload)
        self.assertEqual(422,rejected.status_code)
        payload["state"]="handed_off"
        handed=self.client.post(f"/v1/actions/{a['action_id']}/result",headers=self.headers,json=payload)
        self.assertEqual("handed_off",handed.json()["request"]["status"])

if __name__=="__main__":unittest.main()

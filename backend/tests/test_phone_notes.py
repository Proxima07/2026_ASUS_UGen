"""External phone notes handoff, explicit platform storage, and native boundaries."""
import tempfile
import unittest
from pathlib import Path
from fastapi.testclient import TestClient
from app.agent.policy import PolicyError, validate_result
from app.config import Settings
from app.main import create_app
from app.schemas import Plan

class FakePlanner:
    async def plan(self, text, timezone):
        if text == "create":
            return Plan(kind="tool", tool="notes.create", args={"title":"購物","content":"買牛奶","transcript":"記下買牛奶"})
        if text == "update":
            return Plan(kind="tool", tool="notes.update", args={"query":"購物","content":"雞蛋","mode":"append"})
        return Plan(kind="tool", tool="notes.search", args={"query":"購物"})

class PhoneNotesTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        cfg = Settings(admin_bootstrap_token="a"*48,data_dir=Path(self.temp.name),web_dir=Path(self.temp.name)/"missing")
        self.app = create_app(cfg)
        self.context = TestClient(self.app,base_url="https://assistant.example.com")
        self.client = self.context.__enter__()
        self.app.state.planner = FakePlanner()
        d = self.app.state.repo.create_device("poc-user","phone")
        self.identity = self.app.state.repo.authenticate_device(d["token"])
        self.headers = {"Authorization":"Bearer "+d["token"]}
        self.seq = 0
    def tearDown(self):
        self.context.__exit__(None,None,None)
        self.temp.cleanup()
    def chat(self,text="create",caps=None,target="phone_first",key=None):
        self.seq += 1
        response = self.client.post("/v1/chat",headers=self.headers,json={"text":text,"note_target":target,
            "native_capabilities":caps if caps is not None else ["notes.create_native"],
            "idempotency_key":key or f"request-{self.seq}"})
        self.assertEqual(200,response.status_code,response.text)
        return response.json()
    def action(self,r):
        return self.client.get("/v1/actions/"+r["action_id"],headers=self.headers).json()
    def claim(self,a):
        r = self.client.post(f"/v1/actions/{a['action_id']}/confirm",headers=self.headers)
        self.assertEqual(200,r.status_code,r.text)
        return r.json()["execution_token"]
    def result(self,a,state,data=None,token=None):
        token = token or self.claim(a)
        r = self.client.post(f"/v1/actions/{a['action_id']}/result",headers=self.headers,
            json={"execution_token":token,"state":state,"result":data or {}})
        self.assertEqual(200,r.status_code,r.text)
        return r.json()["request"],token
    def notes(self):
        return self.client.get("/v1/notes",headers=self.headers).json()["items"]
    def add(self,title="購物",content="牛奶"):
        return self.client.post("/v1/notes",headers=self.headers,json={"title":title,"content":content}).json()

    def test_native_create_handoff_preserves_content_no_platform_copy_and_replay(self):
        r=self.chat(key="one");a=self.action(r)
        self.assertEqual("notes.create_native",a["kind"])
        self.assertEqual({"title":"購物","content":"買牛奶","transcript":"記下買牛奶"},a["payload"])
        self.assertEqual("phone_app",r["storage_target"])
        self.assertIn("尚未保存",r["message"])
        self.assertEqual([],self.notes())
        r,t=self.result(a,"handed_off")
        self.assertEqual("handed_off",r["status"])
        self.assertIn("尚未驗證",r["message"])
        repeat,_=self.result(a,"handed_off",token=t)
        self.assertEqual(r,repeat)
        self.assertEqual(r["request_id"],self.chat(key="one")["request_id"])
        self.assertEqual([],self.notes())

    def test_failures_cancel_and_expiry_do_not_create_automatic_platform_backup(self):
        for state in ("failed","unsupported","permission_denied","cancelled"):
            a=self.action(self.chat())
            r,t=self.result(a,state)
            self.assertEqual("phone_app",r["storage_target"])
            self.assertFalse(r["fallback"])
            self.assertEqual(state,r["status"])
            repeat,_=self.result(a,state,token=t)
            self.assertEqual(r,repeat)
            self.assertEqual([],self.notes())
        a=self.action(self.chat())
        r=self.app.state.dispatcher.after_result(self.identity,{**a,"state":"execution_expired"})
        self.assertEqual("execution_expired",r["status"])
        self.assertEqual([],self.notes())

    def test_browser_and_old_private_capabilities_are_unsupported_without_fallback(self):
        for caps in ([],["notes.save_local"],["notes.search_local","notes.update_local"]):
            r=self.chat(caps=caps)
            self.assertEqual("unsupported",r["status"])
            self.assertIsNone(r["action_id"])
            self.assertFalse(r["fallback"])
        response=self.client.post("/v1/chat",headers=self.headers,json={"text":"create"})
        self.assertEqual("unsupported",response.json()["status"])
        self.assertEqual([],self.notes())

    def test_native_notes_cannot_claim_completed(self):
        a=self.action(self.chat());t=self.claim(a)
        r=self.client.post(f"/v1/actions/{a['action_id']}/result",headers=self.headers,
            json={"execution_token":t,"state":"completed","result":{"note_id":"made-up"}})
        self.assertEqual(422,r.status_code)
        self.assertEqual("claimed",self.action(a)["state"])
        with self.assertRaises(PolicyError):validate_result("notes.create_native","completed",{})
        r,_=self.result(a,"opened",token=t)
        self.assertEqual("opened",r["status"])
        self.assertIn("尚未驗證",r["message"])

    def test_native_read_update_unsupported_even_when_old_private_capabilities_advertised(self):
        original=self.add()
        for text in ("search","update"):
            r=self.chat(text,caps=["notes.create_native","notes.search_local","notes.update_local"])
            self.assertEqual("unsupported",r["status"])
            self.assertIsNone(r["action_id"])
            self.assertEqual("phone_app",r["storage_target"])
            self.assertFalse(r["fallback"])
        self.assertEqual([original],self.notes())

    def test_explicit_platform_create_lookup_and_update(self):
        r=self.chat(target="platform")
        self.assertFalse(r["fallback"]);self.assertEqual("platform",r["storage_target"])
        search=self.chat("search",target="platform")
        self.assertEqual([r["note"]],search["notes"])
        updated=self.chat("update",target="platform")
        self.assertEqual("買牛奶\n雞蛋",updated["note"]["content"])
        self.assertEqual(1,len(self.notes()))

    def test_platform_ambiguity_requires_owned_selection_and_never_reads_other_device(self):
        self.add("購物A","牛奶");target=self.add("購物B","麵包")
        r=self.chat("update",caps=[],target="platform")
        self.assertEqual("needs_note_selection",r["status"])
        d=self.app.state.repo.create_device("poc-user","tablet")
        url=f"/v1/requests/{r['request_id']}/select-note"
        choice=next(n["candidate_id"] for n in r["note_candidates"] if n["note_id"]==target["note_id"])
        self.assertEqual(404,self.client.post(url,headers={"Authorization":"Bearer "+d["token"]},json={"candidate_id":choice}).status_code)
        selected=self.client.post(url,headers=self.headers,json={"candidate_id":choice})
        self.assertEqual(200,selected.status_code,selected.text)
        self.assertEqual("麵包\n雞蛋",selected.json()["note"]["content"])

    def test_hints_never_grant_auth_and_context_conflicts(self):
        r=self.client.post("/v1/chat",headers=self.headers,json={"text":"create","native_capabilities":["notes.delete_anything"]})
        self.assertEqual(422,r.status_code)
        r=self.client.post("/v1/chat",json={"text":"create","native_capabilities":["notes.create_native"]})
        self.assertEqual(401,r.status_code)
        request=self.chat(key="same")
        r=self.client.post("/v1/chat",headers=self.headers,json={"text":"create","note_target":"platform","native_capabilities":[],"idempotency_key":"same"})
        self.assertEqual(409,r.status_code)
        self.client.post("/v1/auth/session",headers=self.headers)
        r=self.client.post(f"/v1/actions/{request['action_id']}/confirm",headers={"Origin":"https://assistant.example.com"})
        self.assertEqual(403,r.status_code)

    def test_existing_v2_request_reuses_idempotency_without_new_fields(self):
        old=self.app.state.repo.create_request(self.identity,"create",{"timezone":"Asia/Taipei"},"v2-replay")
        self.app.state.repo.update_request(self.identity,old["request_id"],{"status":"completed","message":"既有結果"})
        response=self.client.post("/v1/chat",headers=self.headers,json={"text":"create","idempotency_key":"v2-replay"})
        self.assertEqual(200,response.status_code,response.text)
        self.assertEqual(old["request_id"],response.json()["request_id"])
        self.assertEqual("既有結果",response.json()["message"])

    def test_direct_native_draft_no_platform_intermediate_and_deduplicates(self):
        body={"title":"錄音筆記","content":"逐字稿摘要","transcript":"私人逐字稿","idempotency_key":"draft-one"}
        response=self.client.post("/v1/notes/native-actions",headers=self.headers,json=body)
        self.assertEqual(200,response.status_code,response.text)
        a=response.json()
        self.assertEqual("notes.create_native",a["kind"])
        self.assertIsNone(a["request_id"])
        self.assertEqual("私人逐字稿",a["payload"]["transcript"])
        self.assertEqual(a,self.client.post("/v1/notes/native-actions",headers=self.headers,json=body).json())
        self.assertEqual(409,self.client.post("/v1/notes/native-actions",headers=self.headers,json={**body,"content":"different"}).status_code)
        self.assertEqual(401,self.client.post("/v1/notes/native-actions",json=body).status_code)
        self.assertEqual([],self.notes())

    def test_old_private_note_export_name_maps_external_handoff(self):
        note=self.add()
        r=self.client.post(f"/v1/notes/{note['note_id']}/actions",headers=self.headers,json={"kind":"notes.save_local"})
        self.assertEqual(200,r.status_code,r.text)
        self.assertEqual("notes.create_native",r.json()["kind"])
        self.assertEqual(note["content"],r.json()["payload"]["content"])
        with self.assertRaises(ValueError):Plan(kind="tool",tool="notes.save_local",args={"note_id":note["note_id"]})

    def test_pending_platform_update_is_immutable(self):
        r=self.chat("update",target="platform")
        with self.assertRaises(PolicyError):
            self.app.state.dispatcher.apply(self.identity,r["request_id"],Plan(kind="tool",tool="notes.update",args={"query":"購物","content":"不同內容"}),"update")
        self.assertEqual("雞蛋",self.app.state.repo.get_request(self.identity,r["request_id"])["pending_note_update"]["content"])

if __name__=="__main__":unittest.main()

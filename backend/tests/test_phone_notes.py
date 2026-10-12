"""Phone-first routing and authenticated, idempotent note continuations."""
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
            "native_capabilities":caps if caps is not None else ["notes.save_local","notes.search_local","notes.update_local"],
            "idempotency_key":key or f"request-{self.seq}"})
        self.assertEqual(200,response.status_code,response.text)
        return response.json()
    def action(self,r):
        return self.client.get("/v1/actions/"+r["action_id"],headers=self.headers).json()
    def claim(self,a):
        r = self.client.post(f"/v1/actions/{a['action_id']}/confirm",headers=self.headers)
        self.assertEqual(200,r.status_code,r.text)
        return r.json()["execution_token"]
    def result(self,a,state,data,token=None):
        token = token or self.claim(a)
        r = self.client.post(f"/v1/actions/{a['action_id']}/result",headers=self.headers,
            json={"execution_token":token,"state":state,"result":data})
        self.assertEqual(200,r.status_code,r.text)
        return r.json()["request"],token
    def notes(self):
        return self.client.get("/v1/notes",headers=self.headers).json()["items"]
    def add(self,title="購物",content="牛奶"):
        return self.client.post("/v1/notes",headers=self.headers,json={"title":title,"content":content}).json()

    def test_phone_create_no_platform_copy_and_success_replay(self):
        r=self.chat(key="one");a=self.action(r)
        self.assertEqual("notes.save_local",a["kind"])
        self.assertTrue(a["payload"]["note_id"].startswith("phone_note_"))
        self.assertEqual("記下買牛奶",a["payload"]["transcript"])
        self.assertEqual([],self.notes())
        r,t=self.result(a,"completed",{"note_id":a["payload"]["note_id"]})
        self.assertEqual("phone",r["storage_target"])
        self.assertEqual("completed",r["status"])
        repeat,_=self.result(a,"completed",{"note_id":a["payload"]["note_id"]},t)
        self.assertEqual(r,repeat)
        self.assertEqual(r["request_id"],self.chat(key="one")["request_id"])
        self.assertEqual([],self.notes())

    def test_definitive_failure_saves_platform_exactly_once(self):
        for state in ("failed","unsupported","permission_denied"):
            before=len(self.notes());a=self.action(self.chat())
            r,t=self.result(a,state,{})
            self.assertEqual("platform",r["storage_target"])
            self.assertTrue(r["fallback"])
            self.assertEqual(before+1,len(self.notes()))
            repeat,_=self.result(a,state,{},t)
            self.assertEqual(r,repeat)
            self.assertEqual(before+1,len(self.notes()))

    def test_cancel_uncertainty_and_expiry_have_no_backup(self):
        a=self.action(self.chat())
        r=self.client.post(f"/v1/actions/{a['action_id']}/cancel",headers=self.headers)
        self.assertEqual("cancelled",r.json()["request"]["status"])
        for data in ({"uncertain":True},{"code":"execution_timeout"},{"code":"result_not_synced"}):
            r,_=self.result(self.action(self.chat()),"failed",data)
            self.assertEqual("failed",r["status"])
        a=self.action(self.chat())
        r=self.app.state.dispatcher.after_result(self.identity,{**a,"state":"execution_expired"})
        self.assertEqual("execution_expired",r["status"])
        self.assertEqual([],self.notes())

    def test_browser_fallback_and_platform_default(self):
        r=self.chat(caps=[])
        self.assertEqual("platform",r["storage_target"]);self.assertTrue(r["fallback"])
        self.assertIn("手機",r["message"])
        r=self.chat(target="platform")
        self.assertFalse(r["fallback"]);self.assertEqual(2,len(self.notes()))

    def test_hints_never_grant_auth_and_context_conflicts(self):
        r=self.client.post("/v1/chat",headers=self.headers,json={"text":"create","native_capabilities":["notes.delete_anything"]})
        self.assertEqual(422,r.status_code)
        r=self.client.post("/v1/chat",json={"text":"create","note_target":"phone_first","native_capabilities":["notes.save_local"]})
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

    def test_lookup_returns_metadata_without_platform_copy(self):
        a=self.action(self.chat("search"));self.assertEqual("lookup",a["payload"]["purpose"])
        notes=[{"note_id":"phone-a","title":"購物","preview":"牛奶"}]
        r,_=self.result(a,"completed",{"notes":notes})
        self.assertEqual(notes,r["notes"]);self.assertEqual("phone",r["storage_target"])
        self.assertEqual([],self.notes())

    def test_metadata_rejects_bodies_duplicates_and_size(self):
        cases=[{"notes":[{"note_id":"a","title":"title","content":"private"}]},
               {"notes":[{"note_id":"a","title":"title","preview":"x"*501}]},
               {"notes":[{"note_id":"a","title":"title"}]*2},
               {"notes":[{"note_id":str(i),"title":"title"} for i in range(21)]},
               {"notes":[],"content":"private"}]
        for invalid in cases:
            with self.assertRaises(PolicyError):validate_result("notes.search_local","completed",invalid)

    def test_phone_update_exact_target_and_stale_search_replay(self):
        search=self.action(self.chat("update"))
        found={"notes":[{"note_id":"phone-a","title":"購物"}]}
        r,t=self.result(search,"completed",found)
        update=self.action(r)
        self.assertEqual("notes.update_local",update["kind"])
        self.assertEqual({"note_id":"phone-a","content":"雞蛋","mode":"append",
            "current_title":"購物","current_preview":""},update["payload"])
        r,_=self.result(update,"completed",{"note_id":"phone-a"})
        self.assertEqual("completed",r["status"]);self.assertEqual("phone",r["storage_target"])
        repeat,_=self.result(search,"completed",found,t)
        self.assertEqual(r,repeat);self.assertEqual([],self.notes())

    def test_matching_note_id_required_before_final_commit(self):
        a=self.action(self.chat());t=self.claim(a)
        for data in ({},{"note_id":"wrong"}):
            r=self.client.post(f"/v1/actions/{a['action_id']}/result",headers=self.headers,
                json={"execution_token":t,"state":"completed","result":data})
            self.assertEqual(422,r.status_code,r.text)
            self.assertEqual("claimed",self.action(a)["state"])
        r,_=self.result(a,"completed",{"note_id":a["payload"]["note_id"]},t)
        self.assertEqual("phone",r["storage_target"])

    def test_multiple_phone_notes_require_owned_selection(self):
        a=self.action(self.chat("update"))
        r,_=self.result(a,"completed",{"notes":[{"note_id":"phone-a","title":"購物A"},{"note_id":"phone-b","title":"購物B"}]})
        self.assertEqual("needs_note_selection",r["status"])
        url=f"/v1/requests/{r['request_id']}/select-note"
        self.assertEqual(422,self.client.post(url,headers=self.headers,json={"candidate_id":"forged"}).status_code)
        d=self.app.state.repo.create_device("poc-user","tablet")
        self.assertEqual(404,self.client.post(url,headers={"Authorization":"Bearer "+d["token"]},json={"candidate_id":r["note_candidates"][0]["candidate_id"]}).status_code)
        selected=self.client.post(url,headers=self.headers,json={"candidate_id":r["note_candidates"][1]["candidate_id"]})
        self.assertEqual(200,selected.status_code,selected.text)
        self.assertEqual("phone-b",self.action(selected.json())["payload"]["note_id"])

    def test_zero_native_matches_updates_unique_platform_once(self):
        note=self.add();a=self.action(self.chat("update"))
        r,t=self.result(a,"completed",{"notes":[]})
        self.assertEqual("platform",r["storage_target"]);self.assertTrue(r["fallback"])
        self.assertEqual("牛奶\n雞蛋",r["note"]["content"])
        repeat,_=self.result(a,"completed",{"notes":[]},t)
        self.assertEqual(r,repeat)
        self.assertEqual(note["note_id"],self.notes()[0]["note_id"])
        self.assertEqual("牛奶\n雞蛋",self.notes()[0]["content"])

    def test_update_failure_never_invents_note(self):
        a=self.action(self.chat("update"))
        r,_=self.result(a,"completed",{"notes":[{"note_id":"phone-a","title":"購物"}]})
        r,_=self.result(self.action(r),"unsupported",{})
        self.assertEqual("needs_clarification",r["status"]);self.assertEqual([],self.notes())

    def test_ambiguous_platform_update_requires_selection(self):
        self.add("購物A","牛奶");target=self.add("購物B","麵包")
        r=self.chat("update",caps=[])
        self.assertEqual("needs_note_selection",r["status"])
        selected=self.client.post(f"/v1/requests/{r['request_id']}/select-note",headers=self.headers,
            json={"candidate_id":next(n["candidate_id"] for n in r["note_candidates"] if n["note_id"]==target["note_id"])})
        self.assertEqual(200,selected.status_code,selected.text)
        self.assertEqual("麵包\n雞蛋",selected.json()["note"]["content"]);self.assertEqual(2,len(self.notes()))

    def test_pending_update_is_immutable(self):
        r=self.chat("update")
        with self.assertRaises(PolicyError):
            self.app.state.dispatcher.apply(self.identity,r["request_id"],Plan(kind="tool",tool="notes.update",args={"query":"購物","content":"不同內容"}),"update")
        self.assertEqual("雞蛋",self.app.state.repo.get_request(self.identity,r["request_id"])["pending_note_update"]["content"])

if __name__=="__main__":unittest.main()

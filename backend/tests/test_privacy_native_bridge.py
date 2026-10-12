"""Pairing isolation, legacy credential migration, and file-recording bridge bounds."""
import json
import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient
from pydantic import TypeAdapter, ValidationError

from app.config import Settings
from app.main import create_app
from app.schemas import BridgeProtocol, Plan
from app.storage.database import Database
from app.storage.repositories import Repository, RepositoryError, hash_token


class PrivacyAPITests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.cfg=Settings(admin_bootstrap_token="private-test-admin-"+"x"*40,data_dir=Path(self.tmp.name),
            public_base_url="https://assistant.example.com",web_dir=Path(self.tmp.name)/"absent")
        self.app=create_app(self.cfg)
        self.context=TestClient(self.app,base_url=self.cfg.public_base_url)
        self.client=self.context.__enter__()
        self.admin={"X-Bootstrap-Token":self.cfg.admin_bootstrap_token}
    def tearDown(self):
        self.context.__exit__(None,None,None)
        self.tmp.cleanup()
    def pair(self,label="same label",user=None):
        code=self.client.post("/v1/auth/pairing-codes",headers=self.admin,
            json={"user_id":user} if user is not None else None)
        self.assertEqual(200,code.status_code,code.text)
        r=self.client.post("/v1/auth/pair",json={"code":code.json()["code"],"label":label})
        self.assertEqual(200,r.status_code,r.text)
        return r.json()
    @staticmethod
    def auth(device):return {"Authorization":"Bearer "+device["token"]}

    def test_separate_pair_codes_never_share_user_even_same_label_and_default_env(self):
        self.cfg.default_user_id="everyone-used-to-be-here"
        a=self.pair();b=self.pair()
        self.assertNotEqual(a["user_id"],b["user_id"])
        self.assertRegex(a["user_id"],r"^usr_[a-f0-9]{32}$")
        self.assertNotEqual(self.cfg.default_user_id,a["user_id"])
        note=self.client.post("/v1/notes",headers=self.auth(a),json={"title":"A secret","content":"A PRIVATE"}).json()
        self.assertEqual([],self.client.get("/v1/notes",headers=self.auth(b)).json()["items"])
        self.assertEqual(404,self.client.get("/v1/notes/"+note["note_id"],headers=self.auth(b)).status_code)

    def test_legacy_same_user_notes_block_every_read_write_export_search_path(self):
        repo=self.app.state.repo
        a=repo.create_device("poc-user","A");b=repo.create_device("poc-user","B")
        ah,bh=self.auth(a),self.auth(b)
        note=self.client.post("/v1/notes",headers=ah,json={"title":"secret title","content":"secret body"}).json()
        path="/v1/notes/"+note["note_id"]
        for endpoint in ("/v1/notes","/v1/notes?q=secret"):
            r=self.client.get(endpoint,headers=bh)
            self.assertEqual(200,r.status_code)
            self.assertEqual([],r.json()["items"])
        self.assertEqual(404,self.client.get(path,headers=bh).status_code)
        self.assertEqual(404,self.client.put(path,headers=bh,json={"title":"hijack","content":"bad"}).status_code)
        self.assertEqual(404,self.client.delete(path,headers=bh).status_code)
        for kind in ("notes.share","notes.create_native","notes.save_local"):
            self.assertEqual(404,self.client.post(path+"/actions",headers=bh,json={"kind":kind}).status_code)
        self.assertEqual(note,self.client.get(path,headers=ah).json())
        class Search:
            async def plan(self,text,timezone):return Plan(kind="tool",tool="notes.search",args={"query":"secret"})
        self.app.state.planner=Search()
        r=self.client.post("/v1/chat",headers=bh,json={"text":"search","note_target":"platform"})
        self.assertEqual(200,r.status_code,r.text)
        self.assertEqual([],r.json()["notes"])
        self.assertNotIn("secret body",json.dumps(r.json()))

    def test_same_user_device_actions_audio_conversation_sources_stay_private(self):
        repo=self.app.state.repo
        a=repo.create_device("poc-user","A");b=repo.create_device("poc-user","B")
        identity=repo.authenticate_device(a["token"]);bh=self.auth(b)
        request=repo.create_request(identity,"A PRIVATE")
        conversation=repo.create_conversation_for_request(identity,request["request_id"])
        repo.append_conversation_request(identity,conversation,request["request_id"],None)
        repo.update_request(identity,request["request_id"],{"status":"completed","message":"private"})
        action=repo.create_action(identity,"notes.create_native",{"title":"private","content":"private"},request["request_id"])
        job_id="job_"+"a"*32
        repo.put_job(identity,job_id,{"purpose":"command","status":"transcribed","transcript":"private"})
        for path in ("/v1/requests/"+request["request_id"],"/v1/actions/"+action["action_id"],"/v1/audio/"+job_id):
            self.assertEqual(404,self.client.get(path,headers=bh).status_code)
        self.assertEqual([],self.client.get("/v1/actions",headers=bh).json()["items"])
        self.assertEqual(404,self.client.post("/v1/actions/"+action["action_id"]+"/confirm",headers=bh).status_code)
        for extra in ({"source_job_id":job_id},{"conversation_id":conversation,"parent_request_id":request["request_id"]}):
            r=self.client.post("/v1/chat",headers=bh,json={"text":"private",**extra})
            self.assertEqual(404,r.status_code,r.text)

    def test_admin_explicit_user_binding_requires_bootstrap_and_pair_body_cannot_override(self):
        a=self.pair(user="specific-real-person");b=self.pair(user="specific-real-person")
        self.assertEqual(a["user_id"],b["user_id"])
        self.assertNotEqual(a["device_id"],b["device_id"])
        self.assertEqual(401,self.client.post("/v1/auth/pairing-codes",headers=self.auth(a),json={"user_id":a["user_id"]}).status_code)
        code=self.client.post("/v1/auth/pairing-codes",headers=self.admin).json()
        forged=self.client.post("/v1/auth/pair",json={"code":code["code"],"label":"forged","user_id":a["user_id"]})
        self.assertEqual(422,forged.status_code)
        valid=self.client.post("/v1/auth/pair",json={"code":code["code"],"label":"valid"})
        self.assertEqual(200,valid.status_code)
        self.assertNotEqual(a["user_id"],valid.json()["user_id"])
        self.assertEqual(401,self.client.post("/v1/auth/pair",json={"code":code["code"],"label":"again"}).status_code)

    def test_cookie_session_keeps_exact_device_note_owner_and_does_not_override_bearer(self):
        repo=self.app.state.repo
        a=repo.create_device("poc-user","A");b=repo.create_device("poc-user","B")
        note=self.client.post("/v1/notes",headers=self.auth(a),json={"title":"private","content":"A PRIVATE"}).json()
        self.client.post("/v1/auth/session",headers=self.auth(b))
        self.assertEqual([],self.client.get("/v1/notes").json()["items"])
        self.assertEqual(404,self.client.get("/v1/notes/"+note["note_id"]).status_code)
        self.assertEqual(note,self.client.get("/v1/notes/"+note["note_id"],headers=self.auth(a)).json())
        self.assertEqual(401,self.client.get("/v1/notes",headers={"Authorization":"Broken"}).status_code)


class LegacyPrivacyMigrationTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.path=Path(self.tmp.name)
        self.db=Database(self.path/"data.sqlite3",self.path/"data.key");self.repo=Repository(self.db)
        self.a=self.repo.create_device("poc-user","A");self.b=self.repo.create_device("poc-user","B")
        self.ai=self.repo.authenticate_device(self.a["token"]);self.bi=self.repo.authenticate_device(self.b["token"])
    def tearDown(self):self.tmp.cleanup()

    def test_v1_upgrade_preserves_keys_tokens_sessions_encrypted_owners_and_unused_code_is_unique(self):
        note=self.repo.create_note(self.ai,"my note","my private content")
        session=self.repo.create_session(self.ai)
        key=(self.path/"data.key").read_bytes()
        with self.db.connect(write=True) as connection:
            connection.execute("DROP TABLE pairing_codes")
            connection.execute("CREATE TABLE pairing_codes(code_hash TEXT PRIMARY KEY,expires_at REAL,created_at REAL,consumed_at REAL)")
            connection.execute("INSERT INTO pairing_codes VALUES(?,?,?,NULL)",(hash_token("old-unused-code"),9999999999,100))
            connection.execute("PRAGMA user_version=1")
        migrated=Repository(Database(self.path/"data.sqlite3",self.path/"data.key"))
        self.assertEqual(key,(self.path/"data.key").read_bytes())
        self.assertEqual(self.ai,migrated.authenticate_device(self.a["token"]))
        self.assertEqual(self.ai.device_id,migrated.authenticate_session(session["token"]).device_id)
        self.assertEqual(note,migrated.get_note(self.ai,note["note_id"]))
        with self.assertRaises(RepositoryError):migrated.get_note(self.bi,note["note_id"])
        paired=migrated.consume_pairing_code("old-unused-code","new owner")
        self.assertRegex(paired["user_id"],r"^usr_[0-9a-f]{32}$")
        self.assertNotEqual("poc-user",paired["user_id"])
        with migrated.database.connect() as connection:self.assertEqual(2,connection.execute("PRAGMA user_version").fetchone()[0])

    def test_foreign_note_snapshots_quarantined_in_request_action_and_history_own_data_retained(self):
        note=self.repo.create_note(self.ai,"PRIVATE FOREIGN TITLE","PRIVATE FOREIGN BODY")
        own=self.repo.create_note(self.bi,"own","own body")
        request=self.repo.create_request(self.bi,"look up a note",idempotency_key="original-key")
        conversation=self.repo.create_conversation_for_request(self.bi,request["request_id"])
        self.repo.append_conversation_request(self.bi,conversation,request["request_id"],None)
        action=self.repo.create_action(self.bi,"notes.share",note,request["request_id"])
        claim=self.repo.confirm_action(self.bi,action["action_id"])
        self.repo.record_result(self.bi,action["action_id"],claim["execution_token"],"handed_off",{})
        self.repo.update_request(self.bi,request["request_id"],{"status":"completed","note":note,
            "notes":[note],"note_candidates":[note],"pending_platform_note_update":note,
            "last_result":{"notes":[note]},"action_id":action["action_id"],"message":"PRIVATE FOREIGN BODY"})
        self.assertEqual(2,self.repo.quarantine_legacy_note_snapshots())
        record=self.repo.get_request(self.bi,request["request_id"])
        self.assertEqual("legacy_note_snapshot_quarantined",record["error"]["code"])
        current_action=self.repo.get_action(self.bi,action["action_id"])
        self.assertEqual({},current_action["payload"])
        self.assertEqual("unsupported",current_action["state"])
        history=self.repo.conversation_history(self.bi,conversation)
        for value in (record,current_action,history):
            self.assertNotIn("PRIVATE FOREIGN",json.dumps(value))
            self.assertNotIn(note["note_id"],json.dumps(value))
        self.assertEqual(note,self.repo.get_note(self.ai,note["note_id"]))
        self.assertEqual([own],self.repo.list_notes(self.bi))
        replay=self.repo.create_request(self.bi,"look up a note",idempotency_key="original-key")
        self.assertEqual(record,replay)
        self.assertEqual(0,self.repo.quarantine_legacy_note_snapshots())
        with self.assertRaises(RepositoryError):self.repo.record_result(self.bi,action["action_id"],claim["execution_token"],"handed_off",{})

    def test_pending_old_private_note_action_retired_without_backup_or_deleting_own_notes(self):
        note=self.repo.create_note(self.ai,"own","old note")
        request=self.repo.create_request(self.ai,"create phone note")
        action=self.repo.create_action(self.ai,"notes.save_local",{"note_id":"phone_note_old","title":"phone","content":"private"},request["request_id"])
        self.repo.update_request(self.ai,request["request_id"],{"action_id":action["action_id"],"status":"awaiting_device"})
        self.assertEqual(2,self.repo.quarantine_legacy_note_snapshots())
        self.assertEqual("unsupported",self.repo.get_action(self.ai,action["action_id"])["state"])
        self.assertEqual("unsupported",self.repo.get_request(self.ai,request["request_id"])["status"])
        self.assertEqual([note],self.repo.list_notes(self.ai))
        self.assertEqual(0,self.repo.quarantine_legacy_note_snapshots())


class NativeBridgeContractTests(unittest.TestCase):
    def test_file_recording_message_shapes_and_identity_accepted(self):
        adapter=TypeAdapter(BridgeProtocol);r="rec_"+"a"*32;d="dev_"+"b"*32
        base={"protocol_version":"1","message_id":"message1"}
        messages=[
            {"type":"ready","capabilities":["notes.create_native"],"identity":{"user_id":"usr_one","device_id":d},"device_id":d,
             "recording":{"protocol_version":"1","format":"audio/mp4","max_duration_ms":180000,"max_bytes":8388608}},
            {"type":"recording_start","purpose":"command","expected_user_id":"usr_one","expected_device_id":d},
            {"type":"recording_stop","recording_id":r},
            {"type":"recording_cancel","start_message_id":"start1"},
            {"type":"recording_started","recording_id":r,"format":"audio/mp4"},
            {"type":"recording_progress","recording_id":r,"elapsed_ms":42,"level":0.5},
            {"type":"recording_stopping","recording_id":r},
            {"type":"recording_uploading","recording_id":r},
            {"type":"recording_uploaded","recording_id":r,"job_id":"job_"+"c"*32,"trace_id":"http_"+"d"*32,"status":"queued","purpose":"command"},
            {"type":"recording_cancelled","recording_id":r,"reason":"user"},
            {"type":"error","recording_id":r,"error":{"code":"recording_failed","message":"failed"}},
        ]
        for message in messages:self.assertIsNotNone(adapter.validate_python({**base,**message}))
    def test_file_recording_untrusted_url_injection_invalid_ids_and_bad_bounds_rejected(self):
        adapter=TypeAdapter(BridgeProtocol);base={"protocol_version":"1","message_id":"message1"};r="rec_"+"a"*32
        bad=[
            {"type":"recording_start","expected_user_id":"one","expected_device_id":"dev_"+"b"*32,"url":"https://attacker.example"},
            {"type":"recording_start","purpose":"note","expected_user_id":"one","expected_device_id":"dev_"+"b"*32},
            {"type":"recording_cancel"},{"type":"recording_stop","recording_id":"other"},
            {"type":"recording_progress","recording_id":r,"elapsed_ms":-1,"level":0},
            {"type":"recording_progress","recording_id":r,"elapsed_ms":180001,"level":0},
            {"type":"recording_progress","recording_id":r,"elapsed_ms":True,"level":0},
            {"type":"recording_progress","recording_id":r,"elapsed_ms":5,"level":float('nan')},
            {"type":"recording_cancelled","recording_id":r,"reason":"silent_save"},
        ]
        for message in bad:
            with self.assertRaises(ValidationError):adapter.validate_python({**base,**message})

if __name__=="__main__":unittest.main()

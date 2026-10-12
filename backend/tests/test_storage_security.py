"""Security invariants for encrypted data, device ownership, and action retries."""

import concurrent.futures
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from cryptography.exceptions import InvalidTag

from app.security.auth import Authenticator
from app.security.crypto import CryptoBox
from app.storage.database import Database
from app.storage.repositories import Repository, RepositoryError


class StorageSecurityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.folder = Path(self.temp.name)
        self.database = Database(self.folder / "assistant.sqlite3", self.folder / "private.key")
        self.repo = Repository(self.database)
        self.device = self.repo.create_device("alice", "Alice 的手機")
        self.principal = self.repo.authenticate_device(self.device["token"])
        second = self.repo.create_device("alice", "Alice 的平板")
        self.other_device = self.repo.authenticate_device(second["token"])
        third = self.repo.create_device("bob", "Bob 的手機")
        self.other_user = self.repo.authenticate_device(third["token"])

    def tearDown(self):
        self.temp.cleanup()

    def assertRepositoryError(self, code, callback, *args, **kwargs):
        with self.assertRaises(RepositoryError) as raised:
            callback(*args, **kwargs)
        self.assertEqual(code, raised.exception.code)

    def test_private_fields_are_encrypted_and_credentials_hashed(self):
        secret = "唯一私人內容-不要明文存放-987654321"
        self.repo.create_request(self.principal, secret, {"private": secret}, "request-key")
        self.repo.create_note(self.principal, secret, secret, transcript=secret)
        self.repo.create_action(self.principal, "open_dialer", {"phone": secret})
        self.repo.put_job(self.principal, "job-one", {"transcript": secret})
        session = self.repo.create_session(self.principal)
        for item in self.folder.glob("assistant.sqlite3*"):
            raw = item.read_bytes()
            for forbidden in (secret, self.device["token"], session["token"], "Alice 的手機"):
                self.assertNotIn(forbidden.encode(), raw)
        if os.name == "posix":
            self.assertEqual(0o600, self.folder.joinpath("private.key").stat().st_mode & 0o777)

    def test_crypto_uses_random_nonce_and_binds_record_identity(self):
        arguments = dict(user_id="alice", kind="note", record_id="note-a")
        first = self.database.crypto.encrypt({"text": "秘密"}, **arguments)
        second = self.database.crypto.encrypt({"text": "秘密"}, **arguments)
        self.assertNotEqual(first, second)
        self.assertEqual({"text": "秘密"}, self.database.crypto.decrypt(first, **arguments))
        for field, replacement in (("user_id", "bob"), ("kind", "request"), ("record_id", "note-b")):
            with self.assertRaises(InvalidTag):
                self.database.crypto.decrypt(first, **{**arguments, field: replacement})

    def test_missing_key_for_existing_db_fails_without_creating_replacement(self):
        key_path = self.folder / "private.key"
        key_path.unlink()
        with self.assertRaisesRegex(RuntimeError, "missing"):
            Database(self.folder / "assistant.sqlite3", key_path)
        self.assertFalse(key_path.exists())

    def test_symlink_key_is_rejected(self):
        if os.name != "posix":
            self.skipTest("Symbolic links require platform support")
        target = self.folder / "target.key"
        target.write_bytes(os.urandom(32))
        link = self.folder / "link.key"
        link.symlink_to(target)
        with self.assertRaisesRegex(RuntimeError, "symbolic"):
            CryptoBox(link)

    def test_ownership_user_notes_and_device_actions(self):
        note = self.repo.create_note(self.principal, "我的筆記", "內容")
        self.assertEqual(note, self.repo.get_note(self.other_device, note["note_id"]))
        self.assertRepositoryError("not_found", self.repo.get_note, self.other_user, note["note_id"])
        action = self.repo.create_action(self.principal, "set_alarm", {"hour": 7})
        self.assertRepositoryError("not_found", self.repo.get_action, self.other_device, action["action_id"])
        self.assertRepositoryError("not_found", self.repo.confirm_action, self.other_user, action["action_id"])
        request = self.repo.create_request(self.principal, "私人指令")
        self.assertRepositoryError("not_found", self.repo.get_request, self.other_device, request["request_id"])
        self.repo.put_job(self.principal, "job-private", {"text": "私人音訊"})
        self.assertRepositoryError("not_found", self.repo.get_job, self.other_device, "job-private")

    def test_pairing_code_is_single_use_even_under_concurrency(self):
        pairing = self.repo.create_pairing_code()

        def consume(_):
            try:
                return self.repo.consume_pairing_code(pairing["code"], "手機", "alice")
            except RepositoryError as error:
                return error.code

        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
            outcomes = list(executor.map(consume, range(4)))
        self.assertEqual(1, sum(isinstance(result, dict) for result in outcomes))
        self.assertEqual(3, outcomes.count("invalid_pairing_code"))

    def test_atomic_confirmation_allows_one_claim_only(self):
        action = self.repo.create_action(self.principal, "open_dialer", {"phone": "0912345678"})

        def claim(_):
            try:
                return self.repo.confirm_action(self.principal, action["action_id"])
            except RepositoryError as error:
                return error.code

        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
            outcomes = list(executor.map(claim, range(4)))
        self.assertEqual(1, sum(isinstance(result, dict) for result in outcomes))
        self.assertEqual(3, outcomes.count("action_already_claimed"))

    def test_result_token_required_and_retries_are_idempotent(self):
        action = self.repo.create_action(self.principal, "open_dialer", {"phone": "0912345678"})
        claim = self.repo.confirm_action(self.principal, action["action_id"])
        self.assertRepositoryError("invalid_execution_token", self.repo.record_result,
                                   self.principal, action["action_id"], "wrong", "opened")
        result = {"detail": "撥號介面已開啟"}
        first = self.repo.record_result(self.principal, action["action_id"], claim["execution_token"], "opened", result)
        repeated = self.repo.record_result(self.principal, action["action_id"], claim["execution_token"], "opened", result)
        self.assertEqual(first, repeated)
        self.assertRepositoryError("result_conflict", self.repo.record_result,
                                   self.principal, action["action_id"], claim["execution_token"], "failed", {})
        self.assertNotIn("execution_token", self.repo.get_action(self.principal, action["action_id"]))

    def test_opening_phone_or_alarm_cannot_claim_verified_completion(self):
        for kind in ("open_dialer", "set_alarm", "phone_call", "notes.share"):
            action = self.repo.create_action(self.principal, kind, {})
            claim = self.repo.confirm_action(self.principal, action["action_id"])
            self.assertRepositoryError("unverifiable_result", self.repo.record_result,
                                       self.principal, action["action_id"], claim["execution_token"], "completed")
            self.repo.record_result(self.principal, action["action_id"], claim["execution_token"], "handed_off")

    def test_expired_claim_cannot_be_reissued_or_finalized(self):
        with patch("app.storage.repositories.time.time", return_value=1000):
            action = self.repo.create_action(self.principal, "create_calendar_event", {}, ttl_seconds=300)
            claim = self.repo.confirm_action(self.principal, action["action_id"], lease_seconds=30)
        with patch("app.storage.repositories.time.time", return_value=1031):
            self.assertEqual("execution_expired", self.repo.get_action(self.principal, action["action_id"])["state"])
            self.assertRepositoryError("execution_expired", self.repo.record_result,
                                       self.principal, action["action_id"], claim["execution_token"], "completed")
            self.assertRepositoryError("action_already_claimed", self.repo.confirm_action,
                                       self.principal, action["action_id"])

    def test_request_note_action_idempotency_and_input_conflict(self):
        request = self.repo.create_request(self.principal, "記下買牛奶", {"timezone": "Asia/Taipei"}, "req-1")
        self.repo.update_request(self.principal, request["request_id"], {"status": "completed", "response": "已記錄"})
        duplicate = self.repo.create_request(self.principal, "記下買牛奶", {"timezone": "Asia/Taipei"}, "req-1")
        self.assertEqual(request["request_id"], duplicate["request_id"])
        self.assertEqual("completed", duplicate["status"])
        self.assertRepositoryError("idempotency_conflict", self.repo.create_request, self.principal, "不同內容", {}, "req-1")
        note = self.repo.create_note(self.principal, "購物", "買牛奶", idempotency_key="note-1")
        self.assertEqual(note, self.repo.create_note(self.principal, "購物", "買牛奶", idempotency_key="note-1"))
        self.assertRepositoryError("idempotency_conflict", self.repo.create_note,
                                   self.principal, "購物", "買麵包", idempotency_key="note-1")
        action = self.repo.create_action(self.principal, "set_alarm", {"hour": 7}, idempotency_key="act-1")
        self.assertEqual(action, self.repo.create_action(self.principal, "set_alarm", {"hour": 7}, idempotency_key="act-1"))
        self.assertRepositoryError("idempotency_conflict", self.repo.create_action,
                                   self.principal, "set_alarm", {"hour": 8}, idempotency_key="act-1")

    def test_sessions_expire_and_revoke_with_device(self):
        with patch("app.storage.repositories.time.time", return_value=1000):
            session = self.repo.create_session(self.principal, ttl_seconds=60)
        with patch("app.storage.repositories.time.time", return_value=1020):
            result = self.repo.authenticate_session(session["token"])
            self.assertEqual(self.principal.device_id, result.device_id)
            self.assertEqual("session", result.auth_kind)
        with patch("app.storage.repositories.time.time", return_value=1060):
            self.assertIsNone(self.repo.authenticate_session(session["token"]))
        session = self.repo.create_session(self.principal)
        self.repo.revoke_device(self.principal)
        self.assertIsNone(self.repo.authenticate_session(session["token"]))
        self.assertIsNone(self.repo.authenticate_device(self.device["token"]))
        self.assertRepositoryError("unauthorized", self.repo.list_notes, self.principal)

    def test_malformed_authorization_does_not_fall_back_to_valid_cookie(self):
        authenticator = Authenticator(self.repo, "bootstrap-token-with-at-least-24-characters")
        session = self.repo.create_session(self.principal)
        self.assertEqual(self.principal.device_id, authenticator.authenticate(session_token=session["token"]).device_id)
        for header in ("Basic credentials", "Bearer invalid", "Bearer ", "Bearer token more"):
            self.assertIsNone(authenticator.authenticate(header, session["token"]))
        self.assertTrue(authenticator.verify_admin("bootstrap-token-with-at-least-24-characters"))
        self.assertFalse(authenticator.verify_admin("wrong"))

    def test_note_delete_and_job_updates(self):
        note = self.repo.create_note(self.principal, "刪除", "內容")
        self.repo.delete_note(self.principal, note["note_id"])
        self.assertRepositoryError("not_found", self.repo.get_note, self.principal, note["note_id"])
        self.repo.put_job(self.principal, "audio-job", {"status": "queued"})
        updated = self.repo.update_job(self.principal, "audio-job", {"status": "completed", "transcript": "繁中逐字稿"})
        self.assertEqual("繁中逐字稿", updated["transcript"])
        self.assertRepositoryError("immutable_fields", self.repo.update_job,
                                   self.principal, "audio-job", {"job_id": "other"})

    def test_note_update_preserves_identity_encrypts_content_and_checks_owner(self):
        note = self.repo.create_note(self.principal, "原始標題", "原始內容", transcript="原始逐字稿")
        updated = self.repo.update_note(self.other_device, note["note_id"], "新的私人標題", "新的私人內容", "新的私人逐字稿")
        self.assertEqual(note["note_id"], updated["note_id"])
        self.assertEqual(note["created_at"], updated["created_at"])
        self.assertGreaterEqual(updated["updated_at"], note["updated_at"])
        self.assertEqual("新的私人內容", self.repo.get_note(self.principal, note["note_id"])["content"])
        for item in self.folder.glob("assistant.sqlite3*"):
            raw = item.read_bytes()
            for forbidden in ("新的私人標題", "新的私人內容", "新的私人逐字稿"):
                self.assertNotIn(forbidden.encode(), raw)
        self.assertRepositoryError("not_found", self.repo.update_note,
                                   self.other_user, note["note_id"], "冒名修改", "不應寫入")
        self.assertEqual(updated, self.repo.get_note(self.principal, note["note_id"]))

    def test_restart_marks_only_unfinished_audio_jobs_interrupted(self):
        self.repo.put_job(self.principal, "queued-job", {"status": "queued"})
        self.repo.put_job(self.principal, "processing-job", {"status": "processing"})
        self.repo.put_job(self.principal, "done-job", {"status": "completed", "transcript": "已完成"})
        self.assertEqual(2, self.repo.recover_jobs())
        for job_id in ("queued-job", "processing-job"):
            recovered = self.repo.get_job(self.principal, job_id)
            self.assertEqual("interrupted", recovered["status"])
            self.assertEqual("job_interrupted", recovered["error_code"])
        self.assertEqual("completed", self.repo.get_job(self.principal, "done-job")["status"])
        self.assertEqual(0, self.repo.recover_jobs())


if __name__ == "__main__":
    unittest.main()

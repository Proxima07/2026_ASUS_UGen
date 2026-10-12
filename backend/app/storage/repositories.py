"""Ownership checked, encrypted persistence and atomic mobile action claims."""

from __future__ import annotations

import hashlib
import secrets
import sqlite3
import time
import uuid
import json
from datetime import datetime
from zoneinfo import ZoneInfo
from typing import Any

from app.security.auth import Principal
from app.storage.database import Database


class RepositoryError(Exception):
    def __init__(self, code: str, message: str, status_code: int = 400):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _identifier(prefix: str) -> str:
    return prefix + "_" + uuid.uuid4().hex


def _ttl(seconds: int, *, maximum: int = 86400) -> int:
    if isinstance(seconds, bool) or not isinstance(seconds, int) or not 1 <= seconds <= maximum:
        raise RepositoryError("invalid_ttl", "TTL is outside the allowed range.")
    return seconds


class Repository:
    TERMINAL_STATES = frozenset({"completed", "opened", "handed_off", "cancelled", "permission_denied", "unsupported", "failed"})

    def __init__(self, database: Database):
        self.database = database
        self.crypto = database.crypto

    def _encrypt(self, principal: Principal, kind: str, record_id: str, payload: Any) -> str:
        return self.crypto.encrypt(payload, user_id=principal.user_id, kind=kind, record_id=record_id)

    def _decrypt(self, row: sqlite3.Row, kind: str, record_id: str, field: str = "payload_enc") -> Any:
        return self.crypto.decrypt(row[field], user_id=row["user_id"], kind=kind, record_id=record_id)

    @staticmethod
    def _assert_active(connection: sqlite3.Connection, principal: Principal) -> None:
        exists = connection.execute(
            "SELECT 1 FROM devices WHERE device_id=? AND user_id=? AND active=1",
            (principal.device_id, principal.user_id),
        ).fetchone()
        if not exists:
            raise RepositoryError("unauthorized", "The device is not active.", 401)

    @staticmethod
    def _find(connection: sqlite3.Connection, table: str, id_column: str, record_id: str, principal: Principal,
              *, device_only: bool = True) -> sqlite3.Row:
        # Table and column names come exclusively from fixed callers below.
        query = f"SELECT * FROM {table} WHERE {id_column}=? AND user_id=?"
        params = [record_id, principal.user_id]
        if device_only:
            query += " AND device_id=?"
            params.append(principal.device_id)
        row = connection.execute(query, params).fetchone()
        if row is None:
            raise RepositoryError("not_found", "The requested record was not found.", 404)
        return row

    @staticmethod
    def _idempotency(value: str | None) -> str | None:
        if value is None:
            return None
        if not isinstance(value, str) or not 1 <= len(value) <= 200:
            raise RepositoryError("invalid_idempotency_key", "An idempotency key must contain 1–200 characters.")
        return hash_token(value)

    def _create_device(self, connection: sqlite3.Connection, user_id: str, label: str) -> dict:
        if not user_id or len(user_id) > 200 or not isinstance(label, str) or len(label) > 100:
            raise RepositoryError("invalid_device", "A user id and a device label of at most 100 characters are required.")
        device_id, token = _identifier("dev"), secrets.token_urlsafe(32)
        created = time.time()
        label_enc = self.crypto.encrypt(label, user_id=user_id, kind="device", record_id=device_id)
        connection.execute(
            "INSERT INTO devices(device_id,user_id,label_enc,token_hash,created_at) VALUES(?,?,?,?,?)",
            (device_id, user_id, label_enc, hash_token(token), created),
        )
        return {"device_id": device_id, "user_id": user_id, "label": label, "token": token, "created_at": created}

    def create_device(self, user_id: str, label: str) -> dict:
        with self.database.connect(write=True) as connection:
            return self._create_device(connection, user_id, label)

    def _principal(self, row: sqlite3.Row, *, auth_kind: str = "device") -> Principal:
        label = self.crypto.decrypt(row["label_enc"], user_id=row["user_id"], kind="device", record_id=row["device_id"])
        return Principal(row["user_id"], row["device_id"], label, auth_kind)

    def authenticate_device(self, token: str) -> Principal | None:
        if not token or len(token) > 500:
            return None
        with self.database.connect() as connection:
            row = connection.execute("SELECT * FROM devices WHERE token_hash=? AND active=1", (hash_token(token),)).fetchone()
            return self._principal(row) if row else None

    def revoke_device(self, principal: Principal, device_id: str | None = None) -> None:
        target = device_id or principal.device_id
        with self.database.connect(write=True) as connection:
            self._assert_active(connection, principal)
            if target != principal.device_id:
                raise RepositoryError("forbidden", "A device may revoke only its own credential.", 403)
            connection.execute("UPDATE devices SET active=0 WHERE device_id=?", (target,))
            connection.execute("DELETE FROM sessions WHERE device_id=?", (target,))

    def create_pairing_code(self, ttl_seconds: int = 300, *, user_id: str | None = None) -> dict:
        expires = time.time() + _ttl(ttl_seconds, maximum=3600)
        code = secrets.token_urlsafe(18)
        # The trusted server assigns the owner before issuing the credential.
        # Labels and the unauthenticated pairing body never choose an account.
        if user_id is not None and (not isinstance(user_id, str) or not 1 <= len(user_id) <= 200):
            raise RepositoryError("invalid_user_id", "A user id must contain 1–200 characters.")
        user_id = user_id if user_id is not None else _identifier("usr")
        with self.database.connect(write=True) as connection:
            connection.execute("DELETE FROM pairing_codes WHERE expires_at<?", (time.time(),))
            connection.execute("INSERT INTO pairing_codes(code_hash,expires_at,created_at,user_id) VALUES(?,?,?,?)",
                               (hash_token(code), expires, time.time(), user_id))
        return {"code": code, "expires_at": expires}

    def consume_pairing_code(self, code: str, label: str) -> dict:
        if not code or len(code) > 200:
            raise RepositoryError("invalid_pairing_code", "The pairing code is invalid or expired.", 401)
        with self.database.connect(write=True) as connection:
            now = time.time()
            updated = connection.execute(
                "UPDATE pairing_codes SET consumed_at=? WHERE code_hash=? AND consumed_at IS NULL AND expires_at>?",
                (now, hash_token(code), now),
            ).rowcount
            if not updated:
                raise RepositoryError("invalid_pairing_code", "The pairing code is invalid or expired.", 401)
            user_id = connection.execute("SELECT user_id FROM pairing_codes WHERE code_hash=?",
                (hash_token(code),)).fetchone()["user_id"]
            return self._create_device(connection, user_id, label)

    def create_session(self, principal: Principal, ttl_seconds: int = 86400) -> dict:
        token, now = secrets.token_urlsafe(32), time.time()
        expires = now + _ttl(ttl_seconds, maximum=604800)
        with self.database.connect(write=True) as connection:
            self._assert_active(connection, principal)
            connection.execute("DELETE FROM sessions WHERE expires_at<?", (now,))
            connection.execute("INSERT INTO sessions(token_hash,device_id,expires_at,created_at) VALUES(?,?,?,?)",
                               (hash_token(token), principal.device_id, expires, now))
        return {"token": token, "expires_at": expires}

    def authenticate_session(self, token: str) -> Principal | None:
        if not token or len(token) > 500:
            return None
        with self.database.connect() as connection:
            row = connection.execute(
                "SELECT d.* FROM sessions s JOIN devices d ON d.device_id=s.device_id "
                "WHERE s.token_hash=? AND s.expires_at>? AND d.active=1",
                (hash_token(token), time.time()),
            ).fetchone()
            return self._principal(row, auth_kind="session") if row else None

    def revoke_session(self, token: str) -> None:
        with self.database.connect(write=True) as connection:
            connection.execute("DELETE FROM sessions WHERE token_hash=?", (hash_token(token),))

    def _request_view(self, row: sqlite3.Row) -> dict:
        payload = self._decrypt(row, "request", row["request_id"])
        payload.pop("_original_input", None)
        return {**payload, "request_id": row["request_id"], "created_at": row["created_at"], "updated_at": row["updated_at"]}

    def create_request(self, principal: Principal, text: str, context: dict | None = None,
                       idempotency_key: str | None = None) -> dict:
        idem = self._idempotency(idempotency_key)
        original = {"text": text, "context": context or {}}
        with self.database.connect(write=True) as connection:
            self._assert_active(connection, principal)
            if idem:
                row = connection.execute("SELECT * FROM requests WHERE device_id=? AND idem_hash=?",
                                         (principal.device_id, idem)).fetchone()
                if row:
                    if self._decrypt(row, "request", row["request_id"])["_original_input"] != original:
                        raise RepositoryError("idempotency_conflict", "This idempotency key was used for a different request.", 409)
                    return self._request_view(row)
            record_id, now = _identifier("req"), time.time()
            payload = {**original, "_original_input": original, "status": "processing", "response": None, "action_id": None}
            connection.execute(
                "INSERT INTO requests(request_id,user_id,device_id,payload_enc,idem_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
                (record_id, principal.user_id, principal.device_id, self._encrypt(principal, "request", record_id, payload), idem, now, now),
            )
            return self._request_view(self._find(connection, "requests", "request_id", record_id, principal))

    def get_request(self, principal: Principal, request_id: str) -> dict:
        with self.database.connect() as connection:
            self._assert_active(connection, principal)
            return self._request_view(self._find(connection, "requests", "request_id", request_id, principal))

    def find_request_by_idempotency(self, principal: Principal, text: str, context: dict,
                                    idempotency_key: str | None) -> dict | None:
        idem = self._idempotency(idempotency_key)
        if not idem:
            return None
        with self.database.connect() as connection:
            self._assert_active(connection, principal)
            row = connection.execute("SELECT * FROM requests WHERE device_id=? AND idem_hash=?",
                                     (principal.device_id, idem)).fetchone()
            if row is None:
                return None
            if self._decrypt(row, "request", row["request_id"])["_original_input"] != {"text": text, "context": context}:
                raise RepositoryError("idempotency_conflict", "This idempotency key was used for a different request.", 409)
            return self._request_view(row)

    def create_conversation_for_request(self, principal: Principal, request_id: str) -> str:
        conversation_id = "conv_" + request_id.removeprefix("req_")
        with self.database.connect(write=True) as connection:
            self._assert_active(connection, principal)
            self._find(connection, "requests", "request_id", request_id, principal)
            row = connection.execute("SELECT * FROM conversations WHERE conversation_id=?", (conversation_id,)).fetchone()
            if row:
                self._find(connection, "conversations", "conversation_id", conversation_id, principal)
                return conversation_id
            now = time.time()
            payload = self._encrypt(principal, "conversation", conversation_id, {"request_ids": []})
            connection.execute("INSERT INTO conversations VALUES(?,?,?,?,?,?)",
                (conversation_id, principal.user_id, principal.device_id, payload, now, now))
        return conversation_id

    def get_conversation(self, principal: Principal, conversation_id: str) -> dict:
        with self.database.connect() as connection:
            self._assert_active(connection, principal)
            row = self._find(connection, "conversations", "conversation_id", conversation_id, principal)
            ids = self._decrypt(row, "conversation", conversation_id)["request_ids"]
            return {"conversation_id": conversation_id, "request_ids": ids,
                    "last_request_id": ids[-1] if ids else None}

    def append_conversation_request(self, principal: Principal, conversation_id: str,
                                    request_id: str, parent_request_id: str | None) -> None:
        with self.database.connect(write=True) as connection:
            self._assert_active(connection, principal)
            conversation = self._find(connection, "conversations", "conversation_id", conversation_id, principal)
            request = self._find(connection, "requests", "request_id", request_id, principal)
            payload = self._decrypt(conversation, "conversation", conversation_id)
            ids = payload["request_ids"]
            if request_id in ids:
                return
            if (ids[-1] if ids else None) != parent_request_id:
                raise RepositoryError("conversation_head_conflict", "Conversation has a newer turn; refresh before sending another.", 409)
            request_payload = self._decrypt(request, "request", request_id)
            if request_payload.get("conversation_id") not in {None, conversation_id}:
                raise RepositoryError("conversation_conflict", "Request belongs to another conversation.", 409)
            request_payload["conversation_id"] = conversation_id
            connection.execute("UPDATE requests SET payload_enc=?,updated_at=? WHERE request_id=?",
                (self._encrypt(principal, "request", request_id, request_payload), time.time(), request_id))
            payload["request_ids"] = (ids + [request_id])[-20:]
            connection.execute("UPDATE conversations SET payload_enc=?,updated_at=? WHERE conversation_id=?",
                (self._encrypt(principal, "conversation", conversation_id, payload), time.time(), conversation_id))

    def conversation_history(self, principal: Principal, conversation_id: str,
                             *, exclude_request_id: str | None = None,
                             max_messages: int = 12, max_chars: int = 16000) -> dict:
        if not 2 <= max_messages <= 40 or not 2000 <= max_chars <= 48000:
            raise RepositoryError("invalid_context_limits", "Conversation context limits are invalid.")
        conversation = self.get_conversation(principal, conversation_id)
        messages = []
        previous_status = None
        for request_id in conversation["request_ids"]:
            if request_id == exclude_request_id:
                continue
            request = self.get_request(principal, request_id)
            previous_status = request["status"]
            timezone_name = request.get("context", {}).get("timezone", "Asia/Taipei")
            stamp = datetime.fromtimestamp(request["created_at"], ZoneInfo(timezone_name)).isoformat()
            messages.append({"role": "user", "content":
                f"[歷史使用者訊息：原始時間 {stamp}；原始時區 {timezone_name}]\n" + request["text"][:min(4000,max_chars//2-200)]})
            summary = ""
            if request.get("action_id"):
                action = self.get_action(principal, request["action_id"])
                allowed = {"title", "start", "end", "reminder_minutes", "hour", "minute", "label",
                           "duration_seconds", "query", "name", "note_id", "weekdays"}
                metadata = {key: value for key, value in action["payload"].items() if key in allowed}
                summary = (f"[已保存操作狀態：{action['kind']}，手機狀態={action['state']}；"
                           f"中樞請求狀態={request['status']}]\n" + json.dumps(metadata, ensure_ascii=False) + "\n")
            elif request.get("note"):
                summary = f"[本地筆記狀態={request['status']}；標題={request['note']['title']}]\n"
            summary += request.get("message") or f"[已保存請求狀態={request['status']}；沒有確認手機操作完成]"
            messages.append({"role": "assistant", "content": summary[:min(2000,max_chars//2-200)]})
        # Retain complete chronological pairs; history never contains tool/system roles.
        messages = messages[-(max_messages//2*2):]
        while messages and sum(len(message["content"]) for message in messages) > max_chars:
            messages = messages[2:]
        return {"messages": messages, "previous_status": previous_status}

    def update_request(self, principal: Principal, request_id: str, updates: dict) -> dict:
        if {"text", "context", "_original_input", "request_id", "created_at", "updated_at"} & updates.keys():
            raise RepositoryError("immutable_fields", "Original input and record identity are immutable.")
        with self.database.connect(write=True) as connection:
            self._assert_active(connection, principal)
            row = self._find(connection, "requests", "request_id", request_id, principal)
            payload = {**self._decrypt(row, "request", request_id), **updates}
            connection.execute("UPDATE requests SET payload_enc=?,updated_at=? WHERE request_id=?",
                               (self._encrypt(principal, "request", request_id, payload), time.time(), request_id))
            return self._request_view(self._find(connection, "requests", "request_id", request_id, principal))

    def _note_view(self, row: sqlite3.Row) -> dict:
        return {**self._decrypt(row, "note", row["note_id"]), "note_id": row["note_id"],
                "created_at": row["created_at"], "updated_at": row["updated_at"]}

    def create_note(self, principal: Principal, title: str, content: str, transcript: str | None = None,
                    idempotency_key: str | None = None) -> dict:
        payload = {"title": title, "content": content, "transcript": transcript}
        idem = self._idempotency(idempotency_key)
        with self.database.connect(write=True) as connection:
            self._assert_active(connection, principal)
            if idem:
                row = connection.execute("SELECT * FROM notes WHERE device_id=? AND idem_hash=?", (principal.device_id, idem)).fetchone()
                if row:
                    if self._decrypt(row, "note", row["note_id"]) != payload:
                        raise RepositoryError("idempotency_conflict", "This idempotency key was used for a different note.", 409)
                    return self._note_view(row)
            record_id, now = _identifier("note"), time.time()
            connection.execute(
                "INSERT INTO notes(note_id,user_id,device_id,payload_enc,idem_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
                (record_id, principal.user_id, principal.device_id, self._encrypt(principal, "note", record_id, payload), idem, now, now),
            )
            return self._note_view(self._find(connection, "notes", "note_id", record_id, principal))

    def list_notes(self, principal: Principal, limit: int = 100, offset: int = 0) -> list[dict]:
        if not 1 <= limit <= 200 or offset < 0:
            raise RepositoryError("invalid_pagination", "Invalid pagination parameters.")
        with self.database.connect() as connection:
            self._assert_active(connection, principal)
            rows = connection.execute("SELECT * FROM notes WHERE user_id=? AND device_id=? ORDER BY created_at DESC LIMIT ? OFFSET ?",
                                      (principal.user_id, principal.device_id, limit, offset)).fetchall()
            return [self._note_view(row) for row in rows]

    def get_note(self, principal: Principal, note_id: str) -> dict:
        with self.database.connect() as connection:
            self._assert_active(connection, principal)
            return self._note_view(self._find(connection, "notes", "note_id", note_id, principal))

    def update_note(self, principal: Principal, note_id: str, title: str, content: str,
                    transcript: str | None = None) -> dict:
        payload = {"title": title, "content": content, "transcript": transcript}
        with self.database.connect(write=True) as connection:
            self._assert_active(connection, principal)
            self._find(connection, "notes", "note_id", note_id, principal)
            connection.execute("UPDATE notes SET payload_enc=?,updated_at=? WHERE note_id=? AND user_id=? AND device_id=?",
                               (self._encrypt(principal, "note", note_id, payload), time.time(), note_id, principal.user_id, principal.device_id))
            return self._note_view(self._find(connection, "notes", "note_id", note_id, principal))

    def delete_note(self, principal: Principal, note_id: str) -> None:
        with self.database.connect(write=True) as connection:
            self._assert_active(connection, principal)
            self._find(connection, "notes", "note_id", note_id, principal)
            connection.execute("DELETE FROM notes WHERE note_id=? AND user_id=? AND device_id=?", (note_id, principal.user_id, principal.device_id))

    def _action_view(self, row: sqlite3.Row) -> dict:
        state, now = row["state"], time.time()
        if state == "pending_confirmation" and row["expires_at"] <= now:
            state = "expired"
        if state == "claimed" and row["lease_expires_at"] <= now:
            state = "execution_expired"
        result = self._decrypt(row, "action_result", row["action_id"], field="result_enc") if row["result_enc"] else None
        return {"action_id": row["action_id"], "request_id": row["request_id"], "kind": row["kind"],
                "payload": self._decrypt(row, "action", row["action_id"]), "state": state,
                "created_at": row["created_at"], "updated_at": row["updated_at"], "expires_at": row["expires_at"],
                "lease_expires_at": row["lease_expires_at"], "result": result, "result_at": row["result_at"]}

    def create_action(self, principal: Principal, kind: str, payload: dict, request_id: str | None = None,
                      idempotency_key: str | None = None, ttl_seconds: int = 300) -> dict:
        if not isinstance(kind, str) or not 1 <= len(kind) <= 100 or not isinstance(payload, dict):
            raise RepositoryError("invalid_action", "An action kind and an object payload are required.")
        ttl = _ttl(ttl_seconds, maximum=3600)
        idem = self._idempotency(idempotency_key)
        with self.database.connect(write=True) as connection:
            self._assert_active(connection, principal)
            if request_id:
                self._find(connection, "requests", "request_id", request_id, principal)
            if idem:
                row = connection.execute("SELECT * FROM actions WHERE device_id=? AND idem_hash=?", (principal.device_id, idem)).fetchone()
                if row:
                    if row["kind"] != kind or row["request_id"] != request_id or self._decrypt(row, "action", row["action_id"]) != payload:
                        raise RepositoryError("idempotency_conflict", "This idempotency key was used for a different action.", 409)
                    return self._action_view(row)
            record_id, now = _identifier("act"), time.time()
            connection.execute(
                "INSERT INTO actions(action_id,user_id,device_id,request_id,kind,payload_enc,idem_hash,state,created_at,updated_at,expires_at) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                (record_id, principal.user_id, principal.device_id, request_id, kind, self._encrypt(principal, "action", record_id, payload),
                 idem, "pending_confirmation", now, now, now + ttl),
            )
            return self._action_view(self._find(connection, "actions", "action_id", record_id, principal))

    def get_action(self, principal: Principal, action_id: str) -> dict:
        with self.database.connect() as connection:
            self._assert_active(connection, principal)
            return self._action_view(self._find(connection, "actions", "action_id", action_id, principal))

    def list_actions(self, principal: Principal, limit: int = 100) -> list[dict]:
        if not 1 <= limit <= 200:
            raise RepositoryError("invalid_pagination", "Invalid pagination parameters.")
        with self.database.connect() as connection:
            self._assert_active(connection, principal)
            rows = connection.execute("SELECT * FROM actions WHERE user_id=? AND device_id=? ORDER BY created_at DESC LIMIT ?",
                                      (principal.user_id, principal.device_id, limit)).fetchall()
            return [self._action_view(row) for row in rows]

    def confirm_action(self, principal: Principal, action_id: str, lease_seconds: int = 120) -> dict:
        lease = _ttl(lease_seconds, maximum=600)
        with self.database.connect(write=True) as connection:
            self._assert_active(connection, principal)
            row = self._find(connection, "actions", "action_id", action_id, principal)
            state = self._action_view(row)["state"]
            if state == "expired":
                raise RepositoryError("action_expired", "This action has expired; submit a new request.", 410)
            if state != "pending_confirmation":
                raise RepositoryError("action_already_claimed", "This action has already been claimed or finished; inspect its status.", 409)
            now, token = time.time(), secrets.token_urlsafe(32)
            connection.execute("UPDATE actions SET state='claimed',execution_hash=?,lease_expires_at=?,updated_at=? WHERE action_id=?",
                               (hash_token(token), now + lease, now, action_id))
            return {**self._action_view(self._find(connection, "actions", "action_id", action_id, principal)), "execution_token": token}

    def record_result(self, principal: Principal, action_id: str, execution_token: str, state: str,
                      result: dict | None = None) -> dict:
        if state not in self.TERMINAL_STATES or (result is not None and not isinstance(result, dict)):
            raise RepositoryError("invalid_result", "Result state or payload is invalid.")
        result = result or {}
        with self.database.connect(write=True) as connection:
            self._assert_active(connection, principal)
            row = self._find(connection, "actions", "action_id", action_id, principal)
            if not execution_token or not row["execution_hash"] or not secrets.compare_digest(hash_token(execution_token), row["execution_hash"]):
                raise RepositoryError("invalid_execution_token", "The execution token is invalid.", 403)
            if row["state"] in self.TERMINAL_STATES:
                existing = self._decrypt(row, "action_result", action_id, field="result_enc")
                if row["state"] != state or existing != result:
                    raise RepositoryError("result_conflict", "A different final result has already been recorded.", 409)
                return self._action_view(row)
            if self._action_view(row)["state"] == "execution_expired":
                raise RepositoryError("execution_expired", "The execution window expired; inspect the phone before retrying.", 410)
            if row["state"] != "claimed":
                raise RepositoryError("action_not_claimed", "This action has not been claimed.", 409)
            normalized_kind = row["kind"].lower().replace(".", "_")
            # Launching another app does not prove a call connected or an alarm was saved.
            if state == "completed" and (normalized_kind in {"dial", "call", "phone_call", "open_dialer", "set_alarm", "alarm", "notes_share"}
                                         or normalized_kind == "notes_create_native"
                                         or "dial" in normalized_kind or "alarm" in normalized_kind or "timer" in normalized_kind):
                raise RepositoryError("unverifiable_result", "This action can report opened or handed_off, not verified completion.")
            now = time.time()
            connection.execute("UPDATE actions SET state=?,result_enc=?,result_at=?,updated_at=? WHERE action_id=?",
                               (state, self._encrypt(principal, "action_result", action_id, result), now, now, action_id))
            return self._action_view(self._find(connection, "actions", "action_id", action_id, principal))

    def cancel_action(self, principal: Principal, action_id: str) -> dict:
        with self.database.connect(write=True) as connection:
            self._assert_active(connection, principal)
            row = self._find(connection, "actions", "action_id", action_id, principal)
            if row["state"] == "cancelled":
                return self._action_view(row)
            if self._action_view(row)["state"] != "pending_confirmation":
                raise RepositoryError("action_not_pending", "Only an unclaimed action can be cancelled.", 409)
            now = time.time()
            connection.execute("UPDATE actions SET state='cancelled',result_enc=?,result_at=?,updated_at=? WHERE action_id=?",
                               (self._encrypt(principal, "action_result", action_id, {}), now, now, action_id))
            return self._action_view(self._find(connection, "actions", "action_id", action_id, principal))

    def _job_view(self, row: sqlite3.Row) -> dict:
        return {**self._decrypt(row, "job", row["job_id"]), "job_id": row["job_id"],
                "created_at": row["created_at"], "updated_at": row["updated_at"]}

    def put_job(self, principal: Principal, job_id: str, payload: dict) -> dict:
        if not isinstance(job_id, str) or not 1 <= len(job_id) <= 100 or not isinstance(payload, dict):
            raise RepositoryError("invalid_job", "A job id and object payload are required.")
        if {"job_id", "created_at", "updated_at"} & payload.keys():
            raise RepositoryError("immutable_fields", "Record identity is reserved.")
        with self.database.connect(write=True) as connection:
            self._assert_active(connection, principal)
            row = connection.execute("SELECT * FROM jobs WHERE job_id=?", (job_id,)).fetchone()
            if row:
                row = self._find(connection, "jobs", "job_id", job_id, principal)
                if self._decrypt(row, "job", job_id) != payload:
                    raise RepositoryError("job_conflict", "This job id already has different content.", 409)
                return self._job_view(row)
            now = time.time()
            connection.execute("INSERT INTO jobs(job_id,user_id,device_id,payload_enc,created_at,updated_at) VALUES(?,?,?,?,?,?)",
                               (job_id, principal.user_id, principal.device_id, self._encrypt(principal, "job", job_id, payload), now, now))
            return self._job_view(self._find(connection, "jobs", "job_id", job_id, principal))

    def get_job(self, principal: Principal, job_id: str) -> dict:
        with self.database.connect() as connection:
            self._assert_active(connection, principal)
            return self._job_view(self._find(connection, "jobs", "job_id", job_id, principal))

    def update_job(self, principal: Principal, job_id: str, updates: dict) -> dict:
        if {"job_id", "created_at", "updated_at"} & updates.keys():
            raise RepositoryError("immutable_fields", "Record identity is reserved.")
        with self.database.connect(write=True) as connection:
            self._assert_active(connection, principal)
            row = self._find(connection, "jobs", "job_id", job_id, principal)
            payload = {**self._decrypt(row, "job", job_id), **updates}
            connection.execute("UPDATE jobs SET payload_enc=?,updated_at=? WHERE job_id=?",
                               (self._encrypt(principal, "job", job_id, payload), time.time(), job_id))
            return self._job_view(self._find(connection, "jobs", "job_id", job_id, principal))

    def recover_jobs(self) -> int:
        """Startup only: in-memory audio cannot resume after a process restart."""
        recovered = 0
        with self.database.connect(write=True) as connection:
            rows = connection.execute("SELECT * FROM jobs").fetchall()
            for row in rows:
                payload = self._decrypt(row, "job", row["job_id"])
                if payload.get("status") not in {"queued", "processing", "transcribing", "summarizing"}:
                    continue
                payload.update({"status": "interrupted", "error_code": "job_interrupted",
                                "error": "伺服器重新啟動，這次錄音未完成處理；請重新上傳。"})
                principal = Principal(row["user_id"], row["device_id"])
                connection.execute("UPDATE jobs SET payload_enc=?,updated_at=? WHERE job_id=?",
                                   (self._encrypt(principal, "job", row["job_id"], payload), time.time(), row["job_id"]))
                recovered += 1
        return recovered

    def quarantine_legacy_note_snapshots(self) -> int:
        """Retire copied foreign note snapshots before authenticated API startup.

        The earlier shared user id could copy a different device's platform note
        into a request/action even after live note queries are fixed. Never
        rewrite note ownership, device credentials, or AES-GCM user AAD.
        """
        changed = 0
        legacy_kinds = {"notes.save_local", "notes.search_local", "notes.update_local"}
        with self.database.connect(write=True) as connection:
            owners = {row["note_id"]: (row["user_id"], row["device_id"])
                for row in connection.execute("SELECT note_id,user_id,device_id FROM notes").fetchall()}

            def foreign_reference(value, owner):
                if isinstance(value, dict):
                    note_id = value.get("note_id")
                    # note_* identifies platform notes; phone metadata ids are
                    # not mistaken for records in this database. Missing deleted
                    # platform records have no provable owner, so fail closed.
                    if isinstance(note_id, str) and note_id.startswith("note_") and owners.get(note_id) != owner:
                        return True
                    return any(foreign_reference(item, owner) for key, item in value.items()
                        if key != "_original_input")
                if isinstance(value, list):
                    return any(foreign_reference(item, owner) for item in value)
                return False

            unsafe_actions = set()
            retired_private_actions = set()
            now = time.time()
            for row in connection.execute("SELECT * FROM actions").fetchall():
                owner = (row["user_id"], row["device_id"])
                payload = self._decrypt(row, "action", row["action_id"])
                result = self._decrypt(row, "action_result", row["action_id"], field="result_enc") if row["result_enc"] else {}
                unsafe = foreign_reference(payload, owner) or foreign_reference(result, owner)
                retired = row["kind"] in legacy_kinds and row["state"] in {"pending_confirmation", "claimed"}
                if not unsafe and not retired:
                    continue
                principal = Principal(*owner)
                if unsafe:
                    unsafe_actions.add(row["action_id"])
                    payload = {}
                    result = {"code": "legacy_note_snapshot_quarantined"}
                else:
                    retired_private_actions.add(row["action_id"])
                    result = {"code": "legacy_private_notes_disabled"}
                connection.execute("UPDATE actions SET payload_enc=?,state='unsupported',execution_hash=NULL,"
                    "lease_expires_at=NULL,result_enc=?,result_at=?,updated_at=? WHERE action_id=?",
                    (self._encrypt(principal, "action", row["action_id"], payload),
                     self._encrypt(principal, "action_result", row["action_id"], result), now, now, row["action_id"]))
                changed += 1

            for row in connection.execute("SELECT * FROM requests").fetchall():
                owner = (row["user_id"], row["device_id"])
                payload = self._decrypt(row, "request", row["request_id"])
                unsafe = foreign_reference(payload, owner) or payload.get("action_id") in unsafe_actions
                retired = payload.get("action_id") in retired_private_actions
                if not unsafe and not retired:
                    continue
                principal = Principal(*owner)
                if unsafe:
                    original = payload.get("_original_input")
                    conversation_id = payload.get("conversation_id")
                    payload = {"_original_input": original, "text": "[舊版跨裝置筆記紀錄已隔離]",
                        "context": {}, "status": "failed", "action_id": None,
                        "message": "舊版紀錄包含無法確認為此裝置所有的筆記內容，已隔離；請建立新指令。",
                        "error": {"code": "legacy_note_snapshot_quarantined", "message": "舊版筆記快照已隔離"}}
                    if conversation_id:
                        payload["conversation_id"] = conversation_id
                else:
                    payload.update(status="unsupported",
                        message="舊版 APK 私有筆記操作已停用；請重新建立指令使用手機記事本。",
                        fallback=False)
                connection.execute("UPDATE requests SET payload_enc=?,updated_at=? WHERE request_id=?",
                    (self._encrypt(principal, "request", row["request_id"], payload), now, row["request_id"]))
                changed += 1
        return changed

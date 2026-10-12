from __future__ import annotations

from app.agent.policy import PolicyError, validate_plan
from app.schemas import Plan


class Dispatcher:
    def __init__(self, repository, settings):
        self.repo = repository
        self.settings = settings

    def apply(self, principal, request_id: str, plan: Plan, input_text: str) -> dict:
        validate_plan(plan, input_text)
        if plan.kind != "tool":
            self.repo.update_request(principal, request_id, {"status": "completed" if plan.kind == "reply" else "needs_clarification", "message": plan.message})
        elif plan.tool == "notes.create":
            note = self.repo.create_note(principal, title=plan.args["title"], content=plan.args["content"],
                                         transcript=plan.args.get("transcript"), idempotency_key=f"request:{request_id}")
            self.repo.update_request(principal, request_id, {"status": "completed", "message": "備忘錄已保存", "note": note})
        elif plan.tool == "notes.search":
            query = plan.args["query"].casefold()
            notes = [n for n in self.repo.list_notes(principal) if query in (n["title"] + "\n" + n["content"]).casefold()][:20]
            self.repo.update_request(principal, request_id, {"status": "completed", "message": f"找到 {len(notes)} 筆備忘錄", "notes": notes})
        else:
            payload = dict(plan.args)
            if plan.tool in {"notes.save_local", "notes.share"}:
                note = self.repo.get_note(principal, payload["note_id"])
                payload = {"note_id": note["note_id"], "title": note["title"], "content": note["content"]}
            action = self.repo.create_action(principal, kind=plan.tool, payload=payload, request_id=request_id,
                                            idempotency_key=f"request:{request_id}:initial", ttl_seconds=self.settings.action_ttl_seconds)
            self.repo.update_request(principal, request_id, {"status": "awaiting_device", "message": plan.message or "請在手機確認操作", "action_id": action["action_id"]})
        return self.repo.get_request(principal, request_id)

    def after_result(self, principal, action: dict) -> dict | None:
        request_id = action.get("request_id")
        if not request_id:
            return None
        # Repeated /result requests must not redo continuation.
        request = self.repo.get_request(principal, request_id)
        if request.get("last_result_action_id") == action["action_id"] or request.get("action_id") != action["action_id"]:
            return request
        state = action["state"]
        changes = {"last_result_action_id": action["action_id"], "last_result": action.get("result"), "status": state}
        if action["kind"] == "contacts.search" and state == "completed":
            result = action.get("result") or {}
            # Repository stores result body as dict; state stays in action envelope.
            contacts = result.get("contacts", [])
            candidates = [{**c, "candidate_id": f"{action['action_id']}:{i}"} for i, c in enumerate(contacts)]
            changes["candidates"] = candidates
            if action["payload"].get("purpose", "dial") == "lookup":
                changes.update(status="completed", message="聯絡人查詢完成")
            elif not candidates:
                changes.update(status="needs_clarification", message="找不到對應聯絡人，請換個名稱")
            elif len(candidates) > 1:
                changes.update(status="needs_selection", message="找到多個號碼，請選擇要撥打的對象")
            else:
                next_action = self._dial_action(principal, request_id, candidates[0], action["action_id"])
                changes.update(status="awaiting_device", action_id=next_action["action_id"], message="請確認聯絡人與電話，再開啟撥號介面")
        else:
            messages = {"opened": "已開啟手機操作介面", "handed_off": "已交給手機 App 處理", "completed": "操作已完成", "cancelled": "操作已取消", "permission_denied": "手機權限未取得", "unsupported": "手機不支援這項操作", "failed": "手機操作失敗"}
            changes["message"] = messages.get(state, "操作狀態已更新")
        self.repo.update_request(principal, request_id, changes)
        return self.repo.get_request(principal, request_id)

    def _dial_action(self, principal, request_id: str, candidate: dict, parent_id: str) -> dict:
        return self.repo.create_action(principal, kind="phone.dial", payload={"name": candidate.get("name", ""), "phone_number": candidate["phone_number"]},
                                       request_id=request_id, idempotency_key=f"contact-dial:{parent_id}", ttl_seconds=self.settings.action_ttl_seconds)

    def select_contact(self, principal, request_id: str, candidate_id: str) -> dict:
        request = self.repo.get_request(principal, request_id)
        if request.get("status") != "needs_selection":
            raise PolicyError("selection_not_expected", "這個請求目前不需要選擇聯絡人")
        candidates = [c for c in request.get("candidates", []) if c["candidate_id"] == candidate_id]
        if not candidates:
            raise PolicyError("invalid_candidate", "選擇的聯絡人不屬於這個請求")
        action = self._dial_action(principal, request_id, candidates[0], request["last_result_action_id"])
        self.repo.update_request(principal, request_id, {"status": "awaiting_device", "action_id": action["action_id"], "message": "請確認電話後開啟撥號介面"})
        return self.repo.get_request(principal, request_id)

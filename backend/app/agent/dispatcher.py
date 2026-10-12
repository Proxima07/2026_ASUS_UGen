from __future__ import annotations

from app.agent.policy import PolicyError, validate_plan
from app.schemas import Plan


class Dispatcher:
    def __init__(self, repository, settings):
        self.repo = repository
        self.settings = settings

    @staticmethod
    def _phone_first(request: dict) -> bool:
        return request.get("context", {}).get("note_target", "phone_first") == "phone_first"

    @staticmethod
    def _supports(request: dict, *kinds: str) -> bool:
        capabilities = set(request.get("context", {}).get("native_capabilities", []))
        return all(kind in capabilities for kind in kinds)

    def _finish(self, principal, request_id: str, changes: dict) -> dict:
        self.repo.update_request(principal, request_id, changes)
        return self.repo.get_request(principal, request_id)

    def _action(self, principal, request_id: str, kind: str, payload: dict, key: str) -> dict:
        return self.repo.create_action(principal, kind=kind, payload=payload, request_id=request_id,
            idempotency_key=key, ttl_seconds=self.settings.action_ttl_seconds)

    def _await(self, principal, request_id: str, action: dict, message: str, **changes) -> dict:
        return self._finish(principal, request_id,
            {**changes, "status": "awaiting_device", "action_id": action["action_id"], "message": message})

    def _platform_create(self, principal, request_id: str, args: dict, *, fallback: bool = False,
                         changes: dict | None = None) -> dict:
        note = self.repo.create_note(principal, title=args["title"], content=args["content"],
            transcript=args.get("transcript"), idempotency_key=f"request:{request_id}")
        message = "備忘錄已保存至本地中樞"
        if fallback:
            message = "手機筆記未能保存，已改存本地中樞；手機筆記未宣稱完成"
        return self._finish(principal, request_id, {**(changes or {}), "status": "completed",
            "message": message, "note": note, "storage_target": "platform", "fallback": fallback})

    def _platform_matches(self, principal, query: str) -> list[dict]:
        query = query.casefold()
        # PoC limits the lookup to the same bounded page used by existing notes APIs.
        return [note for note in self.repo.list_notes(principal, limit=200)
            if query in (note["title"] + "\n" + note["content"]).casefold()][:20]

    def _platform_lookup(self, principal, request_id: str, query: str, *, fallback: bool,
                         changes: dict | None = None) -> dict:
        notes = self._platform_matches(principal, query)
        message = f"在本地中樞找到 {len(notes)} 筆備忘錄"
        if fallback:
            message = "手機筆記未能查詢，已改查本地中樞。" + message
        return self._finish(principal, request_id, {**(changes or {}), "status": "completed",
            "message": message, "notes": notes, "storage_target": "platform", "fallback": fallback})

    def _stash_update(self, principal, request_id: str, args: dict) -> dict:
        request = self.repo.get_request(principal, request_id)
        saved = request.get("pending_note_update")
        if saved is not None and saved != args:
            raise PolicyError("immutable_note_update", "此請求的筆記修改內容已固定，請建立新指令")
        if saved is None:
            self.repo.update_request(principal, request_id, {"pending_note_update": dict(args)})
        return self.repo.get_request(principal, request_id)

    def _platform_update_selected(self, principal, request_id: str, note_id: str, *, fallback: bool,
                                  changes: dict | None = None) -> dict:
        request = self.repo.get_request(principal, request_id)
        specification = request["pending_note_update"]
        staged = request.get("pending_platform_note_update")
        if staged is None:
            note = self.repo.get_note(principal, note_id)
            content = specification["content"]
            if specification.get("mode", "replace") == "append":
                content = note["content"] + "\n" + content
            if len(content) > 16000:
                return self._finish(principal, request_id, {**(changes or {}), "status": "needs_clarification",
                    "message": "追加後筆記超過支援上限，請縮短內容；原筆記未修改",
                    "storage_target": "platform", "fallback": fallback})
            staged = {"note_id": note_id, "title": specification.get("title") or note["title"],
                      "content": content, "transcript": note.get("transcript")}
            # Persist the exact replacement BEFORE writing. Replay never appends twice.
            self.repo.update_request(principal, request_id, {"pending_platform_note_update": staged})
        elif staged["note_id"] != note_id:
            raise PolicyError("immutable_note_update", "此請求已固定修改另一筆筆記，請建立新指令")
        note = self.repo.update_note(principal, **staged)
        message = "本地中樞筆記已更新"
        if fallback:
            message = "手機筆記未能更新，已更新明確對應的本地中樞筆記；手機修改未宣稱完成"
        return self._finish(principal, request_id, {**(changes or {}), "status": "completed", "message": message,
            "note": note, "storage_target": "platform", "fallback": fallback})

    def _platform_update(self, principal, request_id: str, *, fallback: bool,
                         changes: dict | None = None) -> dict:
        request = self.repo.get_request(principal, request_id)
        staged = request.get("pending_platform_note_update")
        if staged:
            return self._platform_update_selected(principal, request_id, staged["note_id"],
                fallback=fallback, changes=changes)
        notes = self._platform_matches(principal, request["pending_note_update"]["query"])
        if not notes:
            prefix = "手機筆記未能更新，" if fallback else ""
            return self._finish(principal, request_id, {**(changes or {}), "status": "needs_clarification",
                "message": prefix + "本地中樞也找不到明確對應筆記；請提供筆記名稱，沒有新增或修改筆記",
                "storage_target": "platform", "fallback": fallback})
        if len(notes) > 1:
            candidates = [{"note_id": n["note_id"], "title": n["title"], "preview": n["content"][:500],
                           "candidate_id": f"platform:{request_id}:{index}"} for index, n in enumerate(notes)]
            return self._finish(principal, request_id, {**(changes or {}), "status": "needs_note_selection",
                "message": "本地中樞找到多筆筆記，請選擇要修改的對象", "note_candidates": candidates,
                "note_selection_target": "platform", "storage_target": "platform", "fallback": fallback})
        return self._platform_update_selected(principal, request_id, notes[0]["note_id"],
            fallback=fallback, changes=changes)

    def apply(self, principal, request_id: str, plan: Plan, input_text: str) -> dict:
        validate_plan(plan, input_text)
        request = self.repo.get_request(principal, request_id)
        phone_first = self._phone_first(request)
        if plan.kind != "tool":
            return self._finish(principal, request_id, {"status": "completed" if plan.kind == "reply" else "needs_clarification", "message": plan.message})
        if plan.tool == "notes.create":
            if phone_first:
                if not self._supports(request, "notes.create_native"):
                    return self._finish(principal, request_id, {"status": "unsupported",
                        "message": "目前未連接支援手機記事本的 APK；沒有保存筆記。請在 APK 使用，或明確改用平台備忘錄。",
                        "storage_target": "phone_app", "fallback": False})
                payload = {"title": plan.args["title"], "content": plan.args["content"],
                    "transcript": plan.args.get("transcript")}
                action = self._action(principal, request_id, "notes.create_native", payload, f"request:{request_id}:initial")
                return self._await(principal, request_id, action,
                    "請確認後開啟手機記事本，並在記事本 App 內確認儲存；尚未保存筆記。",
                    note_operation="create_native", storage_target="phone_app", fallback=False)
            return self._platform_create(principal, request_id, plan.args)
        if plan.tool == "notes.search":
            if phone_first:
                return self._native_notes_unavailable(principal, request_id, "查詢")
            return self._platform_lookup(principal, request_id, plan.args["query"], fallback=False)
        if plan.tool == "notes.update":
            if phone_first:
                return self._native_notes_unavailable(principal, request_id, "更新")
            self._stash_update(principal, request_id, plan.args)
            return self._platform_update(principal, request_id, fallback=False)
        payload = dict(plan.args)
        if plan.tool == "calendar.create" and plan._defaults_notice:
            payload["defaults_notice"] = plan._defaults_notice
        if plan.tool == "notes.share":
            note = self.repo.get_note(principal, payload["note_id"])
            payload = {"note_id": note["note_id"], "title": note["title"], "content": note["content"]}
        action = self._action(principal, request_id, plan.tool, payload, f"request:{request_id}:initial")
        message = plan.message or "請在手機確認操作"
        if plan.tool == "calendar.create":
            message = (f"請確認行程「{payload['title']}」：{payload['start']} 至 {payload['end']}，"
                       f"開始前 {payload['reminder_minutes']} 分鐘提醒。" + plan._defaults_notice)
        elif plan.tool == "timer.create":
            message = f"請確認倒數計時 {payload['duration_seconds']} 秒「{payload['label']}」；尚未在時鐘 App 執行。"
        return self._await(principal, request_id, action, message)

    def _native_notes_unavailable(self, principal, request_id: str, operation: str) -> dict:
        return self._finish(principal, request_id, {"status": "unsupported",
            "message": f"手機預設記事本沒有通用的 Android {operation}介面；目前未{operation}筆記，也沒有改用平台備忘錄。請在記事本 App 內處理，或明確改用平台備忘錄。",
            "storage_target": "phone_app", "fallback": False})

    def after_result(self, principal, action: dict) -> dict | None:
        request_id = action.get("request_id")
        if not request_id:
            return None
        request = self.repo.get_request(principal, request_id)
        if request.get("last_result_action_id") == action["action_id"] or request.get("action_id") != action["action_id"]:
            return request
        state = action["state"]
        changes = {"last_result_action_id": action["action_id"], "last_result": action.get("result"), "status": state}
        kind = action["kind"]
        if kind == "notes.create_native":
            messages = {
                "opened": "已開啟手機記事本介面；請在該 App 內確認儲存，尚未驗證筆記已保存。",
                "handed_off": "已把筆記內容交給手機 App；請選擇記事本並確認儲存，尚未驗證筆記已保存。",
                "cancelled": "已取消開啟手機記事本；沒有改存平台備忘錄。",
                "unsupported": "手機沒有支援的記事本接收介面；沒有改存平台備忘錄。",
                "permission_denied": "未取得開啟手機記事本所需權限；沒有改存平台備忘錄。",
                "failed": "開啟手機記事本未完成；没有改存平台備忘錄。",
            }
            return self._finish(principal, request_id, {**changes,
                "message": messages.get(state, "手機記事本操作狀態已更新；尚未驗證筆記已保存。"),
                "storage_target": "phone_app", "fallback": False})
        if kind in {"notes.save_local", "notes.search_local", "notes.update_local"}:
            # Old APK-private notes are not the user's default notes application.
            # In particular, an unsupported old operation must never copy content
            # into platform notes as an automatic fallback.
            return self._finish(principal, request_id, {**changes,
                "message": "舊版 APK 私有筆記功能已停用；請重新建立指令使用手機記事本。沒有改存平台備忘錄。",
                "fallback": False})
        if kind == "contacts.search" and state == "completed":
            contacts = (action.get("result") or {}).get("contacts", [])
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
        return self._finish(principal, request_id, changes)

    def _dial_action(self, principal, request_id: str, candidate: dict, parent_id: str) -> dict:
        return self._action(principal, request_id, "phone.dial",
            {"name": candidate.get("name", ""), "phone_number": candidate["phone_number"]}, f"contact-dial:{parent_id}")

    def select_contact(self, principal, request_id: str, candidate_id: str) -> dict:
        request = self.repo.get_request(principal, request_id)
        if request.get("status") != "needs_selection":
            raise PolicyError("selection_not_expected", "這個請求目前不需要選擇聯絡人")
        candidates = [c for c in request.get("candidates", []) if c["candidate_id"] == candidate_id]
        if not candidates:
            raise PolicyError("invalid_candidate", "選擇的聯絡人不屬於這個請求")
        action = self._dial_action(principal, request_id, candidates[0], request["last_result_action_id"])
        return self._await(principal, request_id, action, "請確認電話後開啟撥號介面")

    def select_note(self, principal, request_id: str, candidate_id: str) -> dict:
        request = self.repo.get_request(principal, request_id)
        if request.get("status") != "needs_note_selection":
            raise PolicyError("note_selection_not_expected", "這個請求目前不需要選擇筆記")
        candidates = [note for note in request.get("note_candidates", []) if note["candidate_id"] == candidate_id]
        if not candidates:
            raise PolicyError("invalid_note_candidate", "選擇的筆記不屬於這個請求")
        if request.get("note_selection_target") == "platform":
            return self._platform_update_selected(principal, request_id, candidates[0]["note_id"],
                fallback=request.get("fallback", False))
        return self._native_notes_unavailable(principal, request_id, "更新")

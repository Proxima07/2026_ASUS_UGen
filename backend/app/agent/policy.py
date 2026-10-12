import json
import re
from datetime import datetime, timezone

from app.schemas import DialArgs, LocalNoteMetadata, Plan


class PolicyError(Exception):
    def __init__(self, code: str, message: str):
        self.code = code
        super().__init__(message)


def validate_plan(plan: Plan, input_text: str) -> None:
    if plan.tool == "phone.dial":
        target = re.sub(r"\D", "", plan.args["phone_number"])
        source = re.sub(r"\D", "", input_text)
        if not target or target not in source:
            raise PolicyError("unverified_phone", "姓名撥號必須先查通訊錄；模型不能自行猜電話號碼")
    if plan.tool == "calendar.create":
        start = datetime.fromisoformat(plan.args["start"])
        if start < datetime.now(timezone.utc):
            raise PolicyError("past_calendar_time", "模型解析到已過去的時間，請指定日期與時間")


def validate_result(kind: str, state: str, result: dict, *, payload: dict | None = None) -> None:
    try:
        encoded = json.dumps(result, ensure_ascii=False, allow_nan=False).encode()
    except (ValueError, TypeError) as exc:
        raise PolicyError("invalid_result_json", "操作結果必須是有效 JSON，不能包含 NaN 或 Infinity") from exc
    if len(encoded) > 32768:
        raise PolicyError("result_too_large", "操作結果超過上限")
    if state == "completed" and kind in {"phone.dial", "alarm.create", "timer.create", "notes.share"}:
        raise PolicyError("unverifiable_completion", "這項操作只能回報已開啟或已交接，不能宣稱已完成")
    if state == "completed" and kind == "calendar.create" and not result.get("event_id"):
        raise PolicyError("missing_event_id", "直接日曆寫入完成時需要 event_id；開啟新增介面請回報 opened")
    if state == "completed" and kind in {"notes.save_local", "notes.update_local"}:
        note_id = result.get("note_id")
        if not isinstance(note_id, str) or not 1 <= len(note_id) <= 100:
            raise PolicyError("missing_note_id", "手機筆記完成時需要回傳 note_id")
        if payload is not None and note_id != payload.get("note_id"):
            raise PolicyError("mismatched_note_id", "回傳的手機筆記 ID 與操作不一致")
    if kind == "notes.search_local" and state == "completed":
        if set(result) != {"notes"}:
            raise PolicyError("invalid_local_notes", "手機筆記查詢結果只能包含 notes metadata")
        notes = result.get("notes")
        if not isinstance(notes, list) or len(notes) > 20:
            raise PolicyError("invalid_local_notes", "手機筆記查詢需提供最多 20 筆 notes metadata")
        seen = set()
        for note in notes:
            try:
                metadata = LocalNoteMetadata.model_validate(note)
            except Exception as exc:
                raise PolicyError("invalid_local_notes", "手機筆記結果只能包含合法 note_id、title 與短 preview") from exc
            if metadata.note_id in seen:
                raise PolicyError("invalid_local_notes", "手機筆記結果的 note_id 不可重複")
            seen.add(metadata.note_id)
    if kind == "contacts.search" and state == "completed":
        contacts = result.get("contacts")
        if not isinstance(contacts, list) or len(contacts) > 20:
            raise PolicyError("invalid_contacts", "通訊錄結果需提供最多 20 筆 contacts")
        for contact in contacts:
            if not isinstance(contact, dict) or set(contact) - {"name", "phone_number", "contact_id"}:
                raise PolicyError("invalid_contacts", "聯絡人欄位不合法")
            try:
                DialArgs.model_validate({"name": contact.get("name", ""), "phone_number": contact.get("phone_number", "")})
            except Exception as exc:
                raise PolicyError("invalid_contacts", "聯絡人名稱或電話格式不合法") from exc

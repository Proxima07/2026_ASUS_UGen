"""Versioned, bounded contracts shared with the future web/APK clients."""
from __future__ import annotations

from datetime import datetime
from typing import Annotated, Any, Literal
from zoneinfo import ZoneInfo

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, field_validator, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class PairRequest(StrictModel):
    code: str = Field(min_length=8, max_length=200)
    label: str = Field(min_length=1, max_length=100)


NativeCapability = Literal[
    "contacts.search", "phone.dial", "alarm.create", "calendar.create",
    "notes.save_local", "notes.share", "notes.search_local", "notes.update_local",
]


class ChatRequest(StrictModel):
    text: str = Field(min_length=1, max_length=8000)
    timezone: str = "Asia/Taipei"
    idempotency_key: str | None = Field(default=None, min_length=1, max_length=128)
    note_target: Literal["platform", "phone_first"] = "platform"
    # Hints choose routing only. They do not authenticate or grant device access.
    native_capabilities: list[NativeCapability] = Field(default_factory=list, max_length=20)

    @field_validator("native_capabilities")
    @classmethod
    def normalize_capabilities(cls, value: list[str]) -> list[str]:
        return sorted(set(value))

    @field_validator("timezone")
    @classmethod
    def valid_timezone(cls, value: str) -> str:
        try:
            ZoneInfo(value)
        except (KeyError, ValueError) as exc:
            raise ValueError("請提供合法 IANA 時區") from exc
        return value


class NoteCreate(StrictModel):
    title: str = Field(min_length=1, max_length=200)
    content: str = Field(min_length=1, max_length=16000)
    transcript: str | None = Field(default=None, max_length=24000)
    idempotency_key: str | None = Field(default=None, min_length=1, max_length=128)


class NoteUpdate(StrictModel):
    title: str = Field(min_length=1, max_length=200)
    content: str = Field(min_length=1, max_length=16000)
    transcript: str | None = Field(default=None, max_length=24000)


class NoteActionCreate(StrictModel):
    kind: Literal["notes.save_local", "notes.share"]
    idempotency_key: str | None = Field(default=None, min_length=1, max_length=128)


class ContactsSearchArgs(StrictModel):
    query: str = Field(min_length=1, max_length=100)
    purpose: Literal["dial", "lookup"] = "dial"


class DialArgs(StrictModel):
    name: str = Field(default="", max_length=100)
    phone_number: str = Field(min_length=3, max_length=32, pattern=r"^\+?[0-9][0-9 ()-]{1,30}[0-9]$")


class AlarmArgs(StrictModel):
    hour: int = Field(ge=0, le=23)
    minute: int = Field(ge=0, le=59)
    label: str = Field(default="提醒", max_length=100)
    weekdays: list[int] = Field(default_factory=list, max_length=7)

    @field_validator("weekdays")
    @classmethod
    def valid_weekdays(cls, days: list[int]) -> list[int]:
        if any(d < 1 or d > 7 for d in days) or len(set(days)) != len(days):
            raise ValueError("weekdays 使用 Android Calendar 1=週日至7=週六，不可重複")
        return days


class CalendarArgs(StrictModel):
    title: str = Field(min_length=1, max_length=200)
    start: datetime
    end: datetime
    description: str = Field(default="", max_length=2000)
    location: str = Field(default="", max_length=200)
    reminder_minutes: int = Field(default=10, ge=0, le=10080)

    @model_validator(mode="after")
    def valid_dates(self):
        if self.start.tzinfo is None or self.end.tzinfo is None:
            raise ValueError("日曆時間必須包含時區 offset")
        if self.end <= self.start:
            raise ValueError("結束時間必須晚於開始時間")
        return self


class NoteSearchArgs(StrictModel):
    query: str = Field(min_length=1, max_length=200)


class NoteUpdateArgs(StrictModel):
    query: str = Field(min_length=1, max_length=200)
    content: str = Field(min_length=1, max_length=16000)
    mode: Literal["replace", "append"] = "replace"
    title: str | None = Field(default=None, min_length=1, max_length=200)


class LocalNoteMetadata(StrictModel):
    note_id: str = Field(min_length=1, max_length=100)
    title: str = Field(min_length=1, max_length=200)
    preview: str | None = Field(default=None, max_length=500)


class NoteReferenceArgs(StrictModel):
    note_id: str = Field(min_length=1, max_length=100)


TOOL_ARGS: dict[str, type[BaseModel]] = {
    "contacts.search": ContactsSearchArgs,
    "phone.dial": DialArgs,
    "alarm.create": AlarmArgs,
    "calendar.create": CalendarArgs,
    "notes.create": NoteCreate,
    "notes.search": NoteSearchArgs,
    "notes.update": NoteUpdateArgs,
    "notes.save_local": NoteReferenceArgs,
    "notes.share": NoteReferenceArgs,
}


class Plan(StrictModel):
    kind: Literal["reply", "clarify", "tool"]
    message: str = Field(default="", max_length=3000)
    tool: str | None = Field(default=None, max_length=64)
    args: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def verify_tool(self):
        if self.kind == "tool":
            if self.tool not in TOOL_ARGS:
                raise ValueError("不支援的工具")
            self.args = TOOL_ARGS[self.tool].model_validate(self.args).model_dump(mode="json")
        elif self.tool or self.args:
            raise ValueError("回答與澄清不能帶操作參數")
        elif not self.message.strip():
            raise ValueError("回答不可空白")
        return self


ResultState = Literal["completed", "opened", "handed_off", "cancelled", "permission_denied", "unsupported", "failed"]


class ActionResult(StrictModel):
    execution_token: str = Field(min_length=20, max_length=200)
    state: ResultState
    result: dict[str, Any] = Field(default_factory=dict)


class SelectContact(StrictModel):
    candidate_id: str = Field(min_length=1, max_length=200)


class SelectNote(StrictModel):
    candidate_id: str = Field(min_length=1, max_length=200)


class ActionEnvelope(StrictModel):
    protocol_version: Literal["1"] = "1"
    action_id: str
    request_id: str | None
    kind: NativeCapability
    payload: dict[str, Any]
    state: str
    expires_at: float


class BridgeMessage(StrictModel):
    protocol_version: Literal["1"] = "1"
    message_id: str = Field(min_length=1, max_length=128)
    type: Literal["execute_action"] = "execute_action"
    action_id: str = Field(min_length=1, max_length=128)


class BridgeHello(StrictModel):
    protocol_version: Literal["1"] = "1"
    message_id: str = Field(min_length=1, max_length=128)
    type: Literal["hello"] = "hello"


class BridgeReady(StrictModel):
    protocol_version: Literal["1"] = "1"
    message_id: str = Field(min_length=1, max_length=128)
    type: Literal["ready"] = "ready"
    capabilities: list[str] = Field(default_factory=list, max_length=20)
    uncertain_actions: int = Field(default=0, ge=0)


class BridgeActionResult(StrictModel):
    protocol_version: Literal["1"] = "1"
    message_id: str = Field(min_length=1, max_length=128)
    type: Literal["action_result"] = "action_result"
    action_id: str = Field(min_length=1, max_length=128)
    state: str = Field(min_length=1, max_length=64)
    message: str = Field(default="", max_length=3000)
    result: dict[str, Any] = Field(default_factory=dict)


class BridgeLogout(StrictModel):
    protocol_version: Literal["1"] = "1"
    message_id: str = Field(min_length=1, max_length=128)
    type: Literal["logout"] = "logout"


class BridgeLoggedOut(StrictModel):
    protocol_version: Literal["1"] = "1"
    message_id: str = Field(min_length=1, max_length=128)
    type: Literal["logged_out"] = "logged_out"


class BridgeErrorDetail(StrictModel):
    code: str = Field(min_length=1, max_length=128)
    message: str = Field(min_length=1, max_length=3000)


class BridgeError(StrictModel):
    protocol_version: Literal["1"] = "1"
    message_id: str = Field(default="", max_length=128)
    type: Literal["error"] = "error"
    error: BridgeErrorDetail


BridgeProtocol = Annotated[BridgeMessage | BridgeHello | BridgeReady | BridgeActionResult | BridgeLogout | BridgeLoggedOut | BridgeError, Field(discriminator="type")]

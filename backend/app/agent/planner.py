from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from pydantic import ValidationError

from app.adapters.llm_client import LLMClient
from app.config import BACKEND_DIR
from app.schemas import NoteCreate, Plan, TOOL_ARGS


class PlanningError(Exception):
    def __init__(self, message: str = "模型未提供可驗證的操作，請換一種說法再試一次"):
        self.code = "invalid_model_plan"
        super().__init__(message)


def parse_json_response(text: str) -> dict:
    if len(text) > 40000:
        raise PlanningError()
    cleaned = text.strip()
    if cleaned.startswith("```") and cleaned.endswith("```"):
        cleaned = cleaned.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
    try:
        data = json.loads(cleaned)
    except (ValueError, TypeError) as exc:
        raise PlanningError() from exc
    if not isinstance(data, dict):
        raise PlanningError()
    return data


class Planner:
    def __init__(self, llm: LLMClient):
        self.llm = llm
        self.plan_prompt = (BACKEND_DIR / "prompts/planner.txt").read_text(encoding="utf-8")
        self.summary_prompt = (BACKEND_DIR / "prompts/summarize.txt").read_text(encoding="utf-8")

    async def plan(self, text: str, timezone: str) -> Plan:
        now = datetime.now(ZoneInfo(timezone)).isoformat()
        tools = {name: model.model_json_schema() for name, model in TOOL_ARGS.items()}
        prompt = self.plan_prompt + "\n現在時間（以此解析相對日期）:" + now
        prompt += "\n可用工具參數 JSON Schema:" + json.dumps(tools, ensure_ascii=False)
        prompt += "\n回答 JSON Schema:" + json.dumps(Plan.model_json_schema(), ensure_ascii=False)
        result = await self.llm.complete([
            {"role": "system", "content": prompt},
            {"role": "user", "content": text},
        ], json_schema=Plan.model_json_schema())
        try:
            return Plan.model_validate(parse_json_response(result))
        except ValidationError as exc:
            raise PlanningError() from exc

    async def summarize(self, transcript: str) -> NoteCreate:
        schema = NoteCreate.model_json_schema()
        result = await self.llm.complete([
            {"role": "system", "content": self.summary_prompt + "\n" + json.dumps(schema, ensure_ascii=False)},
            {"role": "user", "content": transcript},
        ], json_schema=schema)
        try:
            note = NoteCreate.model_validate(parse_json_response(result))
            note.transcript = transcript
            note.idempotency_key = None
            return note
        except ValidationError as exc:
            raise PlanningError("逐字稿已完成，但模型未提供合法筆記；可保留逐字稿後重試整理") from exc

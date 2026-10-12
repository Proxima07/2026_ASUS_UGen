import logging
import time

from fastapi import APIRouter, Depends, HTTPException, Request

from app.adapters.llm_client import AdapterError
from app.agent.planner import PlanningError
from app.agent.policy import PolicyError
from app.api.dependencies import principal
from app.observability import event
from app.schemas import ChatRequest, SelectContact, SelectNote
from app.storage.repositories import RepositoryError

router = APIRouter(prefix="/v1", tags=["chat"])


async def _run_request(body, request, identity, record, *, history=None, previous_status=None):
    state = request.app.state
    request_id = record["request_id"]
    record = state.repo.get_request(identity, request_id)
    if not record.get("trace_id"):
        source_trace = None
        if body.source_job_id:
            source_trace = state.repo.get_job(identity, body.source_job_id).get("trace_id")
        record = state.repo.update_request(identity, request_id,
            {"trace_id": source_trace or request.state.http_request_id})
    trace_id = record["trace_id"]
    history_fields = {"conversation_id": record.get("conversation_id"),
        "history_messages": len(history or []), "history_chars": sum(len(m["content"]) for m in history or [])}
    event(state, "chat.received", trace_id=trace_id, http_request_id=request.state.http_request_id,
          request_id=request_id, job_id=body.source_job_id, chars=len(body.text), command_text=body.text, **history_fields)
    if record["status"] != "processing":
        event(state, "chat.replayed", trace_id=trace_id, request_id=request_id, state=record["status"])
        return record
    started = time.monotonic()
    try:
        async with state.model_semaphore:
            started = time.monotonic()
            event(state, "agent.started", trace_id=trace_id, request_id=request_id, chars=len(body.text), **history_fields)
            if history is None:
                plan = await state.planner.plan(body.text, body.timezone)
            else:
                plan = await state.planner.plan(body.text, body.timezone,
                    history=history, previous_status=previous_status)
        result = state.dispatcher.apply(identity, request_id, plan, body.text)
        event(state, "agent.completed", trace_id=trace_id, request_id=request_id,
              plan_kind=plan.kind, kind=plan.tool, state=result["status"],
              duration_ms=round((time.monotonic()-started)*1000, 2))
        return result
    except (AdapterError, PlanningError, PolicyError, RepositoryError) as exc:
        event(state, "agent.failed", level=logging.ERROR, trace_id=trace_id, request_id=request_id,
              code=exc.code, duration_ms=round((time.monotonic()-started)*1000, 2))
        state.repo.update_request(identity, request_id, {"status": "failed", "error": {"code": exc.code, "message": str(exc)}})
        return state.repo.get_request(identity, request_id)
    except Exception:
        event(state, "agent.failed", level=logging.ERROR, trace_id=trace_id, request_id=request_id,
              code="agent_internal_error", duration_ms=round((time.monotonic()-started)*1000, 2))
        state.repo.update_request(identity, request_id, {"status": "failed",
            "error": {"code": "agent_internal_error", "message": "本次指令未完成，請重新提交"}})
        if body.conversation_id is not None:
            # This turn already became the conversation head. Return its IDs so
            # the next legitimate turn can follow it instead of being stranded.
            return state.repo.get_request(identity, request_id)
        raise


@router.post("/chat")
async def chat(body: ChatRequest, request: Request, identity=Depends(principal)):
    state = request.app.state
    if len(body.text) > state.settings.max_text_chars:
        raise HTTPException(413, detail={"code": "text_too_large", "message": "文字超過設定上限"})
    context = {"timezone": body.timezone}
    if body.note_target != "platform" or body.native_capabilities:
        context.update(note_target=body.note_target, native_capabilities=body.native_capabilities)
    if body.source_job_id:
        source_job = state.repo.get_job(identity, body.source_job_id)
        if source_job.get("purpose") != "command" or source_job.get("status") != "transcribed":
            raise HTTPException(409, detail={"code": "source_job_not_ready", "message": "來源工作不是已完成的語音指令"})
        if source_job.get("transcript", "").strip() != body.text.strip():
            raise HTTPException(422, detail={"code": "source_job_text_mismatch", "message": "指令與來源工作逐字稿不一致；修改文字時請作為新文字指令"})
        context["source_job_id"] = body.source_job_id
    if body.conversation_id is None:
        record = state.repo.create_request(identity, body.text, context, body.idempotency_key)
        async with state.request_lock(record["request_id"]):
            return await _run_request(body, request, identity, record)
    context["conversation_id"] = body.conversation_id
    if body.parent_request_id:
        context["parent_request_id"] = body.parent_request_id
    if body.conversation_id == "new":
        record = state.repo.create_request(identity, body.text, context, body.idempotency_key)
        conversation_id = state.repo.create_conversation_for_request(identity, record["request_id"])
    else:
        conversation_id = body.conversation_id
        record = None
    async with state.request_lock("conversation:" + conversation_id):
        conversation = state.repo.get_conversation(identity, conversation_id)
        if record is None:
            record = state.repo.find_request_by_idempotency(identity, body.text, context, body.idempotency_key)
        if record is None:
            if conversation["last_request_id"] != body.parent_request_id:
                raise HTTPException(409, detail={"code": "conversation_head_conflict", "message": "對話已有較新的訊息，請重新整理後再傳送"})
            if conversation["last_request_id"] and state.repo.get_request(identity, conversation["last_request_id"])["status"] == "processing":
                raise HTTPException(409, detail={"code": "conversation_busy", "message": "上一輪尚未完成，請先重試上一輪請求"})
            record = state.repo.create_request(identity, body.text, context, body.idempotency_key)
        request_id = record["request_id"]
        if record.get("conversation_id") == conversation_id and request_id not in conversation["request_ids"]:
            if record["status"] == "processing":
                raise HTTPException(409, detail={"code": "conversation_request_stale", "message": "這個舊請求已不在目前對話範圍，請建立新的指令"})
            async with state.request_lock(request_id):
                return await _run_request(body, request, identity, record)
        if request_id not in conversation["request_ids"]:
            state.repo.append_conversation_request(identity, conversation_id, request_id, body.parent_request_id)
        elif record["status"] == "processing" and conversation["last_request_id"] != request_id:
            raise HTTPException(409, detail={"code": "conversation_request_stale", "message": "無法重新規劃已有後續訊息的舊請求"})
        history = state.repo.conversation_history(identity, conversation_id, exclude_request_id=request_id,
            max_messages=state.settings.conversation_max_messages, max_chars=state.settings.conversation_max_chars)
        async with state.request_lock(request_id):
            return await _run_request(body, request, identity, record,
                history=history["messages"], previous_status=history["previous_status"])


@router.get("/requests/{request_id}")
def get_request(request_id: str, request: Request, identity=Depends(principal)):
    record = request.app.state.repo.get_request(identity, request_id)
    if record.get("action_id"):
        record["action"] = request.app.state.repo.get_action(identity, record["action_id"])
    return record


@router.post("/requests/{request_id}/select-contact")
async def select_contact(request_id: str, body: SelectContact, request: Request, identity=Depends(principal)):
    async with request.app.state.request_lock(request_id):
        return request.app.state.dispatcher.select_contact(identity, request_id, body.candidate_id)


@router.post("/requests/{request_id}/select-note")
async def select_note(request_id: str, body: SelectNote, request: Request, identity=Depends(principal)):
    async with request.app.state.request_lock(request_id):
        return request.app.state.dispatcher.select_note(identity, request_id, body.candidate_id)

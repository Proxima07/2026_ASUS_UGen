import logging
import time

from fastapi import APIRouter, Depends, HTTPException, Request

from app.adapters.llm_client import AdapterError
from app.agent.planner import PlanningError
from app.agent.policy import PolicyError
from app.api.dependencies import principal
from app.observability import event
from app.schemas import ChatRequest, SelectContact, SelectNote

router = APIRouter(prefix="/v1", tags=["chat"])


@router.post("/chat")
async def chat(body: ChatRequest, request: Request, identity=Depends(principal)):
    state = request.app.state
    if len(body.text) > state.settings.max_text_chars:
        raise HTTPException(413, detail={"code": "text_too_large", "message": "文字超過設定上限"})
    context = {"timezone": body.timezone}
    # Keep the v1/v2 context shape for callers that omit the new routing hints.
    if body.note_target != "platform" or body.native_capabilities:
        context.update(note_target=body.note_target, native_capabilities=body.native_capabilities)
    source_trace = None
    if body.source_job_id:
        source_job = state.repo.get_job(identity, body.source_job_id)
        if source_job.get("purpose") != "command" or source_job.get("status") != "transcribed":
            raise HTTPException(409, detail={"code": "source_job_not_ready", "message": "來源工作不是已完成的語音指令"})
        if source_job.get("transcript", "").strip() != body.text.strip():
            raise HTTPException(422, detail={"code": "source_job_text_mismatch", "message": "指令與來源工作逐字稿不一致；修改文字時請作為新文字指令"})
        context["source_job_id"] = body.source_job_id
        source_trace = source_job.get("trace_id")
    record = state.repo.create_request(identity, body.text, context, body.idempotency_key)
    request_id = record["request_id"]
    async with state.request_lock(request_id):
        record = state.repo.get_request(identity, request_id)
        if not record.get("trace_id"):
            record = state.repo.update_request(identity, request_id,
                {"trace_id": source_trace or request.state.http_request_id})
        trace_id = record["trace_id"]
        event(state, "chat.received", trace_id=trace_id, http_request_id=request.state.http_request_id,
              request_id=request_id, job_id=body.source_job_id, chars=len(body.text), command_text=body.text)
        if record["status"] != "processing":
            event(state, "chat.replayed", trace_id=trace_id, request_id=request_id, state=record["status"])
            return record
        started = time.monotonic()
        try:
            async with state.model_semaphore:
                started = time.monotonic()
                event(state, "agent.started", trace_id=trace_id, request_id=request_id, chars=len(body.text))
                plan = await state.planner.plan(body.text, body.timezone)
            result = state.dispatcher.apply(identity, request_id, plan, body.text)
            event(state, "agent.completed", trace_id=trace_id, request_id=request_id,
                  plan_kind=plan.kind, kind=plan.tool, state=result["status"],
                  duration_ms=round((time.monotonic()-started)*1000, 2))
            return result
        except (AdapterError, PlanningError, PolicyError) as exc:
            event(state, "agent.failed", level=logging.ERROR, trace_id=trace_id, request_id=request_id,
                  code=exc.code, duration_ms=round((time.monotonic()-started)*1000, 2))
            state.repo.update_request(identity, request_id, {"status": "failed", "error": {"code": exc.code, "message": str(exc)}})
            return state.repo.get_request(identity, request_id)
        except Exception:
            event(state, "agent.failed", level=logging.ERROR, trace_id=trace_id, request_id=request_id,
                  code="agent_internal_error", duration_ms=round((time.monotonic()-started)*1000, 2))
            raise


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

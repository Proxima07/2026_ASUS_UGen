from fastapi import APIRouter, Depends, HTTPException, Request

from app.adapters.llm_client import AdapterError
from app.agent.planner import PlanningError
from app.agent.policy import PolicyError
from app.api.dependencies import principal
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
    record = state.repo.create_request(identity, body.text, context, body.idempotency_key)
    request_id = record["request_id"]
    async with state.request_lock(request_id):
        record = state.repo.get_request(identity, request_id)
        if record["status"] != "processing":
            return record
        try:
            async with state.model_semaphore:
                plan = await state.planner.plan(body.text, body.timezone)
            return state.dispatcher.apply(identity, request_id, plan, body.text)
        except (AdapterError, PlanningError, PolicyError) as exc:
            state.repo.update_request(identity, request_id, {"status": "failed", "error": {"code": exc.code, "message": str(exc)}})
            return state.repo.get_request(identity, request_id)


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

from fastapi import APIRouter, Depends, Request

from app.agent.policy import validate_result
from app.api.dependencies import device_principal, principal
from app.schemas import ActionResult

router = APIRouter(prefix="/v1/actions", tags=["actions"])


@router.get("")
def list_actions(request: Request, identity=Depends(principal)):
    return {"items": request.app.state.repo.list_actions(identity)}


@router.get("/{action_id}")
def get_action(action_id: str, request: Request, identity=Depends(device_principal)):
    return request.app.state.repo.get_action(identity, action_id)


@router.post("/{action_id}/confirm")
def confirm(action_id: str, request: Request, identity=Depends(device_principal)):
    return request.app.state.repo.confirm_action(identity, action_id, lease_seconds=request.app.state.settings.action_lease_seconds)


@router.post("/{action_id}/cancel")
async def cancel(action_id: str, request: Request, identity=Depends(principal)):
    action = request.app.state.repo.get_action(identity, action_id)
    key = action.get("request_id") or action_id
    async with request.app.state.request_lock(key):
        action = request.app.state.repo.cancel_action(identity, action_id)
        record = request.app.state.dispatcher.after_result(identity, action)
    return {"action": action, "request": record}


@router.post("/{action_id}/result")
async def result(action_id: str, body: ActionResult, request: Request, identity=Depends(device_principal)):
    state = request.app.state
    action = state.repo.get_action(identity, action_id)
    validate_result(action["kind"], body.state, body.result)
    async with state.request_lock(action.get("request_id") or action_id):
        action = state.repo.record_result(identity, action_id, body.execution_token, body.state, body.result)
        record = state.dispatcher.after_result(identity, action)
    return {"action": action, "request": record}

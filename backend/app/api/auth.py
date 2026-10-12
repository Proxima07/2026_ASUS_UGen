from fastapi import APIRouter, Depends, HTTPException, Request, Response

from app.api.dependencies import device_principal, principal
from app.schemas import PairingCodeCreate, PairRequest

router = APIRouter(prefix="/v1/auth", tags=["auth"])


@router.post("/pairing-codes")
def create_code(request: Request, body: PairingCodeCreate | None = None):
    request.app.state.rate_limit.check("pairing-admin", limit=20)
    if not request.app.state.auth.verify_admin(request.headers.get("x-bootstrap-token")):
        raise HTTPException(401, detail={"code": "invalid_admin_token", "message": "初始化管理憑證不正確"})
    return request.app.state.repo.create_pairing_code(ttl_seconds=300,
        user_id=body.user_id if body else None)


@router.post("/pair")
def pair(body: PairRequest, request: Request):
    request.app.state.rate_limit.check("pairing", limit=20)
    return request.app.state.repo.consume_pairing_code(body.code, body.label)


@router.post("/session")
def session(request: Request, response: Response, identity=Depends(device_principal)):
    ttl = request.app.state.settings.session_ttl_seconds
    token = request.app.state.repo.create_session(identity, ttl_seconds=ttl)
    response.set_cookie("local_assistant_session", token["token"], max_age=ttl,
                        secure=True, httponly=True, samesite="strict", path="/")
    return {"device_id": identity.device_id, "expires_at": token["expires_at"]}


@router.post("/logout")
def logout(request: Request, response: Response, identity=Depends(principal)):
    token = request.cookies.get("local_assistant_session")
    if token:
        request.app.state.repo.revoke_session(token)
    response.delete_cookie("local_assistant_session", secure=True, httponly=True, samesite="strict")
    return {"status": "logged_out"}


@router.get("/me")
def me(identity=Depends(principal)):
    return {"user_id": identity.user_id, "device_id": identity.device_id, "label": identity.label, "auth_kind": identity.auth_kind}


@router.post("/revoke-device")
def revoke(request: Request, identity=Depends(device_principal)):
    request.app.state.repo.revoke_device(identity)
    return {"status": "revoked"}

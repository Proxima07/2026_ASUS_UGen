from urllib.parse import urlsplit

from fastapi import HTTPException, Request


def principal(request: Request):
    identity = request.app.state.auth.authenticate_request(request)
    if identity is None:
        raise HTTPException(401, detail={"code": "unauthorized", "message": "請先完成裝置配對或登入"})
    if identity.auth_kind == "session" and request.method not in {"GET", "HEAD", "OPTIONS"}:
        origin = request.headers.get("origin")
        if not origin:
            ref = urlsplit(request.headers.get("referer", ""))
            origin = f"{ref.scheme}://{ref.netloc}" if ref.scheme and ref.netloc else None
        if origin != request.app.state.settings.allowed_origin:
            raise HTTPException(403, detail={"code": "invalid_origin", "message": "網頁操作來源不符"})
    return identity


def device_principal(request: Request):
    identity = principal(request)
    if identity.auth_kind != "device":
        raise HTTPException(403, detail={"code": "device_auth_required", "message": "這個端點需要 APK 的裝置憑證"})
    return identity

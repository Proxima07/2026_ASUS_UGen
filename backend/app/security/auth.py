"""Credential validation shared by API dependencies and native clients."""

from __future__ import annotations

import secrets
from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from app.storage.repositories import Repository


@dataclass(frozen=True)
class Principal:
    user_id: str
    device_id: str
    label: str = ""
    auth_kind: str = "device"


class Authenticator:
    """Prefer Bearer auth; malformed supplied auth never falls back to cookies."""

    def __init__(self, repository: Repository, admin_bootstrap_token: str, cookie_name: str = "local_assistant_session"):
        if len(admin_bootstrap_token) < 24:
            raise ValueError("ADMIN_BOOTSTRAP_TOKEN must contain at least 24 characters.")
        self.repository = repository
        self._admin_token = admin_bootstrap_token
        self.cookie_name = cookie_name

    def verify_admin(self, token: str | None) -> bool:
        return bool(token) and secrets.compare_digest(token.encode("utf-8"), self._admin_token.encode("utf-8"))

    def authenticate(self, authorization: str | None = None, session_token: str | None = None) -> Principal | None:
        if authorization is not None:
            scheme, separator, token = authorization.partition(" ")
            if not separator or scheme.lower() != "bearer" or not token or " " in token:
                return None
            return self.repository.authenticate_device(token)
        if session_token:
            return self.repository.authenticate_session(session_token)
        return None

    def authenticate_request(self, request) -> Principal | None:
        return self.authenticate(request.headers.get("authorization"), request.cookies.get(self.cookie_name))

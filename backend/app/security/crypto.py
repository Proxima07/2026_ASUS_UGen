"""Authenticated encryption for private payloads; no data is logged here."""

from __future__ import annotations

import base64
import json
import os
import stat
from pathlib import Path
from typing import Any

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


class CryptoBox:
    """Keep the key outside the database and authenticate each record's identity."""

    def __init__(self, key_path: str | Path, existing_data: bool = False):
        path = Path(key_path)
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if not path.exists():
            if existing_data:
                raise RuntimeError("Encryption key is missing for an existing database; restore the original key.")
            flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
            if hasattr(os, "O_NOFOLLOW"):
                flags |= os.O_NOFOLLOW
            try:
                descriptor = os.open(path, flags, 0o600)
            except FileExistsError:
                pass  # Another first-start process created the key.
            else:
                with os.fdopen(descriptor, "wb") as output:
                    output.write(os.urandom(32))
                    output.flush()
                    os.fsync(output.fileno())
        if path.is_symlink() or not stat.S_ISREG(path.stat().st_mode):
            raise RuntimeError("Encryption key must be a regular file, not a symbolic link.")
        key = path.read_bytes()
        if len(key) != 32:
            raise RuntimeError("Encryption key must contain exactly 32 bytes.")
        if os.name == "posix":
            path.chmod(0o600)
        self._cipher = AESGCM(key)

    @staticmethod
    def aad(user_id: str, kind: str, record_id: str) -> bytes:
        return json.dumps([user_id, kind, record_id], ensure_ascii=False, separators=(",", ":")).encode("utf-8")

    def encrypt(self, value: Any, *, user_id: str, kind: str, record_id: str) -> str:
        plaintext = json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
        nonce = os.urandom(12)
        ciphertext = self._cipher.encrypt(nonce, plaintext, self.aad(user_id, kind, record_id))
        return "v1:" + base64.urlsafe_b64encode(nonce + ciphertext).decode("ascii")

    def decrypt(self, value: str, *, user_id: str, kind: str, record_id: str) -> Any:
        if not value.startswith("v1:"):
            raise ValueError("Unsupported encrypted payload version.")
        raw = base64.b64decode(value[3:].encode("ascii"), altchars=b"-_", validate=True)
        if len(raw) < 28:
            raise ValueError("Invalid encrypted payload.")
        plaintext = self._cipher.decrypt(raw[:12], raw[12:], self.aad(user_id, kind, record_id))
        return json.loads(plaintext.decode("utf-8"))

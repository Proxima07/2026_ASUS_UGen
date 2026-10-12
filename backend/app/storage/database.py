"""Small SQLite owner; encrypted payloads are managed by Repository."""

from __future__ import annotations

import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from app.security.crypto import CryptoBox


SCHEMA = """
CREATE TABLE IF NOT EXISTS devices (
    device_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, label_enc TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE, active INTEGER NOT NULL DEFAULT 1,
    created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(device_id),
    expires_at REAL NOT NULL, created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS pairing_codes (
    code_hash TEXT PRIMARY KEY, expires_at REAL NOT NULL, created_at REAL NOT NULL,
    consumed_at REAL
);
CREATE TABLE IF NOT EXISTS requests (
    request_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, device_id TEXT NOT NULL REFERENCES devices(device_id),
    payload_enc TEXT NOT NULL, idem_hash TEXT, created_at REAL NOT NULL, updated_at REAL NOT NULL,
    UNIQUE(device_id, idem_hash)
);
CREATE TABLE IF NOT EXISTS notes (
    note_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, device_id TEXT NOT NULL REFERENCES devices(device_id),
    payload_enc TEXT NOT NULL, idem_hash TEXT, created_at REAL NOT NULL, updated_at REAL NOT NULL,
    UNIQUE(device_id, idem_hash)
);
CREATE TABLE IF NOT EXISTS actions (
    action_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, device_id TEXT NOT NULL REFERENCES devices(device_id),
    request_id TEXT REFERENCES requests(request_id), kind TEXT NOT NULL, payload_enc TEXT NOT NULL,
    idem_hash TEXT, state TEXT NOT NULL, created_at REAL NOT NULL, updated_at REAL NOT NULL,
    expires_at REAL NOT NULL, execution_hash TEXT, lease_expires_at REAL,
    result_enc TEXT, result_at REAL,
    UNIQUE(device_id, idem_hash)
);
CREATE TABLE IF NOT EXISTS jobs (
    job_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, device_id TEXT NOT NULL REFERENCES devices(device_id),
    payload_enc TEXT NOT NULL, created_at REAL NOT NULL, updated_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_user_created ON notes(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_actions_device_created ON actions(device_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_requests_device_created ON requests(device_id, created_at DESC);
PRAGMA user_version = 1;
"""


class Database:
    def __init__(self, db_path: str | Path, key_path: str | Path):
        self.path = Path(db_path)
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if self.path.is_symlink():
            raise RuntimeError("Database path must not be a symbolic link.")
        self.crypto = CryptoBox(key_path, existing_data=self.path.exists() and self.path.stat().st_size > 0)
        with self.connect() as connection:
            connection.execute("PRAGMA journal_mode = WAL")
            version = connection.execute("PRAGMA user_version").fetchone()[0]
            if version not in (0, 1):
                raise RuntimeError("Unsupported database schema version.")
            connection.executescript(SCHEMA)
        if os.name == "posix":
            self.path.chmod(0o600)

    @contextmanager
    def connect(self, *, write: bool = False) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.path, timeout=10, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 10000")
        connection.execute("PRAGMA secure_delete = ON")
        try:
            if write:
                connection.execute("BEGIN IMMEDIATE")
            yield connection
            if write:
                connection.commit()
        except BaseException:
            if write:
                connection.rollback()
            raise
        finally:
            connection.close()

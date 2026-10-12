#!/usr/bin/env python3
"""Package a component release or a file-level update without applying it.

Only explicitly associated paths are included. Runtime data and credentials
are excluded, and symbolic links are never followed or packaged.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import tempfile
from datetime import datetime, timezone
import zipfile


ASSOCIATED_PATHS = {
    "backend": (
        "docs/backend_v1.md",
        "docs/backend_v2.md",
        "deploy/pi/cloudflared.example.yml",
        "deploy/pi/local-assistant.service",
        "scripts/package_updates.py",
        "scripts/export_contracts.py",
        "contracts/action.schema.json",
        "contracts/result.schema.json",
        "contracts/bridge.schema.json",
        "contracts/examples/contacts-search.json",
        "contracts/examples/dial-result.json",
    ),
    "web": ("docs/web_v1.md", "scripts/package_updates.py"),
    "android": ("docs/android_v1.md", "scripts/package_updates.py"),
}
EXCLUDED_DIRS = {
    ".git", ".venv", "venv", "node_modules", "__pycache__", ".pytest_cache",
    ".mypy_cache", ".ruff_cache", ".gradle", ".kotlin", "build", "dist", "data", "runtime",
    "secrets", "privatekeys", "private_keys", "credentials", "recordings",
}
EXCLUDED_SUFFIXES = {
    ".pyc", ".pyo", ".zip", ".db", ".sqlite", ".sqlite3", ".db-wal",
    ".db-shm", ".key", ".pem", ".p12", ".pfx", ".jks", ".keystore",
    ".log", ".wav", ".mp3", ".m4a", ".webm", ".ogg",
}
MANIFEST_NAME = "PACKAGE_MANIFEST.json"


def excluded(relative: Path) -> bool:
    parts = relative.parts
    if any(part.lower() in EXCLUDED_DIRS for part in parts):
        return True
    name = relative.name.lower()
    if name.startswith(".env") and name != ".env.example":
        return True
    if name == MANIFEST_NAME.lower() or name.endswith(".manifest.json"):
        return True
    if any(name.endswith(suffix) for suffix in EXCLUDED_SUFFIXES):
        return True
    if name in {"credentials.json", "credential.json", "id_rsa", "id_ed25519", "local.properties"}:
        return True
    return False


def collect(root: Path, component: str) -> dict[str, Path]:
    candidates = list((root / component).rglob("*"))
    candidates += [root / entry for entry in ASSOCIATED_PATHS[component]]
    files: dict[str, Path] = {}
    for path in candidates:
        relative = path.relative_to(root)
        if excluded(relative) or path.is_symlink() or not path.is_file():
            continue
        # An associated path must not enter an external tree through a symlink.
        if any((root / Path(*relative.parts[:count])).is_symlink() for count in range(1, len(relative.parts) + 1)):
            continue
        if not path.resolve().is_relative_to(root):
            continue
        files[relative.as_posix()] = path
    return dict(sorted(files.items()))


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def read_baseline(path: Path | None, component: str) -> dict[str, str]:
    if path is None:
        return {}
    baseline = json.loads(path.read_text(encoding="utf-8"))
    if baseline.get("schema_version") != 1 or baseline.get("component") != component:
        raise ValueError("baseline must be a schema_version=1 manifest for the same component")
    previous = baseline.get("files")
    if not isinstance(previous, dict):
        raise ValueError("baseline files must be an object mapping paths to SHA-256 hashes")
    for name, checksum in previous.items():
        relative = PurePosixPath(name)
        if relative.is_absolute() or ".." in relative.parts or "\\" in name or ":" in name or relative.as_posix() != name:
            raise ValueError("baseline contains an unsafe path")
        associated = name in ASSOCIATED_PATHS[component]
        if (not name.startswith(f"{component}/") and not associated) or excluded(Path(name)):
            raise ValueError("baseline contains a path outside the component allowlist")
        if not isinstance(checksum, str) or len(checksum) != 64 or any(c not in "0123456789abcdef" for c in checksum):
            raise ValueError("baseline contains an invalid SHA-256 hash")
    return previous


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--component", choices=sorted(ASSOCIATED_PATHS), required=True)
    parser.add_argument("--version", type=int, required=True)
    parser.add_argument("--output", type=Path, required=True, help="path ending in COMPONENT_vN.zip")
    parser.add_argument("--baseline", type=Path, help="previous .manifest.json; omit for a complete component release")
    parser.add_argument("--project-root", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    if args.version < 1:
        parser.error("--version must be a positive integer")
    expected_name = f"{args.component}_v{args.version}.zip"
    if args.output.name != expected_name:
        parser.error(f"--output filename must be {expected_name}")

    root = args.project_root.resolve(strict=True)
    if not (root / args.component).is_dir():
        parser.error(f"missing component directory: {args.component}")
    try:
        previous = read_baseline(args.baseline, args.component)
        collected = collect(root, args.component)
        current = {name: digest(path) for name, path in collected.items()}
        included = [name for name, checksum in current.items() if previous.get(name) != checksum]
        deleted = sorted(set(previous) - set(current))
        manifest = {
            "schema_version": 1,
            "component": args.component,
            "version": args.version,
            "archive_root": "local-assistant/",
            "package_kind": "update" if args.baseline else "full",
            "created_at": datetime.now(timezone.utc).isoformat(),
            "files": current,
            "included_paths": included,
            "deleted_paths": deleted,
            "instructions": "Extract over local-assistant. Review deleted_paths manually; this package never deletes files automatically.",
        }
        manifest_bytes = (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=args.output.parent, suffix=".zip.tmp", delete=False) as temporary:
            temporary_path = Path(temporary.name)
        try:
            with zipfile.ZipFile(temporary_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                for name in included:
                    content = collected[name].read_bytes()
                    if hashlib.sha256(content).hexdigest() != current[name]:
                        raise ValueError(f"source changed during packaging: {name}; retry after edits finish")
                    info = zipfile.ZipInfo(f"local-assistant/{name}")
                    info.create_system = 3
                    info.compress_type = zipfile.ZIP_DEFLATED
                    info.external_attr = (0o100755 if Path(name).name == "gradlew" or name.endswith(".sh") else 0o100644) << 16
                    archive.writestr(info, content)
                info = zipfile.ZipInfo(f"local-assistant/{args.component}/{MANIFEST_NAME}")
                info.create_system = 3
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o100644 << 16
                archive.writestr(info, manifest_bytes)
            os.replace(temporary_path, args.output)
        finally:
            temporary_path.unlink(missing_ok=True)
        manifest_path = args.output.with_suffix(".manifest.json")
        manifest_path.write_bytes(manifest_bytes)
        print(json.dumps({"archive": str(args.output), "manifest": str(manifest_path), "included_files": len(included), "deleted_paths": deleted}, ensure_ascii=False))
    except (OSError, ValueError, json.JSONDecodeError) as error:
        parser.error(str(error))


if __name__ == "__main__":
    main()

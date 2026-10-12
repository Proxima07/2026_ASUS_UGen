from fastapi import APIRouter, Depends, Request

from app.api.dependencies import principal
from app.schemas import NoteActionCreate, NoteCreate, NoteUpdate

router = APIRouter(prefix="/v1/notes", tags=["notes"])


@router.get("")
def list_notes(request: Request, q: str = "", identity=Depends(principal)):
    notes = request.app.state.repo.list_notes(identity)
    if q:
        notes = [n for n in notes if q.casefold() in (n["title"] + "\n" + n["content"]).casefold()]
    return {"items": notes}


@router.post("")
def create_note(body: NoteCreate, request: Request, identity=Depends(principal)):
    return request.app.state.repo.create_note(identity, **body.model_dump())


@router.post("/native-actions")
def create_native_note_action(body: NoteCreate, request: Request, identity=Depends(principal)):
    """Send an approved STT draft/manual note straight to an external notes app.

    No platform note is created as an intermediate or automatic backup.
    Native confirmation and the external app's own save step still apply.
    """
    action = request.app.state.repo.create_action(identity, kind="notes.create_native",
        payload={"title": body.title, "content": body.content, "transcript": body.transcript},
        idempotency_key=body.idempotency_key,
        ttl_seconds=request.app.state.settings.action_ttl_seconds)
    return {"protocol_version": "1", **action}


@router.get("/{note_id}")
def get_note(note_id: str, request: Request, identity=Depends(principal)):
    return request.app.state.repo.get_note(identity, note_id)


@router.delete("/{note_id}")
def delete_note(note_id: str, request: Request, identity=Depends(principal)):
    request.app.state.repo.delete_note(identity, note_id)
    return {"status": "deleted"}


@router.put("/{note_id}")
def update_note(note_id: str, body: NoteUpdate, request: Request, identity=Depends(principal)):
    return request.app.state.repo.update_note(identity, note_id, **body.model_dump())


@router.post("/{note_id}/actions")
def create_note_action(note_id: str, body: NoteActionCreate, request: Request, identity=Depends(principal)):
    repo = request.app.state.repo
    note = repo.get_note(identity, note_id)
    # Older clients may request this export name. It now means an external notes
    # app handoff, never a write to the assistant APK's former private notebook.
    kind = "notes.create_native" if body.kind == "notes.save_local" else body.kind
    action = repo.create_action(identity, kind=kind,
        payload={"note_id": note["note_id"], "title": note["title"], "content": note["content"]},
        idempotency_key=body.idempotency_key, ttl_seconds=request.app.state.settings.action_ttl_seconds)
    return {"protocol_version": "1", **action}

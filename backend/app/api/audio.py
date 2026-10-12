from __future__ import annotations

import asyncio
import logging
import time
import uuid
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request

from app.adapters.llm_client import AdapterError
from app.agent.planner import PlanningError
from app.api.dependencies import principal
from app.observability import event, new_trace_id

router = APIRouter(prefix="/v1/audio", tags=["audio"])
AUDIO_TYPES = {"audio/webm", "audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp4", "audio/ogg", "audio/aac", "audio/flac"}
EXTENSIONS = {"audio/webm": "webm", "audio/wav": "wav", "audio/x-wav": "wav", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/ogg": "ogg", "audio/aac": "aac", "audio/flac": "flac"}


async def process_audio(state, identity, job_id: str, audio: bytes, content_type: str,
                        purpose: str = "note", trace_id: str | None = None):
    trace_id = trace_id or new_trace_id()
    fields = {"trace_id": trace_id, "job_id": job_id, "purpose": purpose}
    stage = "stt"
    started = time.monotonic()
    try:
        state.repo.update_job(identity, job_id, {"status": "transcribing", "trace_id": trace_id})
        event(state, "stt.started", **fields, bytes=len(audio), content_type=content_type)
        transcript = await state.stt.transcribe(audio, "recording." + EXTENSIONS[content_type], content_type)
        if not transcript.strip():
            raise AdapterError("empty_transcript", "未辨識到語音，請重新錄音")
        if len(transcript) > 24000:
            raise AdapterError("transcript_too_long", "逐字稿超過第一版支援上限，請分段錄音")
        event(state, "stt.completed", **fields, chars=len(transcript),
              duration_ms=round((time.monotonic()-started)*1000, 2))
        stage = "command" if purpose == "command" else "note.summary"
        if purpose == "command":
            if len(transcript) > min(state.settings.max_text_chars, 8000):
                state.repo.update_job(identity, job_id, {"status": "failed", "transcript": transcript,
                    "error": {"code": "command_too_long", "message": "語音指令超過字數上限，請分段說明"}})
                event(state, "command.failed", level=logging.WARNING, **fields,
                      chars=len(transcript), state="failed", code="command_too_long")
            else:
                state.repo.update_job(identity, job_id, {"status": "transcribed", "transcript": transcript,
                    "message": "語音指令已轉錄"})
                event(state, "command.transcribed", **fields, chars=len(transcript),
                      state="transcribed", command_text=transcript)
            return
        state.repo.update_job(identity, job_id, {"status": "summarizing", "transcript": transcript})
        try:
            async with state.model_semaphore:
                started = time.monotonic()
                event(state, "note.summary.started", **fields, chars=len(transcript))
                draft = await state.planner.summarize(transcript)
            state.repo.update_job(identity, job_id, {"status": "ready", "draft": draft.model_dump(), "message": "筆記草稿已完成，請確認後保存"})
            event(state, "note.summary.completed", **fields, state="ready",
                  duration_ms=round((time.monotonic()-started)*1000, 2))
        except (AdapterError, PlanningError) as exc:
            state.repo.update_job(identity, job_id, {"status": "transcribed", "error": {"code": exc.code, "message": str(exc)}})
            event(state, "note.summary.failed", level=logging.ERROR, **fields, state="transcribed",
                  code=exc.code, duration_ms=round((time.monotonic()-started)*1000, 2))
    except asyncio.CancelledError:
        try:
            state.repo.update_job(identity, job_id, {"status": "interrupted", "message": "服務停止，請重新上傳錄音"})
        except Exception:
            pass
        event(state, "audio.interrupted", level=logging.WARNING, **fields, state="interrupted", code="job_interrupted")
        raise
    except (AdapterError, PlanningError) as exc:
        state.repo.update_job(identity, job_id, {"status": "failed", "error": {"code": exc.code, "message": str(exc)}})
        event(state, stage + ".failed", level=logging.ERROR, **fields, state="failed",
              code=exc.code, duration_ms=round((time.monotonic()-started)*1000, 2))
    except Exception:
        event(state, stage + ".failed", level=logging.ERROR, **fields, state="failed",
              code="audio_processing_failed", duration_ms=round((time.monotonic()-started)*1000, 2))
        try:
            state.repo.update_job(identity, job_id, {"status": "failed", "error": {"code": "audio_processing_failed", "message": "錄音處理未完成，請檢查服務並重試"}})
        except Exception:
            pass


@router.post("", status_code=202)
async def upload_audio(request: Request, purpose: Literal["note", "command"] = "note", identity=Depends(principal)):
    state = request.app.state
    trace_id = request.state.http_request_id
    event(state, "audio.received", trace_id=trace_id, purpose=purpose)
    if not state.settings.stt_base_url:
        raise HTTPException(503, detail={"code": "stt_disabled", "message": "尚未配置本地轉錄服務"})
    content_type = request.headers.get("content-type", "").split(";", 1)[0].lower()
    if content_type not in AUDIO_TYPES:
        raise HTTPException(415, detail={"code": "unsupported_audio", "message": "請上傳原始 audio/* 音檔內容，不使用 multipart"})
    if len(state.audio_tasks) >= state.settings.max_audio_jobs:
        raise HTTPException(429, detail={"code": "audio_busy", "message": "轉錄工作已滿，請稍後重試"})
    audio = bytearray()
    async for chunk in request.stream():
        audio.extend(chunk)
        if len(audio) > state.settings.max_audio_bytes:
            raise HTTPException(413, detail={"code": "audio_too_large", "message": "錄音檔超過上限"})
    if not audio:
        raise HTTPException(400, detail={"code": "empty_audio", "message": "錄音檔不可空白"})
    # Recheck after await: reserve without awaiting to keep one-worker capacity exact.
    if len(state.audio_tasks) >= state.settings.max_audio_jobs:
        raise HTTPException(429, detail={"code": "audio_busy", "message": "轉錄工作已滿，請稍後重試"})
    job_id = "job_" + uuid.uuid4().hex
    state.repo.put_job(identity, job_id, {"status": "queued", "purpose": purpose, "trace_id": trace_id})
    event(state, "audio.accepted", trace_id=trace_id, job_id=job_id, purpose=purpose,
          bytes=len(audio), content_type=content_type, state="queued")
    task = asyncio.create_task(process_audio(state, identity, job_id, bytes(audio), content_type, purpose, trace_id))
    state.audio_tasks.add(task)
    task.add_done_callback(state.audio_tasks.discard)
    return {"job_id": job_id, "status": "queued", "purpose": purpose, "trace_id": trace_id}


@router.get("/{job_id}")
def get_audio_job(job_id: str, request: Request, identity=Depends(principal)):
    return request.app.state.repo.get_job(identity, job_id)

"""Status line telemetry ingestion (fed by ``claude-office-hook statusline``)."""

import logging
import re
from typing import Annotated, Any

from fastapi import APIRouter, Depends

from app.core.event_processor import EventProcessor, get_event_processor
from app.core.telemetry import get_telemetry_store

logger = logging.getLogger(__name__)

router = APIRouter()

_SID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


@router.post("/telemetry/statusline")
async def receive_statusline(
    payload: dict[str, Any],
    ep: Annotated[EventProcessor, Depends(get_event_processor)],
) -> dict[str, str]:
    """Store one Claude Code status line report; rate-limited campus rebroadcast."""
    sid = payload.get("session_id")
    if isinstance(sid, str) and not _SID_RE.match(sid):
        payload = {**payload, "session_id": None}
    get_telemetry_store().ingest_statusline(payload)
    ep.schedule_telemetry_broadcast()
    return {"status": "accepted"}

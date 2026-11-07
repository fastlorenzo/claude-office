"""Pinned repos: GitHub repos always shown as factory lines, even without a session."""

import json
import logging
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.core.ci_poller import MAX_PINNED, get_ci_poller, normalize_repo
from app.db.database import get_db, get_session_factory
from app.db.models import UserPreference

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/ci", tags=["ci"])

PINNED_PREF_KEY = "ci_pinned_repos"


class PinnedRepos(BaseModel):
    repos: list[str]


def _env_pinned() -> list[str]:
    raw = get_settings().CI_PINNED_REPOS
    return [r for r in (normalize_repo(p) for p in raw.split(",")) if r]


def _parse(value: str | None) -> list[str] | None:
    if value is None:
        return None
    try:
        data = json.loads(value)
    except ValueError:
        return None
    if not isinstance(data, list):
        return None
    return [r for r in (normalize_repo(x) for x in data) if r]  # pyright: ignore[reportUnknownVariableType, reportUnknownArgumentType]


async def load_pinned_repos() -> list[str]:
    """Persisted preference when present, else the ``CI_PINNED_REPOS`` env default."""
    try:
        async with get_session_factory()() as db:
            pref = (
                await db.execute(
                    select(UserPreference).where(UserPreference.key == PINNED_PREF_KEY)
                )
            ).scalar_one_or_none()
        stored = _parse(pref.value if pref else None)
        if stored is not None:
            return stored
    except Exception:
        logger.debug("could not read pinned repos preference", exc_info=True)
    return _env_pinned()


@router.get("/pinned-repos")
async def get_pinned_repos() -> PinnedRepos:
    return PinnedRepos(repos=list(get_ci_poller().pinned))


@router.put("/pinned-repos")
async def set_pinned_repos(
    body: PinnedRepos, db: Annotated[AsyncSession, Depends(get_db)]
) -> PinnedRepos:
    bad = [r for r in body.repos if normalize_repo(r) is None]
    if bad:
        raise HTTPException(status_code=400, detail=f"Invalid repo (want owner/name): {bad[0]!r}")
    if len(body.repos) > MAX_PINNED:
        raise HTTPException(status_code=400, detail=f"At most {MAX_PINNED} pinned repos")
    poller = get_ci_poller()
    repos = list(poller.set_pinned(body.repos))
    value = json.dumps(repos)
    try:
        pref = (
            await db.execute(select(UserPreference).where(UserPreference.key == PINNED_PREF_KEY))
        ).scalar_one_or_none()
        if pref:
            pref.value = value
        else:
            db.add(UserPreference(key=PINNED_PREF_KEY, value=value))
        await db.commit()
    except Exception as exc:
        await db.rollback()
        logger.exception("Error persisting pinned repos")
        raise HTTPException(status_code=500, detail="Failed to save pinned repos") from exc
    from app.core.event_processor import get_event_processor

    get_event_processor().request_campus_broadcast()
    return PinnedRepos(repos=repos)

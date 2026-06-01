"""
Orchestrator for the live Brownsville feed agents.

Runs every agent (news / gov / social / weather) on one shared HTTP client and
dedup map, swaps the result into module state atomically, and exposes the same
public API the rest of the backend already consumes:

    refresh(incident_types, locations) -> int
    get_incidents() -> list[dict]
    status() -> dict
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone

import httpx

from agents.base import HAS_FEEDPARSER, FeedContext
from agents.news_agent import NewsAgent
from agents.gov_agent import GovAgent
from agents.social_agent import SocialAgent
from agents.weather_agent import WeatherAgent

logger = logging.getLogger("bv_dashboard.feeds")

# The four feed categories, mirroring tx-safety/agents/.
AGENTS = [NewsAgent(), GovAgent(), SocialAgent(), WeatherAgent()]

# ─── STATE ───────────────────────────────────────────────────────────────────
_seen: set[str] = set()
_SEEN_MAX = 4000
_incidents: dict[str, dict] = {}
_status: dict = {
    "last_run": None,
    "last_ok": None,
    "count": 0,
    "per_feed": {},
    "agents": [a.name for a in AGENTS],
    "enabled": HAS_FEEDPARSER,
}


async def refresh(incident_types: list[dict], locations: list[dict]) -> int:
    """Poll every agent and rebuild the live-incident set. Returns total count.

    Safe to call concurrently with readers; the global dict is swapped at the
    end. A fully failed poll leaves the previous incidents untouched.
    """
    if not HAS_FEEDPARSER:
        logger.warning("[feeds] feedparser not installed — live feed disabled")
        return len(_incidents)

    if len(_seen) >= _SEEN_MAX:
        _seen.clear()

    ctx = FeedContext(
        itype_map={t["type"]: t for t in incident_types},
        new_map=dict(_incidents),
        seen=_seen,
    )

    per_feed: dict[str, int] = {}
    async with httpx.AsyncClient(timeout=httpx.Timeout(20.0), follow_redirects=True) as client:
        for agent in AGENTS:
            try:
                per_feed.update(await agent.collect(client, ctx))
            except Exception:
                logger.exception("[feeds] agent failed: %s", agent.name)

    any_ok = any(v >= 0 for v in per_feed.values())

    _incidents.clear()
    _incidents.update(ctx.new_map)

    now = datetime.now(timezone.utc).isoformat()
    _status.update({
        "last_run": now,
        "last_ok": now if any_ok else _status["last_ok"],
        "count": len(_incidents),
        "per_feed": per_feed,
        "enabled": True,
    })
    logger.info("[feeds] %d live Brownsville incidents (%s)",
                len(_incidents), ", ".join(f"{k}:{v}" for k, v in per_feed.items()))
    return len(_incidents)


def get_incidents() -> list[dict]:
    return list(_incidents.values())


def status() -> dict:
    return dict(_status)

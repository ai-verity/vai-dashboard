"""
Weather agent (ported from tx-safety/agents/weather_agent.py).

tx-safety polled per-WFO CAP feeds on alerts.weather.gov, which is now dead
(DNS fails). The modern api.weather.gov returns every active Texas alert from a
single endpoint, so we use that and geocode each alert by its areaDesc. Alert
events map onto the dashboard's ENVIRON incident types.
"""
from __future__ import annotations

import logging

import httpx

from agents.base import (
    BaseAgent, FeedContext, NWS_HEADERS, NWS_SEV, WEATHER_TYPE_KEYWORDS,
    classify_type, clean, detect_city, get, hash_id, make_incident, parse_dt,
)

logger = logging.getLogger("bv_dashboard.feeds")

NWS_ALERTS_URL = "https://api.weather.gov/alerts/active?area=TX"


class WeatherAgent(BaseAgent):
    name = "weather_agent"

    async def collect(self, client: httpx.AsyncClient, ctx: FeedContext) -> dict[str, int]:
        resp = await get(client, "NWS Texas Alerts", NWS_ALERTS_URL, NWS_HEADERS)
        if resp is None:
            return {"NWS Texas Alerts": -1}
        try:
            return {"NWS Texas Alerts": self._collect(resp.json(), ctx)}
        except Exception:
            logger.debug("[weather_agent] NWS parse failed")
            return {"NWS Texas Alerts": -1}

    @staticmethod
    def _collect(payload: dict, ctx: FeedContext) -> int:
        kept = 0
        for feat in payload.get("features", [])[:120]:
            p = feat.get("properties", {})
            event = p.get("event", "") or ""
            headline = clean(p.get("headline") or event)
            desc = clean(p.get("description") or "")
            area = clean(p.get("areaDesc") or "")
            it = classify_type(event, ctx.itype_map, table=WEATHER_TYPE_KEYWORDS)
            if not it:
                continue
            eid = hash_id(p.get("id") or headline)
            uid = f"L-{eid[:10]}"
            if uid in ctx.new_map:
                continue
            ctx.seen.add(eid)
            dt = parse_dt(p.get("onset") or p.get("effective") or p.get("sent") or "")
            sev = NWS_SEV.get(p.get("severity", "Unknown"), 0.5)
            loc_id, loc_name, lat, lon = detect_city(area)
            ctx.new_map[uid] = make_incident(
                uid, dt, it, loc_id, loc_name, lat, lon, "NWS Texas Alerts",
                desc or headline, p.get("web") or p.get("@id"), sev)
            kept += 1
        return kept

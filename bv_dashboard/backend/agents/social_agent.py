"""
Social / open-web agent (ported from tx-safety/agents/social_agent.py).

Three source kinds:
  - Reddit city subs via the RSS endpoint (the JSON API 403s datacenter IPs).
  - Broadcastify public incident-call RSS.
  - Socrata open-data incident endpoints (Austin PD, Dallas PD) as JSON.
Reddit rate-limits rapid hits, so an occasional -1 (skipped) is expected.
"""
from __future__ import annotations

import asyncio
import logging
import os

import httpx

from agents.base import (
    BaseAgent, FeedContext, HEADERS, JSON_HEADERS, collect_opendata, collect_rss, get,
)

logger = logging.getLogger("bv_dashboard.feeds")


class SocialAgent(BaseAgent):
    name = "social_agent"

    # (display_name, url, default_city) — Reddit RSS + Broadcastify.
    FEEDS = [
        ("Reddit r/texas", "https://www.reddit.com/r/texas/.rss", ""),
        ("Reddit r/houston", "https://www.reddit.com/r/houston/.rss", "houston"),
        ("Reddit r/Dallas", "https://www.reddit.com/r/Dallas/.rss", "dallas"),
        ("Reddit r/sanantonio", "https://www.reddit.com/r/sanantonio/.rss", "san antonio"),
        ("Reddit r/Austin", "https://www.reddit.com/r/Austin/.rss", "austin"),
        ("Reddit r/brownsville", "https://www.reddit.com/r/brownsville/.rss", "brownsville"),
        ("Reddit r/rgv", "https://www.reddit.com/r/rgv/.rss", "harlingen"),
        ("Broadcastify TX", "https://www.broadcastify.com/calls/rss?l=18", ""),
    ]

    # (display_name, url, default_city) — Socrata JSON open data.
    OPEN_DATA = [
        ("Austin PD Incidents",
         "https://data.austintexas.gov/resource/fdj4-gpfu.json?$limit=20&$order=occurred_date_time%20DESC",
         "austin"),
        ("Dallas PD Incidents",
         "https://www.dallasopendata.com/resource/qv6i-rri7.json?$limit=20&$order=date1%20DESC",
         "dallas"),
    ]

    async def collect(self, client: httpx.AsyncClient, ctx: FeedContext) -> dict[str, int]:
        socrata = dict(JSON_HEADERS)
        token = os.getenv("SOCRATA_APP_TOKEN", "")
        if token:
            socrata["X-App-Token"] = token

        rss_resps, od_resps = await asyncio.gather(
            asyncio.gather(*[get(client, n, u, HEADERS) for n, u, _ in self.FEEDS]),
            asyncio.gather(*[get(client, n, u, socrata) for n, u, _ in self.OPEN_DATA]),
        )

        per_feed: dict[str, int] = {}
        for (name, _u, default_city), resp in zip(self.FEEDS, rss_resps):
            if resp is None:
                per_feed[name] = -1
                continue
            try:
                per_feed[name] = collect_rss(name, default_city, resp.text, ctx)
            except Exception:
                logger.exception("[social_agent] parse failed: %s", name)
                per_feed[name] = -1

        for (name, _u, default_city), resp in zip(self.OPEN_DATA, od_resps):
            if resp is None:
                per_feed[name] = -1
                continue
            try:
                per_feed[name] = collect_opendata(name, default_city, resp.json(), ctx)
            except Exception:
                logger.debug("[social_agent] opendata parse failed: %s", name)
                per_feed[name] = -1
        return per_feed

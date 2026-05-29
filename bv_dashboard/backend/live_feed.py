"""
Live public-safety feed for Brownsville, TX.

Polls a small set of *live* RSS sources and turns Brownsville-relevant,
safety-related items into incident records that drop straight into the
dashboard's existing incident feed (same dict shape as build_incidents()).

Design notes
------------
- Brownsville-only: aggregator feeds (Google News, ValleyCentral) must mention
  "brownsville"; the City of Brownsville official feed is inherently local so it
  is accepted wholesale.
- Keyword classification (no LLM): each item is mapped onto the dashboard's
  existing incident taxonomy and Brownsville locations. Items that don't match a
  known incident type are skipped so the taxonomy stays clean.
- Resilient: each feed is fetched independently; a 404/timeout/parse error on
  one source never blocks the others. A bad poll leaves the previous results in
  place.
- State is in-memory only (no DB), matching the rest of this backend.
"""
from __future__ import annotations

import asyncio
import hashlib
import html
import logging
import re
from datetime import datetime, timezone

import httpx

try:
    import feedparser
    _HAS_FEEDPARSER = True
except ImportError:  # pragma: no cover - dependency missing
    _HAS_FEEDPARSER = False

logger = logging.getLogger("bv_dashboard.live_feed")

# ─── SOURCES ─────────────────────────────────────────────────────────────────
# (display_name, url, implicit, require_tx).
#   implicit=True   → source is inherently Brownsville, TX (accept all items).
#   implicit=False  → item text must mention "brownsville".
#   require_tx=True → ALSO require a Texas/RGV signal, to exclude the other
#                     Brownsvilles (TN, PA, …) that a national aggregator returns.
FEEDS: list[tuple[str, str, bool, bool]] = [
    ("Google News — Brownsville",
     "https://news.google.com/rss/search?q=%22Brownsville%22%20Texas%20"
     "(police%20OR%20crash%20OR%20shooting%20OR%20fire%20OR%20arrest%20OR%20"
     "flood%20OR%20stabbing%20OR%20robbery)%20when:21d&hl=en-US&gl=US&ceid=US:en",
     False, True),
    ("ValleyCentral RGV", "https://www.valleycentral.com/news/local-news/feed/", False, False),
    ("ValleyCentral Crime", "https://www.valleycentral.com/news/crime/feed/", False, False),
    ("City of Brownsville", "https://www.brownsvilletx.gov/RSSFeed.aspx?ModID=1&CID=All-0", True, False),
]

# Texas / Rio Grande Valley signals used to disambiguate Brownsville, TX from
# the other U.S. cities named Brownsville.
TX_SIGNALS = ("texas", " tx", ",tx", "rio grande", "cameron county", "rgv",
              "south texas", "the valley", "rio grande valley", "spacex", "starbase")

HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; BVDashBot/1.0; +public-safety-dashboard)"}

SAFETY_KEYWORDS = [
    "shooting", "shot", "gunfire", "gunshot", "homicide", "murder", "stabbing",
    "stabbed", "assault", "robbery", "burglary", "theft", "arson", "fire",
    "explosion", "crash", "accident", "collision", "pursuit", "chase",
    "missing", "kidnap", "amber alert", "silver alert", "hazmat", "chemical",
    "spill", "flood", "tornado", "severe weather", "storm", "outage",
    "powerline", "power line", "officer", "police", "swat", "sheriff", "fbi",
    "dps", "suspect", "arrested", "warrant", "fugitive", "overdose", "drug",
    "narcotic", "fentanyl", "disturbance", "evacuation", "emergency",
    "vandalism", "domestic", "weapon", "firearm", "gun", "carjack",
]

# Ordered most-specific → least. First match wins. Each maps to a `type` that
# must exist in the dashboard's INCIDENT_TYPES taxonomy (passed into refresh()).
TYPE_KEYWORDS: list[tuple[list[str], str]] = [
    (["officer-involved", "officer involved", "ois"], "Officer-Involved Shooting"),
    (["stabbing", "stabbed", "knife"], "Stabbing"),
    (["shooting", "shot ", "gunfire", "gunshot", "shots fired"], "Weapons / Firearms"),
    (["firearm", "weapon", "gun ", "guns", "handgun", "rifle"], "Weapons / Firearms"),
    (["armed robbery", "robbery", "carjack", "mugging"], "Armed Robbery / Assault"),
    (["aggravated assault"], "Aggravated Assault"),
    (["homicide", "murder", "killed", "assault", "attack"], "Aggravated Assault"),
    (["domestic"], "Domestic Disturbance"),
    (["brawl", "fight", "fighting"], "Fighting / Brawl"),
    (["overdose", "fentanyl", "narcotic", "drug", "meth", "cocaine"], "Drug Activity"),
    (["carjacking", "stolen vehicle", "vehicle theft", "auto theft"], "Vehicle Theft"),
    (["vandalism", "graffiti"], "Vandalism"),
    (["wildfire", "brush fire", "house fire", "structure fire", "arson", "fire", "smoke"], "Smoke / Fire"),
    (["flood", "flash flood", "high water", "heavy rain"], "Flash Flooding"),
    (["powerline", "power line", "downed line", "power outage", "outage"], "Downed Powerlines"),
    (["mental health", "suicidal", "psychiatric"], "Mental Health Crisis"),
    (["homeless", "unsheltered", "encampment"], "Unsheltered / Homeless"),
    (["suspicious package", "suspicious item", "unattended bag", "bomb"], "Unattended Suspicious Item"),
    (["protest", "rally", "crowd", "mob"], "Crowd Surge / Mob"),
    (["disturbance", "aggressive"], "Aggressive Behavior"),
]

# Brownsville location keywords → location id (must exist in LOCATIONS).
LOCATION_KEYWORDS: list[tuple[list[str], str]] = [
    (["downtown", "elizabeth st", "market square"], "downtown"),
    (["ozanam"], "ozanam"),
    (["airport", "south padre island international", "bro airport"], "airport"),
    (["dean porter"], "dean_porter"),
    (["linear park"], "linear_park"),
    (["washington park"], "washington"),
    (["pablo kisel"], "pablo_kisel"),
    (["gateway", "international bridge", "b&m bridge"], "gateway"),
    (["sunrise mall"], "sunrise"),
    (["valley regional", "valley baptist", "hospital"], "valley_reg"),
    (["southmost", "texas southmost", "tsc", "utrgv"], "tsc"),
    (["midtown"], "midtown"),
    (["resaca"], "resaca"),
    (["rawhide"], "rawhide"),
    (["boca chica", "spacex", "starbase"], "boca_chica"),
    (["expressway 83", "us-77", "us 77", "i-69", "fm 511", "highway"], "exp83"),
]

# Words that nudge severity up/down from the matched type's base level.
_SEV_UP = ("fatal", "dead", "killed", "death", "critical", "shooting", "homicide", "murder")
_SEV_DOWN = ("minor", "no injuries", "non-life", "small", "contained")

# Negative signals — drop retrospectives, features, and other non-incident
# stories that nonetheless trip a safety keyword (e.g. a zoo's "10 years since
# Harambe was shot" anniversary piece).
EXCLUDE_KEYWORDS = [
    "harambe", "gorilla", "zoo", "years since", "years ago", "anniversary",
    "throwback", "look back", "remembering", "decade since", "decades since",
    "in memory of", "obituary", "retrospective", "history of",
]

_TAG_RE = re.compile(r"<[^>]+>")

# ─── STATE ───────────────────────────────────────────────────────────────────
_seen: set[str] = set()
_SEEN_MAX = 4000
_incidents: dict[str, dict] = {}
_status: dict = {
    "last_run": None,
    "last_ok": None,
    "count": 0,
    "per_feed": {},
    "enabled": _HAS_FEEDPARSER,
}


def _clean(text: str) -> str:
    text = html.unescape(text or "")
    text = _TAG_RE.sub(" ", text)
    return re.sub(r"\s+", " ", text).strip()


def _is_safety(text: str) -> bool:
    t = text.lower()
    return any(kw in t for kw in SAFETY_KEYWORDS)


def _classify_type(text: str, itype_map: dict) -> dict | None:
    t = text.lower()
    for kws, type_name in TYPE_KEYWORDS:
        if type_name not in itype_map:
            continue
        if any(kw in t for kw in kws):
            return itype_map[type_name]
    return None


def _classify_location(text: str, loc_map: dict) -> str:
    t = text.lower()
    for kws, loc_id in LOCATION_KEYWORDS:
        if loc_id in loc_map and any(kw in t for kw in kws):
            return loc_id
    # City-center fallback when no specific location is named.
    return "downtown" if "downtown" in loc_map else next(iter(loc_map))


def _severity(base: float, text: str) -> float:
    t = text.lower()
    sev = base
    if any(w in t for w in _SEV_UP):
        sev += 0.08
    if any(w in t for w in _SEV_DOWN):
        sev -= 0.12
    return round(min(1.0, max(0.1, sev)), 3)


def _entry_id(entry) -> str:
    raw = (getattr(entry, "id", "") or getattr(entry, "link", "") or
           getattr(entry, "title", ""))
    return hashlib.md5(raw.encode("utf-8", "ignore")).hexdigest()


def _published(entry) -> datetime:
    for attr in ("published_parsed", "updated_parsed"):
        tm = getattr(entry, attr, None)
        if tm:
            try:
                return datetime(*tm[:6], tzinfo=timezone.utc)
            except Exception:
                pass
    return datetime.now(timezone.utc)


def _source_name(feed_name: str, title: str) -> str:
    # Google News titles look like "Headline - Publisher". Prefer the publisher.
    if feed_name.startswith("Google News") and " - " in title:
        return title.rsplit(" - ", 1)[-1].strip()[:60] or feed_name
    return feed_name


async def _fetch(client: httpx.AsyncClient, name: str, url: str):
    try:
        r = await client.get(url)
        if r.status_code >= 400:
            logger.debug("[live_feed] HTTP %s for %s", r.status_code, name)
            return name, None
        return name, r.text
    except Exception as e:  # noqa: BLE001 - per-feed isolation
        logger.debug("[live_feed] fetch error %s: %s", name, e)
        return name, None


async def refresh(incident_types: list[dict], locations: list[dict]) -> int:
    """Poll all feeds and rebuild the live-incident set. Returns total count.

    Safe to call concurrently with readers; the global dict is swapped at the
    end. A fully failed poll leaves the previous incidents untouched.
    """
    if not _HAS_FEEDPARSER:
        logger.warning("[live_feed] feedparser not installed — live feed disabled")
        return len(_incidents)

    itype_map = {t["type"]: t for t in incident_types}
    loc_map = {l["id"]: l for l in locations}

    async with httpx.AsyncClient(timeout=httpx.Timeout(15.0),
                                 follow_redirects=True, headers=HEADERS) as client:
        results = await asyncio.gather(
            *[_fetch(client, n, u) for n, u, _, _ in FEEDS]
        )

    feed_cfg = {n: (imp, req_tx) for n, u, imp, req_tx in FEEDS}
    new_map: dict[str, dict] = dict(_incidents)
    per_feed: dict[str, int] = {}
    any_ok = False

    for name, text in results:
        if text is None:
            per_feed[name] = -1  # fetch failed
            continue
        any_ok = True
        kept = 0
        implicit, require_tx = feed_cfg[name]
        parsed = feedparser.parse(text)
        for entry in (parsed.entries or [])[:40]:
            title = _clean(getattr(entry, "title", ""))
            summary = _clean(getattr(entry, "summary", ""))
            combined = f"{title}. {summary}"
            low = combined.lower()
            title_low = title.lower()

            # Brownsville, TX relevance gate. Require "brownsville" in the
            # headline (not just the body) so RGV-wide feeds don't leak articles
            # that merely mention Brownsville in a sidebar; require a Texas
            # signal for national aggregators to exclude the other Brownsvilles.
            if not implicit:
                if "brownsville" not in title_low:
                    continue
                if require_tx and not any(sig in low for sig in TX_SIGNALS):
                    continue
            if not _is_safety(combined):
                continue
            if any(kw in low for kw in EXCLUDE_KEYWORDS):
                continue

            it = _classify_type(combined, itype_map)
            if not it:
                continue

            eid = _entry_id(entry)
            uid = f"L-{eid[:10]}"
            if uid in new_map:
                continue
            if len(_seen) >= _SEEN_MAX:
                _seen.clear()
            _seen.add(eid)

            loc_id = _classify_location(combined, loc_map)
            loc = loc_map[loc_id]
            pub = _published(entry)

            new_map[uid] = {
                "id": uid,
                "date": pub.strftime("%Y-%m-%d"),
                "time": pub.strftime("%H:%M"),
                "type": it["type"],
                "cat": it["cat"],
                "icon": it["icon"],
                "color": it["color"],
                "sev": _severity(it["sev"], combined),
                "location_id": loc_id,
                "location_name": loc["name"],
                "lat": loc["lat"],
                "lon": loc["lon"],
                "source": _source_name(name, title),
                "desc": (summary or title)[:400],
                "verified": True,
                "live": True,
                "url": getattr(entry, "link", None),
            }
            kept += 1
        per_feed[name] = kept

    _incidents.clear()
    _incidents.update(new_map)

    now = datetime.now(timezone.utc).isoformat()
    _status.update({
        "last_run": now,
        "last_ok": now if any_ok else _status["last_ok"],
        "count": len(_incidents),
        "per_feed": per_feed,
        "enabled": True,
    })
    logger.info("[live_feed] %d live Brownsville incidents (%s)",
                len(_incidents), ", ".join(f"{k}:{v}" for k, v in per_feed.items()))
    return len(_incidents)


def get_incidents() -> list[dict]:
    return list(_incidents.values())


def status() -> dict:
    return dict(_status)

"""
Shared building blocks for the live Texas public-safety feed agents.

Mirrors tx-safety/agents/: one agent per category (news / gov / social /
weather), each owning its own source list, all sharing the keyword
classification, Texas-city geocoding, and incident builder defined here. Agents
append into a single dedup map supplied by the orchestrator.

Statewide (not Brownsville-only): items are kept when they are safety-related and
classify onto the dashboard taxonomy; each is geocoded to its Texas city.
"""
from __future__ import annotations

import asyncio
import hashlib
import html
import logging
import re
from dataclasses import dataclass
from datetime import datetime, timezone

import httpx

try:
    import feedparser
    HAS_FEEDPARSER = True
except ImportError:  # pragma: no cover - dependency missing
    HAS_FEEDPARSER = False

logger = logging.getLogger("bv_dashboard.feeds")

# ─── HTTP ────────────────────────────────────────────────────────────────────
# A real browser UA is required by Reddit's RSS endpoint and is harmless for the
# news/gov feeds, so all RSS sources share it.
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}
JSON_HEADERS = {**HEADERS, "Accept": "application/json"}
# NWS requires its own contact-style UA and a geo+json Accept header.
NWS_HEADERS = {"User-Agent": "(bv-dashboard, public-safety) BVDashBot/1.0",
               "Accept": "application/geo+json"}

# ─── GEOCODING (ported from tx-safety/core/geocoder.py) ──────────────────────
TX_CITY_COORDS: dict[str, tuple[float, float]] = {
    "houston": (29.7604, -95.3698), "dallas": (32.7767, -96.7970),
    "san antonio": (29.4241, -98.4936), "austin": (30.2672, -97.7431),
    "fort worth": (32.7555, -97.3308), "el paso": (31.7619, -106.4850),
    "arlington": (32.7357, -97.1081), "corpus christi": (27.8006, -97.3964),
    "plano": (33.0198, -96.6989), "laredo": (27.5064, -99.5075),
    "lubbock": (33.5779, -101.8552), "garland": (32.9126, -96.6389),
    "irving": (32.8140, -96.9489), "grand prairie": (32.7460, -96.9978),
    "brownsville": (25.9017, -97.4975), "mckinney": (33.1972, -96.6397),
    "frisco": (33.1507, -96.8236), "pasadena": (29.6911, -95.2091),
    "mcallen": (26.2034, -98.2300), "killeen": (31.1171, -97.7278),
    "mesquite": (32.7668, -96.5992), "midland": (31.9973, -102.0779),
    "waco": (31.5493, -97.1467), "abilene": (32.4487, -99.7331),
    "beaumont": (30.0802, -94.1266), "odessa": (31.8457, -102.3676),
    "tyler": (32.3513, -95.3011), "carrollton": (32.9537, -96.8903),
    "round rock": (30.5083, -97.6789), "denton": (33.2148, -97.1331),
    "lewisville": (33.0462, -96.9942), "sugar land": (29.6197, -95.6349),
    "cedar park": (30.5052, -97.8203), "longview": (32.5007, -94.7405),
    "edinburg": (26.3017, -98.1633), "wichita falls": (33.9137, -98.4934),
    "san angelo": (31.4638, -100.4370), "temple": (31.0982, -97.3428),
    "mission": (26.2159, -98.3253), "pearland": (29.5635, -95.2860),
    "college station": (30.6280, -96.3344), "conroe": (30.3119, -95.4561),
    "new braunfels": (29.7030, -98.1245), "harlingen": (26.1906, -97.6961),
    "league city": (29.5075, -95.0949), "allen": (33.1032, -96.6705),
    "richardson": (32.9483, -96.7299), "san marcos": (29.8833, -97.9414),
    "pharr": (26.1948, -98.1836), "baytown": (29.7355, -94.9774),
    "galveston": (29.3013, -94.7977), "victoria": (28.8053, -97.0036),
    "lufkin": (31.3382, -94.7291), "nacogdoches": (31.6035, -94.6557),
    "texarkana": (33.4251, -94.0477), "mansfield": (32.5632, -97.1417),
}
# Statewide fallback when no city is detected.
TX_CENTROID = (31.0, -99.0)

_CITY_RE = re.compile(
    r"\b(" + "|".join(re.escape(c) for c in sorted(TX_CITY_COORDS, key=len, reverse=True)) + r")\b")


def detect_city(text: str, default_city: str = "") -> tuple[str, str, float, float]:
    """Resolve (location_id, location_name, lat, lon) for an item.

    Prefers a TX city named in the text, falls back to the feed's region
    default, then to a statewide marker.
    """
    m = _CITY_RE.search(text.lower())
    city = m.group(1) if m else (default_city if default_city in TX_CITY_COORDS else "")
    if not city:
        return ("texas", "Texas (statewide)", *TX_CENTROID)
    lat, lon = TX_CITY_COORDS[city]
    return (city.replace(" ", "_"), f"{city.title()}, TX", lat, lon)


# ─── CLASSIFICATION TABLES ───────────────────────────────────────────────────
SAFETY_KEYWORDS = [
    "shooting", "shot", "gunfire", "gunshot", "homicide", "murder", "stabbing",
    "stabbed", "assault", "robbery", "burglary", "theft", "arson", "fire",
    "explosion", "crash", "accident", "collision", "rollover", "pursuit", "chase",
    "missing", "kidnap", "amber alert", "silver alert", "hazmat", "chemical",
    "spill", "flood", "tornado", "severe weather", "storm", "outage",
    "powerline", "power line", "officer", "police", "swat", "sheriff", "fbi",
    "dps", "suspect", "arrested", "warrant", "fugitive", "overdose", "drug",
    "narcotic", "fentanyl", "disturbance", "evacuation", "emergency",
    "vandalism", "domestic", "weapon", "firearm", "gun", "carjack", "sentenced",
    "indicted", "charged",
]

# Negative signals — drop retrospectives/features that trip a safety keyword.
EXCLUDE_KEYWORDS = [
    "harambe", "gorilla", "zoo", "years since", "years ago", "anniversary",
    "throwback", "look back", "remembering", "decade since", "decades since",
    "in memory of", "obituary", "retrospective", "history of",
]

# Ordered most-specific → least. First match wins. Each `type` must exist in the
# dashboard's INCIDENT_TYPES taxonomy (passed into refresh()).
TYPE_KEYWORDS: list[tuple[list[str], str]] = [
    (["officer-involved", "officer involved", "ois"], "Officer-Involved Shooting"),
    (["stabbing", "stabbed", "knife"], "Stabbing"),
    (["shooting", "shot ", "gunfire", "gunshot", "shots fired"], "Weapons / Firearms"),
    (["firearm", "weapon", "gun ", "guns", "handgun", "rifle"], "Weapons / Firearms"),
    (["armed robbery", "robbery", "carjack", "mugging"], "Armed Robbery / Assault"),
    (["aggravated assault"], "Aggravated Assault"),
    (["crash", "collision", "wreck", "rollover", "car accident", "vehicle accident",
      "pileup", "pile-up", "hit-and-run", "hit and run", "fatal accident"], "Vehicle Accident"),
    (["homicide", "murder", "killed", "assault", "attack"], "Aggravated Assault"),
    (["domestic"], "Domestic Disturbance"),
    (["brawl", "fight", "fighting"], "Fighting / Brawl"),
    (["overdose", "fentanyl", "narcotic", "drug", "meth", "cocaine", "trafficking"], "Drug Activity"),
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

# NWS alert event → incident type (kept within the ENVIRON category).
WEATHER_TYPE_KEYWORDS: list[tuple[list[str], str]] = [
    (["flood", "coastal flood", "hydrologic", "rain"], "Flash Flooding"),
    (["red flag", "fire weather", "fire warning"], "Smoke / Fire"),
    (["wind", "thunderstorm", "tornado", "hurricane", "tropical", "storm surge", "severe"], "Downed Powerlines"),
]

_SEV_UP = ("fatal", "dead", "killed", "death", "critical", "shooting", "homicide", "murder")
_SEV_DOWN = ("minor", "no injuries", "non-life", "small", "contained")
NWS_SEV = {"Extreme": 0.92, "Severe": 0.78, "Moderate": 0.6, "Minor": 0.45, "Unknown": 0.5}

_TAG_RE = re.compile(r"<[^>]+>")


# ─── SHARED STATE FOR ONE REFRESH ────────────────────────────────────────────
@dataclass
class FeedContext:
    """Passed to every agent during a single refresh cycle.

    itype_map : dashboard taxonomy (type name → record).
    new_map   : shared dedup map (uid → incident dict) all agents append into,
                so cross-source duplicates collapse.
    seen      : rolling set of source ids seen across refreshes.
    """
    itype_map: dict
    new_map: dict
    seen: set


# ─── HELPERS ─────────────────────────────────────────────────────────────────
def clean(text: str) -> str:
    text = html.unescape(text or "")
    text = _TAG_RE.sub(" ", text)
    return re.sub(r"\s+", " ", text).strip()


def is_safety(text: str) -> bool:
    t = text.lower()
    return any(kw in t for kw in SAFETY_KEYWORDS)


def is_excluded(text: str) -> bool:
    t = text.lower()
    return any(kw in t for kw in EXCLUDE_KEYWORDS)


def classify_type(text: str, itype_map: dict, table=TYPE_KEYWORDS) -> dict | None:
    t = text.lower()
    for kws, type_name in table:
        if type_name in itype_map and any(kw in t for kw in kws):
            return itype_map[type_name]
    return None


def severity(base: float, text: str) -> float:
    t = text.lower()
    sev = base
    if any(w in t for w in _SEV_UP):
        sev += 0.08
    if any(w in t for w in _SEV_DOWN):
        sev -= 0.12
    return round(min(1.0, max(0.1, sev)), 3)


def hash_id(raw: str) -> str:
    return hashlib.md5((raw or "").encode("utf-8", "ignore")).hexdigest()


def entry_id(entry) -> str:
    return hash_id(getattr(entry, "id", "") or getattr(entry, "link", "") or
                   getattr(entry, "title", ""))


def published(entry) -> datetime:
    for attr in ("published_parsed", "updated_parsed"):
        tm = getattr(entry, attr, None)
        if tm:
            try:
                return datetime(*tm[:6], tzinfo=timezone.utc)
            except Exception:
                pass
    return datetime.now(timezone.utc)


def parse_dt(value: str) -> datetime:
    if value:
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)
        except Exception:
            pass
    return datetime.now(timezone.utc)


def source_name(feed_name: str, title: str) -> str:
    # Google News titles look like "Headline - Publisher". Prefer the publisher.
    if feed_name.startswith("Google News") and " - " in title:
        return title.rsplit(" - ", 1)[-1].strip()[:60] or feed_name
    return feed_name


def make_incident(uid: str, dt: datetime, it: dict, loc_id: str, loc_name: str,
                  lat: float, lon: float, source: str, desc: str, url, sev: float) -> dict:
    return {
        "id": uid,
        "date": dt.strftime("%Y-%m-%d"),
        "time": dt.strftime("%H:%M"),
        "type": it["type"],
        "cat": it["cat"],
        "icon": it["icon"],
        "color": it["color"],
        "sev": sev,
        "location_id": loc_id,
        "location_name": loc_name,
        "lat": lat,
        "lon": lon,
        "source": source,
        "desc": (desc or "")[:400],
        "verified": True,
        "live": True,
        "url": url,
    }


async def get(client: httpx.AsyncClient, name: str, url: str, headers: dict):
    """Fetch one URL. Returns the response, or None on any error (per-source
    isolation — one dead/blocked source never breaks the others)."""
    try:
        r = await client.get(url, headers=headers)
        if r.status_code >= 400:
            logger.debug("[%s] HTTP %s", name, r.status_code)
            return None
        return r
    except Exception as e:  # noqa: BLE001
        logger.debug("[%s] fetch error: %s", name, e)
        return None


def collect_rss(name: str, default_city: str, text: str, ctx: FeedContext) -> int:
    """Parse one RSS/Atom feed and append safety items to ctx.new_map."""
    kept = 0
    parsed = feedparser.parse(text)
    for entry in (parsed.entries or [])[:40]:
        title = clean(getattr(entry, "title", ""))
        summary = clean(getattr(entry, "summary", ""))
        combined = f"{title}. {summary}"
        if not is_safety(combined) or is_excluded(combined):
            continue
        it = classify_type(combined, ctx.itype_map)
        if not it:
            continue
        eid = entry_id(entry)
        uid = f"L-{eid[:10]}"
        if uid in ctx.new_map:
            continue
        ctx.seen.add(eid)
        loc_id, loc_name, lat, lon = detect_city(combined, default_city)
        ctx.new_map[uid] = make_incident(
            uid, published(entry), it, loc_id, loc_name, lat, lon,
            source_name(name, title), summary or title,
            getattr(entry, "link", None), severity(it["sev"], combined))
        kept += 1
    return kept


def _record_dt(rec: dict) -> datetime:
    """Best-effort timestamp from a Socrata record's first date-like field."""
    for k, v in rec.items():
        if isinstance(v, str) and v and ("date" in k.lower() or "time" in k.lower()):
            dt = parse_dt(v)
            if dt:
                return dt
    return datetime.now(timezone.utc)


def collect_opendata(name: str, default_city: str, records: list, ctx: FeedContext) -> int:
    """Parse a Socrata open-data record list (one dict per incident)."""
    kept = 0
    for rec in (records or [])[:20]:
        text = " ".join(f"{k}: {v}" for k, v in rec.items() if v)[:1500]
        if not is_safety(text) or is_excluded(text):
            continue
        it = classify_type(text, ctx.itype_map)
        if not it:
            continue
        eid = hash_id(text[:160])
        uid = f"L-{eid[:10]}"
        if uid in ctx.new_map:
            continue
        ctx.seen.add(eid)
        loc_id, loc_name, lat, lon = detect_city(text, default_city)
        ctx.new_map[uid] = make_incident(
            uid, _record_dt(rec), it, loc_id, loc_name, lat, lon,
            name, text[:300], None, severity(it["sev"], text))
        kept += 1
    return kept


# ─── BASE AGENT ──────────────────────────────────────────────────────────────
class BaseAgent:
    """An agent owns a set of sources and turns them into incidents.

    RSS-backed agents (news/gov/social) only declare FEEDS as
    (display_name, url, default_city) triples; weather/open-data override collect().
    """
    name: str = "base"
    FEEDS: list[tuple[str, str, str]] = []

    async def collect(self, client: httpx.AsyncClient, ctx: FeedContext) -> dict[str, int]:
        """Fetch every source and return {source_name: kept_count}.
        A value of -1 means the source was unreachable/blocked this cycle."""
        resps = await asyncio.gather(
            *[get(client, n, u, HEADERS) for n, u, _ in self.FEEDS]
        )
        per_feed: dict[str, int] = {}
        for (name, _url, default_city), resp in zip(self.FEEDS, resps):
            if resp is None:
                per_feed[name] = -1
                continue
            try:
                per_feed[name] = collect_rss(name, default_city, resp.text, ctx)
            except Exception:
                logger.exception("[%s] parse failed: %s", self.name, name)
                per_feed[name] = -1
        return per_feed

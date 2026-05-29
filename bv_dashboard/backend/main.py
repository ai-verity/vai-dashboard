"""
Brownsville TX Public Safety Dashboard — FastAPI Backend
Serves incident data, statistics, and AI analysis via REST API.
"""

import asyncio
import hmac
import logging
import os
import random
from datetime import datetime
from typing import Optional
from fastapi import FastAPI, Header, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool
from pydantic import BaseModel, Field
import httpx
import json

import vlm
import ai_metrics
import live_feed

# Optional rate-limit. slowapi is only required for production deployments;
# dev installs (fastapi + uvicorn + httpx + pydantic) work without it. When
# absent we no-op the decorator so endpoints stay unchanged.
try:
    from slowapi import Limiter, _rate_limit_exceeded_handler
    from slowapi.errors import RateLimitExceeded
    from slowapi.util import get_remote_address
    _HAS_SLOWAPI = True
except ImportError:  # pragma: no cover — optional dep
    _HAS_SLOWAPI = False

logger = logging.getLogger("bv_dashboard")

app = FastAPI(title="Brownsville Public Safety API", version="1.0.0")

# Comma-separated origin list, e.g. "http://localhost:5173,https://dashboard.example.com".
# Wildcard "*" is intentionally disallowed when credentials are enabled. When
# the frontend is served from the same origin as the API (production same-origin
# build), this list is irrelevant.
_default_origins = "http://localhost:5173,http://localhost:4173"
_origins = [o.strip() for o in os.getenv("BV_CORS_ORIGINS", _default_origins).split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Rate-limit setup. Per-IP caps protect /api/analyze (Anthropic cost vector)
# and /api/vlm/reload (full CSV re-parse). Default limits are conservative;
# override via BV_ANALYZE_RATE / BV_RELOAD_RATE env vars.
if _HAS_SLOWAPI:
    limiter = Limiter(key_func=get_remote_address)
    app.state.limiter = limiter
    app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

    def rate_limit(rule: str):
        return limiter.limit(rule)
else:
    def rate_limit(rule: str):  # type: ignore[misc]
        # No-op decorator when slowapi isn't installed (dev).
        def deco(fn):
            return fn
        return deco

_ANALYZE_RATE = os.getenv("BV_ANALYZE_RATE", "20/minute")
_RELOAD_RATE  = os.getenv("BV_RELOAD_RATE",  "5/minute")

# ─── CONSTANTS ───────────────────────────────────────────────────────────────
LOCATIONS = [
    {"id": "downtown",    "name": "Downtown / Elizabeth St",      "lat": 25.9015, "lon": -97.4975, "icon": "🏙️"},
    {"id": "ozanam",      "name": "Ozanam Center (Shelter)",       "lat": 25.9112, "lon": -97.5143, "icon": "🏠"},
    {"id": "airport",     "name": "BRO Airport",                   "lat": 25.9068, "lon": -97.4259, "icon": "✈️"},
    {"id": "dean_porter", "name": "Dean Porter Park",              "lat": 25.9064, "lon": -97.5017, "icon": "🌳"},
    {"id": "linear_park", "name": "Linear Park",                   "lat": 25.9023, "lon": -97.4971, "icon": "🛤️"},
    {"id": "washington",  "name": "Washington Park",               "lat": 25.9035, "lon": -97.5028, "icon": "🏛️"},
    {"id": "pablo_kisel", "name": "Pablo Kisel Blvd",              "lat": 25.8900, "lon": -97.4950, "icon": "🍺"},
    {"id": "gateway",     "name": "Gateway Intl Bridge",           "lat": 25.8986, "lon": -97.5094, "icon": "🌉"},
    {"id": "sunrise",     "name": "Sunrise Mall",                  "lat": 25.9253, "lon": -97.4789, "icon": "🛍️"},
    {"id": "valley_reg",  "name": "Valley Regional Med Ctr",       "lat": 25.9150, "lon": -97.4900, "icon": "🏥"},
    {"id": "tsc",         "name": "Texas Southmost College",       "lat": 25.9008, "lon": -97.5011, "icon": "🎓"},
    {"id": "midtown",     "name": "Midtown Entertainment Dist.",   "lat": 25.8900, "lon": -97.4930, "icon": "🎭"},
    {"id": "resaca",      "name": "Resaca / Flood Zones",          "lat": 25.9200, "lon": -97.5100, "icon": "💧"},
    {"id": "rawhide",     "name": "Rawhide Dr (Residential)",      "lat": 25.9450, "lon": -97.4800, "icon": "🏘️"},
    {"id": "boca_chica",  "name": "Boca Chica Blvd Corridor",      "lat": 25.8750, "lon": -97.4500, "icon": "🛣️"},
    {"id": "exp83",       "name": "Expressway 83 / US-77",         "lat": 25.9300, "lon": -97.4750, "icon": "🚗"},
]

LOC_MAP = {l["id"]: l for l in LOCATIONS}

LOC_WEIGHTS = {
    "downtown": 0.15, "pablo_kisel": 0.12, "ozanam": 0.11, "airport": 0.09,
    "gateway": 0.08, "resaca": 0.07, "valley_reg": 0.06, "midtown": 0.06,
    "linear_park": 0.05, "washington": 0.04, "sunrise": 0.04, "rawhide": 0.04,
    "exp83": 0.03, "boca_chica": 0.03, "dean_porter": 0.02, "tsc": 0.01,
}

INCIDENT_TYPES = [
    {"type": "Unattended Suspicious Item",  "cat": "SECURITY", "icon": "📦", "color": "#06B6D4", "sev": 0.65},
    {"type": "Weapons / Firearms",          "cat": "VIOLENT",  "icon": "🔫", "color": "#EF4444", "sev": 0.88},
    {"type": "Armed Robbery / Assault",     "cat": "VIOLENT",  "icon": "🗡️","color": "#DC2626", "sev": 0.82},
    {"type": "Fighting / Brawl",            "cat": "VIOLENT",  "icon": "👊", "color": "#F97316", "sev": 0.65},
    {"type": "Aggravated Assault",          "cat": "VIOLENT",  "icon": "⚠️", "color": "#E8534A", "sev": 0.78},
    {"type": "Aggressive Behavior",         "cat": "VIOLENT",  "icon": "😤", "color": "#F59E0B", "sev": 0.50},
    {"type": "Vandalism",                   "cat": "ORDER",    "icon": "🔨", "color": "#FBBF24", "sev": 0.38},
    {"type": "Mental Health Crisis",        "cat": "HEALTH",   "icon": "🧠", "color": "#A78BFA", "sev": 0.60},
    {"type": "Medical — Diabetes",          "cat": "HEALTH",   "icon": "💉", "color": "#818CF8", "sev": 0.70},
    {"type": "Medical — Cardiac",           "cat": "HEALTH",   "icon": "❤️", "color": "#C084FC", "sev": 0.85},
    {"type": "Medical — Obesity/Related",   "cat": "HEALTH",   "icon": "🏥", "color": "#A855F7", "sev": 0.62},
    {"type": "Unsheltered / Homeless",      "cat": "ORDER",    "icon": "🏕️", "color": "#6B7280", "sev": 0.32},
    {"type": "Flash Flooding",              "cat": "ENVIRON",  "icon": "🌊", "color": "#3B82F6", "sev": 0.80},
    {"type": "Smoke / Fire",               "cat": "ENVIRON",  "icon": "🔥", "color": "#F97316", "sev": 0.75},
    {"type": "Crowd Surge / Mob",           "cat": "ORDER",    "icon": "👥", "color": "#F5B731", "sev": 0.68},
    {"type": "Perimeter Breach",            "cat": "SECURITY", "icon": "🔓", "color": "#2DC9A8", "sev": 0.60},
    {"type": "Downed Powerlines",           "cat": "ENVIRON",  "icon": "⚡", "color": "#FDE047", "sev": 0.55},
    {"type": "Vehicle Theft",               "cat": "ORDER",    "icon": "🚗", "color": "#94A3B8", "sev": 0.48},
    {"type": "Drug Activity",               "cat": "ORDER",    "icon": "💊", "color": "#8B5CF6", "sev": 0.55},
    {"type": "Domestic Disturbance",        "cat": "VIOLENT",  "icon": "🏠", "color": "#FB7185", "sev": 0.72},
    {"type": "Officer-Involved Shooting",   "cat": "VIOLENT",  "icon": "🚔", "color": "#991B1B", "sev": 0.95},
    {"type": "Stabbing",                    "cat": "VIOLENT",  "icon": "🔪", "color": "#B91C1C", "sev": 0.90},
]

ITYPE_MAP = {t["type"]: t for t in INCIDENT_TYPES}

REAL_INCIDENTS = [
    {"date": "2026-01-01", "time": "00:15", "type": "Weapons / Firearms",       "loc": "downtown",    "sev": 0.82, "source": "BPD/KRGV",               "desc": "Multiple arrests for celebratory gunfire. AR-15 and 9mm handguns seized at Tulipan St and W 9th St. SWAT deployed citywide. Five individuals arraigned with $3,000 bonds.", "verified": True},
    {"date": "2026-01-20", "time": "18:30", "type": "Crowd Surge / Mob",        "loc": "tsc",         "sev": 0.35, "source": "City of Brownsville",      "desc": "City Commission meeting draws large attendance discussing new $75M Public Safety Complex and Midtown Entertainment District safety regulations.", "verified": True},
    {"date": "2026-02-03", "time": "23:45", "type": "Perimeter Breach",         "loc": "midtown",     "sev": 0.58, "source": "City Commission",          "desc": "Pablo Kisel Blvd spike in late-night disturbances. City enacts updated safety standards for Downtown and Central Entertainment Districts.", "verified": True},
    {"date": "2026-02-17", "time": "01:30", "type": "Stabbing",                 "loc": "pablo_kisel", "sev": 0.91, "source": "KRGV/Nextdoor",            "desc": "Female victim stabbed at Pablo Kisel nightclub. Suspects fled. BPD investigation ongoing. Multiple witnesses interviewed.", "verified": True},
    {"date": "2026-02-19", "time": "14:00", "type": "Weapons / Firearms",       "loc": "airport",     "sev": 0.55, "source": "BPD",                      "desc": "BPD deploys drone patrol at BRO Airport. TSA firearms detection at RGV airports remains elevated — highest per-capita checkpoint detections in Texas.", "verified": True},
    {"date": "2026-02-24", "time": "21:10", "type": "Armed Robbery / Assault",  "loc": "downtown",    "sev": 0.95, "source": "KRGV Feb 24 2026",        "desc": "Three charged in fatal shooting — 'deal gone wrong' involving illegal firearm purchase. Victim deceased at Valley Regional Medical Center.", "verified": True},
    {"date": "2026-02-28", "time": "02:20", "type": "Stabbing",                 "loc": "pablo_kisel", "sev": 0.96, "source": "KRGV Feb 28 2026",        "desc": "Fatal stabbing near nightclub district. Three suspects charged. Victim sustained fatal neck wounds. Texas Rangers notified.", "verified": True},
    {"date": "2026-03-11", "time": "09:00", "type": "Flash Flooding",           "loc": "resaca",      "sev": 0.72, "source": "City of Brownsville",      "desc": "Stage 2 water restrictions enacted. Amistad and Falcon Reservoirs at 26.6% capacity. Road flooding in resaca areas. Drainage pumps activated.", "verified": True},
    {"date": "2026-03-19", "time": "13:30", "type": "Smoke / Fire",            "loc": "boca_chica",  "sev": 0.68, "source": "City of Brownsville",      "desc": "Extreme drought — Stage 2 restrictions in effect. Brush fire risk elevated across southern Cameron County. BFD on heightened readiness.", "verified": True},
    {"date": "2026-03-23", "time": "07:45", "type": "Flash Flooding",           "loc": "resaca",      "sev": 0.65, "source": "City of Brownsville",      "desc": "Coffee Road construction disrupts drainage. Flooding near resaca channels. Engineering & Public Works activated.", "verified": True},
    {"date": "2026-04-02", "time": "11:00", "type": "Crowd Surge / Mob",        "loc": "downtown",    "sev": 0.28, "source": "City OEM",                 "desc": "Citywide emergency drill — mass WEA alerts. Large crowd gathers near Washington Park. All-clear issued by 12:30PM.", "verified": True},
    {"date": "2026-04-15", "time": "14:00", "type": "Medical — Diabetes",       "loc": "valley_reg",  "sev": 0.72, "source": "Valley Regional Med Ctr",  "desc": "Elevated diabetic emergency admissions. Cameron County diabetes rate 3× state average. 3 in 5 diabetics require hospital care.", "verified": True},
    {"date": "2026-04-29", "time": "16:00", "type": "Perimeter Breach",         "loc": "dean_porter", "sev": 0.40, "source": "KRGV Apr 29",              "desc": "Washington Park renovation raises security concerns. Construction access points near Dean Porter Park. After-hours violations documented.", "verified": True},
    {"date": "2026-04-30", "time": "06:36", "type": "Officer-Involved Shooting","loc": "rawhide",     "sev": 0.97, "source": "KRGV Apr 30 2026",        "desc": "OIS at 5500 Rawhide Drive. BISD employee fired at wife and daughter's vehicle; officers returned fire. Non-fatal wound. Texas Rangers investigating.", "verified": True},
    {"date": "2026-05-10", "time": "18:12", "type": "Downed Powerlines",        "loc": "exp83",       "sev": 0.52, "source": "KRGV May 11 2026",        "desc": "FM 511 closed after storm downed powerlines. AEP Texas outage — Villa Los Pinos, Brownsville Country Club, Rancho Viejo affected.", "verified": True},
    {"date": "2026-05-11", "time": "08:00", "type": "Downed Powerlines",        "loc": "boca_chica",  "sev": 0.45, "source": "KRGV May 11 2026",        "desc": "Continued storm-related outage in southern Brownsville. Multiple road closures. Power restored after repair crews deployed.", "verified": True},
]

MONTH_WEIGHTS = {"2026-01": 0.82, "2026-02": 1.38, "2026-03": 1.08, "2026-04": 1.22, "2026-05": 0.50}
MONTH_DAYS    = {"2026-01": 31,   "2026-02": 28,   "2026-03": 31,   "2026-04": 30,   "2026-05": 13}

def weighted_choice(weights: dict, rng: random.Random) -> str:
    keys = list(weights.keys())
    vals = list(weights.values())
    total = sum(vals)
    r = rng.random() * total
    acc = 0
    for k, v in zip(keys, vals):
        acc += v
        if r <= acc:
            return k
    return keys[-1]

def build_incidents() -> list:
    rng = random.Random(42)
    incidents = []

    # Real verified incidents
    for i, r in enumerate(REAL_INCIDENTS):
        loc = LOC_MAP[r["loc"]]
        it  = ITYPE_MAP[r["type"]]
        incidents.append({
            "id": f"R-{i+1:03d}",
            "date": r["date"],
            "time": r["time"],
            "type": r["type"],
            "cat": it["cat"],
            "icon": it["icon"],
            "color": it["color"],
            "sev": r["sev"],
            "location_id": r["loc"],
            "location_name": loc["name"],
            "lat": loc["lat"] + rng.uniform(-0.001, 0.001),
            "lon": loc["lon"] + rng.uniform(-0.001, 0.001),
            "source": r["source"],
            "desc": r["desc"],
            "verified": True,
        })

    # Synthetic incidents. idx resets per month so the S-YYYY-MM-### id stays
    # interpretable as a per-month sequence.
    for ym, days in MONTH_DAYS.items():
        target = round(50 * MONTH_WEIGHTS[ym])
        for idx in range(target):
            day  = rng.randint(1, days)
            hour = rng.randint(0, 23)
            mint = rng.randint(0, 59)
            it   = rng.choice(INCIDENT_TYPES)
            lid  = weighted_choice(LOC_WEIGHTS, rng)
            loc  = LOC_MAP[lid]
            sev  = min(1.0, max(0.1, it["sev"] + rng.uniform(-0.14, 0.17)))
            desc_suffix = {
                "HEALTH":  "EMS responding.",
                "ENVIRON": "EPW/BFD notified.",
            }.get(it["cat"], "Units dispatched.")
            sev_label = "CRITICAL" if sev >= 0.8 else "HIGH" if sev >= 0.6 else "MODERATE" if sev >= 0.4 else "LOW"
            incidents.append({
                "id": f"S-{ym}-{idx:03d}",
                "date": f"{ym}-{day:02d}",
                "time": f"{hour:02d}:{mint:02d}",
                "type": it["type"],
                "cat":  it["cat"],
                "icon": it["icon"],
                "color": it["color"],
                "sev":  round(sev, 3),
                "location_id": lid,
                "location_name": loc["name"],
                "lat": loc["lat"] + rng.uniform(-0.003, 0.003),
                "lon": loc["lon"] + rng.uniform(-0.004, 0.004),
                "source": "BPD CAD / Simulation",
                "desc": f"{it['type']} reported at {loc['name']}. {desc_suffix} Severity: {sev_label}.",
                "verified": False,
            })

    incidents.sort(key=lambda x: (x["date"], x["time"]), reverse=True)
    return incidents

# Curated + synthetic baseline, built once at startup.
_BASE_INCIDENTS: list = build_incidents()
# Public-facing feed = baseline + live-ingested Brownsville incidents. Rebuilt
# by _recompose_incidents() whenever the live feed refreshes.
ALL_INCIDENTS: list = list(_BASE_INCIDENTS)

# Background poll interval for the live Brownsville feed (seconds).
_LIVE_FEED_INTERVAL = int(os.getenv("BV_LIVE_FEED_INTERVAL", "900"))


def _recompose_incidents() -> None:
    """Merge the baseline incidents with live-ingested Brownsville items.

    Live records (verified real news/government items) are appended to the
    curated + synthetic baseline and the whole list is re-sorted newest-first,
    so the feed, map, KPIs and charts all pick them up automatically.
    """
    global ALL_INCIDENTS
    combined = _BASE_INCIDENTS + live_feed.get_incidents()
    combined.sort(key=lambda x: (x["date"], x["time"]), reverse=True)
    ALL_INCIDENTS = combined
    # The feed just changed ALL_INCIDENTS, so the precomputed /api/stats/*
    # snapshots are now stale — rebuild them to match the live data.
    _recompute_stats()


# ─── MODELS ──────────────────────────────────────────────────────────────────
class AnalysisRequest(BaseModel):
    incident_id: str  = Field(..., max_length=64)
    type:         str = Field(..., max_length=128)
    location_name: str = Field(..., max_length=128)
    date:         str = Field(..., max_length=32)
    severity:     float = Field(..., ge=0.0, le=1.0)
    sev_label:    str = Field(..., max_length=32)
    desc:         str = Field(..., max_length=2000)
    cat:          str = Field(..., max_length=32)


# ─── HELPERS ─────────────────────────────────────────────────────────────────
def sev_label(s: float) -> str:
    if s >= 0.9: return "CRITICAL"
    if s >= 0.7: return "HIGH"
    if s >= 0.5: return "MODERATE"
    if s >= 0.3: return "LOW"
    return "MINIMAL"

def rule_ai(cat: str, type_: str, loc: str, sev: float) -> str:
    templates = {
        "VIOLENT":  f"This {type_} at {loc} is a {'critical' if sev>=0.85 else 'elevated'}-severity violent event. Pablo Kisel Blvd and downtown corridors account for the majority of Brownsville's violent incidents — February 2026 saw two fatal stabbings and one fatal shooting in these corridors. Priority: immediate BPD response, CIT coordination if behavioral component present, Texas Rangers notification for fatalities.",
        "HEALTH":   f"Medical emergency at {loc} reflects Brownsville's chronic health burden: 30% diabetic (half undiagnosed), 80% obese/overweight, limited insurance driving elevated ER utilization at Valley Regional Medical Center. Three in five diabetic patients in the RGV require hospital care. Priority: EMS dispatch, diabetic/cardiac protocol, public health flag.",
        "ENVIRON":  f"Environmental incident at {loc}. Brownsville faces compounding risk: 74% of buildings in FEMA flood zones, Falcon and Amistad Reservoirs at 26.6% capacity. Priority: Engineering & Public Works activation, Resaca drainage assessment, road closure coordination with TxDOT.",
        "ORDER":    f"Public order incident at {loc}. Brownsville averages 12.56 daily crimes; unsheltered populations near Ozanam Center and park corridors elevate baseline risk. Priority: community policing response, coordinate city social services.",
        "SECURITY": f"Security breach at {loc}. BRO Airport and city facilities remain elevated targets per BPD threat assessment and elevated TSA firearm detections. Priority: facility security activation, BPD perimeter response.",
    }
    return templates.get(cat, "Standard BPD response. Monitor for escalation.")


# ─── ROUTES ──────────────────────────────────────────────────────────────────

@app.get("/api/incidents")
def get_incidents(
    cat:      Optional[str] = Query(None),
    month:    Optional[str] = Query(None),
    min_sev:  float         = Query(0.0, ge=0.0, le=1.0),
    limit:    int           = Query(500, ge=1, le=1000),
    offset:   int           = Query(0, ge=0),
    search:   Optional[str] = Query(None, max_length=200),
):
    incs = ALL_INCIDENTS
    if cat and cat != "ALL":
        incs = [i for i in incs if i["cat"] == cat]
    if month:
        incs = [i for i in incs if i["date"].startswith(month)]
    if min_sev is not None and min_sev > 0.0:
        incs = [i for i in incs if i["sev"] >= min_sev]
    if search:
        q = search.lower()
        incs = [i for i in incs if q in i["type"].lower() or q in i["location_name"].lower() or q in i["desc"].lower()]
    total = len(incs)
    return {"total": total, "incidents": incs[offset : offset + limit]}


@app.get("/api/incidents/{incident_id}")
def get_incident(incident_id: str):
    for i in ALL_INCIDENTS:
        if i["id"] == incident_id:
            return i
    raise HTTPException(status_code=404, detail="Incident not found")


_TOTAL_DAYS = sum(MONTH_DAYS.values())
_CATS = ("VIOLENT", "HEALTH", "ENVIRON", "ORDER", "SECURITY")


def _compute_kpi() -> dict:
    incs = ALL_INCIDENTS
    total = len(incs)
    counts = {c: 0 for c in _CATS}
    sev_sum = 0.0
    critical = 0
    for i in incs:
        counts[i["cat"]] = counts.get(i["cat"], 0) + 1
        sev_sum += i["sev"]
        if i["sev"] >= 0.75:
            critical += 1
    return {
        "total":     total,
        "violent":   counts["VIOLENT"],
        "health":    counts["HEALTH"],
        "environ":   counts["ENVIRON"],
        "order":     counts["ORDER"],
        "security":  counts["SECURITY"],
        "critical":  critical,
        "avg_daily": round(total / _TOTAL_DAYS, 2) if _TOTAL_DAYS else 0,
        "avg_sev":   round(sev_sum / total, 3) if total else 0,
    }


def _compute_monthly() -> list[dict]:
    by_month: dict[str, dict] = {}
    for ym in MONTH_DAYS:
        by_month[ym] = {
            "month": ym, "label": ym[5:], "total": 0, "_sev_sum": 0.0,
            **{c.lower(): 0 for c in _CATS},
            **{f"{c.lower()}_sev_sum": 0.0 for c in _CATS},
        }
    for i in ALL_INCIDENTS:
        m = i["date"][:7]
        entry = by_month.get(m)
        if entry is None:
            continue
        entry["total"] += 1
        entry["_sev_sum"] += i["sev"]
        c = i["cat"].lower()
        entry[c] += 1
        entry[f"{c}_sev_sum"] += i["sev"]
    result: list[dict] = []
    for ym in sorted(by_month):
        e = by_month[ym]
        row = {"month": e["month"], "label": e["label"], "total": e["total"]}
        for c in _CATS:
            cl = c.lower()
            cnt = e[cl]
            row[cl] = cnt
            row[f"{cl}_avg_sev"] = round(e[f"{cl}_sev_sum"] / cnt, 3) if cnt else 0
        row["avg_sev"] = round(e["_sev_sum"] / e["total"], 3) if e["total"] else 0
        result.append(row)
    return result


def _compute_by_category() -> list[dict]:
    counts = {c: 0 for c in _CATS}
    sev_sum = {c: 0.0 for c in _CATS}
    for i in ALL_INCIDENTS:
        cat = i["cat"]
        if cat in counts:
            counts[cat] += 1
            sev_sum[cat] += i["sev"]
    return [
        {
            "cat": c,
            "count": counts[c],
            "avg_sev": round(sev_sum[c] / counts[c], 3) if counts[c] else 0,
        }
        for c in _CATS
    ]


def _compute_by_location(top_n: int = 10) -> list[dict]:
    counts: dict = {}
    sev_sums: dict = {}
    for i in ALL_INCIDENTS:
        lid = i["location_id"]
        counts[lid] = counts.get(lid, 0) + 1
        sev_sums[lid] = sev_sums.get(lid, 0) + i["sev"]
    top = sorted(counts.items(), key=lambda x: x[1], reverse=True)[:top_n]
    result = []
    for lid, cnt in top:
        loc = LOC_MAP.get(lid, {"name": lid, "icon": "📍"})
        result.append({
            "location_id":   lid,
            "location_name": loc["name"],
            "icon":          loc.get("icon", "📍"),
            "count":         cnt,
            "avg_sev":       round(sev_sums[lid] / cnt, 3),
        })
    return result


def _compute_severity_dist() -> list[dict]:
    incs = ALL_INCIDENTS
    return [
        {"tier": "Critical ≥0.9",   "min": 0.9, "max": 1.0, "count": sum(1 for i in incs if i["sev"] >= 0.9),             "color": "#7f1d1d"},
        {"tier": "High 0.7–0.9",    "min": 0.7, "max": 0.9, "count": sum(1 for i in incs if 0.7 <= i["sev"] < 0.9),       "color": "#EF4444"},
        {"tier": "Moderate 0.5–0.7","min": 0.5, "max": 0.7, "count": sum(1 for i in incs if 0.5 <= i["sev"] < 0.7),       "color": "#F97316"},
        {"tier": "Low 0.3–0.5",     "min": 0.3, "max": 0.5, "count": sum(1 for i in incs if 0.3 <= i["sev"] < 0.5),       "color": "#F5B731"},
        {"tier": "Minimal <0.3",    "min": 0.0, "max": 0.3, "count": sum(1 for i in incs if i["sev"] < 0.3),              "color": "#2EC98A"},
    ]


_WEEKDAY_LABELS = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")


def _compute_heatmap() -> list[dict]:
    grid_sums   = [[0.0] * 7 for _ in range(8)]
    grid_counts = [[0]   * 7 for _ in range(8)]
    for inc in ALL_INCIDENTS:
        try:
            dt = datetime.fromisoformat(f"{inc['date']}T{inc['time']}")
        except ValueError:
            continue
        dow = dt.weekday()
        bi  = dt.hour // 3
        grid_sums[bi][dow]   += inc["sev"]
        grid_counts[bi][dow] += 1
    result = []
    for bi in range(8):
        for dow in range(7):
            cnt = grid_counts[bi][dow]
            result.append({
                "hour_block": bi,
                "hour_label": f"{bi*3:02d}h",
                "weekday": dow,
                "weekday_label": _WEEKDAY_LABELS[dow],
                "count": cnt,
                "avg_sev": round(grid_sums[bi][dow] / cnt, 3) if cnt else 0,
            })
    return result


def _compute_type_ranking(top_n: int = 12) -> list[dict]:
    counts: dict = {}
    sev_sums: dict = {}
    for i in ALL_INCIDENTS:
        t = i["type"]
        counts[t] = counts.get(t, 0) + 1
        sev_sums[t] = sev_sums.get(t, 0) + i["sev"]
    top = sorted(counts.items(), key=lambda x: x[1], reverse=True)[:top_n]
    result = []
    for t, cnt in top:
        meta = ITYPE_MAP.get(t, {"icon": "⬡", "color": "#94A3B8", "cat": "ORDER"})
        result.append({
            "type":    t,
            "icon":    meta["icon"],
            "color":   meta["color"],
            "cat":     meta["cat"],
            "count":   cnt,
            "avg_sev": round(sev_sums[t] / cnt, 3),
        })
    return result


# Every /api/stats/* response is served from these precomputed snapshots so we
# don't iterate the full incident list per request. They must be rebuilt whenever
# ALL_INCIDENTS changes — i.e. each time the live feed calls _recompose_incidents().
_STATS_KPI                  = {}
_STATS_MONTHLY              = {}
_STATS_BY_CATEGORY          = {}
_STATS_BY_LOCATION          = {}
_STATS_SEVERITY_DIST        = {}
_STATS_HEATMAP              = {}
_STATS_TYPE_RANKING         = {}


def _recompute_stats() -> None:
    """Rebuild all /api/stats/* snapshots from the current ALL_INCIDENTS."""
    global _STATS_KPI, _STATS_MONTHLY, _STATS_BY_CATEGORY, _STATS_BY_LOCATION
    global _STATS_SEVERITY_DIST, _STATS_HEATMAP, _STATS_TYPE_RANKING
    _STATS_KPI                  = _compute_kpi()
    _STATS_MONTHLY              = _compute_monthly()
    _STATS_BY_CATEGORY          = _compute_by_category()
    _STATS_BY_LOCATION          = _compute_by_location()
    _STATS_SEVERITY_DIST        = _compute_severity_dist()
    _STATS_HEATMAP              = _compute_heatmap()
    _STATS_TYPE_RANKING         = _compute_type_ranking()


# Initial snapshot from the baseline incidents; refreshed once the live feed loads.
_recompute_stats()


@app.get("/api/stats/kpi")
def get_kpi():
    return _STATS_KPI


@app.get("/api/stats/monthly")
def get_monthly():
    return _STATS_MONTHLY


@app.get("/api/stats/by_category")
def get_by_category():
    return _STATS_BY_CATEGORY


@app.get("/api/stats/by_location")
def get_by_location():
    return _STATS_BY_LOCATION


@app.get("/api/stats/severity_distribution")
def get_severity_dist():
    return _STATS_SEVERITY_DIST


@app.get("/api/stats/heatmap")
def get_heatmap():
    """Return avg severity and count by weekday (0=Mon..6=Sun) × 3-hour block (0-7)."""
    return _STATS_HEATMAP


@app.get("/api/stats/type_ranking")
def get_type_ranking():
    return _STATS_TYPE_RANKING


@app.get("/api/locations")
def get_locations():
    return LOCATIONS


@app.post("/api/analyze")
@rate_limit(_ANALYZE_RATE)
async def analyze_incident(
    req: AnalysisRequest,
    request: Request,  # noqa: ARG001 — slowapi inspects this argument
    x_analyze_token: Optional[str] = Header(default=None),
):
    """Stream AI analysis via Anthropic API, fall back to rule-based.

    When BV_ANALYZE_TOKEN is set, requests must include a matching
    `X-Analyze-Token` header. Per-IP rate-limit is applied regardless.
    """
    expected_token = os.getenv("BV_ANALYZE_TOKEN")
    if expected_token:
        if not x_analyze_token or not hmac.compare_digest(x_analyze_token, expected_token):
            raise HTTPException(status_code=401, detail="invalid analyze token")

    api_key = os.getenv("ANTHROPIC_API_KEY", "")

    async def generate():
        if not api_key:
            text = rule_ai(req.cat, req.type, req.location_name, req.severity)
            for word in text.split():
                yield f"data: {json.dumps({'token': word + ' '})}\n\n"
            yield "data: [DONE]\n\n"
            return

        system = (
            "You are a concise public safety analyst for Brownsville TX. "
            "Analyze the incident in exactly 3 focused sentences: "
            "(1) immediate risk assessment, "
            "(2) connection to Brownsville's documented patterns "
            "(30% diabetes, 80% obesity, 74% flood zone, border city, elevated vehicle theft, "
            "Pablo Kisel entertainment district violence), "
            "(3) recommended response priority. "
            "No markdown, no bullets, plain prose only."
        )
        prompt = (
            f"Incident: {req.type} at {req.location_name} on {req.date}. "
            f"Severity: {req.sev_label} ({req.severity:.2f}). {req.desc}"
        )

        try:
            async with httpx.AsyncClient(timeout=30) as client:
                async with client.stream(
                    "POST",
                    "https://api.anthropic.com/v1/messages",
                    headers={
                        "x-api-key": api_key,
                        "anthropic-version": "2023-06-01",
                        "content-type": "application/json",
                    },
                    json={
                        "model": os.getenv("BV_ANALYZE_MODEL", "claude-sonnet-4-6"),
                        "max_tokens": 300,
                        "stream": True,
                        "system": system,
                        "messages": [{"role": "user", "content": prompt}],
                    },
                ) as resp:
                    if resp.status_code >= 400:
                        body = await resp.aread()
                        logger.warning(
                            "anthropic upstream %s: %s",
                            resp.status_code,
                            body[:500].decode("utf-8", "replace"),
                        )
                        raise httpx.HTTPStatusError(
                            f"anthropic {resp.status_code}", request=resp.request, response=resp
                        )
                    async for line in resp.aiter_lines():
                        if line.startswith("data: "):
                            payload = line[6:]
                            if payload == "[DONE]":
                                yield "data: [DONE]\n\n"
                                return
                            try:
                                evt = json.loads(payload)
                            except json.JSONDecodeError:
                                logger.warning("anthropic SSE non-JSON payload: %r", payload[:200])
                                continue
                            if evt.get("type") == "content_block_delta":
                                token = evt["delta"].get("text", "")
                                if token:
                                    yield f"data: {json.dumps({'token': token})}\n\n"
            yield "data: [DONE]\n\n"
        except Exception:
            logger.exception("LLM stream failed; serving rule-based fallback")
            text = rule_ai(req.cat, req.type, req.location_name, req.severity)
            for word in text.split():
                yield f"data: {json.dumps({'token': word + ' '})}\n\n"
            yield "data: [DONE]\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream")


# ─── VLM endpoints ───────────────────────────────────────────────────────────
_PROMPTS_DIR = os.path.join(os.path.dirname(__file__), "data", "vlm_prompts_inputs")
PROMPTS_PATH = os.path.join(_PROMPTS_DIR, "vlm_prompts.json")
VEHICLE_PROMPTS_PATH = os.path.join(_PROMPTS_DIR, "vlm_vehicle_prompts.json")
DUMPING_PROMPTS_PATH = os.path.join(_PROMPTS_DIR, "vlm_illegal_dumping_prompts.json")
# (path, preset_id) pairs. The frontend filters prompts by the observation's
# preset, so each prompt entry needs to carry its preset.
_PROMPT_FILES = [
    (PROMPTS_PATH, "crowd_behavior"),
    (VEHICLE_PROMPTS_PATH, "vehicle_prompts"),
    (DUMPING_PROMPTS_PATH, "illegal_dumping"),
]


def _load_prompts_cached() -> list:
    """Merged prompt catalog (crowd + vehicle), each entry tagged with preset.

    Missing files are skipped silently; malformed JSON is logged and skipped.
    Prompt `id`s are namespaced per preset on the wire so they stay unique
    when both catalogs are concatenated.
    """
    merged: list = []
    for path, preset in _PROMPT_FILES:
        if not os.path.exists(path):
            continue
        try:
            with open(path, "r", encoding="utf-8") as f:
                entries = json.load(f)
        except (OSError, json.JSONDecodeError):
            logger.exception("failed to load %s", path)
            continue
        for e in entries:
            e = dict(e)
            e["preset"] = preset
            e["id"] = f"{preset}:{e.get('id')}"
            merged.append(e)
    return merged


_PROMPTS_CACHE: list = []


@app.on_event("startup")
def _load_vlm():
    global _PROMPTS_CACHE
    try:
        info = vlm.load_all()
        logger.info(
            "vlm loaded %d observations from %d file(s)",
            info["row_count"], len(info["files"]),
        )
    except Exception:
        logger.exception("vlm load failed")
    _PROMPTS_CACHE = _load_prompts_cached()


@app.on_event("startup")
async def _start_live_feed():
    """Kick off the live Brownsville feed: one immediate poll, then every
    _LIVE_FEED_INTERVAL seconds in the background. All failures are non-fatal —
    the dashboard still serves the baseline incidents if the feed is down."""
    async def _poll_loop():
        while True:
            await asyncio.sleep(_LIVE_FEED_INTERVAL)
            try:
                await live_feed.refresh(INCIDENT_TYPES, LOCATIONS)
                _recompose_incidents()
            except Exception:
                logger.exception("live_feed refresh failed")

    try:
        n = await live_feed.refresh(INCIDENT_TYPES, LOCATIONS)
        _recompose_incidents()
        logger.info("live_feed initial load: %d Brownsville incidents", n)
    except Exception:
        logger.exception("live_feed initial load failed")
    asyncio.create_task(_poll_loop())


@app.get("/api/vlm/prompts")
def vlm_prompts():
    return _PROMPTS_CACHE


@app.get("/api/vlm/feeds")
def vlm_feeds():
    return {"feeds": vlm.feeds_summary(), "load": vlm.load_info()}


@app.get("/api/vlm/runs")
def vlm_runs():
    return vlm.runs_summary()


@app.get("/api/vlm/stats")
def vlm_stats():
    return vlm.stats_summary()


@app.get("/api/vlm/aggregates")
def vlm_aggregates():
    return vlm.aggregates()


@app.post("/api/vlm/reload")
@rate_limit(_RELOAD_RATE)
async def vlm_reload(
    request: Request,  # noqa: ARG001 — slowapi inspects this argument
    x_reload_token: Optional[str] = Header(default=None),
):
    """Re-read CSV/JSON sources from disk.

    Fail-closed: requires `BV_RELOAD_TOKEN` set on the server and a matching
    `X-Reload-Token` header on the request. If the env var is missing the
    endpoint returns 503 — re-parsing 20MB of CSV is a DoS vector, so we
    refuse rather than warn. For local dev, set the token to any string
    (e.g. `BV_RELOAD_TOKEN=dev`) or just restart the backend.
    """
    expected = os.getenv("BV_RELOAD_TOKEN")
    if not expected:
        raise HTTPException(
            status_code=503,
            detail="reload disabled: set BV_RELOAD_TOKEN on the server to enable",
        )
    if not x_reload_token or not hmac.compare_digest(x_reload_token, expected):
        raise HTTPException(status_code=401, detail="invalid reload token")

    global _PROMPTS_CACHE
    info = await run_in_threadpool(vlm.load_all)
    _PROMPTS_CACHE = await run_in_threadpool(_load_prompts_cached)
    return info


@app.get("/api/vlm/{obs_id}")
def vlm_one(obs_id: str):
    o = vlm.get_observation(obs_id)
    if o is None:
        raise HTTPException(status_code=404, detail="observation not found")
    return vlm.to_detail(o)


@app.get("/api/vlm")
def vlm_list(
    feed_id: Optional[str] = None,
    run_id: Optional[str] = None,
    location_id: Optional[str] = None,
    preset: Optional[str] = None,          # crowd_behavior | vehicle_prompts
    density: Optional[str] = None,         # SPARSE / MODERATE / DENSE
    risk: Optional[str] = None,            # exact tier match
    min_risk: Optional[str] = None,        # tier threshold (MODERATE = MEDIUM band)
    only_threats: bool = False,            # any crowd threat flag
    has_pedestrians: bool = False,
    only_vehicle_issues: bool = False,     # any vehicle issue flag
    collision: bool = False,
    speeding: bool = False,
    fire_lane: bool = False,
    # illegal_dumping filters
    only_dumping: bool = False,            # require dumping_present
    chronic_site: bool = False,
    water_proximity: bool = False,
    priority: Optional[str] = None,        # LOW / MEDIUM / HIGH
    waste_type: Optional[str] = None,      # case-insensitive substring match
    search: Optional[str] = None,
    limit: int = Query(100, le=500),
    offset: int = 0,
    sort: str = "captured_at",             # captured_at | processed_at
    order: str = "desc",                   # asc | desc
):
    items = vlm.all_observations()

    if feed_id:
        items = [o for o in items if o.feed_id == feed_id]
    if run_id:
        items = [o for o in items if o.run_id == run_id]
    if location_id:
        items = [o for o in items if o.location_id == location_id]
    if preset:
        items = [o for o in items if o.preset == preset]
    if density:
        d = density.upper()
        items = [o for o in items if (o.density_zone or "") == d]
    if risk:
        r = risk.upper()
        items = [o for o in items if (o.risk_level or "") == r]
    if min_risk:
        thr = vlm.RISK_ORDER.get(min_risk.upper(), -1)
        items = [o for o in items if vlm.RISK_ORDER.get((o.risk_level or "").upper(), -1) >= thr]
    if only_threats:
        items = [
            o for o in items
            if o.has_imminent_threat or o.weapons_visible or o.medical_emergency
               or o.fire_smoke or o.fallen_person or o.physical_altercation
               or o.unsupervised_children
        ]
    if has_pedestrians:
        items = [o for o in items if (o.pedestrian_count or 0) > 0]
    if only_vehicle_issues:
        items = [
            o for o in items
            if o.collision or o.speeding or o.fire_lane_violation or o.erratic_maneuver
               or o.wrong_way or o.vehicle_tamper or o.building_contact
               or o.pedestrian_struck or o.pedestrian_near_miss or o.child_struck
        ]
    if collision:
        items = [o for o in items if o.collision]
    if speeding:
        items = [o for o in items if o.speeding]
    if fire_lane:
        items = [o for o in items if o.fire_lane_violation]
    if only_dumping:
        items = [o for o in items if o.dumping_present]
    if chronic_site:
        items = [o for o in items if o.chronic_site]
    if water_proximity:
        items = [o for o in items if o.water_proximity]
    if priority:
        p = priority.upper()
        items = [o for o in items if (o.priority or "") == p]
    if waste_type:
        wt = waste_type.lower()
        items = [o for o in items if wt in (o.waste_type or "").lower()]
    if search:
        q = search.lower()
        items = [o for o in items if q in (o.feed_label.lower() + " " + o.image_name.lower() + " " + o.full_caption.lower())]

    key = (lambda o: o.captured_at or "") if sort == "captured_at" else (lambda o: o.processed_at or "")
    items = sorted(items, key=key, reverse=(order == "desc"))

    total = len(items)
    page = items[offset: offset + limit]
    return {
        "total": total,
        "limit": limit,
        "offset": offset,
        "items": [vlm.to_summary(o) for o in page],
    }


# ─── AI Model Metrics endpoints ─────────────────────────────────────────────
# Per-class Precision / Recall / F1 captured by the daily training
# pipeline. comparison.csv carries before/after for the latest run;
# additional comparison_YYYYMMDD.csv files in data/ai_metrics/history/
# are picked up automatically as the pipeline accumulates daily runs.


@app.get("/api/ai_metrics/summary")
def ai_metrics_summary():
    return ai_metrics.summary()


@app.get("/api/ai_metrics/by_class")
def ai_metrics_by_class():
    return ai_metrics.by_class()


@app.get("/api/ai_metrics/comparison")
def ai_metrics_comparison(period: str = Query("daily", regex="^(daily|weekly|monthly)$")):
    return ai_metrics.comparison(period)


@app.get("/api/ai_metrics/history")
def ai_metrics_history(period: str = Query("daily", regex="^(daily|weekly|monthly)$")):
    return ai_metrics.history(period)


@app.get("/api/ai_metrics/state")
def ai_metrics_state():
    return ai_metrics.state()


@app.get("/api/ai_metrics/dataset")
def ai_metrics_dataset():
    return ai_metrics.dataset_by_date()


@app.post("/api/ai_metrics/reload")
@rate_limit(_RELOAD_RATE)
async def ai_metrics_reload(
    request: Request,  # noqa: ARG001 — slowapi inspects this argument
    x_reload_token: Optional[str] = Header(default=None),
):
    """Re-read AI Model Metrics files from disk.

    Same fail-closed token contract as /api/vlm/reload: requires
    BV_RELOAD_TOKEN env var on the server and a matching X-Reload-Token
    request header.
    """
    expected = os.getenv("BV_RELOAD_TOKEN")
    if not expected:
        raise HTTPException(
            status_code=503,
            detail="reload disabled: set BV_RELOAD_TOKEN on the server to enable",
        )
    if not x_reload_token or not hmac.compare_digest(x_reload_token, expected):
        raise HTTPException(status_code=401, detail="invalid reload token")
    await run_in_threadpool(ai_metrics.load)
    return ai_metrics.state()


# ─── Live Brownsville feed ──────────────────────────────────────────────────
@app.get("/api/feeds/status")
def feeds_status():
    """Health of the live Brownsville RSS ingestion: last run, per-source counts."""
    return live_feed.status()


@app.post("/api/feeds/refresh")
@rate_limit(_RELOAD_RATE)
async def feeds_refresh(
    request: Request,  # noqa: ARG001 — slowapi inspects this argument
    x_reload_token: Optional[str] = Header(default=None),
):
    """Force an immediate live-feed poll. Same fail-closed token as /vlm/reload."""
    expected = os.getenv("BV_RELOAD_TOKEN")
    if not expected:
        raise HTTPException(
            status_code=503,
            detail="refresh disabled: set BV_RELOAD_TOKEN on the server to enable",
        )
    if not x_reload_token or not hmac.compare_digest(x_reload_token, expected):
        raise HTTPException(status_code=401, detail="invalid reload token")
    await live_feed.refresh(INCIDENT_TYPES, LOCATIONS)
    _recompose_incidents()
    return live_feed.status()


@app.get("/api/health")
def health():
    _fs = live_feed.status()
    return {
        "status": "ok",
        "incidents": len(ALL_INCIDENTS),
        "live_incidents": _fs.get("count", 0),
        "live_feed_last_run": _fs.get("last_run"),
        "vlm_observations": vlm.load_info().get("row_count", 0),
        "ai_metrics_runs": ai_metrics.state().get("runs", 0),
        "timestamp": datetime.now().isoformat(),
    }


# ─── Frontend static serving ────────────────────────────────────────────────
# When the Vite build output exists, serve it from this same FastAPI process
# (same-origin: no CORS, single port, single TLS cert in production).
# Override the search path with BV_FRONTEND_DIST. The mount is registered
# AFTER every /api/* route so API requests take precedence.
_default_dist = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "frontend", "dist"))
_FRONTEND_DIST = os.getenv("BV_FRONTEND_DIST", _default_dist)
if os.path.isdir(_FRONTEND_DIST):
    # html=True makes StaticFiles serve index.html for unmatched paths,
    # so client-side routing (e.g. /dashboard/charts) returns the SPA shell.
    app.mount("/", StaticFiles(directory=_FRONTEND_DIST, html=True), name="frontend")
    logger.info("serving frontend bundle from %s", _FRONTEND_DIST)
else:
    logger.info("no frontend bundle at %s; running API-only (dev mode)", _FRONTEND_DIST)

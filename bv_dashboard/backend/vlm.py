"""
VLM observation loader + parser.

Reads every *.csv in backend/data/, parses each row into a structured
observation with extracted fields (density, pedestrian count, risk
level, threat flags, etc.), and exposes lookup helpers used by the
/api/vlm/* endpoints.
"""

from __future__ import annotations

import csv
import os
import re
import threading
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from typing import Optional

DATA_DIR = os.path.join(os.path.dirname(__file__), "data")

# Filename suffix encoding capture time, e.g.
#   ..._03-27-2026-01-09-40-pm.jpg  -> 2026-03-27T13:09:40
_FILENAME_TS_RE = re.compile(
    r"_(\d{2})-(\d{2})-(\d{4})-(\d{2})-(\d{2})-(\d{2})-(am|pm)\.jpg$",
    re.IGNORECASE,
)

# Section header in full_caption
_SECTION_RE = re.compile(r"^\[([^\]]+)\]\s*$")
# Numbered answer: "1. <text>"
_ANSWER_RE = re.compile(r"^(\d+)\.\s*(.*)$")

# Maps free-text camera names to the existing 16-location list.
# Substrings are matched against the feed_id (minio_key directory).
_FEED_TO_LOCATION = [
    ("dean_porter", "dean_porter"),
    ("childrens_museum", "dean_porter"),
    ("linear_park", "linear_park"),
    ("washington_park", "washington"),
    ("pablo_kisel", "pablo_kisel"),
    ("gateway", "gateway"),
    ("sunrise", "sunrise"),
    ("valley_regional", "valley_reg"),
    ("tsc", "tsc"),
    ("midtown", "midtown"),
    ("resaca", "resaca"),
    ("ozanam", "ozanam"),
    ("airport", "airport"),
    ("downtown", "downtown"),
    ("rawhide", "rawhide"),
    ("boca_chica", "boca_chica"),
    ("expressway_83", "exp83"),
    ("exp83", "exp83"),
]


@dataclass
class VlmObservation:
    id: str
    run_id: str
    run_started_at: Optional[str]  # ISO 8601 UTC — parsed from run_id (YYYYMMDDTHHMMSSZ)
    feed_id: str
    feed_label: str
    location_id: Optional[str]
    image_name: str
    captured_at: Optional[str]    # ISO 8601, local time as captured
    processed_at: Optional[str]   # ISO 8601 UTC
    preset: str
    model: str
    total_seconds: Optional[float]

    # Derived
    pedestrian_count: Optional[int]
    density_zone: Optional[str]        # SPARSE / MODERATE / DENSE
    risk_level: Optional[str]          # LOW / MEDIUM / HIGH
    has_imminent_threat: bool
    weapons_visible: bool
    medical_emergency: bool
    fire_smoke: bool
    fallen_person: bool
    unsupervised_children: bool
    physical_altercation: bool

    # Raw
    answers: dict                       # {q_number: text}
    full_caption: str


_RUN_ID_RE = re.compile(r"^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$")


def _parse_run_started_at(run_id: str) -> Optional[str]:
    """run_id is YYYYMMDDTHHMMSSZ; convert to ISO 8601 UTC."""
    if not run_id:
        return None
    m = _RUN_ID_RE.match(run_id)
    if not m:
        return None
    y, mo, d, h, mi, s = (int(x) for x in m.groups())
    try:
        return datetime(y, mo, d, h, mi, s, tzinfo=timezone.utc).isoformat()
    except ValueError:
        return None


def _parse_capture_time(filename: str) -> Optional[str]:
    m = _FILENAME_TS_RE.search(filename)
    if not m:
        return None
    mm, dd, yyyy, h, mi, ss, ampm = m.groups()
    hour = int(h) % 12
    if ampm.lower() == "pm":
        hour += 12
    try:
        dt = datetime(int(yyyy), int(mm), int(dd), hour, int(mi), int(ss))
    except ValueError:
        return None
    return dt.isoformat()


# Known camera-vendor prefixes that are noise in the human label. Add new
# prefixes here as more feeds come online instead of patching the regex.
_FEED_PREFIXES = (
    "mdn80i_b_verkada_",
)


def _humanize_feed(feed_id: str) -> str:
    s = feed_id
    for pfx in _FEED_PREFIXES:
        if s.startswith(pfx):
            s = s[len(pfx):]
            break
    s = s.replace("_", " ").strip()
    return s.title()


def _map_location(feed_id: str) -> Optional[str]:
    fid = feed_id.lower()
    for token, loc_id in _FEED_TO_LOCATION:
        if token in fid:
            return loc_id
    return None


def _parse_answers(caption: str) -> dict[int, str]:
    out: dict[int, str] = {}
    for line in caption.splitlines():
        line = line.strip()
        if not line:
            continue
        if _SECTION_RE.match(line):
            continue
        m = _ANSWER_RE.match(line)
        if m:
            out[int(m.group(1))] = m.group(2).strip()
    return out


def _yes(text: str) -> bool:
    """True if the answer starts with 'Yes' (case-insensitive) and is not negated."""
    if not text:
        return False
    t = text.strip().lower()
    if t.startswith("no") or t.startswith("not applicable") or t.startswith("none") or t.startswith("zero"):
        return False
    if t.startswith("yes"):
        return True
    return False


# Positive-keyword patterns per flag domain. Each is matched on the answer
# text. When the answer does NOT start with "Yes" / "No", we fall back to
# checking whether any positive keyword appears in a non-negated sentence.
_POSITIVE_KW = {
    "weapons":     re.compile(r"\b(weapon|firearm|gun|knife|pistol|rifle|blade|brandish|stab|dangerous object)\w*\b", re.I),
    "medical":     re.compile(r"\b(unconscious|convulsing|seizure|cardiac|medical emergency|chest pain|collapsed|incapacitated)\b", re.I),
    "fire":        re.compile(r"\b(smoke|flames?|fires?|burning|chemical spill|downed (?:power|powerline)|powerlines? down)\b", re.I),
    "altercation": re.compile(r"\b(fight|brawl|assault|punch|strike|grapple|altercation|attack|robbery|wrestling|pushing)\b", re.I),
    "fallen":      re.compile(r"\b(fallen|lying on the ground|collapsed|prone|on the floor|incapacitated)\b", re.I),
    "threat":      re.compile(r"\b(threat|hazard|imminent (?:danger|risk))\b", re.I),
    "children":    re.compile(r"\b(unsupervised|unattended|alone) (?:child|children|minor|kid)s?\b", re.I),
    "luggage":     re.compile(r"\b(unattended (?:luggage|bag|package|item|object))\b", re.I),
}
# Negation marker — if present in the same answer text alongside a positive
# keyword, we treat the answer as negative ("no weapons visible").
_NEGATION_RE = re.compile(r"\b(no|not|none|zero|without|absence|absent)\b", re.I)


def _flag_yes(text: Optional[str], positive_re) -> bool:
    """Looser positive-flag detector.

    Returns True if:
      • the answer literally starts with 'Yes' / 'Yes,' / 'Yes.', OR
      • a domain-specific positive keyword appears AND the sentence has no
        negation marker (e.g. 'A weapon is visible in frame.').
    Returns False on 'No / Not / Zero / Not applicable' prefixes."""
    if not text:
        return False
    t = text.strip()
    low = t.lower()
    if low.startswith(("not applicable", "n/a", "no", "none", "zero")):
        return False
    if low.startswith("yes"):
        return True
    if positive_re.search(t) and not _NEGATION_RE.search(t):
        return True
    return False


def _flag_any(answers: dict[int, str], qs: list[int], positive_re) -> bool:
    return any(_flag_yes(answers.get(n), positive_re) for n in qs)


# Word-boundary tier matchers. Without \b, "HIGH" matches "NEIGHBORHOOD"
# and "DENSE" matches "MODERATELY DENSE" before the MODERATE branch fires.
_DENSITY_PATTERNS = [
    ("MODERATE", re.compile(r"\bMODERATE(?:LY)?\b")),
    ("DENSE",    re.compile(r"\bDENSE(?:LY)?\b")),
    ("SPARSE",   re.compile(r"\bSPARSE(?:LY)?\b")),
]

# Risk: MEDIUM and MODERATE collapse to the canonical "MODERATE" band so the
# frontend doesn't need to merge them.
_RISK_PATTERNS = [
    ("HIGH",     re.compile(r"\bHIGH\b")),
    ("MODERATE", re.compile(r"\b(?:MODERATE|MEDIUM)\b")),
    ("LOW",      re.compile(r"\bLOW\b")),
]


def _density(text: str) -> Optional[str]:
    if not text:
        return None
    t = text.upper()
    for label, pat in _DENSITY_PATTERNS:
        if pat.search(t):
            return label
    return None


def _risk(text: str) -> Optional[str]:
    if not text:
        return None
    t = text.upper()
    for label, pat in _RISK_PATTERNS:
        if pat.search(t):
            return label
    return None


_PED_COUNT_PATTERNS = [
    (re.compile(r"\bzero\b", re.I), 0),
    (re.compile(r"\bno (pedestrian|individual|people|person|crowd)", re.I), 0),
]


def _ped_count(text: str) -> Optional[int]:
    if not text:
        return None
    for pat, val in _PED_COUNT_PATTERNS:
        if pat.search(text):
            return val
    m = re.search(r"(?:approximately\s+)?(\d+)\s+(?:pedestrian|individual|person|attendee|people)", text, re.I)
    if m:
        return int(m.group(1))
    m = re.search(r"^(\d+)", text.strip())
    if m:
        try:
            n = int(m.group(1))
            if 0 <= n <= 100000:
                return n
        except ValueError:
            pass
    return None


def _parse_row(row: dict, idx: int) -> Optional[VlmObservation]:
    file_name = (row.get("file_name") or "").strip()
    minio_key = (row.get("minio_key") or "").strip()
    if not minio_key and not file_name:
        return None
    feed_id = minio_key.split("/")[0] if "/" in minio_key else (file_name.rsplit("_", 1)[0] if file_name else "unknown")
    full_caption = row.get("full_caption") or ""
    answers = _parse_answers(full_caption)

    captured = _parse_capture_time(file_name)
    started_at = (row.get("started_at") or "").strip() or None
    total = row.get("total_seconds")
    try:
        total_f = float(total) if total else None
    except ValueError:
        total_f = None

    run_id_val = (row.get("run_id") or "").strip()
    return VlmObservation(
        id=f"{run_id_val}-{idx:06d}",
        run_id=run_id_val,
        run_started_at=_parse_run_started_at(run_id_val),
        feed_id=feed_id,
        feed_label=_humanize_feed(feed_id),
        location_id=_map_location(feed_id),
        image_name=file_name,
        captured_at=captured,
        processed_at=started_at,
        preset=(row.get("preset") or "").strip(),
        model=(row.get("model") or "").strip(),
        total_seconds=total_f,
        pedestrian_count=_ped_count(answers.get(3, "")),
        density_zone=_density(answers.get(2, "")),
        risk_level=_risk(answers.get(6, "")),
        has_imminent_threat=_flag_any(answers, [16, 20], _POSITIVE_KW["threat"]),
        weapons_visible=_flag_any(answers, [18, 26], _POSITIVE_KW["weapons"]),
        medical_emergency=_flag_any(answers, [25], _POSITIVE_KW["medical"]),
        fire_smoke=_flag_any(answers, [22, 23], _POSITIVE_KW["fire"]),
        fallen_person=_flag_any(answers, [28], _POSITIVE_KW["fallen"]),
        unsupervised_children=_flag_any(answers, [13, 14], _POSITIVE_KW["children"]),
        physical_altercation=_flag_any(answers, [24, 27], _POSITIVE_KW["altercation"]),
        answers=answers,
        full_caption=full_caption,
    )


_OBSERVATIONS: list[VlmObservation] = []
_BY_ID: dict[str, VlmObservation] = {}
_LOAD_INFO: dict = {"loaded_at": None, "files": [], "row_count": 0}
# Aggregates derived from _OBSERVATIONS. Rebuilt inside the load lock so
# read endpoints (which run thousands of times more often than reloads)
# never re-iterate the full dataset.
_RUNS_SUMMARY:  list[dict] = []
_FEEDS_SUMMARY: list[dict] = []
_AGGREGATES:    dict       = {"hour_risk": [], "feed_density": [], "daily_dense": []}
_STATS_SUMMARY: dict       = {
    "total": 0, "feeds": 0, "runs": 0, "with_pedestrians": 0,
    "imminent_threats": 0, "weapons": 0, "medical": 0, "fire_smoke": 0,
    "density": {}, "risk": {}, "loaded_at": None,
}
# Serialize reloads (sync route may be called concurrently) and protect
# the atomic snapshot swap from readers.
_LOAD_LOCK = threading.Lock()


def load_all() -> dict:
    """Reload all VLM CSVs from backend/data/ into memory.

    Serialized via _LOAD_LOCK so concurrent reload calls don't half-overwrite
    the global snapshot. Readers always see a fully-populated snapshot.
    """
    global _OBSERVATIONS, _BY_ID, _LOAD_INFO
    global _RUNS_SUMMARY, _FEEDS_SUMMARY, _AGGREGATES, _STATS_SUMMARY
    rows: list[VlmObservation] = []
    files: list[dict] = []
    if os.path.isdir(DATA_DIR):
        for fn in sorted(os.listdir(DATA_DIR)):
            if not fn.lower().endswith(".csv"):
                continue
            path = os.path.join(DATA_DIR, fn)
            cnt = 0
            with open(path, newline="", encoding="utf-8") as fh:
                reader = csv.DictReader(fh)
                for row in reader:
                    obs = _parse_row(row, len(rows))
                    if obs:
                        rows.append(obs)
                        cnt += 1
            files.append({"name": fn, "rows": cnt})

    by_id = {o.id: o for o in rows}
    info = {
        "loaded_at": datetime.now(timezone.utc).isoformat(),
        "files": files,
        "row_count": len(rows),
    }
    runs        = _compute_runs_summary(rows)
    feeds       = _compute_feeds_summary(rows)
    aggregates_ = _compute_aggregates(rows)
    stats       = _compute_stats_summary(rows, info["loaded_at"])

    with _LOAD_LOCK:
        _OBSERVATIONS  = rows
        _BY_ID         = by_id
        _LOAD_INFO     = info
        _RUNS_SUMMARY  = runs
        _FEEDS_SUMMARY = feeds
        _AGGREGATES    = aggregates_
        _STATS_SUMMARY = stats
    return dict(info)


def all_observations() -> list[VlmObservation]:
    return _OBSERVATIONS


def get_observation(obs_id: str) -> Optional[VlmObservation]:
    """O(1) lookup by observation id."""
    return _BY_ID.get(obs_id)


def load_info() -> dict:
    return dict(_LOAD_INFO)


def to_summary(obs: VlmObservation) -> dict:
    d = asdict(obs)
    # Trim large fields for list responses
    d.pop("full_caption", None)
    d.pop("answers", None)
    return d


def to_detail(obs: VlmObservation) -> dict:
    d = asdict(obs)
    # answers is dict[int,str] but JSON keys must be strings
    d["answers"] = {str(k): v for k, v in obs.answers.items()}
    return d


# Risk threshold ordering. Parser canonicalizes MEDIUM→MODERATE, so MEDIUM
# is kept here only as an alias for callers that still send the old label.
RISK_ORDER = {"LOW": 0, "MODERATE": 1, "MEDIUM": 1, "HIGH": 2}


def _compute_runs_summary(rows: list[VlmObservation]) -> list[dict]:
    """Distinct batches (run_id) with row counts and feed counts."""
    by_run: dict[str, dict] = {}
    for o in rows:
        r = by_run.setdefault(o.run_id, {
            "run_id": o.run_id,
            "run_started_at": o.run_started_at,
            "count": 0,
            "feed_ids": set(),
        })
        r["count"] += 1
        r["feed_ids"].add(o.feed_id)
    out = []
    for r in by_run.values():
        out.append({
            "run_id": r["run_id"],
            "run_started_at": r["run_started_at"],
            "count": r["count"],
            "feeds": len(r["feed_ids"]),
        })
    return sorted(out, key=lambda r: r["run_started_at"] or "", reverse=True)


def _compute_feeds_summary(rows: list[VlmObservation]) -> list[dict]:
    by_feed: dict[str, dict] = {}
    for o in rows:
        f = by_feed.setdefault(o.feed_id, {
            "feed_id": o.feed_id,
            "feed_label": o.feed_label,
            "location_id": o.location_id,
            "count": 0,
            "threats": 0,
        })
        f["count"] += 1
        if o.has_imminent_threat or o.weapons_visible or o.fire_smoke or o.medical_emergency:
            f["threats"] += 1
    return sorted(by_feed.values(), key=lambda f: -f["count"])


def _compute_aggregates(rows: list[VlmObservation]) -> dict:
    """Pre-computed aggregates for VLM charts.

    Returns:
      hour_risk:    [{hour: 0..23, LOW, MODERATE, HIGH}]            (24 rows)
      feed_density: [{feed_id, feed_label, SPARSE, MODERATE, DENSE, total}]  (top 10)
      daily_dense:  [{date: 'YYYY-MM-DD', dense, total, share}]     (sorted)
    """
    hour_risk = [{"hour": h, "LOW": 0, "MODERATE": 0, "HIGH": 0} for h in range(24)]
    feed_density: dict[str, dict] = {}
    daily: dict[str, dict] = {}
    for o in rows:
        captured_dt: Optional[datetime] = None
        if o.captured_at:
            try:
                captured_dt = datetime.fromisoformat(o.captured_at)
            except ValueError:
                captured_dt = None

        if captured_dt is not None:
            tier = (o.risk_level or "LOW").upper()
            if tier in hour_risk[captured_dt.hour]:
                hour_risk[captured_dt.hour][tier] += 1

        if o.density_zone:
            f = feed_density.setdefault(o.feed_id, {
                "feed_id": o.feed_id,
                "feed_label": o.feed_label,
                "SPARSE": 0, "MODERATE": 0, "DENSE": 0, "total": 0,
            })
            f[o.density_zone] += 1
            f["total"] += 1

        if captured_dt is not None:
            day = captured_dt.date().isoformat()
            d = daily.setdefault(day, {"date": day, "dense": 0, "total": 0})
            d["total"] += 1
            if o.density_zone == "DENSE":
                d["dense"] += 1

    feeds_top = sorted(feed_density.values(), key=lambda f: -f["total"])[:10]
    daily_list = sorted(daily.values(), key=lambda d: d["date"])
    for d in daily_list:
        d["share"] = round(d["dense"] / d["total"], 4) if d["total"] else 0.0

    return {"hour_risk": hour_risk, "feed_density": feeds_top, "daily_dense": daily_list}


def _compute_stats_summary(rows: list[VlmObservation], loaded_at: Optional[str]) -> dict:
    n = len(rows)
    if not n:
        return {
            "total": 0, "feeds": 0, "runs": 0, "with_pedestrians": 0,
            "imminent_threats": 0, "weapons": 0, "medical": 0, "fire_smoke": 0,
            "density": {}, "risk": {}, "loaded_at": loaded_at,
        }
    density: dict[str, int] = {}
    risk: dict[str, int] = {}
    feeds: set[str] = set()
    runs:  set[str] = set()
    with_peds = threats = weapons = medical = fire = 0
    for o in rows:
        feeds.add(o.feed_id)
        if o.run_id:
            runs.add(o.run_id)
        if o.density_zone:
            density[o.density_zone] = density.get(o.density_zone, 0) + 1
        if o.risk_level:
            risk[o.risk_level] = risk.get(o.risk_level, 0) + 1
        if o.pedestrian_count and o.pedestrian_count > 0:
            with_peds += 1
        if o.has_imminent_threat:
            threats += 1
        if o.weapons_visible:
            weapons += 1
        if o.medical_emergency:
            medical += 1
        if o.fire_smoke:
            fire += 1
    return {
        "total": n, "feeds": len(feeds), "runs": len(runs),
        "with_pedestrians": with_peds,
        "imminent_threats": threats, "weapons": weapons, "medical": medical, "fire_smoke": fire,
        "density": density, "risk": risk,
        "loaded_at": loaded_at,
    }


# Public wrappers — return cached results refreshed by load_all().
def runs_summary() -> list[dict]:
    return _RUNS_SUMMARY


def feeds_summary() -> list[dict]:
    return _FEEDS_SUMMARY


def aggregates() -> dict:
    return _AGGREGATES


def stats_summary() -> dict:
    return _STATS_SUMMARY

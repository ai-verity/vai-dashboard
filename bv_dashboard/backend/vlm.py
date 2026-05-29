"""
VLM observation loader + parser.

Reads every *.csv in backend/data/, parses each row into a structured
observation with extracted fields (density, pedestrian count, risk
level, threat flags, etc.), and exposes lookup helpers used by the
/api/vlm/* endpoints.
"""

from __future__ import annotations

import csv
import json
import os
import re
import threading
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from typing import Optional

DATA_DIR = os.path.join(os.path.dirname(__file__), "data", "vlm_outputs")

# Filename suffix encoding capture time. Two formats in the wild:
#   ..._03-27-2026-01-09-40-pm.jpg   (legacy: MM-DD-YYYY-HH-MM-SS-am/pm)
#   ..._20260515T000000.jpg          (compact ISO: YYYYMMDDTHHMMSS[Z])
_FILENAME_TS_RE = re.compile(
    r"_(\d{2})-(\d{2})-(\d{4})-(\d{2})-(\d{2})-(\d{2})-(am|pm)\.jpg$",
    re.IGNORECASE,
)
_FILENAME_TS_ISO_RE = re.compile(
    r"_(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?\.jpg$",
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

    # Derived — crowd_behavior preset (None/False for non-crowd frames)
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

    # Derived — vehicle_prompts preset (None/False for non-vehicle frames)
    speeding: bool
    collision: bool
    near_miss_count: Optional[int]
    fire_lane_violation: bool
    erratic_maneuver: bool
    person_near_vehicle: bool
    vehicle_tamper: bool
    wrong_way: bool
    building_contact: bool
    no_plate_count: Optional[int]
    pedestrian_struck: bool              # Q15: actual strike (count > 0)
    pedestrian_near_miss: bool           # Q16: near-miss (count > 0)
    child_struck: bool                   # Q17: includes struck OR near-miss (prompt merges them)
    vehicle_description: Optional[str]   # Q13 text — e.g. "Gray SUV, white pickup truck"

    # Derived — illegal_dumping preset (None/False for non-dumping frames)
    dumping_present: bool                # actionable: Q1=Yes AND severity ≥ 2
    ordinance_violation: bool
    waste_type: Optional[str]            # household / construction / mixed / ...
    waste_volume: Optional[str]          # small / medium / large
    waste_origin: Optional[str]          # commercial / residential / unknown
    property_type: Optional[str]
    gutter_alley: bool                   # near gutter / parkway / half-alley
    water_proximity: bool                # near resaca / drainage / water
    chronic_site: bool
    severity: Optional[int]              # 1–5
    ordinance: Optional[str]             # Sec-46-45 / Sec-46-46
    priority: Optional[str]              # LOW / MEDIUM / HIGH
    dumping_summary: Optional[str]       # 1-line enforcement summary

    # Derived — license_plate preset (normalized from CSV preset
    # "vehicle_prompts_2"; None/False/0 for every other preset). The scalar
    # plate_* fields describe the single highest-confidence plate so the list
    # row / badges have something to show; the full per-frame `plates` and
    # `vehicles` lists ride along for the detail panel.
    plate_count: Optional[int]           # number of plates read in the frame
    plates_detected: bool                # plate_count > 0
    plate_text: Optional[str]            # best (highest-confidence) plate text
    plate_state: Optional[str]           # normalized 2-letter state (TX, CA, …)
    plate_type: Optional[str]            # standard / commercial / temporary / …
    plate_confidence: Optional[float]    # confidence of the best plate (0–1)
    vehicle_count: Optional[int]         # vehicles detected in the frame
    vehicle_make: Optional[str]          # primary vehicle make
    vehicle_model: Optional[str]         # primary vehicle model
    vehicle_color: Optional[str]         # primary vehicle color (primary tone)
    vehicle_body_style: Optional[str]    # primary vehicle body style (normalized)

    # Raw
    answers: dict                       # {q_number: text}
    full_caption: str
    # Structured LPR payload (license_plate preset only) — trimmed from list
    # responses by to_summary(), kept by to_detail().
    plates: list                        # [{plate_text, state, plate_type, confidence, vehicle_id}]
    vehicles: list                      # [{make, model, year_range, color, body_style, confidence}]


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
    if m:
        mm, dd, yyyy, h, mi, ss, ampm = m.groups()
        hour = int(h) % 12
        if ampm.lower() == "pm":
            hour += 12
        try:
            return datetime(int(yyyy), int(mm), int(dd), hour, int(mi), int(ss)).isoformat()
        except ValueError:
            return None
    m = _FILENAME_TS_ISO_RE.search(filename)
    if m:
        yyyy, mm, dd, h, mi, ss = m.groups()
        try:
            return datetime(int(yyyy), int(mm), int(dd), int(h), int(mi), int(ss)).isoformat()
        except ValueError:
            return None
    return None


# Known camera-vendor prefixes that are noise in the human label. Add new
# prefixes here as more feeds come online instead of patching the regex.
_FEED_PREFIXES = (
    "mdn80i_b_verkada_",
)

# Upstream-data spelling fixes applied during humanization (case-insensitive).
# Keep this map tight — we're correcting typos in feed names, not localizing.
# Use word-boundary regex so 'cemras' inside a longer token isn't misreplaced.
_FEED_TYPO_FIXES = (
    (re.compile(r"\bcemras\b", re.I),  "cameras"),
    (re.compile(r"\bcemra\b",  re.I),  "camera"),
)

# Pipeline-generated dataset folders are named `dataset_YYYYMMDD_HHMMSS`.
# We strip the time portion in the display label per product call — same-date
# datasets collide visually, but users disambiguate via the count column.
_DATASET_TS_RE = re.compile(r"^dataset_(\d{4})(\d{2})(\d{2})_\d{6}$", re.I)


def _humanize_feed(feed_id: str) -> str:
    m = _DATASET_TS_RE.match(feed_id)
    if m:
        y, mo, d = m.groups()
        return f"Dataset {y}-{mo}-{d}"
    s = feed_id
    for pfx in _FEED_PREFIXES:
        if s.startswith(pfx):
            s = s[len(pfx):]
            break
    s = s.replace("_", " ").strip()
    for pat, repl in _FEED_TYPO_FIXES:
        s = pat.sub(repl, s)
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
    """True if the answer starts with 'Yes' (case-insensitive) and is not negated.

    Negative prefixes need word boundaries so 'north', 'notable', 'nothing'
    aren't treated as 'no'. We accept 'no'/'no '/'no.'/'no,' but not 'no'
    followed by other letters.
    """
    if not text:
        return False
    t = text.strip().lower()
    if t == "no" or t.startswith(("no ", "no.", "no,")):
        return False
    if t.startswith(("not applicable", "none ", "none.", "none,", "zero ", "zero.", "zero,")) or t in ("none", "zero"):
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
    if low == "no" or low.startswith(("no ", "no.", "no,")):
        return False
    if low.startswith(("not applicable", "n/a", "none ", "none.", "none,", "zero ", "zero.", "zero,")) or low in ("none", "zero", "n/a"):
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


# ─── Vehicle prompt detectors ────────────────────────────────────────────────
# The vehicle_prompts preset uses a different question set (see
# data/vlm_vehicle_prompts.json). Most positive answers from the VLM start
# with "Yes"; counts (near-miss, no-plate, struck-count) are surfaced as
# integers when extractable, else None. "Not visible" / "No" map to False/None.

_VEHICLE_POSITIVE_KW = {
    "speeding":    re.compile(r"\b(speeding|above (?:the )?(?:posted )?(?:speed )?limit|excessive speed|exceeds? (?:the )?speed)\b", re.I),
    "collision":   re.compile(r"\b(collide|collision|struck|crashed|impact)\b", re.I),
    "fire_lane":   re.compile(r"\b(fire lane|emergency (?:access|corridor)|loading bay|no[- ]stopping zone)\b", re.I),
    "erratic":     re.compile(r"\b(erratic|reverse|unexpected (?:maneuver|movement)|pursuit|threatening manner)\b", re.I),
    "near_person": re.compile(r"\b(crouching|crawling|passing by|near (?:the )?vehicle)\b", re.I),
    "tamper":      re.compile(r"\b(tamper|forced entry|breaking into|prying|jimmy|inconsistent with normal entry)\b", re.I),
    "wrong_way":   re.compile(r"\b(wrong (?:direction|way)|restricted[- ]access|against (?:the )?traffic)\b", re.I),
    "building":    re.compile(r"\b(physical contact|driving alongside (?:a|the) building|parking (?:directly )?against|against (?:any|the|a) (?:building|obstruction))\b", re.I),
    "struck_ped":  re.compile(r"\b(struck|injured|hit by a vehicle|run over)\b", re.I),
    "struck_kid":  re.compile(r"\b(child|children|minor|kid)s?\b.*\b(struck|injured|hit|near[- ]miss)\b", re.I),
}


def _vehicle_yes(text: Optional[str], positive_re=None) -> bool:
    """Generic positive detector for vehicle prompts.

    True when the answer:
      • starts with "Yes" (case-insensitive), OR
      • contains a domain keyword with no negation in the same answer.
    "Not visible" / "No" / "None" / "Zero" → False.
    """
    if not text:
        return False
    t = text.strip()
    low = t.lower()
    if low.startswith(("not visible", "not applicable", "n/a", "no ", "no.", "no,", "none", "zero")) or low == "no":
        return False
    if low.startswith("yes"):
        return True
    if positive_re is not None and positive_re.search(t) and not _NEGATION_RE.search(t):
        return True
    return False


def _vehicle_count(text: Optional[str]) -> Optional[int]:
    """Extract a leading integer count; 'Not visible'/'None'/'Zero' → 0.

    Used for Q4 (near-miss count), Q11 (no-plate count), and pedestrian
    struck/near-miss counts (Q15/Q16/Q17).
    """
    if not text:
        return None
    t = text.strip()
    low = t.lower()
    if low.startswith(("not visible", "not applicable", "n/a")):
        return None
    if low.startswith(("none", "zero", "no ")) or low in ("no", "0"):
        return 0
    m = re.match(r"^(\d+)", t)
    if m:
        try:
            n = int(m.group(1))
            if 0 <= n <= 100000:
                return n
        except ValueError:
            return None
    m = re.search(r"(?:approximately\s+)?(\d+)\s+(?:vehicle|individual|person|pedestrian|child|children|near[- ]miss)", t, re.I)
    if m:
        return int(m.group(1))
    return None


# ─── Illegal-dumping detectors ───────────────────────────────────────────────
# The illegal_dumping preset emits "KEY: value" lines (not "1. answer"), so it
# needs a different parser. We normalize each KEY into a q_number so the
# frontend's existing per-prompt accordion (which looks up answers[q_num])
# works unchanged.

_DUMPING_KEY_RE = re.compile(r"^([A-Z][A-Z &/]+):\s*(.*)$")
_DUMPING_KEY_TO_Q = {
    "DUMPING PRESENT":     1,
    "ORDINANCE VIOLATION": 2,
    "WASTE TYPE":          3,
    "WASTE VOLUME":        4,
    "WASTE ORIGIN":        5,
    "PROPERTY TYPE":       6,
    "ADDRESS MARKERS":     7,
    "GUTTER/ALLEY":        8,
    "WATER PROXIMITY":     9,
    "CHRONIC SITE":        10,
    "VEHICLES":            11,
    "IDENTIFIERS":         12,
    "SEVERITY":            13,
    "ORDINANCE":           14,
    "PRIORITY":            15,
    "SUMMARY":             16,
}


def _parse_dumping_answers(caption: str) -> dict[int, str]:
    """Parse 'KEY: value' lines into a q_number → text dict.

    Lines with unknown keys are skipped — keeps the answers dict tight
    so the frontend's per-prompt loop doesn't have to defend against junk.
    """
    out: dict[int, str] = {}
    for line in caption.splitlines():
        line = line.strip()
        if not line:
            continue
        m = _DUMPING_KEY_RE.match(line)
        if not m:
            continue
        key, val = m.group(1).strip(), m.group(2).strip()
        q = _DUMPING_KEY_TO_Q.get(key)
        if q is not None and val:
            out[q] = val
    return out


def _is_yes(text: Optional[str]) -> bool:
    """True for any answer starting with 'Yes' (case-insensitive)."""
    if not text:
        return False
    return text.strip().lower().startswith("yes")


def _clean_value(text: Optional[str]) -> Optional[str]:
    """Trim and drop placeholder responses ('none', 'not visible', ...).

    Strips wrapping punctuation like '<…>' or '(…)' before classifying AND
    before returning, so '<none detected>' is rejected and a real value
    like '<3 bags>' returns as '3 bags' (not the bracketed original).
    """
    if not text:
        return None
    t = text.strip()
    if not t:
        return None
    stripped = re.sub(r"^[<\[(\s]+|[>\])\s]+$", "", t).strip()
    if not stripped:
        return None
    low = stripped.lower()
    if low in ("none", "no", "not visible", "not applicable", "n/a", "unknown"):
        return None
    if low.startswith(("not visible", "not applicable", "no ", "none ", "none.", "none detected")):
        return None
    return stripped[:160]


def _parse_severity(text: Optional[str]) -> Optional[int]:
    """Pull a 1–5 integer out of the SEVERITY answer."""
    if not text:
        return None
    m = re.search(r"\b([1-5])\b", text)
    if m:
        return int(m.group(1))
    return None


_PRIORITY_RE = re.compile(r"\b(LOW|MEDIUM|HIGH)\b", re.I)
_ORDINANCE_RE = re.compile(r"\bSec[.\- ]?\s?(46[\- ]?4[56])\b", re.I)


def _parse_priority(text: Optional[str]) -> Optional[str]:
    if not text:
        return None
    m = _PRIORITY_RE.search(text)
    if m:
        return m.group(1).upper()
    return None


def _parse_ordinance(text: Optional[str]) -> Optional[str]:
    """Canonicalize ordinance string to 'Sec-46-45' / 'Sec-46-46'."""
    if not text:
        return None
    m = _ORDINANCE_RE.search(text)
    if m:
        digits = re.sub(r"[^0-9]", "", m.group(1))
        if len(digits) == 4:
            return f"Sec-{digits[:2]}-{digits[2:]}"
    return None


def _vehicle_desc(text: Optional[str]) -> Optional[str]:
    """Q13 free-form vehicle description ('Gray SUV, white pickup, ...').

    Filtered: drop 'Not visible' / 'None' so the UI can show '—' instead of
    a confusing phrase.
    """
    if not text:
        return None
    t = text.strip()
    if not t:
        return None
    low = t.lower()
    if low.startswith(("not visible", "not applicable", "n/a", "none", "no ", "no.")):
        return None
    return t[:200]  # cap to keep the JSON wire small


# Vehicle nouns we count when parsing Q13 free text. Order matters only
# for the duplicate-suppression below — longer compounds first so
# "pickup truck" doesn't double-count as pickup + truck.
_VEHICLE_NOUN_RE = re.compile(
    r"\b(pickup truck|tractor[- ]trailer|box truck|tow truck|"
    r"truck|sedan|suv|van|pickup|motorcycle|bicycle|bus|coupe|"
    r"hatchback|jeep|crossover|minivan|cab|vehicle|car)\b",
    re.I,
)


def _count_vehicles_in_desc(desc: Optional[str]) -> int:
    """Estimate the number of vehicles described in a Q13 text.

    Counts non-overlapping vehicle-noun mentions (with two-word compounds
    matched as a single unit so 'pickup truck' is 1, not 2). Returns 0
    when the description is None or the parser couldn't find any
    vehicle-shaped tokens — that's intentional, because the per-frame
    aggregator uses 0 to mean 'no count to attribute to this frame'.
    """
    if not desc:
        return 0
    matches = _VEHICLE_NOUN_RE.findall(desc)
    return len(matches)


# ─── License-plate preset (CSV preset "vehicle_prompts_2") ──────────────────
# Its full_caption is a JSON blob, not the numbered Q&A / KEY:value formats the
# other presets use:
#   {"analysis": {"license_plates": [...], "vehicles": [...], "vehicle_count": N}}
# usually wrapped in a ```json … ``` fence. We normalize this preset to the
# canonical key "license_plate" so the API/UI key off a readable value.
_LPR_PRESET_RAW = "vehicle_prompts_2"
_LPR_PRESET = "license_plate"
_JSON_FENCE_RE = re.compile(r"```(?:json)?\s*(.*?)\s*```", re.S | re.I)

# Generic minio_key container dirs that don't identify a camera; when a frame
# sits under one, the real feed is recovered from the filename instead.
_GENERIC_KEY_DIRS = {"input_data", "frames"}


def _feed_from_filename(file_name: str) -> str:
    """Recover the camera/feed id by stripping the trailing capture-time token
    from a frame filename, e.g.
    'international_and_washington_1_03-27-2026-02-10-48-am.jpg'
    → 'international_and_washington_1'.
    """
    s = _FILENAME_TS_RE.sub("", file_name)
    s = _FILENAME_TS_ISO_RE.sub("", s)
    if s.lower().endswith(".jpg"):
        s = s[:-4]
    return s.strip("_ ") or "unknown"

# US state names → 2-letter codes. The model emits a mix of full names, codes
# and junk ("null"/None); unrecognized values pass through (uppercased if short)
# so a real-but-unmapped value still groups consistently.
_STATE_MAP = {
    "texas": "TX", "california": "CA", "new york": "NY", "west virginia": "WV",
    "arizona": "AZ", "new mexico": "NM", "florida": "FL", "louisiana": "LA",
    "oklahoma": "OK", "colorado": "CO", "nevada": "NV",
}


def _norm_plate_state(val) -> Optional[str]:
    if not isinstance(val, str):
        return None
    s = val.strip()
    if not s or s.lower() in ("null", "none", "unknown", "n/a"):
        return None
    key = s.lower()
    if key in _STATE_MAP:
        return _STATE_MAP[key]
    if len(s) <= 3:           # already a code (TX) — normalize case
        return s.upper()
    return s.title()


def _norm_body_style(val) -> Optional[str]:
    if not isinstance(val, str):
        return None
    s = val.strip().lower().replace("_", " ")
    if not s or s in ("null", "none", "unknown"):
        return None
    return s


def _lpr_clean_str(val) -> Optional[str]:
    if not isinstance(val, str):
        return None
    s = val.strip()
    if not s or s.lower() in ("null", "none"):
        return None
    return s


def _parse_lpr_caption(full_caption: str) -> dict:
    """Parse the JSON full_caption of a license_plate frame.

    Returns {"plates": [...], "vehicles": [...], "vehicle_count": int}, with
    empty lists on any parse failure (~30% of rows the model emits are
    truncated / non-JSON).
    """
    empty = {"plates": [], "vehicles": [], "vehicle_count": 0}
    if not full_caption:
        return empty
    text = full_caption.strip()
    m = _JSON_FENCE_RE.search(text)
    if m:
        text = m.group(1)
    try:
        data = json.loads(text)
    except (ValueError, TypeError):
        return empty
    analysis = data.get("analysis", data) if isinstance(data, dict) else {}
    if not isinstance(analysis, dict):
        return empty
    raw_plates = analysis.get("license_plates") or []
    raw_vehicles = analysis.get("vehicles") or []

    plates = []
    for lp in raw_plates:
        if not isinstance(lp, dict):
            continue
        text_v = _lpr_clean_str(lp.get("plate_text"))
        if not text_v:                       # keep only plates with real text
            continue
        conf = lp.get("confidence")
        plates.append({
            "plate_text": text_v,
            "state": _norm_plate_state(lp.get("state")),
            "plate_type": _lpr_clean_str(lp.get("plate_type")),
            "confidence": float(conf) if isinstance(conf, (int, float)) else None,
            "vehicle_id": lp.get("vehicle_id"),
        })

    vehicles = []
    for v in raw_vehicles:
        if not isinstance(v, dict):
            continue
        color = v.get("color")
        if isinstance(color, dict):
            color_primary = _lpr_clean_str(color.get("primary")) or _lpr_clean_str(color.get("full_description"))
        else:
            color_primary = _lpr_clean_str(color)
        vehicles.append({
            "make": _lpr_clean_str(v.get("make")),
            "model": _lpr_clean_str(v.get("model")),
            "year_range": _lpr_clean_str(v.get("year_range")),
            "color": color_primary,
            "body_style": _norm_body_style(v.get("body_style")),
        })

    vc = analysis.get("vehicle_count")
    vehicle_count = vc if isinstance(vc, int) else len(vehicles)
    return {"plates": plates, "vehicles": vehicles, "vehicle_count": vehicle_count}


def _parse_row(row: dict, idx: int) -> Optional[VlmObservation]:
    file_name = (row.get("file_name") or "").strip()
    minio_key = (row.get("minio_key") or "").strip()
    if not minio_key and not file_name:
        return None
    full_caption = row.get("full_caption") or ""
    preset = (row.get("preset") or "").strip()
    # Feed id is normally the leading minio_key directory (the camera folder).
    # The license_plate dataset instead nests every frame under a generic
    # `input_data/frames/` prefix and encodes the real camera in the filename,
    # so derive the feed from the filename for it (also unlocks location mapping).
    if preset == _LPR_PRESET_RAW or minio_key.split("/")[0] in _GENERIC_KEY_DIRS:
        feed_id = _feed_from_filename(file_name) if file_name else "unknown"
    else:
        feed_id = minio_key.split("/")[0] if "/" in minio_key else (file_name.rsplit("_", 1)[0] if file_name else "unknown")
    # Illegal-dumping captions use "KEY: value" lines; everything else uses
    # the numbered "1. answer" format. Picking the wrong parser would yield
    # an empty answers dict and silently blank the detail panel.
    if preset == "illegal_dumping":
        answers = _parse_dumping_answers(full_caption)
    else:
        answers = _parse_answers(full_caption)

    captured = _parse_capture_time(file_name)
    started_at = (row.get("started_at") or "").strip() or None
    total = row.get("total_seconds")
    try:
        total_f = float(total) if total else None
    except ValueError:
        total_f = None

    run_id_val = (row.get("run_id") or "").strip()
    is_vehicle = preset == "vehicle_prompts"
    is_dumping = preset == "illegal_dumping"
    is_lpr = preset == _LPR_PRESET_RAW

    # Crowd-behavior derived fields. Only crowd_behavior rows populate these;
    # other presets skip the crowd parsers (they'd misfire on prompts like
    # "Provide the color, make, and model", "SEVERITY: 3", or a JSON blob).
    if is_vehicle or is_dumping or is_lpr:
        pedestrian_count = None
        density_zone = None
        risk_level = None
        has_imminent_threat = False
        weapons_visible = False
        medical_emergency = False
        fire_smoke = False
        fallen_person = False
        unsupervised_children = False
        physical_altercation = False
    else:
        pedestrian_count = _ped_count(answers.get(3, ""))
        density_zone = _density(answers.get(2, ""))
        risk_level = _risk(answers.get(6, ""))
        has_imminent_threat = _flag_any(answers, [16, 20], _POSITIVE_KW["threat"])
        weapons_visible = _flag_any(answers, [18, 26], _POSITIVE_KW["weapons"])
        medical_emergency = _flag_any(answers, [25], _POSITIVE_KW["medical"])
        fire_smoke = _flag_any(answers, [22, 23], _POSITIVE_KW["fire"])
        fallen_person = _flag_any(answers, [28], _POSITIVE_KW["fallen"])
        unsupervised_children = _flag_any(answers, [13, 14], _POSITIVE_KW["children"])
        physical_altercation = _flag_any(answers, [24, 27], _POSITIVE_KW["altercation"])

    # Vehicle-prompts derived fields. Conversely, crowd_behavior frames
    # don't carry these — they stay False/None.
    if is_vehicle:
        speeding = _vehicle_yes(answers.get(2), _VEHICLE_POSITIVE_KW["speeding"])
        collision = _vehicle_yes(answers.get(3), _VEHICLE_POSITIVE_KW["collision"])
        near_miss_count = _vehicle_count(answers.get(4))
        fire_lane_violation = _vehicle_yes(answers.get(5), _VEHICLE_POSITIVE_KW["fire_lane"])
        erratic_maneuver = _vehicle_yes(answers.get(6), _VEHICLE_POSITIVE_KW["erratic"])
        person_near_vehicle = _vehicle_yes(answers.get(7), _VEHICLE_POSITIVE_KW["near_person"])
        vehicle_tamper = _vehicle_yes(answers.get(8), _VEHICLE_POSITIVE_KW["tamper"])
        wrong_way = _vehicle_yes(answers.get(9), _VEHICLE_POSITIVE_KW["wrong_way"])
        building_contact = _vehicle_yes(answers.get(10), _VEHICLE_POSITIVE_KW["building"])
        no_plate_count = _vehicle_count(answers.get(11))
        ped_struck_count = _vehicle_count(answers.get(15)) or 0
        ped_near_miss_count = _vehicle_count(answers.get(16)) or 0
        pedestrian_struck = ped_struck_count > 0
        pedestrian_near_miss = ped_near_miss_count > 0
        child_struck_count = _vehicle_count(answers.get(17)) or 0
        child_struck = child_struck_count > 0
        vehicle_description = _vehicle_desc(answers.get(13))
    else:
        speeding = False
        collision = False
        near_miss_count = None
        fire_lane_violation = False
        erratic_maneuver = False
        person_near_vehicle = False
        vehicle_tamper = False
        wrong_way = False
        building_contact = False
        no_plate_count = None
        pedestrian_struck = False
        pedestrian_near_miss = False
        child_struck = False
        vehicle_description = None

    # Illegal-dumping derived fields.
    if is_dumping:
        # Severity is computed first so dumping_present can gate on it.
        severity = _parse_severity(answers.get(13))
        # `dumping_present` is the dashboard's "actionable dumping" signal:
        # Q1 raw answer is "Yes" AND the model rated severity ≥ 2. This drops
        # the model's frequent sev=1 / priority=LOW noise (single piece of
        # trash, minor street litter) that historically inflated the count
        # by ~10% without representing a real enforcement target. The raw
        # Q1 text is still in answers[1] if anyone wants to inspect it.
        dumping_present = _is_yes(answers.get(1)) and (severity or 0) >= 2
        ordinance_violation = _is_yes(answers.get(2))
        waste_type = _clean_value(answers.get(3))
        waste_volume = _clean_value(answers.get(4))
        waste_origin = _clean_value(answers.get(5))
        property_type = _clean_value(answers.get(6))
        gutter_alley = _is_yes(answers.get(8))
        water_proximity = _is_yes(answers.get(9))
        chronic_site = _is_yes(answers.get(10))
        ordinance = _parse_ordinance(answers.get(14))
        priority = _parse_priority(answers.get(15))
        dumping_summary = _clean_value(answers.get(16))
    else:
        dumping_present = False
        ordinance_violation = False
        waste_type = None
        waste_volume = None
        waste_origin = None
        property_type = None
        gutter_alley = False
        water_proximity = False
        chronic_site = False
        severity = None
        ordinance = None
        priority = None
        dumping_summary = None

    # License-plate derived fields. The JSON caption carries every plate and
    # vehicle in the frame; we surface the highest-confidence plate as the
    # scalar plate_* fields and the first vehicle as the primary vehicle_*.
    if is_lpr:
        lpr = _parse_lpr_caption(full_caption)
        plates = lpr["plates"]
        vehicles = lpr["vehicles"]
        vehicle_count = lpr["vehicle_count"]
        plate_count = len(plates)
        plates_detected = plate_count > 0
        if plates:
            best = max(plates, key=lambda p: p["confidence"] or 0.0)
            plate_text = best["plate_text"]
            plate_state = best["state"]
            plate_type = best["plate_type"]
            plate_confidence = best["confidence"]
        else:
            plate_text = plate_state = plate_type = None
            plate_confidence = None
        if vehicles:
            v0 = vehicles[0]
            vehicle_make = v0["make"]
            vehicle_model = v0["model"]
            vehicle_color = v0["color"]
            vehicle_body_style = v0["body_style"]
        else:
            vehicle_make = vehicle_model = vehicle_color = vehicle_body_style = None
    else:
        plates = []
        vehicles = []
        plate_count = None
        plates_detected = False
        plate_text = plate_state = plate_type = None
        plate_confidence = None
        vehicle_count = None
        vehicle_make = vehicle_model = vehicle_color = vehicle_body_style = None

    # Normalize the LPR preset's raw CSV value ("vehicle_prompts_2") to the
    # canonical key the API/UI filter on.
    out_preset = _LPR_PRESET if is_lpr else preset

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
        preset=out_preset,
        model=(row.get("model") or "").strip(),
        total_seconds=total_f,
        pedestrian_count=pedestrian_count,
        density_zone=density_zone,
        risk_level=risk_level,
        has_imminent_threat=has_imminent_threat,
        weapons_visible=weapons_visible,
        medical_emergency=medical_emergency,
        fire_smoke=fire_smoke,
        fallen_person=fallen_person,
        unsupervised_children=unsupervised_children,
        physical_altercation=physical_altercation,
        speeding=speeding,
        collision=collision,
        near_miss_count=near_miss_count,
        fire_lane_violation=fire_lane_violation,
        erratic_maneuver=erratic_maneuver,
        person_near_vehicle=person_near_vehicle,
        vehicle_tamper=vehicle_tamper,
        wrong_way=wrong_way,
        building_contact=building_contact,
        no_plate_count=no_plate_count,
        pedestrian_struck=pedestrian_struck,
        pedestrian_near_miss=pedestrian_near_miss,
        child_struck=child_struck,
        vehicle_description=vehicle_description,
        dumping_present=dumping_present,
        ordinance_violation=ordinance_violation,
        waste_type=waste_type,
        waste_volume=waste_volume,
        waste_origin=waste_origin,
        property_type=property_type,
        gutter_alley=gutter_alley,
        water_proximity=water_proximity,
        chronic_site=chronic_site,
        severity=severity,
        ordinance=ordinance,
        priority=priority,
        dumping_summary=dumping_summary,
        plate_count=plate_count,
        plates_detected=plates_detected,
        plate_text=plate_text,
        plate_state=plate_state,
        plate_type=plate_type,
        plate_confidence=plate_confidence,
        vehicle_count=vehicle_count,
        vehicle_make=vehicle_make,
        vehicle_model=vehicle_model,
        vehicle_color=vehicle_color,
        vehicle_body_style=vehicle_body_style,
        answers=answers,
        full_caption=full_caption,
        plates=plates,
        vehicles=vehicles,
    )


_OBSERVATIONS: list[VlmObservation] = []
_BY_ID: dict[str, VlmObservation] = {}
_LOAD_INFO: dict = {"loaded_at": None, "files": [], "row_count": 0}
# Aggregates derived from _OBSERVATIONS. Rebuilt inside the load lock so
# read endpoints (which run thousands of times more often than reloads)
# never re-iterate the full dataset.
_RUNS_SUMMARY:  list[dict] = []
_FEEDS_SUMMARY: list[dict] = []
_AGGREGATES:    dict       = {
    "hour_risk": [], "feed_density": [], "daily_dense": [],
    "vehicle_hour_issue": [], "vehicle_feed_issue": [], "vehicle_daily_collision": [],
    "dumping_severity": [], "dumping_waste_type": [],
    "dumping_feed": [], "dumping_daily": [],
    "plate_confidence": [], "plate_feed": [], "plate_daily": [],
}
_STATS_SUMMARY: dict       = {
    "total": 0, "feeds": 0, "runs": 0, "with_pedestrians": 0,
    "imminent_threats": 0, "weapons": 0, "medical": 0, "fire_smoke": 0,
    "density": {}, "risk": {}, "loaded_at": None,
    "presets": {}, "vehicle": {}, "dumping": {},
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
    d.pop("plates", None)
    d.pop("vehicles", None)
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
            "presets": {},
        })
        f["count"] += 1
        if o.preset:
            f["presets"][o.preset] = f["presets"].get(o.preset, 0) + 1
        if (
            o.has_imminent_threat or o.weapons_visible or o.fire_smoke or o.medical_emergency
            or o.collision or o.pedestrian_struck or o.pedestrian_near_miss or o.child_struck
            or o.dumping_present
        ):
            f["threats"] += 1
    return sorted(by_feed.values(), key=lambda f: -f["count"])


# Group threat/event flags into a small set of "incident types" suitable
# for a stacked-by-month chart. Each predicate returns True when the
# observation flags at least one signal in that group. A single
# observation can match multiple groups — that's intentional, since a
# fire + collision frame should appear in both buckets.
_INCIDENT_TYPE_GROUPS: list[tuple[str, str]] = [
    ("Threat/Weapon",     "threat_weapon"),
    ("Medical",           "medical"),
    ("Fire/Smoke",        "fire_smoke"),
    ("Crowd Safety",      "crowd_safety"),
    ("Collision",         "collision"),
    ("Traffic Violation", "traffic_violation"),
    ("Property Damage",   "property_damage"),
    ("Illegal Dumping",   "illegal_dumping"),
]


def _matches_type(obs: VlmObservation, key: str) -> bool:
    if key == "threat_weapon":
        return obs.has_imminent_threat or obs.weapons_visible
    if key == "medical":
        return obs.medical_emergency
    if key == "fire_smoke":
        return obs.fire_smoke
    if key == "crowd_safety":
        return obs.fallen_person or obs.unsupervised_children or obs.physical_altercation
    if key == "collision":
        return obs.collision or obs.pedestrian_struck or obs.child_struck
    if key == "traffic_violation":
        return obs.speeding or obs.fire_lane_violation or obs.wrong_way or obs.erratic_maneuver
    if key == "property_damage":
        return obs.vehicle_tamper or obs.building_contact
    if key == "illegal_dumping":
        return obs.dumping_present
    return False


def _is_actionable(obs: VlmObservation) -> bool:
    """True when the observation flagged at least one actionable event.
    Used by the location/period aggregator to filter "incidents" out of
    the broader observation stream."""
    return any(_matches_type(obs, key) for _, key in _INCIDENT_TYPE_GROUPS)


def _compute_aggregates(rows: list[VlmObservation]) -> dict:
    """Pre-computed aggregates for VLM charts.

    Crowd aggregates only look at crowd_behavior rows; vehicle aggregates
    only look at vehicle_prompts rows. Mixing them would make the charts
    meaningless (vehicle frames have no density/risk; crowd frames have
    no collision/speeding signal).

    Returns:
      hour_risk:               [{hour, LOW, MODERATE, HIGH}]
      feed_density:            [{feed_id, feed_label, SPARSE, MODERATE, DENSE, total}]
      daily_dense:             [{date, dense, total, share}]
      vehicle_hour_issue:      [{hour, collisions, speeding, fire_lane}]
      vehicle_feed_issue:      [{feed_id, feed_label, collisions, speeding, fire_lane,
                                 other, total}]
      vehicle_daily_collision: [{date, collisions, total, share}]
      monthly_by_type:         [{month, <type1>, <type2>, …}] — counts per
                                "incident type" per calendar month
      weekly_by_location:      {buckets, locations, data}
      monthly_by_location:     {buckets, locations, data}
    """
    hour_risk = [{"hour": h, "LOW": 0, "MODERATE": 0, "HIGH": 0} for h in range(24)]
    veh_hour = [{"hour": h, "collisions": 0, "speeding": 0, "fire_lane": 0} for h in range(24)]
    feed_density: dict[str, dict] = {}
    veh_feed: dict[str, dict] = {}
    daily: dict[str, dict] = {}
    veh_daily: dict[str, dict] = {}
    # Illegal-dumping aggregates.
    dmp_severity = [{"severity": s, "count": 0} for s in (1, 2, 3, 4, 5)]
    dmp_waste: dict[str, int] = {}
    dmp_feed: dict[str, dict] = {}
    dmp_daily: dict[str, dict] = {}
    # License-plate aggregates.
    plate_conf_bands = [
        {"band": "<0.80", "lo": 0.0,  "hi": 0.80, "count": 0},
        {"band": "0.80–0.89", "lo": 0.80, "hi": 0.90, "count": 0},
        {"band": "0.90–0.94", "lo": 0.90, "hi": 0.95, "count": 0},
        {"band": "≥0.95", "lo": 0.95, "hi": 1.01, "count": 0},
    ]
    plate_feed: dict[str, dict] = {}
    plate_daily: dict[str, dict] = {}
    for o in rows:
        captured_dt: Optional[datetime] = None
        if o.captured_at:
            try:
                captured_dt = datetime.fromisoformat(o.captured_at)
            except ValueError:
                captured_dt = None

        is_vehicle = o.preset == "vehicle_prompts"
        is_dumping = o.preset == "illegal_dumping"
        is_lpr = o.preset == _LPR_PRESET

        if is_lpr:
            # Confidence distribution across every detected plate.
            for p in (o.plates or []):
                c = p.get("confidence")
                if c is None:
                    continue
                for band in plate_conf_bands:
                    if band["lo"] <= c < band["hi"]:
                        band["count"] += 1
                        break
            # Plates per feed (and frame totals for context).
            pf = plate_feed.setdefault(o.feed_id, {
                "feed_id": o.feed_id,
                "feed_label": o.feed_label,
                "plates": 0, "frames": 0,
            })
            pf["frames"] += 1
            pf["plates"] += (o.plate_count or 0)
            # Daily share of frames that carried at least one plate.
            if captured_dt is not None:
                day = captured_dt.date().isoformat()
                pd = plate_daily.setdefault(day, {"date": day, "with_plate": 0, "total": 0})
                pd["total"] += 1
                if o.plates_detected:
                    pd["with_plate"] += 1
        elif not is_vehicle and not is_dumping:
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
        elif is_vehicle:
            if captured_dt is not None:
                bucket = veh_hour[captured_dt.hour]
                if o.collision: bucket["collisions"] += 1
                if o.speeding: bucket["speeding"] += 1
                if o.fire_lane_violation: bucket["fire_lane"] += 1

            vf = veh_feed.setdefault(o.feed_id, {
                "feed_id": o.feed_id,
                "feed_label": o.feed_label,
                "collisions": 0, "speeding": 0, "fire_lane": 0, "other": 0, "total": 0,
            })
            vf["total"] += 1
            had_issue = False
            if o.collision: vf["collisions"] += 1; had_issue = True
            if o.speeding: vf["speeding"] += 1; had_issue = True
            if o.fire_lane_violation: vf["fire_lane"] += 1; had_issue = True
            if not had_issue and (
                o.erratic_maneuver or o.wrong_way or o.vehicle_tamper
                or o.building_contact or o.pedestrian_struck or o.pedestrian_near_miss or o.child_struck
            ):
                vf["other"] += 1

            if captured_dt is not None:
                day = captured_dt.date().isoformat()
                vd = veh_daily.setdefault(day, {"date": day, "collisions": 0, "total": 0})
                vd["total"] += 1
                if o.collision: vd["collisions"] += 1
        else:  # is_dumping
            if o.severity is not None and 1 <= o.severity <= 5:
                dmp_severity[o.severity - 1]["count"] += 1
            if o.waste_type:
                key = o.waste_type.lower()
                dmp_waste[key] = dmp_waste.get(key, 0) + 1

            df = dmp_feed.setdefault(o.feed_id, {
                "feed_id": o.feed_id,
                "feed_label": o.feed_label,
                "dumping": 0, "chronic": 0, "high_priority": 0, "total": 0,
            })
            df["total"] += 1
            if o.dumping_present: df["dumping"] += 1
            if o.chronic_site: df["chronic"] += 1
            if o.priority == "HIGH": df["high_priority"] += 1

            if captured_dt is not None:
                day = captured_dt.date().isoformat()
                dd = dmp_daily.setdefault(day, {"date": day, "dumping": 0, "total": 0})
                dd["total"] += 1
                if o.dumping_present: dd["dumping"] += 1

    feeds_top = sorted(feed_density.values(), key=lambda f: -f["total"])[:10]
    daily_list = sorted(daily.values(), key=lambda d: d["date"])
    for d in daily_list:
        d["share"] = round(d["dense"] / d["total"], 4) if d["total"] else 0.0

    veh_feeds_top = sorted(
        veh_feed.values(),
        key=lambda f: -(f["collisions"] + f["speeding"] + f["fire_lane"] + f["other"]),
    )[:10]
    veh_daily_list = sorted(veh_daily.values(), key=lambda d: d["date"])
    for d in veh_daily_list:
        d["share"] = round(d["collisions"] / d["total"], 4) if d["total"] else 0.0

    dmp_waste_top = sorted(
        ({"waste_type": k, "count": v} for k, v in dmp_waste.items()),
        key=lambda d: -d["count"],
    )[:10]
    dmp_feeds_top = sorted(
        dmp_feed.values(), key=lambda f: -f["dumping"],
    )[:10]
    dmp_daily_list = sorted(dmp_daily.values(), key=lambda d: d["date"])
    for d in dmp_daily_list:
        d["share"] = round(d["dumping"] / d["total"], 4) if d["total"] else 0.0

    plate_conf_out = [{"band": b["band"], "count": b["count"]} for b in plate_conf_bands]
    plate_feeds_top = sorted(plate_feed.values(), key=lambda f: -f["plates"])[:10]
    plate_daily_list = sorted(plate_daily.values(), key=lambda d: d["date"])
    for d in plate_daily_list:
        d["share"] = round(d["with_plate"] / d["total"], 4) if d["total"] else 0.0
    weekly_plates_by_location = _aggregate_plates_by_period_location(rows, "week")
    monthly_plates_by_location = _aggregate_plates_by_period_location(rows, "month")

    monthly_by_type = _aggregate_monthly_by_type(rows)
    weekly_by_location = _aggregate_by_period_location(rows, "week")
    monthly_by_location = _aggregate_by_period_location(rows, "month")
    weekly_people_by_location = _aggregate_people_by_period_location(rows, "week")
    monthly_people_by_location = _aggregate_people_by_period_location(rows, "month")
    weekly_vehicles_by_location = _aggregate_vehicles_by_period_location(rows, "week")
    monthly_vehicles_by_location = _aggregate_vehicles_by_period_location(rows, "month")
    weekly_dumping_by_location = _aggregate_dumping_by_period_location(rows, "week")
    monthly_dumping_by_location = _aggregate_dumping_by_period_location(rows, "month")

    return {
        "hour_risk": hour_risk,
        "feed_density": feeds_top,
        "daily_dense": daily_list,
        "vehicle_hour_issue": veh_hour,
        "vehicle_feed_issue": veh_feeds_top,
        "vehicle_daily_collision": veh_daily_list,
        "dumping_severity": dmp_severity,
        "dumping_waste_type": dmp_waste_top,
        "dumping_feed": dmp_feeds_top,
        "dumping_daily": dmp_daily_list,
        "monthly_by_type": monthly_by_type,
        "weekly_by_location": weekly_by_location,
        "monthly_by_location": monthly_by_location,
        "weekly_people_by_location": weekly_people_by_location,
        "monthly_people_by_location": monthly_people_by_location,
        "weekly_vehicles_by_location": weekly_vehicles_by_location,
        "monthly_vehicles_by_location": monthly_vehicles_by_location,
        "weekly_dumping_by_location": weekly_dumping_by_location,
        "monthly_dumping_by_location": monthly_dumping_by_location,
        "plate_confidence": plate_conf_out,
        "plate_feed": plate_feeds_top,
        "plate_daily": plate_daily_list,
        "weekly_plates_by_location": weekly_plates_by_location,
        "monthly_plates_by_location": monthly_plates_by_location,
    }


def _aggregate_monthly_by_type(rows: list[VlmObservation]) -> list[dict]:
    """Stacked-by-incident-type counts per calendar month (YYYY-MM)."""
    by_month: dict[str, dict[str, int]] = {}
    for o in rows:
        # Bucket by processed_at (when the VLM analyzed the frame), not
        # captured_at (when the image was taken). The same VLM run can
        # contain old recorded footage spanning weeks — bucketing by
        # capture-time creates phantom older bars even though no ingest
        # happened then. See the rolling-period charts below for the
        # same fix.
        ts = o.processed_at or o.captured_at
        if not ts:
            continue
        try:
            month = datetime.fromisoformat(ts).strftime("%Y-%m")
        except ValueError:
            continue
        slot = by_month.setdefault(month, {key: 0 for _, key in _INCIDENT_TYPE_GROUPS})
        for _, key in _INCIDENT_TYPE_GROUPS:
            if _matches_type(o, key):
                slot[key] += 1
    out: list[dict] = []
    for month in sorted(by_month.keys()):
        row = {"month": month}
        row.update(by_month[month])
        out.append(row)
    return out


def _aggregate_by_period_location(rows: list[VlmObservation], period: str) -> dict:
    """Incident counts per (time-bucket, location). period ∈ {"week","month"}.

    Buckets by `processed_at` (when the VLM run analyzed the frame) so the
    chart reflects when we did the work, not when the underlying footage
    was originally recorded. Falls back to captured_at when processed_at
    is missing, so legacy rows still bucket somewhere instead of being
    silently dropped. Limits to the top 10 locations by total to keep
    the chart legible.
    """
    bucket_keys: list[str] = []
    bucket_set: set[str] = set()
    loc_label: dict[str, str] = {}
    counts: dict[tuple[str, str], int] = {}
    for o in rows:
        if not _is_actionable(o):
            continue
        ts = o.processed_at or o.captured_at
        if not ts:
            continue
        try:
            dt = datetime.fromisoformat(ts)
        except ValueError:
            continue
        if period == "week":
            iso_year, iso_week, _ = dt.isocalendar()
            bucket = f"{iso_year}-W{iso_week:02d}"
        else:
            bucket = dt.strftime("%Y-%m")
        if bucket not in bucket_set:
            bucket_set.add(bucket)
            bucket_keys.append(bucket)
        # Prefer the canonical location_id when available so a feed that
        # was relabelled doesn't fragment the location row.
        loc_id = o.location_id or o.feed_id
        loc_label[loc_id] = o.feed_label or loc_id
        counts[(bucket, loc_id)] = counts.get((bucket, loc_id), 0) + 1

    bucket_keys.sort()
    loc_totals: dict[str, int] = {}
    for (_, loc_id), n in counts.items():
        loc_totals[loc_id] = loc_totals.get(loc_id, 0) + n
    top_locs = sorted(loc_totals.keys(), key=lambda l: -loc_totals[l])[:10]
    locations = [{"location_id": l, "label": loc_label[l], "total": loc_totals[l]} for l in top_locs]
    data = [
        {"bucket": b, "location_id": l, "count": counts.get((b, l), 0)}
        for b in bucket_keys for l in top_locs
    ]
    return {
        "period": period,
        "buckets": bucket_keys,
        "locations": locations,
        "data": data,
    }


def _aggregate_vehicles_by_period_location(rows: list[VlmObservation], period: str) -> dict:
    """Sum estimated vehicle count per (time-bucket, location) — vehicle_prompts only.

    Per-frame vehicle count is parsed from `vehicle_description` (Q13)
    via _count_vehicles_in_desc(). Frames with no description contribute
    0, so the sum represents the total vehicles *we could enumerate
    from the VLM caption*, not raw frame counts. Same bucketing rules
    as the other period-location aggregators (period in {"week","month"},
    bucket by processed_at, top 10 locations by total).
    """
    bucket_keys: list[str] = []
    bucket_set: set[str] = set()
    loc_label: dict[str, str] = {}
    sums: dict[tuple[str, str], int] = {}
    for o in rows:
        if o.preset != "vehicle_prompts":
            continue
        n = _count_vehicles_in_desc(o.vehicle_description)
        if n <= 0:
            continue
        ts = o.processed_at or o.captured_at
        if not ts:
            continue
        try:
            dt = datetime.fromisoformat(ts)
        except ValueError:
            continue
        if period == "week":
            iso_year, iso_week, _ = dt.isocalendar()
            bucket = f"{iso_year}-W{iso_week:02d}"
        else:
            bucket = dt.strftime("%Y-%m")
        if bucket not in bucket_set:
            bucket_set.add(bucket)
            bucket_keys.append(bucket)
        loc_id = o.location_id or o.feed_id
        loc_label[loc_id] = o.feed_label or loc_id
        sums[(bucket, loc_id)] = sums.get((bucket, loc_id), 0) + n

    bucket_keys.sort()
    loc_totals: dict[str, int] = {}
    for (_, loc_id), n in sums.items():
        loc_totals[loc_id] = loc_totals.get(loc_id, 0) + n
    top_locs = sorted(loc_totals.keys(), key=lambda l: -loc_totals[l])[:10]
    locations = [{"location_id": l, "label": loc_label[l], "total": loc_totals[l]} for l in top_locs]
    data = [
        {"bucket": b, "location_id": l, "count": sums.get((b, l), 0)}
        for b in bucket_keys for l in top_locs
    ]
    return {
        "period": period,
        "buckets": bucket_keys,
        "locations": locations,
        "data": data,
    }


def _aggregate_dumping_by_period_location(rows: list[VlmObservation], period: str) -> dict:
    """Count frames flagged `dumping_present` per (time-bucket, location)
    — illegal_dumping only. Same bucketing/top-10 rules as the other
    period-location aggregators.
    """
    bucket_keys: list[str] = []
    bucket_set: set[str] = set()
    loc_label: dict[str, str] = {}
    counts: dict[tuple[str, str], int] = {}
    for o in rows:
        if o.preset != "illegal_dumping":
            continue
        if not o.dumping_present:
            continue
        ts = o.processed_at or o.captured_at
        if not ts:
            continue
        try:
            dt = datetime.fromisoformat(ts)
        except ValueError:
            continue
        if period == "week":
            iso_year, iso_week, _ = dt.isocalendar()
            bucket = f"{iso_year}-W{iso_week:02d}"
        else:
            bucket = dt.strftime("%Y-%m")
        if bucket not in bucket_set:
            bucket_set.add(bucket)
            bucket_keys.append(bucket)
        loc_id = o.location_id or o.feed_id
        loc_label[loc_id] = o.feed_label or loc_id
        counts[(bucket, loc_id)] = counts.get((bucket, loc_id), 0) + 1

    bucket_keys.sort()
    loc_totals: dict[str, int] = {}
    for (_, loc_id), n in counts.items():
        loc_totals[loc_id] = loc_totals.get(loc_id, 0) + n
    top_locs = sorted(loc_totals.keys(), key=lambda l: -loc_totals[l])[:10]
    locations = [{"location_id": l, "label": loc_label[l], "total": loc_totals[l]} for l in top_locs]
    data = [
        {"bucket": b, "location_id": l, "count": counts.get((b, l), 0)}
        for b in bucket_keys for l in top_locs
    ]
    return {
        "period": period,
        "buckets": bucket_keys,
        "locations": locations,
        "data": data,
    }


def _aggregate_plates_by_period_location(rows: list[VlmObservation], period: str) -> dict:
    """Sum detected plate_count per (time-bucket, location) — license_plate
    only. Same bucketing/top-10 rules as the other period-location aggregators;
    the `count` field carries the number of plates read at that location.
    """
    bucket_keys: list[str] = []
    bucket_set: set[str] = set()
    loc_label: dict[str, str] = {}
    sums: dict[tuple[str, str], int] = {}
    for o in rows:
        if o.preset != _LPR_PRESET:
            continue
        if not o.plate_count or o.plate_count <= 0:
            continue
        ts = o.processed_at or o.captured_at
        if not ts:
            continue
        try:
            dt = datetime.fromisoformat(ts)
        except ValueError:
            continue
        if period == "week":
            iso_year, iso_week, _ = dt.isocalendar()
            bucket = f"{iso_year}-W{iso_week:02d}"
        else:
            bucket = dt.strftime("%Y-%m")
        if bucket not in bucket_set:
            bucket_set.add(bucket)
            bucket_keys.append(bucket)
        loc_id = o.location_id or o.feed_id
        loc_label[loc_id] = o.feed_label or loc_id
        sums[(bucket, loc_id)] = sums.get((bucket, loc_id), 0) + o.plate_count

    bucket_keys.sort()
    loc_totals: dict[str, int] = {}
    for (_, loc_id), n in sums.items():
        loc_totals[loc_id] = loc_totals.get(loc_id, 0) + n
    top_locs = sorted(loc_totals.keys(), key=lambda l: -loc_totals[l])[:10]
    locations = [{"location_id": l, "label": loc_label[l], "total": loc_totals[l]} for l in top_locs]
    data = [
        {"bucket": b, "location_id": l, "count": sums.get((b, l), 0)}
        for b in bucket_keys for l in top_locs
    ]
    return {
        "period": period,
        "buckets": bucket_keys,
        "locations": locations,
        "data": data,
    }


def _aggregate_people_by_period_location(rows: list[VlmObservation], period: str) -> dict:
    """Sum pedestrian_count per (time-bucket, location) — crowd_behavior only.

    Same bucketing rules as _aggregate_by_period_location (period in
    {"week","month"}, bucket by processed_at, top 10 locations by total),
    but the value summed is the per-frame pedestrian_count rather than a
    frame count. Vehicle and illegal_dumping rows are skipped because
    their pedestrian_count is always None.
    """
    bucket_keys: list[str] = []
    bucket_set: set[str] = set()
    loc_label: dict[str, str] = {}
    sums: dict[tuple[str, str], int] = {}
    for o in rows:
        if o.preset != "crowd_behavior":
            continue
        if not o.pedestrian_count or o.pedestrian_count <= 0:
            continue
        ts = o.processed_at or o.captured_at
        if not ts:
            continue
        try:
            dt = datetime.fromisoformat(ts)
        except ValueError:
            continue
        if period == "week":
            iso_year, iso_week, _ = dt.isocalendar()
            bucket = f"{iso_year}-W{iso_week:02d}"
        else:
            bucket = dt.strftime("%Y-%m")
        if bucket not in bucket_set:
            bucket_set.add(bucket)
            bucket_keys.append(bucket)
        loc_id = o.location_id or o.feed_id
        loc_label[loc_id] = o.feed_label or loc_id
        sums[(bucket, loc_id)] = sums.get((bucket, loc_id), 0) + o.pedestrian_count

    bucket_keys.sort()
    loc_totals: dict[str, int] = {}
    for (_, loc_id), n in sums.items():
        loc_totals[loc_id] = loc_totals.get(loc_id, 0) + n
    top_locs = sorted(loc_totals.keys(), key=lambda l: -loc_totals[l])[:10]
    locations = [{"location_id": l, "label": loc_label[l], "total": loc_totals[l]} for l in top_locs]
    data = [
        {"bucket": b, "location_id": l, "count": sums.get((b, l), 0)}
        for b in bucket_keys for l in top_locs
    ]
    return {
        "period": period,
        "buckets": bucket_keys,
        "locations": locations,
        "data": data,
    }


def _compute_stats_summary(rows: list[VlmObservation], loaded_at: Optional[str]) -> dict:
    n = len(rows)
    if not n:
        return {
            "total": 0, "feeds": 0, "runs": 0, "with_pedestrians": 0,
            "imminent_threats": 0, "weapons": 0, "medical": 0, "fire_smoke": 0,
            "density": {}, "risk": {}, "loaded_at": loaded_at,
            "presets": {},
            "vehicle": _empty_vehicle_stats(),
            "dumping": _empty_dumping_stats(),
            "plate": _empty_plate_stats(),
        }
    density: dict[str, int] = {}
    risk: dict[str, int] = {}
    feeds: set[str] = set()
    runs:  set[str] = set()
    presets: dict[str, int] = {}
    with_peds = threats = weapons = medical = fire = 0
    # Vehicle counters — distinct from crowd to keep the wire schema flat.
    veh_total = veh_collisions = veh_speeding = veh_fire_lane = 0
    veh_erratic = veh_wrong_way = veh_tamper = veh_building = 0
    veh_near_person = veh_struck = veh_near_miss = veh_child = 0
    veh_no_plate_frames = veh_with_desc = 0
    # Illegal-dumping counters.
    dmp_total = dmp_present = dmp_ord_violation = dmp_chronic = 0
    dmp_water = dmp_gutter = dmp_high_priority = dmp_with_summary = 0
    dmp_priority: dict[str, int] = {}
    dmp_ordinance: dict[str, int] = {}
    dmp_waste: dict[str, int] = {}
    # License-plate counters.
    lpr_total = lpr_frames_with_plate = lpr_plates_detected = lpr_high_conf = 0
    lpr_unique: set[str] = set()
    lpr_by_state: dict[str, int] = {}
    lpr_by_type: dict[str, int] = {}
    for o in rows:
        feeds.add(o.feed_id)
        if o.run_id:
            runs.add(o.run_id)
        if o.preset:
            presets[o.preset] = presets.get(o.preset, 0) + 1
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
        if o.preset == "vehicle_prompts":
            veh_total += 1
            if o.collision: veh_collisions += 1
            if o.speeding: veh_speeding += 1
            if o.fire_lane_violation: veh_fire_lane += 1
            if o.erratic_maneuver: veh_erratic += 1
            if o.wrong_way: veh_wrong_way += 1
            if o.vehicle_tamper: veh_tamper += 1
            if o.building_contact: veh_building += 1
            if o.person_near_vehicle: veh_near_person += 1
            if o.pedestrian_struck: veh_struck += 1
            if o.pedestrian_near_miss: veh_near_miss += 1
            if o.child_struck: veh_child += 1
            if (o.no_plate_count or 0) > 0: veh_no_plate_frames += 1
            if o.vehicle_description: veh_with_desc += 1
        elif o.preset == "illegal_dumping":
            dmp_total += 1
            if o.dumping_present: dmp_present += 1
            if o.ordinance_violation: dmp_ord_violation += 1
            if o.chronic_site: dmp_chronic += 1
            if o.water_proximity: dmp_water += 1
            if o.gutter_alley: dmp_gutter += 1
            if o.priority:
                dmp_priority[o.priority] = dmp_priority.get(o.priority, 0) + 1
                if o.priority == "HIGH": dmp_high_priority += 1
            if o.ordinance:
                dmp_ordinance[o.ordinance] = dmp_ordinance.get(o.ordinance, 0) + 1
            if o.waste_type:
                key = o.waste_type.lower()
                dmp_waste[key] = dmp_waste.get(key, 0) + 1
            if o.dumping_summary: dmp_with_summary += 1
        elif o.preset == _LPR_PRESET:
            lpr_total += 1
            if o.plates_detected:
                lpr_frames_with_plate += 1
            for p in (o.plates or []):
                lpr_plates_detected += 1
                if p.get("plate_text"):
                    lpr_unique.add(p["plate_text"])
                if (p.get("confidence") or 0.0) >= 0.9:
                    lpr_high_conf += 1
                st = p.get("state")
                if st:
                    lpr_by_state[st] = lpr_by_state.get(st, 0) + 1
                pt = p.get("plate_type")
                if pt:
                    lpr_by_type[pt] = lpr_by_type.get(pt, 0) + 1
    return {
        "total": n, "feeds": len(feeds), "runs": len(runs),
        "with_pedestrians": with_peds,
        "imminent_threats": threats, "weapons": weapons, "medical": medical, "fire_smoke": fire,
        "density": density, "risk": risk,
        "loaded_at": loaded_at,
        "presets": presets,
        "vehicle": {
            "total": veh_total,
            "with_vehicle_desc": veh_with_desc,
            "collisions": veh_collisions,
            "speeding": veh_speeding,
            "fire_lane": veh_fire_lane,
            "erratic": veh_erratic,
            "wrong_way": veh_wrong_way,
            "tamper": veh_tamper,
            "building_contact": veh_building,
            "person_near_vehicle": veh_near_person,
            "pedestrian_struck": veh_struck,
            "pedestrian_near_miss": veh_near_miss,
            "child_struck": veh_child,
            "no_plate_frames": veh_no_plate_frames,
        },
        "dumping": {
            "total": dmp_total,
            "dumping_present": dmp_present,
            "ordinance_violation": dmp_ord_violation,
            "chronic_site": dmp_chronic,
            "water_proximity": dmp_water,
            "gutter_alley": dmp_gutter,
            "high_priority": dmp_high_priority,
            "with_summary": dmp_with_summary,
            "priority": dmp_priority,
            "ordinance": dmp_ordinance,
            "waste_type": dmp_waste,
        },
        "plate": {
            "total": lpr_total,
            "frames_with_plate": lpr_frames_with_plate,
            "plates_detected": lpr_plates_detected,
            "unique_plates": len(lpr_unique),
            "high_confidence": lpr_high_conf,
            "by_state": lpr_by_state,
            "by_type": lpr_by_type,
        },
    }


def _empty_plate_stats() -> dict:
    return {
        "total": 0, "frames_with_plate": 0, "plates_detected": 0,
        "unique_plates": 0, "high_confidence": 0,
        "by_state": {}, "by_type": {},
    }


def _empty_vehicle_stats() -> dict:
    return {
        "total": 0, "with_vehicle_desc": 0, "collisions": 0, "speeding": 0,
        "fire_lane": 0, "erratic": 0, "wrong_way": 0, "tamper": 0,
        "building_contact": 0, "person_near_vehicle": 0,
        "pedestrian_struck": 0, "pedestrian_near_miss": 0, "child_struck": 0,
        "no_plate_frames": 0,
    }


def _empty_dumping_stats() -> dict:
    return {
        "total": 0, "dumping_present": 0, "ordinance_violation": 0,
        "chronic_site": 0, "water_proximity": 0, "gutter_alley": 0,
        "high_priority": 0, "with_summary": 0,
        "priority": {}, "ordinance": {}, "waste_type": {},
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

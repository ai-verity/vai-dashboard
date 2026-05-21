"""
AI Model Metrics loader.

Reads the daily training-pipeline output (per-class Precision/Recall/F1
plus mAP) from backend/data/ai_model_metrics/ and exposes structured
views consumed by the /api/ai_metrics/* endpoints.

Data layout expected (flat — all files live in one directory):

  backend/data/ai_model_metrics/
    comparison_YYYYMMDD.csv                       per-class before/after
    compare_YYYYMMDD_HHMMSS_comparison.csv        timestamped pipeline output
    YYYYMMDD_HHMMSS_stream_class_mapping.txt      per-run dataset summary

The most recent comparison file (by run-date / timestamp) becomes the
"current" snapshot exposed to the dashboard; older files become history.
Per-date collisions are broken by the wall-clock timestamp in the
filename (date-only files lose ties to timestamped files).

Weekly / monthly history is intentionally derived only from real files
on disk — when fewer than 7 / 30 daily runs are present the endpoints
return an explicit `awaiting_runs` payload so the UI can render an
empty-state callout rather than fabricated numbers.
"""

from __future__ import annotations

import csv
import json
import os
import re
import threading
from dataclasses import dataclass, asdict, field
from datetime import datetime, timedelta, timezone
from typing import Optional

# Flat layout: all comparison CSVs + class_mapping.txt files live in one
# directory. The two history-file regexes and the class-mapping regex
# all match against this same flat listing, so files at the same level
# co-exist without nested subfolders.
DATA_DIR = os.path.join(os.path.dirname(__file__), "data", "ai_model_metrics")
HISTORY_DIR = DATA_DIR
CLASS_MAPPING_DIR = DATA_DIR

METRICS = ("Precision", "Recall", "F1")
EXTRA_METRICS = ("mAP@0.5", "mAP@0.5:0.95")

# Accepts three filename shapes in DATA_DIR:
#   comparison_YYYYMMDD.csv                       (date-only — legacy / manual entries)
#   comparison-<model>-YYYYMMDD.csv               (model-tagged date-only — e.g. comparison-rtdetr34-20260519.csv)
#   compare_YYYYMMDD_HHMMSS_comparison.csv        (wall-clock timestamped — pipeline output)
# All three are parsed; when more than one file covers a single date,
# the latest timestamp wins (date-only files are treated as "00:00:00").
_HISTORY_FILE_RES = (
    re.compile(r"^comparison_(\d{4})(\d{2})(\d{2})\.csv$"),
    re.compile(r"^compare_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})_comparison\.csv$"),
    re.compile(r"^comparison-[A-Za-z0-9_]+-(\d{4})(\d{2})(\d{2})\.csv$"),
)


# ─── Dataclasses ────────────────────────────────────────────────────────────


@dataclass
class ClassMetric:
    """Per-class metric for a single run: 'after' is the canonical value
    for the run; 'before' is the value from the immediately prior run
    used for daily comparisons."""

    cls: str
    metric: str            # Precision | Recall | F1 | mAP@0.5 | mAP@0.5:0.95
    before: Optional[float]
    after: float
    delta: Optional[float]


@dataclass
class RunSnapshot:
    """One training run = one comparison file."""

    run_date: str          # YYYY-MM-DD (UTC date of the run)
    run_timestamp: Optional[str]  # ISO 8601 UTC timestamp if known
    run_name: Optional[str]
    model: Optional[str]
    classes: list[str]
    metrics: list[ClassMetric]
    instance_counts: dict[str, dict[str, int]] = field(default_factory=dict)


@dataclass
class DatasetSnapshot:
    """Per-run training-dataset summary parsed from a class_mapping.txt.

    All counts are pulled from the COCO/YOLO instances JSON the pipeline
    emits; per-class numbers are box instances (not unique images — one
    image can contribute multiple boxes). Image-level fields (total /
    annotated / background) are unique images."""

    run_date: str
    run_timestamp: Optional[str]
    run_name: Optional[str]
    model: Optional[str]
    train_images: int
    val_images: int
    train_empty_bg: int
    val_empty_bg: int
    dropped_regions: int       # boxes whose VIA class isn't in the project mapping
    by_class: list[dict]       # [{cls, train, val, total}]

    @property
    def total_images(self) -> int:
        return self.train_images + self.val_images

    @property
    def empty_bg_images(self) -> int:
        return self.train_empty_bg + self.val_empty_bg

    @property
    def annotated_images(self) -> int:
        return max(self.total_images - self.empty_bg_images, 0)


# ─── Loader (process-wide, thread-safe) ─────────────────────────────────────


_LOCK = threading.Lock()
_STATE: dict = {
    "loaded_at": None,
    "current": None,       # RunSnapshot for the latest available run
    "history": [],         # list[RunSnapshot] sorted ascending by run_date
    "dataset": [],         # list[DatasetSnapshot] sorted ascending by run_date
}


def _parse_float(s: str) -> Optional[float]:
    s = (s or "").strip()
    if not s:
        return None
    # Strip leading '+' so values like "+0.091210" parse cleanly.
    if s.startswith("+"):
        s = s[1:]
    try:
        return float(s)
    except ValueError:
        return None


def _read_comparison_csv(path: str) -> tuple[list[str], list[ClassMetric]]:
    classes_in_order: list[str] = []
    seen: set[str] = set()
    metrics: list[ClassMetric] = []
    with open(path, newline="", encoding="utf-8") as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            cls = (row.get("class") or "").strip()
            metric = (row.get("metric") or "").strip()
            if not cls or not metric:
                continue
            if cls not in seen:
                classes_in_order.append(cls)
                seen.add(cls)
            before = _parse_float(row.get("before", ""))
            after = _parse_float(row.get("after", ""))
            if after is None:
                continue
            delta = _parse_float(row.get("delta", ""))
            if delta is None and before is not None:
                delta = after - before
            metrics.append(ClassMetric(
                cls=cls, metric=metric, before=before, after=after, delta=delta,
            ))
    return classes_in_order, metrics


def _read_class_mapping(path: str) -> dict:
    if not os.path.exists(path):
        return {}
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, json.JSONDecodeError):
        return {}


def _snapshot_from_files(comp_path: str, mapping_path: Optional[str],
                        default_run_date: str) -> RunSnapshot:
    classes, metrics = _read_comparison_csv(comp_path)
    mapping = _read_class_mapping(mapping_path) if mapping_path else {}

    ts = mapping.get("timestamp_utc")
    run_date = default_run_date
    if ts:
        try:
            run_date = datetime.fromisoformat(ts.replace("Z", "+00:00")).date().isoformat()
        except ValueError:
            pass

    inst = mapping.get("instance_counts", {}).get("by_class", {})

    return RunSnapshot(
        run_date=run_date,
        run_timestamp=ts,
        run_name=mapping.get("run_name"),
        model=mapping.get("model"),
        classes=classes,
        metrics=metrics,
        instance_counts=inst,
    )


def load() -> None:
    """(Re-)load all available comparison files into memory.

    Called at startup and via /api/ai_metrics/reload. Safe to call from
    request handlers; uses a mutex so concurrent reloads don't tear.
    """
    with _LOCK:
        history: list[RunSnapshot] = []

        # History: parse every file matching either of the two name shapes,
        # then keep only the latest file per date (sort key = the file's
        # full wall-clock timestamp, with date-only files treated as midnight).
        # This is what lets a 2026-04-28_16:16:46 run supersede a
        # 2026-04-28_14:41:09 run on the same date without manual cleanup.
        if os.path.isdir(HISTORY_DIR):
            candidates: dict[str, tuple[str, str, str]] = {}
            # run_date  -> (timestamp_sort_key, comp_path, file_basename)
            for name in sorted(os.listdir(HISTORY_DIR)):
                run_date: Optional[str] = None
                ts_key = ""
                m_legacy = _HISTORY_FILE_RES[0].match(name)
                m_stamped = _HISTORY_FILE_RES[1].match(name)
                m_tagged = _HISTORY_FILE_RES[2].match(name)
                if m_stamped:
                    y, mo, d, hh, mm, ss = m_stamped.groups()
                    run_date = f"{y}-{mo}-{d}"
                    ts_key = f"{y}{mo}{d}{hh}{mm}{ss}"
                elif m_legacy:
                    y, mo, d = m_legacy.groups()
                    run_date = f"{y}-{mo}-{d}"
                    ts_key = f"{y}{mo}{d}000000"  # midnight — loses ties to any stamped file
                elif m_tagged:
                    y, mo, d = m_tagged.groups()
                    run_date = f"{y}-{mo}-{d}"
                    ts_key = f"{y}{mo}{d}000000"  # same midnight tie-break as legacy
                if run_date is None:
                    continue
                comp_path = os.path.join(HISTORY_DIR, name)
                existing = candidates.get(run_date)
                if existing is None or ts_key > existing[0]:
                    candidates[run_date] = (ts_key, comp_path, name)

            for run_date, (_ts_key, comp_path, _name) in candidates.items():
                # Optional class_mapping_YYYYMMDD.json sidecar — purely metadata.
                y, mo, d = run_date.split("-")
                mapping_path = os.path.join(HISTORY_DIR, f"class_mapping_{y}{mo}{d}.json")
                if not os.path.exists(mapping_path):
                    mapping_path = None
                history.append(_snapshot_from_files(comp_path, mapping_path, run_date))

        # Current: backend/data/ai_metrics/comparison.csv
        current: Optional[RunSnapshot] = None
        comp_path = os.path.join(DATA_DIR, "comparison.csv")
        mapping_path = os.path.join(DATA_DIR, "class_mapping.json")
        if os.path.exists(comp_path):
            default_run_date = datetime.now(timezone.utc).date().isoformat()
            current = _snapshot_from_files(
                comp_path,
                mapping_path if os.path.exists(mapping_path) else None,
                default_run_date,
            )

        # If a same-dated history file exists, the current snapshot replaces it
        # (history files are archives; current is the latest run).
        if current is not None:
            history = [h for h in history if h.run_date != current.run_date]
            history.append(current)

        history.sort(key=lambda s: s.run_date)

        dataset = _load_dataset_mappings()

        # Pair each RunSnapshot with the same-date DatasetSnapshot parsed
        # from `YYYYMMDD_HHMMSS_stream_class_mapping.txt` — only for
        # metadata (model / run_name / run_timestamp). We intentionally do
        # NOT pull `instance_counts` from the txt here: those values
        # describe the full COCO training corpus (motorcycle=8019 val),
        # not the deployed model's validation set (motorcycle=2 val). The
        # canonical class_mapping.json fallback below is the right source
        # of weights for the weighted-mean aggregation in _overall().
        dataset_by_date = {ds.run_date: ds for ds in dataset}
        for snap in history:
            ds = dataset_by_date.get(snap.run_date)
            if ds is None:
                continue
            if snap.model is None:
                snap.model = ds.model
            if snap.run_name is None:
                snap.run_name = ds.run_name
            if snap.run_timestamp is None:
                snap.run_timestamp = ds.run_timestamp

        # Fallback: if a history snapshot has no per-date class_mapping_*.json,
        # inherit instance_counts from the canonical class_mapping.json. The
        # train/val split rarely changes day-to-day, so one file covers most
        # cases. The per-date sidecar lookup at _snapshot_from_files() already
        # wins when a same-date JSON exists.
        canonical_inst: dict = {}
        canonical_path = os.path.join(DATA_DIR, "class_mapping.json")
        if os.path.exists(canonical_path):
            canonical_inst = (
                _read_class_mapping(canonical_path)
                .get("instance_counts", {})
                .get("by_class", {})
            )
        if canonical_inst:
            for snap in history:
                if not snap.instance_counts:
                    snap.instance_counts = canonical_inst

        _STATE["history"] = history
        _STATE["current"] = history[-1] if history else None
        _STATE["dataset"] = dataset
        _STATE["loaded_at"] = datetime.now(timezone.utc).isoformat()


# ─── class_mapping.txt parser ──────────────────────────────────────────────
#
# Each file is the human-readable summary the training pipeline emits per
# run. Format (relevant lines):
#
#   Class mapping  (2026-05-19T13:57:14+00:00)
#   Run     : exp
#   Model   : rtv2_r34vd_120e_coco
#   ...
#   Dropped class regions (no entry in mapping):
#                           78
#     _background_images    2966
#
#   Class instance counts (...):
#     class                    train     val   total
#     ──────────────────────────────────────────────
#     person                  317696   78462  396158
#     ...
#     total boxes             603882  145442  749324
#     image files              69153   17288   86441
#       of which empty bg       2342     643    2985

_MAPPING_FILENAME_RE = re.compile(r"^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})_stream_class_mapping\.txt$")
_MAPPING_TIMESTAMP_RE = re.compile(r"\(([^)]+)\)")
_MAPPING_INT3 = re.compile(r"^\s*(\S[^\s]*(?:\s+\S+)*?)\s+(\d+)\s+(\d+)\s+(\d+)\b")
_MAPPING_INT1 = re.compile(r"^\s*(\S[^\s]*(?:\s+\S+)*?)\s+(\d+)\b")


def _parse_class_mapping_txt(path: str, fallback_run_date: str,
                              fallback_ts: Optional[str]) -> Optional[DatasetSnapshot]:
    try:
        with open(path, encoding="utf-8") as fh:
            lines = fh.readlines()
    except OSError:
        return None

    run_timestamp: Optional[str] = fallback_ts
    run_name: Optional[str] = None
    model: Optional[str] = None
    dropped_regions = 0
    train_empty_bg = val_empty_bg = 0
    train_images = val_images = 0
    by_class: list[dict] = []
    in_instance_block = False

    for raw in lines:
        line = raw.rstrip()
        if line.startswith("Class mapping"):
            m = _MAPPING_TIMESTAMP_RE.search(line)
            if m:
                run_timestamp = m.group(1).strip()
        elif line.startswith("Run "):
            run_name = line.split(":", 1)[1].strip() if ":" in line else None
        elif line.startswith("Model"):
            model = line.split(":", 1)[1].strip() if ":" in line else None
        elif "Dropped class regions" in line:
            in_instance_block = False
            # Next non-empty, non-divider line carries the unnamed dropped-count
            # (e.g. "                        78"); _background_images follows.
        elif line.strip().startswith("_background_images"):
            mi = _MAPPING_INT1.match(line)
            if mi:
                # _background_images has only one value (total background); we
                # don't see a train/val split here, so leave per-split fields
                # to the "of which empty bg" row below.
                pass
        elif "Class instance counts" in line:
            in_instance_block = True
            continue
        elif "image files" in line:
            mi = _MAPPING_INT3.match(line)
            if mi:
                train_images = int(mi.group(2))
                val_images = int(mi.group(3))
        elif "of which empty bg" in line:
            mi = _MAPPING_INT3.match(line)
            if mi:
                train_empty_bg = int(mi.group(2))
                val_empty_bg = int(mi.group(3))
        elif in_instance_block:
            stripped = line.strip()
            if not stripped or stripped.startswith(("class", "──", "total boxes")):
                continue
            mi = _MAPPING_INT3.match(line)
            if mi:
                cls = mi.group(1).strip()
                # Filter out arrows / labels the pipeline adds for hints.
                if "←" in cls or "→" in cls:
                    cls = cls.split("←")[0].split("→")[0].strip()
                # Skip non-class anchor rows.
                if cls in {"total boxes", "image files"}:
                    continue
                by_class.append({
                    "cls":   cls,
                    "train": int(mi.group(2)),
                    "val":   int(mi.group(3)),
                    "total": int(mi.group(4)),
                })

    # Pull the dropped-regions number from the first all-digits line that
    # appears directly after the "Dropped class regions" heading. The
    # column is unlabelled, which is awkward to anchor in a single pass —
    # do a second scan for it specifically.
    seen_drop_heading = False
    for raw in lines:
        line = raw.rstrip()
        if "Dropped class regions" in line:
            seen_drop_heading = True
            continue
        if seen_drop_heading:
            stripped = line.strip()
            if not stripped:
                continue
            if stripped.startswith("_background_images"):
                break  # passed the dropped count without finding a number
            try:
                dropped_regions = int(stripped)
                break
            except ValueError:
                # Hit a labelled row first — no anonymous dropped count.
                break

    if train_images == 0 and val_images == 0 and not by_class:
        return None

    return DatasetSnapshot(
        run_date=fallback_run_date,
        run_timestamp=run_timestamp,
        run_name=run_name,
        model=model,
        train_images=train_images,
        val_images=val_images,
        train_empty_bg=train_empty_bg,
        val_empty_bg=val_empty_bg,
        dropped_regions=dropped_regions,
        by_class=by_class,
    )


def _load_dataset_mappings() -> list[DatasetSnapshot]:
    """Scan class-mapping/*.txt, parse each, and return one snapshot per
    date (latest timestamp wins on collision)."""
    if not os.path.isdir(CLASS_MAPPING_DIR):
        return []
    candidates: dict[str, tuple[str, DatasetSnapshot]] = {}  # date -> (ts_key, snap)
    for name in sorted(os.listdir(CLASS_MAPPING_DIR)):
        m = _MAPPING_FILENAME_RE.match(name)
        if not m:
            continue
        y, mo, d, hh, mm, ss = m.groups()
        run_date = f"{y}-{mo}-{d}"
        ts_key = f"{y}{mo}{d}{hh}{mm}{ss}"
        fallback_ts = f"{y}-{mo}-{d}T{hh}:{mm}:{ss}+00:00"
        snap = _parse_class_mapping_txt(
            os.path.join(CLASS_MAPPING_DIR, name),
            fallback_run_date=run_date,
            fallback_ts=fallback_ts,
        )
        if snap is None:
            continue
        existing = candidates.get(run_date)
        if existing is None or ts_key > existing[0]:
            candidates[run_date] = (ts_key, snap)
    return sorted((snap for _, snap in candidates.values()), key=lambda s: s.run_date)


# ─── Aggregation helpers ────────────────────────────────────────────────────


def _avg(xs: list[float]) -> Optional[float]:
    xs = [x for x in xs if x is not None]
    if not xs:
        return None
    return sum(xs) / len(xs)


def _by_metric(snap: RunSnapshot, field_name: str) -> dict[str, dict[str, Optional[float]]]:
    """Reshape a snapshot to {class: {metric: value}} for one of after/before/delta.

    Excludes the 'all' pseudo-class — that's a summary-only row used to
    seed overall metrics for legacy runs and shouldn't appear in the
    per-class breakdown."""
    out: dict[str, dict[str, Optional[float]]] = {}
    for m in snap.metrics:
        if m.cls.lower() == "all":
            continue
        out.setdefault(m.cls, {})[m.metric] = getattr(m, field_name)
    return out


def _real_classes(snap: RunSnapshot) -> list[str]:
    """snap.classes with the 'all' pseudo-class stripped, preserving order."""
    return [c for c in snap.classes if c.lower() != "all"]


def _overall(snap: RunSnapshot, field_name: str) -> dict[str, Optional[float]]:
    """Instance-weighted mean across classes for headline P/R/F1.

    Weighted by val instance counts when available — the right summary
    when the validation set is dominated by a few high-frequency classes
    (person ~38%, bicycle ~42%, car ~20% of val instances; motorcycle/bus
    together are <0.1%). Macro-averaging gives motorcycle the same weight
    as person, which conflates 'no validation data' with regression.

    Falls back to macro-average when no instance counts are available.

    The 'all' pseudo-class in a comparison file shortcuts everything:
    when present with all three METRICS, its values are used verbatim.
    """
    direct: dict[str, Optional[float]] = {}
    for m in snap.metrics:
        if m.cls.lower() == "all" and m.metric in METRICS:
            v = getattr(m, field_name)
            if v is not None:
                direct[m.metric] = v
    if len(direct) == len(METRICS):
        return direct

    inst = snap.instance_counts or {}

    def weight_for(cls: str) -> float:
        cell = inst.get(cls) or {}
        # Prefer val; fall back to total; else equal weight.
        return float(cell.get("val") or cell.get("total") or 1.0)

    out: dict[str, Optional[float]] = {}
    for metric_name in METRICS:
        num = 0.0
        den = 0.0
        for m in snap.metrics:
            if m.cls.lower() == "all" or m.metric != metric_name:
                continue
            v = getattr(m, field_name)
            if v is None:
                continue
            w = weight_for(m.cls)
            num += v * w
            den += w
        out[metric_name] = (num / den) if den > 0 else None

    # Fall back to any 'all'-row values for metrics not derivable from per-class rows.
    for m_name, v in direct.items():
        if out.get(m_name) is None:
            out[m_name] = v
    return out


# ─── Public accessors used by main.py ───────────────────────────────────────


def state() -> dict:
    return {
        "loaded_at": _STATE["loaded_at"],
        "runs": len(_STATE["history"]),
        "dataset_runs": len(_STATE["dataset"]),
        "current_run_date": _STATE["current"].run_date if _STATE["current"] else None,
        "current_model": _STATE["current"].model if _STATE["current"] else None,
    }


def dataset_by_date() -> dict:
    """Per-run training-dataset summary derived from class_mapping.txt
    files. One entry per date (latest timestamp wins on collision)."""
    snaps: list[DatasetSnapshot] = _STATE["dataset"]
    points: list[dict] = []
    for snap in snaps:
        points.append({
            "run_date": snap.run_date,
            "run_timestamp": snap.run_timestamp,
            "run_name": snap.run_name,
            "model": snap.model,
            "total_images": snap.total_images,
            "annotated_images": snap.annotated_images,
            "empty_bg_images": snap.empty_bg_images,
            "train_images": snap.train_images,
            "val_images": snap.val_images,
            "dropped_regions": snap.dropped_regions,
            # NOTE auto-labeled images aren't currently emitted by the
            # pipeline — surface as null so the UI can show "—" rather
            # than silently zero. Once the pipeline includes the field
            # this becomes a real number.
            "auto_labeled_images": None,
            "by_class": snap.by_class,
        })
    return {
        "available": len(points) > 0,
        "points": points,
        "latest": points[-1] if points else None,
    }


def summary() -> dict:
    """Headline payload: macro-averaged P/R/F1 for the latest run plus
    the prior-run baseline. Prior comes from the most recent dated
    snapshot before `current` when available, otherwise from the current
    file's own 'before' column."""
    cur = _STATE["current"]
    if cur is None:
        return {"available": False, "reason": "No comparison data on disk."}

    prior = _prior_snapshot(cur)
    after_overall = _overall(cur, "after")
    before_overall = _overall(prior, "after") if prior is not None else _overall(cur, "before")

    headline = []
    for m in METRICS:
        a = after_overall.get(m)
        b = before_overall.get(m)
        headline.append({
            "metric": m,
            "current": a,
            "previous": b,
            "delta": (a - b) if (a is not None and b is not None) else None,
        })

    return {
        "available": True,
        "run_date": cur.run_date,
        "run_timestamp": cur.run_timestamp,
        "run_name": cur.run_name,
        "model": cur.model,
        "classes": _real_classes(cur),
        "headline": headline,
    }


def by_class() -> dict:
    """Per-class P/R/F1 current + prior + delta for the latest run.

    Prior values come from the most recent dated snapshot (so the table
    shows day-over-day deltas across pipeline runs). When the prior run
    is aggregate-only ('all' pseudo-class), per-class prior cells are
    None — the UI renders those as '—'."""
    cur = _STATE["current"]
    if cur is None:
        return {"available": False, "classes": []}

    prior = _prior_snapshot(cur)
    after = _by_metric(cur, "after")
    before = _by_metric(prior, "after") if prior is not None else _by_metric(cur, "before")

    # Recompute delta against the resolved 'before' rather than the
    # in-file delta column (which only describes the file's own before/after).
    delta: dict[str, dict[str, Optional[float]]] = {}
    for cls, by_m in after.items():
        delta[cls] = {}
        for m_name, a in by_m.items():
            b = before.get(cls, {}).get(m_name)
            delta[cls][m_name] = (a - b) if (a is not None and b is not None) else None

    rows = []
    for cls in _real_classes(cur):
        rows.append({
            "cls": cls,
            "instances": cur.instance_counts.get(cls, {}),
            "metrics": {
                m: {
                    "current": after.get(cls, {}).get(m),
                    "previous": before.get(cls, {}).get(m),
                    "delta": delta.get(cls, {}).get(m),
                }
                for m in METRICS
            },
            "extras": {
                m: {
                    "current": after.get(cls, {}).get(m),
                    "previous": before.get(cls, {}).get(m),
                    "delta": delta.get(cls, {}).get(m),
                }
                for m in EXTRA_METRICS
            },
        })

    return {
        "available": True,
        "run_date": cur.run_date,
        "classes": rows,
    }


def comparison(period: str) -> dict:
    """Period-over-period comparison.

    daily   — preferred baseline is the most recent prior snapshot on
              disk. Falls back to the current snapshot's own 'before'
              column when no prior dated run is available (e.g. first
              run, or pipeline emits before/after in the same CSV).
    weekly  — compares latest run to the run 7 days earlier (or oldest
              available within the last 7 days). Returns awaiting=True
              if fewer than 7 daily runs are on disk.
    monthly — same logic, 30-day lookback. Returns awaiting=True if
              fewer than 30 daily runs are on disk.
    """
    cur = _STATE["current"]
    if cur is None:
        return {"available": False, "period": period}

    history = _STATE["history"]

    if period == "daily":
        # Pick the most recent prior snapshot as the day-over-day baseline.
        # If none exists, fall back to the in-file 'before' column (which is
        # what the original training pipeline reports against its own
        # previous checkpoint).
        prior = _prior_snapshot(cur)
        after_overall = _overall(cur, "after")
        if prior is not None:
            before_overall = _overall(prior, "after")
            previous_run_date: Optional[str] = prior.run_date
        else:
            before_overall = _overall(cur, "before")
            previous_run_date = _previous_date_label(cur.run_date, 1)

        headline = [
            {
                "metric": m,
                "current": after_overall.get(m),
                "previous": before_overall.get(m),
                "delta": (
                    after_overall.get(m) - before_overall.get(m)
                    if after_overall.get(m) is not None and before_overall.get(m) is not None
                    else None
                ),
            }
            for m in METRICS
        ]
        # Per-class delta: prefer prior snapshot's per-class values; fall
        # back to the current file's 'before' column when no prior exists.
        after = _by_metric(cur, "after")
        if prior is not None:
            before = _by_metric(prior, "after")
        else:
            before = _by_metric(cur, "before")
        per_class = []
        for cls in _real_classes(cur):
            per_class.append({
                "cls": cls,
                "metrics": {
                    m: {
                        "current": after.get(cls, {}).get(m),
                        "previous": before.get(cls, {}).get(m),
                        "delta": (
                            after.get(cls, {}).get(m) - before.get(cls, {}).get(m)
                            if after.get(cls, {}).get(m) is not None
                            and before.get(cls, {}).get(m) is not None
                            else None
                        ),
                    }
                    for m in METRICS
                },
            })
        return {
            "available": True,
            "period": "daily",
            "awaiting": False,
            "current_run_date": cur.run_date,
            "previous_run_date": previous_run_date,
            "headline": headline,
            "by_class": per_class,
            "runs_in_window": 1,
            "runs_required": 1,
        }

    # weekly / monthly: require enough daily history files on disk.
    window = 7 if period == "weekly" else 30 if period == "monthly" else None
    if window is None:
        return {"available": False, "period": period, "reason": "unknown period"}

    runs_in_window = len(history)  # all available daily snapshots
    awaiting = runs_in_window < window

    if awaiting:
        return {
            "available": True,
            "period": period,
            "awaiting": True,
            "current_run_date": cur.run_date,
            "previous_run_date": _previous_date_label(cur.run_date, window),
            "runs_in_window": runs_in_window,
            "runs_required": window,
            "headline": [
                {"metric": m, "current": _overall(cur, "after").get(m), "previous": None, "delta": None}
                for m in METRICS
            ],
        }

    # Enough history available — compare to the snapshot from `window` days back.
    baseline = _snapshot_at_or_before(cur.run_date, days_back=window)
    if baseline is None:
        return {
            "available": True,
            "period": period,
            "awaiting": True,
            "current_run_date": cur.run_date,
            "previous_run_date": _previous_date_label(cur.run_date, window),
            "runs_in_window": runs_in_window,
            "runs_required": window,
            "headline": [
                {"metric": m, "current": _overall(cur, "after").get(m), "previous": None, "delta": None}
                for m in METRICS
            ],
        }

    after_cur = _overall(cur, "after")
    after_base = _overall(baseline, "after")
    headline = [
        {
            "metric": m,
            "current": after_cur.get(m),
            "previous": after_base.get(m),
            "delta": (
                after_cur.get(m) - after_base.get(m)
                if after_cur.get(m) is not None and after_base.get(m) is not None
                else None
            ),
        }
        for m in METRICS
    ]
    per_class_cur = _by_metric(cur, "after")
    per_class_base = _by_metric(baseline, "after")
    classes = sorted(set(_real_classes(cur)) | set(_real_classes(baseline)))
    per_class = []
    for cls in classes:
        per_class.append({
            "cls": cls,
            "metrics": {
                m: {
                    "current": per_class_cur.get(cls, {}).get(m),
                    "previous": per_class_base.get(cls, {}).get(m),
                    "delta": (
                        per_class_cur.get(cls, {}).get(m) - per_class_base.get(cls, {}).get(m)
                        if per_class_cur.get(cls, {}).get(m) is not None
                        and per_class_base.get(cls, {}).get(m) is not None
                        else None
                    ),
                }
                for m in METRICS
            },
        })

    return {
        "available": True,
        "period": period,
        "awaiting": False,
        "current_run_date": cur.run_date,
        "previous_run_date": baseline.run_date,
        "runs_in_window": runs_in_window,
        "runs_required": window,
        "headline": headline,
        "by_class": per_class,
    }


def history(period: str) -> dict:
    """Time-series of macro-averaged P/R/F1 across available runs.

    period controls only the lookback window (and the required minimum
    for charts to render): daily=14d, weekly=8w, monthly=6mo. For now
    we return whatever runs we actually have plus a `points_required`
    hint so the UI can show "1 of N captured".
    """
    cur = _STATE["current"]
    if cur is None:
        return {"available": False, "period": period}

    points_required = {"daily": 14, "weekly": 8, "monthly": 6}.get(period, 14)

    series = []
    for snap in _STATE["history"]:
        ov = _overall(snap, "after")
        series.append({
            "run_date": snap.run_date,
            "Precision": ov.get("Precision"),
            "Recall": ov.get("Recall"),
            "F1": ov.get("F1"),
        })

    return {
        "available": True,
        "period": period,
        "points": series,
        "by_class": _by_class_history(),
        "points_captured": len(series),
        "points_required": points_required,
    }


def _by_class_history() -> list[dict]:
    """One time-series per class — the union of classes seen across all
    runs, in the order they first appeared. Missing cells stay null so
    the chart can break the line rather than draw through zero."""
    seen: set[str] = set()
    order: list[str] = []
    for snap in _STATE["history"]:
        for c in _real_classes(snap):
            if c not in seen:
                seen.add(c)
                order.append(c)

    out: list[dict] = []
    for cls in order:
        pts: list[dict] = []
        for snap in _STATE["history"]:
            cell = _by_metric(snap, "after").get(cls, {})
            pts.append({
                "run_date": snap.run_date,
                "Precision": cell.get("Precision"),
                "Recall":    cell.get("Recall"),
                "F1":        cell.get("F1"),
            })
        out.append({"cls": cls, "points": pts})
    return out


# ─── Date helpers ───────────────────────────────────────────────────────────


def _previous_date_label(run_date: str, days_back: int) -> Optional[str]:
    try:
        d = datetime.fromisoformat(run_date).date()
    except ValueError:
        return None
    return (d - timedelta(days=days_back)).isoformat()


def _prior_snapshot(current: RunSnapshot) -> Optional[RunSnapshot]:
    """Return the snapshot immediately before `current` in run_date order,
    or None if `current` is the oldest (or only) run on disk."""
    history = _STATE["history"]
    prior: Optional[RunSnapshot] = None
    for snap in history:
        if snap.run_date < current.run_date:
            prior = snap
        elif snap.run_date >= current.run_date:
            break
    return prior


def _snapshot_at_or_before(run_date: str, days_back: int) -> Optional[RunSnapshot]:
    try:
        target = datetime.fromisoformat(run_date).date() - timedelta(days=days_back)
    except ValueError:
        return None
    target_iso = target.isoformat()
    candidate: Optional[RunSnapshot] = None
    for snap in _STATE["history"]:
        if snap.run_date <= target_iso:
            candidate = snap
        else:
            break
    return candidate


# ─── Initial load on import ─────────────────────────────────────────────────


load()

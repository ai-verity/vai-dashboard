"""
AI Model Metrics loader.

Reads the daily training-pipeline output (per-class Precision/Recall/F1
plus mAP) from backend/data/ai_metrics/ and exposes structured views
consumed by the /api/ai_metrics/* endpoints.

Data layout expected:

  backend/data/ai_metrics/
    comparison.csv         per-class before/after metrics for the most
                           recent training run (columns: class, metric,
                           before, after, delta)
    class_mapping.json     run metadata: timestamp_utc, run_name, model,
                           instance counts per class
    history/               (optional) one comparison_YYYYMMDD.csv per
                           past run, picked up automatically as the
                           pipeline accumulates daily runs

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

DATA_DIR = os.path.join(os.path.dirname(__file__), "data", "ai_metrics")
HISTORY_DIR = os.path.join(DATA_DIR, "history")

METRICS = ("Precision", "Recall", "F1")
EXTRA_METRICS = ("mAP@0.5", "mAP@0.5:0.95")

_HISTORY_FILE_RE = re.compile(r"^comparison_(\d{4})(\d{2})(\d{2})\.csv$")


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


# ─── Loader (process-wide, thread-safe) ─────────────────────────────────────


_LOCK = threading.Lock()
_STATE: dict = {
    "loaded_at": None,
    "current": None,       # RunSnapshot for the latest available run
    "history": [],         # list[RunSnapshot] sorted ascending by run_date
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

        # History: backend/data/ai_metrics/history/comparison_YYYYMMDD.csv
        if os.path.isdir(HISTORY_DIR):
            for name in sorted(os.listdir(HISTORY_DIR)):
                m = _HISTORY_FILE_RE.match(name)
                if not m:
                    continue
                y, mo, d = m.groups()
                run_date = f"{y}-{mo}-{d}"
                comp_path = os.path.join(HISTORY_DIR, name)
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

        _STATE["history"] = history
        _STATE["current"] = history[-1] if history else None
        _STATE["loaded_at"] = datetime.now(timezone.utc).isoformat()


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
    """Macro-average across classes (equal weight per class) for the
    headline metrics. Macro-average is the right summary when class
    balance is highly skewed, which it is here (motorcycle/bus have <10
    instances).

    Pseudo-class 'all' in a comparison file shortcuts the average: when
    present, its value is used verbatim (handy for older runs where the
    pipeline emitted only aggregate metrics, not the per-class
    breakdown)."""
    direct: dict[str, Optional[float]] = {}
    for m in snap.metrics:
        if m.cls.lower() == "all" and m.metric in METRICS:
            v = getattr(m, field_name)
            if v is not None:
                direct[m.metric] = v
    if len(direct) == len(METRICS):
        return direct

    buckets: dict[str, list[float]] = {m: [] for m in METRICS}
    for m in snap.metrics:
        if m.cls.lower() == "all":
            continue
        if m.metric not in buckets:
            continue
        v = getattr(m, field_name)
        if v is not None:
            buckets[m.metric].append(v)
    out = {k: _avg(v) for k, v in buckets.items()}
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
        "current_run_date": _STATE["current"].run_date if _STATE["current"] else None,
        "current_model": _STATE["current"].model if _STATE["current"] else None,
    }


def summary() -> dict:
    """Headline payload: macro-averaged P/R/F1 for the latest run plus
    the prior-run baseline pulled from comparison.csv 'before' values."""
    cur = _STATE["current"]
    if cur is None:
        return {"available": False, "reason": "No comparison data on disk."}

    after_overall = _overall(cur, "after")
    before_overall = _overall(cur, "before")

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
    """Per-class P/R/F1 current + prior + delta for the latest run."""
    cur = _STATE["current"]
    if cur is None:
        return {"available": False, "classes": []}

    after = _by_metric(cur, "after")
    before = _by_metric(cur, "before")
    delta = _by_metric(cur, "delta")

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

    daily   — uses comparison.csv 'before' as the prior-day baseline.
              Always returns real numbers when comparison.csv is loaded.
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
        after_overall = _overall(cur, "after")
        before_overall = _overall(cur, "before")
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
        # Per-class delta for the daily view comes straight from the file.
        per_class = []
        after = _by_metric(cur, "after")
        before = _by_metric(cur, "before")
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
            "previous_run_date": _previous_date_label(cur.run_date, 1),
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
        "points_captured": len(series),
        "points_required": points_required,
    }


# ─── Date helpers ───────────────────────────────────────────────────────────


def _previous_date_label(run_date: str, days_back: int) -> Optional[str]:
    try:
        d = datetime.fromisoformat(run_date).date()
    except ValueError:
        return None
    return (d - timedelta(days=days_back)).isoformat()


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

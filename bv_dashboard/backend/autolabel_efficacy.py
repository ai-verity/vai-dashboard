"""
Auto-labeling efficacy pilot loader.

Reads pilot evaluation cycles that measure the auto-labeling script against a
human-verified ground-truth sample, per the Auto-Labeling Efficacy Measurement
Plan (BTX / VerityAI). Unlike ai_metrics.py (day-over-day training-pipeline
deltas) or lprnet_metrics.py (baseline-vs-trained OCR deltas), this is a
detection-eval scorecard: raw ground-truth / predicted / TP / FP / FN counts
per class and per frame (IoU >= 0.5, class-aware), scored against the plan's
Step 5 decision bands (>=80% F1 pre-label on, 60-80% review required, <60%
pre-label off). Precision/Recall/F1 and the policy band are derived here from
the raw counts rather than stored pre-computed, so a transcription error in
one number can't silently drift from the others.

Data layout — one sub-directory per pilot cycle, sortable by trailing
timestamp (same file-drop spirit as data/lprnet/):

  backend/data/autolabel_efficacy/
    <slug>-YYYYMMDD-HHMMSS/
      summary.json      # cycle meta + by_class + frame-level raw counts (REQUIRED)

Only summary.json is required. The latest cycle (by folder timestamp) is
`current`; earlier cycles become `history` — useful once Cycle 2 (1,000
frames) lands alongside Cycle 1 (100 frames).
"""

from __future__ import annotations

import json
import math
import os
import re
import threading
from datetime import datetime, timezone
from typing import Optional

DATA_DIR = os.path.join(os.path.dirname(__file__), "data", "autolabel_efficacy")

# Run folder: <slug>-YYYYMMDD-HHMMSS (slug may itself contain hyphens, e.g.
# "cycle1-100frames"). The trailing timestamp both identifies the run and
# provides the sort key (latest = current).
_RUN_DIR_RE = re.compile(r"^[a-z0-9_-]+-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$")

# Step 5 decision bands from the Measurement Plan (F1, per class).
_BAND_ON = 0.80
_BAND_REVIEW = 0.60

# Below this many ground-truth instances a class's score is treated as too
# noisy to act on (matches the plan's ~400-instance gold-set sizing logic,
# scaled down for a 100-frame pilot).
_SMALL_SAMPLE_GT = 10

# Fraction of gt>0 frames (by descending GT count) used for the "busiest
# frames" recall stat surfaced on the summary card.
_BUSIEST_QUARTILE = 0.25


def _new_state() -> dict:
    return {"loaded_at": None, "current": None, "history": []}


_LOCK = threading.Lock()
_STATE: dict = _new_state()


# ─── Small helpers ──────────────────────────────────────────────────────────


def _safe_div(n: float, d: float) -> Optional[float]:
    return (n / d) if d else None


def _prf1(tp: int, fp: int, fn: int) -> dict:
    # tp+fp == 0 means the script made zero positive claims for this class —
    # reported as 0.0 (nothing it produced was correct), not None, matching
    # both the pilot's own scorecard convention and scikit-learn's
    # zero_division=0 default. tp+fn == 0 (no ground truth at all) is the one
    # case left as None: recall genuinely can't be computed without a
    # denominator, though it doesn't occur in practice since every class row
    # here has at least one ground-truth instance.
    precision = 0.0 if (tp + fp) == 0 else _safe_div(tp, tp + fp)
    recall = _safe_div(tp, tp + fn)
    if precision is None or recall is None:
        f1 = None
    elif precision + recall == 0:
        f1 = 0.0
    else:
        f1 = 2 * precision * recall / (precision + recall)
    return {"precision": precision, "recall": recall, "f1": f1}


def _policy(f1: Optional[float]) -> str:
    if f1 is None:
        return "insufficient_data"
    if f1 >= _BAND_ON:
        return "pre_label_on"
    if f1 >= _BAND_REVIEW:
        return "review_required"
    return "pre_label_off"


def _class_warning(gt: int, pred: int) -> Optional[str]:
    if gt < _SMALL_SAMPLE_GT:
        return "small_sample"
    if pred == 0 and gt > 0:
        return "zero_predictions"
    return None


def _read_json(path: str) -> dict:
    if not os.path.exists(path):
        return {}
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, json.JSONDecodeError):
        return {}


# ─── Per-run assembly ───────────────────────────────────────────────────────


def _by_class(raw_rows: list[dict]) -> list[dict]:
    rows = []
    for r in raw_rows:
        gt, pred = int(r.get("gt", 0)), int(r.get("pred", 0))
        tp, fp, fn = int(r.get("tp", 0)), int(r.get("fp", 0)), int(r.get("fn", 0))
        metrics = _prf1(tp, fp, fn)
        rows.append({
            "cls": r.get("cls"),
            "gt": gt, "pred": pred, "tp": tp, "fp": fp, "fn": fn,
            "mean_iou": r.get("mean_iou"),
            **metrics,
            "policy": _policy(metrics["f1"]),
            "warning": _class_warning(gt, pred),
        })
    return rows


def _overall(by_class_rows: list[dict]) -> dict:
    gt = sum(r["gt"] for r in by_class_rows)
    pred = sum(r["pred"] for r in by_class_rows)
    tp = sum(r["tp"] for r in by_class_rows)
    fp = sum(r["fp"] for r in by_class_rows)
    fn = sum(r["fn"] for r in by_class_rows)
    metrics = _prf1(tp, fp, fn)
    # TP-weighted, not a plain average across classes — a class with more
    # matched boxes should count for more of the aggregate IoU.
    iou_weight_sum = sum(r["tp"] for r in by_class_rows if r.get("mean_iou") is not None)
    iou_dot = sum(r["mean_iou"] * r["tp"] for r in by_class_rows if r.get("mean_iou") is not None)
    return {
        "cls": "ALL", "gt": gt, "pred": pred, "tp": tp, "fp": fp, "fn": fn,
        "mean_iou": _safe_div(iou_dot, iou_weight_sum),
        **metrics,
        "policy": _policy(metrics["f1"]),
    }


def _frames(raw_frames: list[dict]) -> list[dict]:
    out = []
    for r in raw_frames:
        gt = int(r.get("gt", 0))
        out.append({
            "frame": r.get("frame"),
            "gt": gt,
            "pred": int(r.get("pred", 0)),
            "tp": int(r.get("tp", 0)),
            "fp": int(r.get("fp", 0)),
            "fn": int(r.get("fn", 0)),
            "mean_iou": r.get("mean_iou"),
            "confirmed_empty": gt == 0,
        })
    return out


def _busiest_quartile_recall(frames: list[dict]) -> Optional[dict]:
    """Recall on the busiest quarter of frames (by descending GT count, among
    frames with at least one ground-truth instance) — surfaces whether the
    script's recall collapses specifically in dense scenes."""
    with_gt = [f for f in frames if f["gt"] > 0]
    if not with_gt:
        return None
    ranked = sorted(with_gt, key=lambda f: f["gt"], reverse=True)
    n = max(1, math.ceil(len(ranked) * _BUSIEST_QUARTILE))
    top = ranked[:n]
    gt_total = sum(f["gt"] for f in top)
    tp_total = sum(f["tp"] for f in top)
    return {
        "frame_count": n,
        "gt_total": gt_total,
        "tp_total": tp_total,
        "recall": _safe_div(tp_total, gt_total),
    }


def _frame_stats(frames: list[dict]) -> dict:
    total = len(frames)
    empty = [f for f in frames if f["confirmed_empty"]]
    empty_fp = sum(f["fp"] for f in empty)
    total_fp = sum(f["fp"] for f in frames)
    return {
        "frames_scored": total,
        "confirmed_empty_frames": len(empty),
        "confirmed_empty_share": _safe_div(len(empty), total),
        "fp_from_empty_frames": empty_fp,
        "fp_from_empty_frames_share": _safe_div(empty_fp, total_fp),
        "busiest_quartile": _busiest_quartile_recall(frames),
    }


def _load_run(run_dir: str, slug: str, run_date: str, run_timestamp: str) -> Optional[dict]:
    data = _read_json(os.path.join(run_dir, "summary.json"))
    if not data:
        return None  # summary.json is the one required file
    by_class = _by_class(data.get("by_class", []))
    frames = _frames(data.get("frames", []))
    return {
        "slug": slug,
        "run_date": run_date,
        "run_timestamp": run_timestamp,
        "cycle": data.get("cycle"),
        "frame_count_target": data.get("frame_count_target"),
        "frame_count_note": data.get("frame_count_note"),
        "collection_window": data.get("collection_window"),
        "cameras": data.get("cameras", []),
        "methodology": data.get("methodology", []),
        "notes": data.get("notes", []),
        "by_class": by_class,
        "overall": _overall(by_class),
        "frames": frames,
        "frame_stats": _frame_stats(frames),
    }


def load() -> None:
    """(Re-)load every pilot-cycle folder under DATA_DIR. Safe to call from
    request handlers; mutex-guarded so concurrent reloads don't tear."""
    with _LOCK:
        runs: list[tuple[str, dict]] = []  # (ts_key, run)
        if os.path.isdir(DATA_DIR):
            for name in sorted(os.listdir(DATA_DIR)):
                m = _RUN_DIR_RE.match(name)
                if not m:
                    continue
                run_dir = os.path.join(DATA_DIR, name)
                if not os.path.isdir(run_dir):
                    continue
                y, mo, d, hh, mm, ss = m.groups()
                run_date = f"{y}-{mo}-{d}"
                ts_key = f"{y}{mo}{d}{hh}{mm}{ss}"
                run_timestamp = f"{y}-{mo}-{d}T{hh}:{mm}:{ss}+00:00"
                run = _load_run(run_dir, name, run_date, run_timestamp)
                if run is not None:
                    runs.append((ts_key, run))
        runs.sort(key=lambda t: t[0])
        history = [r for _, r in runs]
        _STATE["history"] = history
        _STATE["current"] = history[-1] if history else None
        _STATE["loaded_at"] = datetime.now(timezone.utc).isoformat()


# ─── Public accessors used by main.py ───────────────────────────────────────


def state() -> dict:
    cur = _STATE["current"]
    return {
        "loaded_at": _STATE["loaded_at"],
        "runs": len(_STATE["history"]),
        "current_run_date": cur["run_date"] if cur else None,
        "current_cycle": cur["cycle"] if cur else None,
    }


def summary() -> dict:
    """Headline payload: cycle meta, overall scorecard, and the frame-level
    empty-frame / busiest-quartile stats for the page header + KPI strip."""
    cur = _STATE["current"]
    if cur is None:
        return {"available": False, "reason": "No auto-labeling efficacy cycles on disk."}
    return {
        "available": True,
        "cycle": cur["cycle"],
        "run_date": cur["run_date"],
        "frame_count_target": cur["frame_count_target"],
        "frame_count_note": cur["frame_count_note"],
        "collection_window": cur["collection_window"],
        "cameras": cur["cameras"],
        "methodology": cur["methodology"],
        "notes": cur["notes"],
        "overall": cur["overall"],
        "frame_stats": cur["frame_stats"],
    }


def by_class() -> dict:
    cur = _STATE["current"]
    if cur is None:
        return {"available": False, "classes": [], "overall": None}
    return {
        "available": True,
        "run_date": cur["run_date"],
        "classes": cur["by_class"],
        "overall": cur["overall"],
    }


def frames() -> dict:
    cur = _STATE["current"]
    if cur is None:
        return {"available": False, "frames": [], "stats": None}
    return {
        "available": True,
        "run_date": cur["run_date"],
        "frames": cur["frames"],
        "stats": cur["frame_stats"],
    }


def history() -> dict:
    """Cross-cycle trend of the overall F1/Precision/Recall — activates once
    Cycle 2 (1,000 frames) lands alongside Cycle 1."""
    points = []
    for run in _STATE["history"]:
        points.append({
            "run_date": run["run_date"],
            "cycle": run["cycle"],
            "frame_count_target": run["frame_count_target"],
            "f1": run["overall"]["f1"],
            "precision": run["overall"]["precision"],
            "recall": run["overall"]["recall"],
        })
    return {
        "available": len(points) > 0,
        "points": points,
        "points_captured": len(points),
        "points_required": 2,
    }


# ─── Initial load on import ─────────────────────────────────────────────────

load()

"""
LPRNet OCR metrics loader.

Reads the LPRNet (license-plate OCR) fine-tuning pipeline output and exposes
structured views consumed by the /api/lprnet_metrics/* endpoints.

Unlike ai_metrics.py (object DETECTION — per-class Precision/Recall/F1/mAP),
this dataset is character RECOGNITION, so the metric shape is different:
sequence accuracy, character accuracy, character error rate (CER), mean edit
distance, and per-character-position accuracy — each reported as a
baseline (pretrained) vs trained (fine-tuned) pair with a delta.

Data layout expected — one sub-directory per run, the MLflow artifact tree
dropped onto disk verbatim (file-drop, same spirit as data/lpr/):

  backend/data/lprnet/
    lprnet-YYYYMMDD-HHMMSS/                 # run name = sortable timestamp
      run_meta.json                         # model + training + tao metadata
      comparison/comparison.csv             # baseline,trained,delta,pct,improvement (REQUIRED)
      eval/eval_custom.json                 # trained metrics + table refs
      eval/eval_custom_len_acc.csv          # per plate-length accuracy
      eval/eval_custom_editdist_hist.csv    # edit-distance histogram
      eval/eval_custom_confusion.csv        # 36x36 char confusion matrix
      eval/eval_custom_latency.json         # TensorRT FP16 latency / throughput
      baseline/eval_baseline.json           # baseline (pretrained) metrics
      dataset/dataset_summary.json          # crop counts, skip reasons, plate-len stats
      dataset/char_freq.csv                 # character frequency in the corpus
      dataset/plate_length.csv              # plate-length distribution
      logs/lprnet_training_log.csv          # epoch,accuracy,loss,lr curve

Only comparison/comparison.csv is required for a run to load; every other
file degrades to an empty/None field so the UI renders an empty-state panel
rather than breaking. The latest run (by folder timestamp) is `current`;
earlier runs become `history` for the trend charts.
"""

from __future__ import annotations

import csv
import json
import os
import re
import threading
from datetime import datetime, timezone
from typing import Optional

DATA_DIR = os.path.join(os.path.dirname(__file__), "data", "lprnet")

# Run folder: lprnet-YYYYMMDD-HHMMSS. The trailing timestamp both identifies
# the run and provides the sort key (latest = current).
_RUN_DIR_RE = re.compile(r"^lprnet-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$")

# The four headline OCR metrics surfaced as KPI cards, in display order.
# `lower_is_better` flips the delta-coloring (a drop in CER is an improvement).
HEADLINE_METRICS = (
    {"key": "seq_accuracy",       "label": "Sequence Accuracy", "lower_is_better": False},
    {"key": "char_accuracy",      "label": "Character Accuracy", "lower_is_better": False},
    {"key": "cer_mean",           "label": "Char Error Rate",    "lower_is_better": True},
    {"key": "edit_distance_mean", "label": "Mean Edit Distance", "lower_is_better": True},
)

_PER_POSITION_RE = re.compile(r"^per_position_accuracy_p(\d+)$")


# ─── Loader state (process-wide, thread-safe) ───────────────────────────────


def _new_state() -> dict:
    return {
        "loaded_at": None,
        "current": None,      # dict for the latest run (see _load_run)
        "history": [],        # list[dict] ascending by run timestamp
    }


_LOCK = threading.Lock()
_STATE: dict = _new_state()


# ─── Small parse helpers ────────────────────────────────────────────────────


def _parse_float(s) -> Optional[float]:
    if s is None:
        return None
    s = str(s).strip()
    if not s or s == "—":
        return None
    if s.startswith("+"):
        s = s[1:]
    try:
        f = float(s)
    except ValueError:
        return None
    # "nan"/"inf" parse as floats but aren't JSON-compliant — the training log
    # uses "nan" for epochs with no validation pass. Surface those as None so
    # the chart breaks the line rather than the response failing to serialize.
    if f != f or f in (float("inf"), float("-inf")):
        return None
    return f


def _parse_int(s) -> Optional[int]:
    f = _parse_float(s)
    return int(f) if f is not None else None


def _read_json(path: str) -> dict:
    if not os.path.exists(path):
        return {}
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, json.JSONDecodeError):
        return {}


def _read_csv_rows(path: str) -> list[dict]:
    if not os.path.exists(path):
        return []
    try:
        with open(path, newline="", encoding="utf-8") as fh:
            return list(csv.DictReader(fh))
    except OSError:
        return []


# ─── Per-file parsers ───────────────────────────────────────────────────────


def _read_comparison(path: str) -> dict:
    """Parse comparison.csv into {metric: {baseline, trained, delta, pct_change,
    improvement}}. Header: metric,baseline,trained,delta,pct_change,improvement."""
    out: dict[str, dict] = {}
    for row in _read_csv_rows(path):
        metric = (row.get("metric") or "").strip()
        if not metric:
            continue
        out[metric] = {
            "baseline": _parse_float(row.get("baseline")),
            "trained": _parse_float(row.get("trained")),
            "delta": _parse_float(row.get("delta")),
            "pct_change": (row.get("pct_change") or "").strip() or None,
            "improvement": (row.get("improvement") or "").strip() or None,
        }
    return out


def _per_position(comparison: dict) -> list[dict]:
    """Extract per_position_accuracy_pN rows, ordered by position, trimming
    trailing positions where BOTH baseline and trained are zero/None (real
    plates here are <=8 chars; the model emits up to p11 padded with zeros)."""
    rows: list[tuple[int, dict]] = []
    for metric, cell in comparison.items():
        m = _PER_POSITION_RE.match(metric)
        if not m:
            continue
        rows.append((int(m.group(1)), {
            "position": int(m.group(1)),
            "baseline": cell.get("baseline"),
            "trained": cell.get("trained"),
            "delta": cell.get("delta"),
        }))
    rows.sort(key=lambda t: t[0])
    ordered = [r for _, r in rows]
    # Trim trailing all-zero / all-null positions.
    while ordered:
        last = ordered[-1]
        b, t = last.get("baseline") or 0.0, last.get("trained") or 0.0
        if b == 0.0 and t == 0.0:
            ordered.pop()
        else:
            break
    return ordered


def _headline(comparison: dict) -> list[dict]:
    rows = []
    for spec in HEADLINE_METRICS:
        cell = comparison.get(spec["key"], {})
        rows.append({
            "key": spec["key"],
            "label": spec["label"],
            "lower_is_better": spec["lower_is_better"],
            "baseline": cell.get("baseline"),
            "trained": cell.get("trained"),
            "delta": cell.get("delta"),
            "pct_change": cell.get("pct_change"),
        })
    return rows


def _latency(eval_json: dict, latency_json: dict) -> dict:
    """Pull TensorRT FP16 latency + throughput from the latency sidecar,
    falling back to the same keys inside eval_custom.json."""
    src = latency_json.get("metrics") or {}
    if not src:
        src = {k: v for k, v in (eval_json.get("metrics") or {}).items()
               if k.startswith("trt_fp16_")}
    if not src:
        return {}
    g = src.get
    return {
        "min": g("trt_fp16_inference_ms_min"),
        "max": g("trt_fp16_inference_ms_max"),
        "mean": g("trt_fp16_inference_ms_mean"),
        "p50": g("trt_fp16_inference_ms_p50"),
        "p90": g("trt_fp16_inference_ms_p90"),
        "p95": g("trt_fp16_inference_ms_p95"),
        "p99": g("trt_fp16_inference_ms_p99"),
        "throughput_qps": g("trt_fp16_throughput_qps"),
        "warmup_ms": latency_json.get("warmup_ms"),
        "iters": latency_json.get("iters"),
    }


def _confusion(path: str) -> dict:
    """Parse the char confusion matrix. First column header is `gt\\pred`;
    remaining headers are predicted labels; each row is one ground-truth label.
    Returns {labels, rows:[{gt, counts:[...], total}]}."""
    raw = _read_csv_rows(path)
    if not raw:
        return {"labels": [], "rows": []}
    fieldnames = list(raw[0].keys())
    gt_key = fieldnames[0]
    labels = fieldnames[1:]
    rows = []
    for r in raw:
        gt = (r.get(gt_key) or "").strip()
        counts = [_parse_int(r.get(lbl)) or 0 for lbl in labels]
        rows.append({"gt": gt, "counts": counts, "total": sum(counts)})
    return {"labels": labels, "rows": rows}


def _len_acc(path: str) -> list[dict]:
    out = []
    for r in _read_csv_rows(path):
        out.append({
            "length": _parse_int(r.get("length")),
            "count": _parse_int(r.get("count")),
            "correct": _parse_int(r.get("correct")),
            "accuracy": _parse_float(r.get("accuracy")),
        })
    return out


def _editdist_hist(path: str) -> list[dict]:
    out = []
    for r in _read_csv_rows(path):
        out.append({
            "edit_distance": _parse_int(r.get("edit_distance")),
            "count": _parse_int(r.get("count")),
        })
    return out


def _char_freq(path: str) -> list[dict]:
    out = []
    for r in _read_csv_rows(path):
        out.append({
            "character": (r.get("character") or "").strip(),
            "count": _parse_int(r.get("count")),
        })
    return out


def _plate_length(path: str) -> list[dict]:
    out = []
    for r in _read_csv_rows(path):
        out.append({
            "length": _parse_int(r.get("length")),
            "count": _parse_int(r.get("count")),
        })
    return out


def _training_curve(path: str) -> list[dict]:
    """epoch,accuracy,loss,lr — accuracy is NaN on epochs without a validation
    pass; emit those as None so the chart can break the line."""
    out = []
    for r in _read_csv_rows(path):
        out.append({
            "epoch": _parse_int(r.get("epoch")),
            "accuracy": _parse_float(r.get("accuracy")),  # "nan" -> None
            "loss": _parse_float(r.get("loss")),
            "lr": _parse_float(r.get("lr")),
        })
    return out


# ─── Per-run assembly ───────────────────────────────────────────────────────


def _load_run(run_dir: str, run_name: str, run_date: str, run_timestamp: str) -> Optional[dict]:
    comp_path = os.path.join(run_dir, "comparison", "comparison.csv")
    comparison = _read_comparison(comp_path)
    if not comparison:
        return None  # comparison.csv is the one required file

    meta = _read_json(os.path.join(run_dir, "run_meta.json"))
    eval_json = _read_json(os.path.join(run_dir, "eval", "eval_custom.json"))
    latency_json = _read_json(os.path.join(run_dir, "eval", "eval_custom_latency.json"))
    dataset_summary = _read_json(os.path.join(run_dir, "dataset", "dataset_summary.json"))

    return {
        "run_name": meta.get("run_name") or run_name,
        "run_date": run_date,
        "run_timestamp": run_timestamp,
        "model": meta.get("model") or {},
        "training": meta.get("training") or {},
        "tao_eval": meta.get("tao_eval") or {},
        "worst_chars": meta.get("worst_chars") or {},
        "n_eval_samples": eval_json.get("n_eval_samples"),
        "comparison": comparison,
        "headline": _headline(comparison),
        "per_position": _per_position(comparison),
        "latency": _latency(eval_json, latency_json),
        "confusion": _confusion(os.path.join(run_dir, "eval", "eval_custom_confusion.csv")),
        "len_acc": _len_acc(os.path.join(run_dir, "eval", "eval_custom_len_acc.csv")),
        "editdist_hist": _editdist_hist(os.path.join(run_dir, "eval", "eval_custom_editdist_hist.csv")),
        "char_freq": _char_freq(os.path.join(run_dir, "dataset", "char_freq.csv")),
        "plate_length": _plate_length(os.path.join(run_dir, "dataset", "plate_length.csv")),
        "dataset_summary": dataset_summary,
        "training_curve": _training_curve(os.path.join(run_dir, "logs", "lprnet_training_log.csv")),
    }


def load() -> None:
    """(Re-)load every run folder under DATA_DIR. Safe to call from request
    handlers; mutex-guarded so concurrent reloads don't tear."""
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
                run_date = f"{y}-{mo}-{d} {hh}:{mm}"
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
        "current_run_name": cur["run_name"] if cur else None,
        "current_model": (cur["model"].get("arch") if cur else None),
    }


def summary() -> dict:
    """Headline payload: the four core OCR metrics (baseline vs trained) plus
    run / model metadata for the page header."""
    cur = _STATE["current"]
    if cur is None:
        return {"available": False, "reason": "No LPRNet runs on disk."}
    return {
        "available": True,
        "run_name": cur["run_name"],
        "run_date": cur["run_date"],
        "run_timestamp": cur["run_timestamp"],
        "model": cur["model"],
        "training": cur["training"],
        "tao_eval": cur["tao_eval"],
        "n_eval_samples": cur["n_eval_samples"],
        "headline": cur["headline"],
    }


def comparison() -> dict:
    """Full baseline→trained→delta table plus the trimmed per-position rows."""
    cur = _STATE["current"]
    if cur is None:
        return {"available": False}
    return {
        "available": True,
        "run_date": cur["run_date"],
        "metrics": cur["comparison"],
        "per_position": cur["per_position"],
        "worst_chars": cur["worst_chars"],
    }


def run_comparison() -> dict:
    """Run-over-run headline comparison — the OCR analogue of the detection
    tab's day-over-day view. Compares the current run's *trained* headline
    metrics against the previous run's *trained* values (the most recent prior
    snapshot on disk). When only one run exists there is no prior run, so we
    fall back to the current run's own *baseline* column and flag
    compared_to="baseline" (same fallback spirit as ai_metrics.comparison's
    daily mode)."""
    cur = _STATE["current"]
    if cur is None:
        return {"available": False}
    hist = _STATE["history"]
    prior = hist[-2] if len(hist) >= 2 else None
    prior_comp = prior["comparison"] if prior else None
    compared_to = "prior_run" if prior is not None else "baseline"

    rows = []
    for spec in HEADLINE_METRICS:
        key = spec["key"]
        cell = cur["comparison"].get(key, {})
        current = cell.get("trained")
        if prior_comp is not None:
            previous = prior_comp.get(key, {}).get("trained")
        else:
            previous = cell.get("baseline")
        delta = (
            current - previous
            if current is not None and previous is not None
            else None
        )
        rows.append({
            "key": key,
            "label": spec["label"],
            "lower_is_better": spec["lower_is_better"],
            "current": current,
            "previous": previous,
            "delta": delta,
        })

    # Per-position accuracy, run-over-run: this run's trained value at each
    # character slot vs the prior run's trained value (baseline fallback when
    # there is no prior run), unioning positions in case the two runs differ.
    cur_pp = {p["position"]: p for p in cur["per_position"]}
    prior_pp = {p["position"]: p for p in prior["per_position"]} if prior is not None else {}
    per_position = []
    for pos in sorted(set(cur_pp) | set(prior_pp)):
        c = cur_pp.get(pos, {})
        pos_current = c.get("trained")
        if prior is not None:
            pos_previous = prior_pp.get(pos, {}).get("trained")
        else:
            pos_previous = c.get("baseline")
        pos_delta = (
            pos_current - pos_previous
            if pos_current is not None and pos_previous is not None
            else None
        )
        per_position.append({
            "position": pos,
            "current": pos_current,
            "previous": pos_previous,
            "delta": pos_delta,
        })

    return {
        "available": True,
        "compared_to": compared_to,
        "current_run_date": cur["run_date"],
        "current_run_name": cur["run_name"],
        "previous_run_date": prior["run_date"] if prior is not None else None,
        "previous_run_name": prior["run_name"] if prior is not None else None,
        "headline": rows,
        "per_position": per_position,
    }


def detail() -> dict:
    """Edit-distance histogram, per-length accuracy, and latency/throughput."""
    cur = _STATE["current"]
    if cur is None:
        return {"available": False}
    return {
        "available": True,
        "run_date": cur["run_date"],
        "n_eval_samples": cur["n_eval_samples"],
        "len_acc": cur["len_acc"],
        "editdist_hist": cur["editdist_hist"],
        "latency": cur["latency"],
    }


def confusion() -> dict:
    cur = _STATE["current"]
    if cur is None:
        return {"available": False, "labels": [], "rows": []}
    c = cur["confusion"]
    return {"available": bool(c["labels"]), "run_date": cur["run_date"], **c}


def char_freq() -> dict:
    cur = _STATE["current"]
    if cur is None:
        return {"available": False, "points": []}
    return {"available": True, "run_date": cur["run_date"], "points": cur["char_freq"]}


def dataset() -> dict:
    """Dataset summary KPIs + plate-length distribution for the latest run."""
    cur = _STATE["current"]
    if cur is None:
        return {"available": False}
    return {
        "available": True,
        "run_date": cur["run_date"],
        "summary": cur["dataset_summary"],
        "plate_length": cur["plate_length"],
    }


def training() -> dict:
    cur = _STATE["current"]
    if cur is None:
        return {"available": False, "points": []}
    return {
        "available": True,
        "run_date": cur["run_date"],
        "points": cur["training_curve"],
        "best_epoch": cur["training"].get("best_epoch"),
    }


def history() -> dict:
    """Time-series of the headline OCR metrics (trained values) across runs —
    powers the multi-run trend chart once 2+ runs are on disk."""
    points = []
    for run in _STATE["history"]:
        comp = run["comparison"]
        points.append({
            "run_date": run["run_date"],
            "run_name": run["run_name"],
            "seq_accuracy": comp.get("seq_accuracy", {}).get("trained"),
            "char_accuracy": comp.get("char_accuracy", {}).get("trained"),
            "cer_mean": comp.get("cer_mean", {}).get("trained"),
            "edit_distance_mean": comp.get("edit_distance_mean", {}).get("trained"),
        })
    return {
        "available": len(points) > 0,
        "points": points,
        "points_captured": len(points),
        "points_required": 2,
    }


# ─── Initial load on import ─────────────────────────────────────────────────

load()

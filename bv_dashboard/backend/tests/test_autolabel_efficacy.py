"""Tests for the auto-labeling efficacy pilot loader + /api/autolabel_efficacy/*
endpoints.

Run from backend/:  python -m pytest tests/test_autolabel_efficacy.py -q

Isolation: a synthetic cycle folder is written into a tmp dir, the loader's
DATA_DIR is monkeypatched to it, and autolabel_efficacy.load() is re-run.
Tests never touch the real data/autolabel_efficacy/ folder. The app is driven
via TestClient without its lifespan context, so startup events don't fire.
"""
import json
import os

import pytest
from fastapi.testclient import TestClient

import main
import autolabel_efficacy


# ── fixtures ──────────────────────────────────────────────────────────────────

@pytest.fixture
def client():
    return TestClient(main.app)


def _write_cycle(root, run_name="cycle1-100frames-20260714-000000"):
    """Write a minimal-but-representative synthetic cycle folder."""
    run = os.path.join(root, run_name)
    os.makedirs(run, exist_ok=True)
    with open(os.path.join(run, "summary.json"), "w") as f:
        json.dump({
            "cycle": 1,
            "frame_count_target": 100,
            "frame_count_note": "synthetic pilot for tests",
            "collection_window": "2026-01-01 to 2026-01-02",
            "cameras": ["cam_1"],
            "methodology": ["Step 1", "Step 2"],
            "notes": ["A note."],
            "by_class": [
                # Below the small-sample floor (gt < 10) — should get warning="small_sample".
                {"cls": "bicycle", "gt": 1, "pred": 0, "tp": 0, "fp": 0, "fn": 1, "mean_iou": None},
                # Zero predictions on a non-trivial GT set — warning="zero_predictions".
                {"cls": "license_plate", "gt": 20, "pred": 0, "tp": 0, "fp": 0, "fn": 20, "mean_iou": None},
                # Clean class: tp=8,fp=2,fn=2 -> precision=.8, recall=.8, f1=.8 -> exactly on the "on" boundary.
                {"cls": "car", "gt": 10, "pred": 10, "tp": 8, "fp": 2, "fn": 2, "mean_iou": 0.9},
            ],
            "frames": [
                {"frame": "f1", "gt": 0, "pred": 5, "tp": 0, "fp": 5, "fn": 0, "mean_iou": 0.0},
                {"frame": "f2", "gt": 10, "pred": 10, "tp": 8, "fp": 2, "fn": 2, "mean_iou": 0.9},
            ],
        }, f)
    return run


@pytest.fixture
def loaded(tmp_path, monkeypatch):
    root = tmp_path / "autolabel_efficacy"
    root.mkdir()
    _write_cycle(str(root))
    monkeypatch.setattr(autolabel_efficacy, "DATA_DIR", str(root))
    autolabel_efficacy.load()
    yield
    # restore real data on teardown so other tests / the app see real cycles
    autolabel_efficacy.load()


@pytest.fixture
def empty(tmp_path, monkeypatch):
    root = tmp_path / "autolabel_efficacy_empty"
    root.mkdir()
    monkeypatch.setattr(autolabel_efficacy, "DATA_DIR", str(root))
    autolabel_efficacy.load()
    yield
    autolabel_efficacy.load()


# ── tests ─────────────────────────────────────────────────────────────────────

def test_summary_shape(client, loaded):
    r = client.get("/api/autolabel_efficacy/summary")
    assert r.status_code == 200
    j = r.json()
    assert j["available"] is True
    assert j["cycle"] == 1
    assert j["frame_count_target"] == 100
    overall = j["overall"]
    # tp=8, fp=2, fn=2 (bicycle/license_plate contribute nothing but fn)
    assert overall["tp"] == 8
    assert overall["gt"] == 31  # 1 + 20 + 10


def test_prf1_and_policy_bands(client, loaded):
    j = client.get("/api/autolabel_efficacy/by_class").json()
    by_cls = {r["cls"]: r for r in j["classes"]}

    car = by_cls["car"]
    assert car["precision"] == pytest.approx(0.8)
    assert car["recall"] == pytest.approx(0.8)
    assert car["f1"] == pytest.approx(0.8)
    assert car["policy"] == "pre_label_on"  # >= 0.80 boundary
    assert car["warning"] is None

    bicycle = by_cls["bicycle"]
    assert bicycle["f1"] == 0.0
    assert bicycle["policy"] == "pre_label_off"
    assert bicycle["warning"] == "small_sample"

    lp = by_cls["license_plate"]
    assert lp["f1"] == 0.0
    assert lp["warning"] == "zero_predictions"


def test_overall_mean_iou_is_tp_weighted(client, loaded):
    """Only 'car' carries a non-null mean_iou with tp=8; bicycle/license_plate
    are null. The aggregate should equal car's IoU exactly (weight = its own
    tp, nothing else contributes), not an unweighted average across classes."""
    j = client.get("/api/autolabel_efficacy/by_class").json()
    assert j["overall"]["mean_iou"] == pytest.approx(0.9)


def test_frames_endpoint_and_empty_frame_stats(client, loaded):
    j = client.get("/api/autolabel_efficacy/frames").json()
    assert j["available"] is True
    frames = {f["frame"]: f for f in j["frames"]}
    assert frames["f1"]["confirmed_empty"] is True
    assert frames["f2"]["confirmed_empty"] is False

    stats = j["stats"]
    assert stats["frames_scored"] == 2
    assert stats["confirmed_empty_frames"] == 1
    assert stats["confirmed_empty_share"] == pytest.approx(0.5)
    assert stats["fp_from_empty_frames"] == 5
    assert stats["fp_from_empty_frames_share"] == pytest.approx(5 / 7)  # total fp = 5 + 2


def test_history_and_state(client, loaded):
    h = client.get("/api/autolabel_efficacy/history").json()
    assert h["available"] is True
    assert h["points_captured"] == 1
    assert h["points"][0]["cycle"] == 1

    s = client.get("/api/autolabel_efficacy/state").json()
    assert s["runs"] == 1
    assert s["current_cycle"] == 1


def test_empty_state_when_no_cycles_on_disk(client, empty):
    r = client.get("/api/autolabel_efficacy/summary")
    assert r.status_code == 200
    j = r.json()
    assert j["available"] is False

    by_class = client.get("/api/autolabel_efficacy/by_class").json()
    assert by_class["available"] is False
    assert by_class["classes"] == []

    frames = client.get("/api/autolabel_efficacy/frames").json()
    assert frames["available"] is False
    assert frames["frames"] == []


def test_reload_requires_token(client, loaded, monkeypatch):
    monkeypatch.delenv("BV_RELOAD_TOKEN", raising=False)
    r = client.post("/api/autolabel_efficacy/reload")
    assert r.status_code == 503

    monkeypatch.setenv("BV_RELOAD_TOKEN", "secret")
    r = client.post("/api/autolabel_efficacy/reload")
    assert r.status_code == 401

    r = client.post("/api/autolabel_efficacy/reload", headers={"X-Reload-Token": "secret"})
    assert r.status_code == 200

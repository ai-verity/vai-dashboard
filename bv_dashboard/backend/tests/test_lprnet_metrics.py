"""Tests for the LPRNet OCR metrics loader + /api/lprnet_metrics/* endpoints.

Run from backend/:  python -m pytest tests/test_lprnet_metrics.py -q

Isolation: a synthetic run folder is written into a tmp dir, the loader's
DATA_DIR is monkeypatched to it, and lprnet_metrics.load() is re-run. Tests
never touch the real data/lprnet/ folder. The app is driven via TestClient
without its lifespan context, so startup events don't fire.
"""
import json
import os

import pytest
from fastapi.testclient import TestClient

import main
import lprnet_metrics


# ── fixtures ──────────────────────────────────────────────────────────────────

@pytest.fixture
def client():
    return TestClient(main.app)


def _write_run(root, run_name="lprnet-20260618-132323"):
    """Write a minimal-but-complete synthetic run tree under root/run_name."""
    run = os.path.join(root, run_name)
    for sub in ("comparison", "eval", "baseline", "dataset", "logs"):
        os.makedirs(os.path.join(run, sub), exist_ok=True)

    with open(os.path.join(run, "comparison", "comparison.csv"), "w") as f:
        f.write(
            "metric,baseline,trained,delta,pct_change,improvement\n"
            "seq_accuracy,0.000000,0.500000,+0.500000,—,↑\n"
            "char_accuracy,0.500000,0.800000,+0.300000,+60.0%,↑\n"
            "cer_mean,0.500000,0.200000,-0.300000,-60.0%,↑\n"
            "edit_distance_mean,3.000000,1.000000,-2.000000,-66.7%,↑\n"
            "per_position_accuracy_p0,0.100000,0.700000,+0.600000,+600.0%,·\n"
            "per_position_accuracy_p1,0.300000,0.600000,+0.300000,+100.0%,·\n"
            # trailing all-zero positions — loader should trim these:
            "per_position_accuracy_p7,0.000000,0.000000,+0.000000,—,·\n"
            "per_position_accuracy_p8,0.000000,0.000000,+0.000000,—,·\n"
        )
    with open(os.path.join(run, "run_meta.json"), "w") as f:
        json.dump({
            "run_name": run_name,
            "model": {"arch": "baseline", "nlayers": "18", "characters_count": "36"},
            "training": {"best_epoch": 31, "epochs_done": 100, "best_seq_accuracy": 0.5},
            "tao_eval": {"tao_accuracy": 0.55, "tao_correct": 57, "tao_total": 102},
        }, f)
    with open(os.path.join(run, "eval", "eval_custom.json"), "w") as f:
        json.dump({"n_eval_samples": 96, "metrics": {}}, f)
    with open(os.path.join(run, "eval", "eval_custom_latency.json"), "w") as f:
        json.dump({"metrics": {"trt_fp16_inference_ms_mean": 0.65,
                               "trt_fp16_throughput_qps": 1494.5}}, f)
    with open(os.path.join(run, "eval", "eval_custom_len_acc.csv"), "w") as f:
        f.write("length,count,correct,accuracy\n7,88,45,0.511364\n")
    with open(os.path.join(run, "eval", "eval_custom_editdist_hist.csv"), "w") as f:
        f.write("edit_distance,count\n0,51\n1,7\n")
    with open(os.path.join(run, "eval", "eval_custom_confusion.csv"), "w") as f:
        f.write("gt\\pred,0,1\n0,40,1\n1,2,34\n")
    with open(os.path.join(run, "dataset", "dataset_summary.json"), "w") as f:
        json.dump({"n_crops": 510, "train_size": 408, "val_size": 102,
                   "plate_length_mean": 6.8, "skipped": {"no_text": 7323}}, f)
    with open(os.path.join(run, "dataset", "char_freq.csv"), "w") as f:
        f.write("character,count\n0,218\nA,14\n")
    with open(os.path.join(run, "dataset", "plate_length.csv"), "w") as f:
        f.write("length,count\n7,458\n")
    # training log includes a "nan" accuracy row — must serialize as null, not NaN.
    with open(os.path.join(run, "logs", "lprnet_training_log.csv"), "w") as f:
        f.write("epoch,accuracy,loss,lr\n0,nan,46.5,1e-06\n1,0.0,26.3,2e-06\n"
                "2,0.54,0.22,1e-06\n")
    return run


@pytest.fixture
def loaded(tmp_path, monkeypatch):
    """Redirect the loader at a tmp run tree and reload."""
    root = tmp_path / "lprnet"
    root.mkdir()
    _write_run(str(root))
    monkeypatch.setattr(lprnet_metrics, "DATA_DIR", str(root))
    lprnet_metrics.load()
    yield
    # restore real data on teardown so other tests / the app see real runs
    lprnet_metrics.load()


@pytest.fixture
def empty(tmp_path, monkeypatch):
    root = tmp_path / "lprnet_empty"
    root.mkdir()
    monkeypatch.setattr(lprnet_metrics, "DATA_DIR", str(root))
    lprnet_metrics.load()
    yield
    lprnet_metrics.load()


# ── tests ───────────────────────────────────────────────────────────────────

def test_summary_shape(client, loaded):
    r = client.get("/api/lprnet_metrics/summary")
    assert r.status_code == 200
    j = r.json()
    assert j["available"] is True
    assert j["run_name"] == "lprnet-20260618-132323"
    assert j["model"]["arch"] == "baseline"
    assert j["n_eval_samples"] == 96
    by_key = {h["key"]: h for h in j["headline"]}
    assert by_key["seq_accuracy"]["trained"] == 0.5
    # CER + edit distance are flagged lower-is-better
    assert by_key["cer_mean"]["lower_is_better"] is True
    assert by_key["edit_distance_mean"]["lower_is_better"] is True


def test_comparison_trims_trailing_zero_positions(client, loaded):
    j = client.get("/api/lprnet_metrics/comparison").json()
    assert j["available"] is True
    positions = [p["position"] for p in j["per_position"]]
    # p7/p8 were all-zero → trimmed; p0/p1 kept.
    assert positions == [0, 1]
    assert "seq_accuracy" in j["metrics"]


def test_detail_and_latency(client, loaded):
    j = client.get("/api/lprnet_metrics/detail").json()
    assert j["available"] is True
    assert j["len_acc"][0]["length"] == 7
    assert j["editdist_hist"][0]["edit_distance"] == 0
    assert j["latency"]["throughput_qps"] == 1494.5


def test_confusion_shape(client, loaded):
    j = client.get("/api/lprnet_metrics/confusion").json()
    assert j["available"] is True
    assert j["labels"] == ["0", "1"]
    assert j["rows"][0]["gt"] == "0"
    assert j["rows"][0]["total"] == 41  # 40 + 1


def test_dataset_and_char_freq(client, loaded):
    ds = client.get("/api/lprnet_metrics/dataset").json()
    assert ds["available"] is True
    assert ds["summary"]["n_crops"] == 510
    assert ds["plate_length"][0]["length"] == 7
    cf = client.get("/api/lprnet_metrics/char_freq").json()
    assert cf["available"] is True
    assert cf["points"][0]["character"] == "0"


def test_training_nan_becomes_null(client, loaded):
    """The 'nan' accuracy row must serialize as JSON null, not crash the
    response (NaN is not JSON-compliant)."""
    r = client.get("/api/lprnet_metrics/training")
    assert r.status_code == 200
    j = r.json()
    assert j["points"][0]["accuracy"] is None      # was "nan"
    assert j["points"][1]["accuracy"] == 0.0
    assert j["best_epoch"] == 31


def test_history(client, loaded):
    j = client.get("/api/lprnet_metrics/history").json()
    assert j["available"] is True
    assert j["points_captured"] == 1
    assert j["points"][0]["seq_accuracy"] == 0.5


def test_empty_state(client, empty):
    assert client.get("/api/lprnet_metrics/summary").json()["available"] is False
    assert client.get("/api/lprnet_metrics/comparison").json()["available"] is False
    assert client.get("/api/lprnet_metrics/confusion").json()["available"] is False
    assert client.get("/api/lprnet_metrics/state").json()["runs"] == 0


def test_required_file_gate(tmp_path, monkeypatch, client):
    """A run folder with no comparison.csv is skipped (not loaded as a run)."""
    root = tmp_path / "lprnet_partial"
    incomplete = root / "lprnet-20260101-000000" / "eval"
    incomplete.mkdir(parents=True)
    (incomplete / "eval_custom.json").write_text("{}")
    monkeypatch.setattr(lprnet_metrics, "DATA_DIR", str(root))
    lprnet_metrics.load()
    try:
        assert client.get("/api/lprnet_metrics/state").json()["runs"] == 0
    finally:
        lprnet_metrics.load()

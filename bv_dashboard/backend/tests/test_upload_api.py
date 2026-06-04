"""Unit tests for the CSV upload APIs, plus guards that existing routes stay intact.

Run from backend/:  python -m pytest tests/ -q

Isolation: each upload test redirects the dataset's data dir to a tmp dir and
stubs the loader, so tests never touch the real data/ folders and run fast. The
app is driven via TestClient WITHOUT its lifespan context manager, so startup
events (real CSV load + live-feed network fetch) don't run.
"""
import io
import os

import pytest
from fastapi.testclient import TestClient

import main
import vlm
import ai_metrics


# ── fixtures ──────────────────────────────────────────────────────────────────

@pytest.fixture
def client():
    # No context manager → startup/shutdown events are not triggered.
    return TestClient(main.app)


@pytest.fixture
def sandbox(tmp_path, monkeypatch):
    """Point every upload target at a tmp dir and stub the loaders.

    The endpoints read these as attributes at call time, so monkeypatching the
    module attributes fully redirects writes + reloads away from real data.
    """
    vdir = tmp_path / "vlm_outputs"
    adir = tmp_path / "ai_model_metrics"
    ldir = tmp_path / "lpr"
    for d in (vdir, adir, ldir):
        d.mkdir()

    monkeypatch.setattr(vlm, "DATA_DIR", str(vdir))
    monkeypatch.setattr(ai_metrics, "DATA_DIR", str(adir))
    monkeypatch.setattr(ai_metrics, "LPR_DATA_DIR", str(ldir))

    calls = {"vlm": 0, "ai": 0, "lpr": 0}

    def vlm_load_all():
        calls["vlm"] += 1
        files = [{"name": n, "rows": 1}
                 for n in sorted(os.listdir(str(vdir))) if n.endswith(".csv")]
        return {"row_count": len(files), "files": files, "loaded_at": "test"}

    monkeypatch.setattr(vlm, "load_all", vlm_load_all)
    monkeypatch.setattr(ai_metrics, "load", lambda: calls.__setitem__("ai", calls["ai"] + 1))
    monkeypatch.setattr(ai_metrics, "state", lambda: {"runs": 1})
    monkeypatch.setattr(ai_metrics.lpr, "load", lambda: calls.__setitem__("lpr", calls["lpr"] + 1))
    monkeypatch.setattr(ai_metrics.lpr, "state", lambda: {"runs": 1})

    return {"vdir": vdir, "adir": adir, "ldir": ldir, "calls": calls}


VLM_HEADER = "run_id,file_name,preset,full_caption\n"
VLM_ROW = 'R1,img.jpg,crowd_behavior,"a caption"\n'
METRICS_CSV = "class,metric,before,after,delta\ncar,Precision,0.80,0.85,0.05\n"


def _post(client, url, filename, content):
    data = content.encode() if isinstance(content, str) else content
    return client.post(url, files={"file": (filename, io.BytesIO(data), "text/csv")})


# ── success paths ───────────────────────────────────────────────────────────

def test_vlm_upload_success(client, sandbox):
    name = "vlm_full_captions_T_crowd_behavior.csv"
    r = _post(client, "/api/vlm/upload", name, VLM_HEADER + VLM_ROW)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["filename"] == name
    assert (sandbox["vdir"] / name).exists()
    assert sandbox["calls"]["vlm"] == 1


def test_ai_metrics_upload_success(client, sandbox):
    name = "comparison_20260101.csv"
    r = _post(client, "/api/ai_metrics/upload", name, METRICS_CSV)
    assert r.status_code == 200, r.text
    assert r.json()["filename"] == name
    assert (sandbox["adir"] / name).exists()
    assert sandbox["calls"]["ai"] == 1


def test_lpr_upload_success(client, sandbox):
    name = "comparison_20260101_010101.csv"
    r = _post(client, "/api/lpr_metrics/upload", name, METRICS_CSV)
    assert r.status_code == 200, r.text
    assert (sandbox["ldir"] / name).exists()
    assert sandbox["calls"]["lpr"] == 1


def test_compare_timestamped_name_accepted_for_ai_metrics(client, sandbox):
    name = "compare_20260101_010101_comparison.csv"
    r = _post(client, "/api/ai_metrics/upload", name, METRICS_CSV)
    assert r.status_code == 200, r.text
    assert (sandbox["adir"] / name).exists()


# ── rejection paths ───────────────────────────────────────────────────────────

def test_rejects_non_csv(client, sandbox):
    r = _post(client, "/api/vlm/upload", "notes.txt", "hello")
    assert r.status_code == 400
    assert r.json()["detail"] == "file must be a .csv"
    assert sandbox["calls"]["vlm"] == 0
    assert list(sandbox["vdir"].iterdir()) == []  # nothing persisted


def test_vlm_rejects_missing_columns(client, sandbox):
    r = _post(client, "/api/vlm/upload", "x.csv", "run_id,preset\nR1,crowd\n")
    assert r.status_code == 400
    assert "full_caption" in r.json()["detail"]
    assert sandbox["calls"]["vlm"] == 0


def test_ai_metrics_rejects_bad_filename(client, sandbox):
    r = _post(client, "/api/ai_metrics/upload", "random_name.csv", METRICS_CSV)
    assert r.status_code == 400
    assert "pattern" in r.json()["detail"]
    assert sandbox["calls"]["ai"] == 0
    assert list(sandbox["adir"].iterdir()) == []


def test_lpr_rejects_date_only_filename(client, sandbox):
    # date-only is valid for ai_metrics but NOT for lpr (which requires HHMMSS)
    r = _post(client, "/api/lpr_metrics/upload", "comparison_20260101.csv", METRICS_CSV)
    assert r.status_code == 400
    assert sandbox["calls"]["lpr"] == 0


def test_metrics_rejects_missing_columns(client, sandbox):
    r = _post(client, "/api/ai_metrics/upload", "comparison_20260101.csv", "class,metric\ncar,F1\n")
    assert r.status_code == 400
    assert "after" in r.json()["detail"]


def test_oversize_rejected(client, sandbox, monkeypatch):
    monkeypatch.setattr(main, "_UPLOAD_MAX_BYTES", 10)
    r = _post(client, "/api/vlm/upload", "vlm_T_crowd_behavior.csv", VLM_HEADER + VLM_ROW * 50)
    assert r.status_code == 413
    # streamed temp file must be cleaned up on failure
    assert not any(p.name.endswith(".uploading") for p in sandbox["vdir"].iterdir())


def test_empty_file_rejected(client, sandbox):
    r = _post(client, "/api/vlm/upload", "empty.csv", "")
    assert r.status_code == 400


def test_path_traversal_neutralized(client, sandbox):
    # a traversal-y name must be reduced to its basename inside the data dir
    r = _post(client, "/api/vlm/upload",
              "../../../tmp/evil_crowd_behavior.csv", VLM_HEADER + VLM_ROW)
    assert r.status_code == 200, r.text
    assert (sandbox["vdir"] / "evil_crowd_behavior.csv").exists()
    assert not os.path.exists("/tmp/evil_crowd_behavior.csv")


def test_no_temp_left_after_validation_failure(client, sandbox):
    _post(client, "/api/vlm/upload", "bad.csv", "wrong,cols\n1,2\n")
    assert not any(p.name.endswith(".uploading") for p in sandbox["vdir"].iterdir())


# ── existing functionality must be unaffected ─────────────────────────────────

def test_health_ok(client):
    assert client.get("/api/health").status_code == 200


def test_existing_and_new_routes_present(client):
    paths = client.get("/openapi.json").json()["paths"]
    for p in [
        "/api/vlm/feeds", "/api/vlm/reload", "/api/stats/kpi",
        "/api/ai_metrics/summary", "/api/ai_metrics/reload",
        "/api/lpr_metrics/summary", "/api/lpr_metrics/reload",
        "/api/incidents", "/api/analyze",
    ]:
        assert p in paths, f"pre-existing route missing: {p}"
    for p in ["/api/vlm/upload", "/api/ai_metrics/upload", "/api/lpr_metrics/upload"]:
        assert p in paths, f"new upload route missing: {p}"


@pytest.mark.parametrize("url", [
    "/api/vlm/reload", "/api/ai_metrics/reload", "/api/lpr_metrics/reload",
])
def test_reload_still_token_gated(client, url, monkeypatch):
    # With no BV_RELOAD_TOKEN set, the reload endpoints stay fail-closed (503).
    monkeypatch.delenv("BV_RELOAD_TOKEN", raising=False)
    assert client.post(url).status_code == 503

# Brownsville TX — Public Safety Dashboard

Vite + React + TypeScript frontend with a FastAPI + Python backend. Displays curated and synthetic incident data, time-of-day heatmaps, location hotspots, and a separate VLM (vision-language model) caption explorer.

---

## Stack

| Layer    | Technology                                              |
|----------|---------------------------------------------------------|
| Frontend | Vite · React 19 · TypeScript                            |
| Charts   | Hand-rolled HTML5 canvas (no chart library)             |
| Backend  | FastAPI · Python 3.10+ · uvicorn · httpx                |
| Styling  | CSS variables · DM Mono · Barlow Condensed              |
| AI       | Anthropic Claude (optional, via `ANTHROPIC_API_KEY`)    |

---

## Project Structure

```
bv_dashboard/
├── backend/
│   ├── main.py              FastAPI app, incident routes, AI analyze stream
│   ├── vlm.py               VLM CSV loader and aggregation helpers
│   └── data/
│       ├── vlm_full_captions_*.csv     VLM caption exports
│       └── vlm_prompts.json            Prompt catalog served at /api/vlm/prompts
├── frontend/
│   ├── src/
│   │   ├── App.tsx                     Top-level view switcher (Dashboard / Charts / VLM)
│   │   ├── components/                 TopNav, KpiStrip, IncidentFeed, IncidentMap,
│   │   │                               AlertTicker, CategoryPanel, DetailPanel,
│   │   │                               LocationStrip, MiniTimeline
│   │   ├── hooks/useApi.ts             Data-fetching hooks + streaming AI hook
│   │   ├── pages/                      DashboardPage, ChartsPage, VlmPage
│   │   └── types/index.ts              Shared TS types and API base URL
│   ├── vite.config.ts                  Dev proxy /api → localhost:8000
│   └── package.json
└── start.sh                            Convenience launcher for backend + frontend
```

---

## Prerequisites

Install once on your machine:

- **Python 3.10+** (3.12 recommended) — check with `python3 --version`
- **Node.js 18+** and **npm 9+** — check with `node --version` / `npm --version`
- **pip** (ships with Python)
- macOS or Linux shell (for `start.sh`); Windows users should run the backend and frontend in two separate terminals

Optional:
- **Anthropic API key** if you want live AI incident analysis. Without it the backend serves a rule-based fallback.

---

## How to run the application

The fastest path is the `start.sh` script. The manual steps below give you finer control.

### Option A — One-shot launch (recommended)

From the `bv_dashboard/` directory:

```bash
chmod +x start.sh        # first time only
./start.sh
```

This boots the FastAPI backend on `http://localhost:8000` and the Vite dev server on `http://localhost:5173`. Press `Ctrl+C` to stop both.

Note: `start.sh` does not install dependencies. Run the install steps below at least once before using it.

### Option B — Run backend and frontend manually (two terminals)

**Terminal 1 — Backend**

```bash
cd bv_dashboard/backend

# (Recommended) create a virtual environment
python3 -m venv .venv
source .venv/bin/activate                 # Windows: .venv\Scripts\activate

# Install Python dependencies
pip install fastapi uvicorn httpx pydantic

# (Optional) enable live AI analysis
export ANTHROPIC_API_KEY=sk-ant-...       # Windows: set ANTHROPIC_API_KEY=sk-ant-...

# Start the API server (hot reload enabled)
uvicorn main:app --reload --port 8000
```

Verify the backend is up:

```bash
curl http://localhost:8000/api/health
# → {"status":"ok", "incidents": ..., "vlm_observations": ...}
```

Interactive API docs: `http://localhost:8000/docs`

**Terminal 2 — Frontend**

```bash
cd bv_dashboard/frontend

# Install Node dependencies (first run, takes a minute)
npm install

# Start the dev server
npm run dev
```

Open the dashboard:

```
http://localhost:5173
```

The Vite dev server proxies `/api/*` to `http://localhost:8000` (see `vite.config.ts`), so the backend must be running first.

### Option C — Production build of the frontend

```bash
cd bv_dashboard/frontend
npm run build            # type-check + bundle to dist/
npm run preview          # serve the built bundle on http://localhost:4173
```

Serve the contents of `dist/` from any static host. Make sure the backend is reachable at the URL the frontend expects (see *Configuration* below).

---

## Data files

The backend reads from `bv_dashboard/backend/data/`:

| File                                            | Purpose                                    |
|-------------------------------------------------|--------------------------------------------|
| `vlm_full_captions_*.csv`                       | VLM caption rows loaded at startup         |
| `vlm_prompts.json`                              | Prompt catalog returned by `/api/vlm/prompts` |

Both CSV files are loaded on startup (~20 MB total). After editing or replacing them, either restart the backend or hit:

```bash
curl -X POST http://localhost:8000/api/vlm/reload
```

The incident list (`/api/incidents`) is generated in memory by `main.py` — no external incident file is required.

---

## Configuration

| Variable / setting        | Where                                       | Default                  | Notes                                       |
|---------------------------|---------------------------------------------|--------------------------|---------------------------------------------|
| `ANTHROPIC_API_KEY`       | Backend environment                         | unset (uses fallback)    | Enables live LLM-streamed analysis          |
| Backend port              | `uvicorn ... --port 8000` / `start.sh`      | `8000`                   | Change in both places if you re-bind        |
| Frontend dev port         | Vite default                                | `5173`                   | Override with `npm run dev -- --port NNNN`  |
| Frontend → backend URL    | `frontend/src/types/index.ts` (`API_BASE`)  | `http://localhost:8000`  | Edit for non-local deployments              |
| Dev proxy                 | `frontend/vite.config.ts`                   | `/api → :8000`           | Only active under `npm run dev`             |

---

## API Endpoints

### Incidents and stats

| Method | Path                                | Description                            |
|--------|-------------------------------------|----------------------------------------|
| GET    | `/api/health`                       | Liveness check + record counts         |
| GET    | `/api/incidents`                    | Paginated incident list with filters   |
| GET    | `/api/incidents/{id}`               | Single incident detail                 |
| GET    | `/api/stats/kpi`                    | Headline KPI metrics                   |
| GET    | `/api/stats/monthly`                | Monthly breakdown                      |
| GET    | `/api/stats/by_category`            | Category totals + average severity     |
| GET    | `/api/stats/by_location`            | Top locations                          |
| GET    | `/api/stats/severity_distribution`  | Severity tier counts                   |
| GET    | `/api/stats/heatmap`                | Hour × weekday matrix                  |
| GET    | `/api/stats/type_ranking`           | Top incident types                     |
| GET    | `/api/locations`                    | Monitored locations                    |
| POST   | `/api/analyze`                      | Streaming AI analysis (SSE)            |

### VLM caption explorer

| Method | Path                          | Description                                  |
|--------|-------------------------------|----------------------------------------------|
| GET    | `/api/vlm/list`               | Paginated VLM observations with filters      |
| GET    | `/api/vlm/{id}`               | Single VLM observation detail                |
| GET    | `/api/vlm/feeds`              | Camera-feed roll-up                          |
| GET    | `/api/vlm/runs`               | Per-run roll-up                              |
| GET    | `/api/vlm/stats`              | Counts by risk / density / threat            |
| GET    | `/api/vlm/aggregates`         | Pre-computed charts (hour × risk, etc.)      |
| GET    | `/api/vlm/prompts`            | Prompt catalog                               |
| POST   | `/api/vlm/reload`             | Re-read CSV/JSON from disk                   |

---

## Dashboard tabs

### Dashboard
KPI strip, alert ticker, SVG incident map, filterable incident feed, category breakdown, location hotspots, mini stacked timeline, and an incident detail panel that streams AI analysis from `/api/analyze`.

### Charts & Trends
Seven canvas-rendered visualizations: monthly volume, category breakdown by month, average severity trend, severity distribution donut, top locations bar, time-of-day heatmap, and an incident-type ranking — plus four insight cards.

### VLM
Browser for the VLM caption dataset: filter by feed, run, risk, density, threat flag; per-observation detail panel; and chart aggregates (hourly risk, feed density, threat-flag counts).

---

## Troubleshooting

| Symptom                                              | Fix                                                                                         |
|------------------------------------------------------|---------------------------------------------------------------------------------------------|
| `uvicorn: command not found`                         | Activate the venv (`source .venv/bin/activate`) or `pip install uvicorn`                    |
| `ModuleNotFoundError: vlm`                           | Run `uvicorn` from inside `bv_dashboard/backend/` so Python can find `vlm.py`               |
| Frontend shows skeletons forever                     | Backend isn't running — start it first; check `curl http://localhost:8000/api/health`        |
| `EADDRINUSE` on 8000 or 5173                         | Another process holds the port. Stop it (`lsof -i :8000`) or change the port                |
| AI analysis returns canned text                      | `ANTHROPIC_API_KEY` is missing or invalid. Set it in the **backend** terminal and restart   |
| Edited a CSV but nothing changed                     | `POST /api/vlm/reload` or restart the backend                                               |
| `npm install` fails on TypeScript / Vite versions    | Delete `node_modules` and `package-lock.json`, then retry; some pins may need adjustment    |
| CORS error in browser console                        | You're hitting the backend from an origin not allowed in `main.py` CORS config              |

---

## Data Sources
- Verified real incidents from BPD, KRGV, City of Brownsville (Jan–May 2026)
- ~250 statistically grounded synthetic incidents across five months
- Monthly volume weights reflect the documented Feb 2026 spike (fatal stabbings, shootings)
- VLM CSVs: crowd-behavior captions produced by an upstream vision-language model

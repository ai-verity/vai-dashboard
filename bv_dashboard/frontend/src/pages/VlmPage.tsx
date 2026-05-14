// pages/VlmPage.tsx
import { useMemo, useState } from 'react';
import {
  useVlmList, useVlmFeeds, useVlmStats, useVlmPrompts, useVlmOne, useVlmAggregates, useVlmRuns,
} from '../hooks/useApi';
import { API_BASE } from '../types';
import type { VlmAggregates } from '../types';
import type { VlmListParams } from '../hooks/useApi';
import { setupCanvas, useCanvas } from '../utils/canvas';

const MODEL_NAME = 'nvidia/cosmos-reason2-8b';

const PAGE_SIZE = 50;

const DENSITY_COLOR: Record<string, string> = {
  SPARSE: '#2DC9A8',
  MODERATE: '#F5B731',
  DENSE: '#EF4444',
};
const RISK_COLOR: Record<string, string> = {
  LOW: '#2DC9A8',
  MODERATE: '#F5B731',
  HIGH: '#EF4444',
};

// Per-frame section roll-up definition.
// Each section knows which Q-numbers feed it and how to summarize them.
type SectionSummary = { value: string; flagCount: number; questionCount: number; highlight?: string };

function isYes(text: string | undefined): boolean {
  if (!text) return false;
  const t = text.trim().toLowerCase();
  if (t.startsWith('no') || t.startsWith('not applicable') || t.startsWith('none') || t.startsWith('zero')) return false;
  if (t.startsWith('yes')) return true;
  return false;
}
function extractNumber(text: string | undefined): number | null {
  if (!text) return null;
  if (/\bzero\b/i.test(text) || /\bno (pedestrian|individual|people|person|crowd|attend)/i.test(text)) return 0;
  const m1 = text.match(/(?:approximately\s+)?(\d+)\s+(pedestrian|individual|person|attendee|people|child|children)/i);
  if (m1) return parseInt(m1[1], 10);
  const m2 = text.trim().match(/^(\d+)/);
  if (m2) return parseInt(m2[1], 10);
  return null;
}
function summarizeAnswers(answers: Record<string, string> | undefined): Record<string, SectionSummary> {
  const a = answers ?? {};
  const get = (n: number) => a[String(n)];
  const yesIn = (qs: number[]) => qs.filter(n => isYes(get(n))).length;

  const density = (get(2) ?? '').toUpperCase().match(/DENSE|MODERATE|SPARSE/)?.[0] ?? '—';
  const risk = (get(6) ?? '').toUpperCase().match(/HIGH|MODERATE|MEDIUM|LOW/)?.[0]?.replace('MEDIUM', 'MODERATE') ?? '—';
  const peds = extractNumber(get(3));
  const attendance = extractNumber(get(11));
  const childCount = extractNumber(get(14));

  return {
    'CROWD DENSITY & ZONES':   { value: density, flagCount: 0, questionCount: 2, highlight: DENSITY_COLOR[density] },
    'PEDESTRIAN ACTIVITY':     { value: peds === null ? '—' : `${peds} ped${peds === 1 ? '' : 's'}`, flagCount: yesIn([4]), questionCount: 2 },
    'RISK ASSESSMENT':         { value: risk, flagCount: yesIn([7]), questionCount: 3, highlight: RISK_COLOR[risk] },
    'CROWD SAFETY & SPACING':  { value: yesIn([9, 10]) === 0 ? 'clear' : `${yesIn([9, 10])} flag${yesIn([9, 10]) === 1 ? '' : 's'}`, flagCount: yesIn([8, 9, 10]), questionCount: 3 },
    'EVENT / VENUE ASSESSMENT':{ value: attendance === null ? '—' : `attend: ${attendance}${childCount ? ` · ${childCount} kids unsup.` : ''}`, flagCount: yesIn([13, 15]), questionCount: 5 },
    'THREAT & SAFETY':         { value: `${yesIn([16, 18, 20, 21])} / 4 flags`, flagCount: yesIn([16, 18, 20, 21]), questionCount: 6 },
    'HAZARDS & INCIDENTS':     { value: `${yesIn([22, 23])} / 2 flags`, flagCount: yesIn([22, 23]), questionCount: 2 },
    'CRITICAL INCIDENTS':      { value: `${yesIn([24, 25, 26, 27, 28, 29])} / 6 flags`, flagCount: yesIn([24, 25, 26, 27, 28, 29]), questionCount: 6 },
  };
}
const SECTION_ORDER = [
  'CROWD DENSITY & ZONES',
  'PEDESTRIAN ACTIVITY',
  'RISK ASSESSMENT',
  'CROWD SAFETY & SPACING',
  'EVENT / VENUE ASSESSMENT',
  'THREAT & SAFETY',
  'HAZARDS & INCIDENTS',
  'CRITICAL INCIDENTS',
];

function StatCell({ label, value, color }: { label: string; value: number | string; color?: string }) {
  return (
    <div style={{ background: 'var(--s0)', padding: '13px 16px' }}>
      <div style={{ fontFamily: 'var(--mono)', fontSize: '1.45rem', fontWeight: 500, lineHeight: 1.1, color: color ?? 'var(--text)' }}>{value}</div>
      <div style={{ fontSize: 8.5, color: 'var(--muted)', letterSpacing: '0.15em', textTransform: 'uppercase', marginTop: 4 }}>{label}</div>
    </div>
  );
}

function Chip({ active, onClick, color, children }: { active?: boolean; onClick: () => void; color?: string; children: React.ReactNode }) {
  const c = color ?? 'var(--accent)';
  return (
    <button onClick={onClick} style={{
      fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.06em',
      padding: '4px 10px', borderRadius: 3,
      border: `1px solid ${active ? c : 'var(--border)'}`,
      background: active ? `${c}1f` : 'transparent',
      color: active ? c : 'var(--muted)',
      cursor: 'pointer', transition: 'all .18s',
    }}>
      {children}
    </button>
  );
}

function Badge({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span style={{
      fontSize: 7.5, padding: '1px 5px', borderRadius: 2, fontFamily: 'var(--mono)',
      background: `${color}18`, color, border: `1px solid ${color}44`,
    }}>
      {children}
    </span>
  );
}

// ─── Aggregate charts ───────────────────────────────────────────────────────
const RISK_KEYS = ['LOW', 'MODERATE', 'HIGH'] as const;
const DENSITY_KEYS = ['SPARSE', 'MODERATE', 'DENSE'] as const;

// Canvas helpers live in utils/canvas.ts; alias setupCanvas → setupCv to
// keep this file's call sites unchanged.
const setupCv = setupCanvas;

function HourRiskChart({ data }: { data: VlmAggregates['hour_risk'] }) {
  const ref = useCanvas(cv => {
    const g = setupCv(cv, 180);
    if (!g) return;
    const { ctx, W, H } = g;
    const p = { l: 30, r: 10, t: 14, b: 28 };
    const totals = data.map(r => r.LOW + r.MODERATE + r.HIGH);
    const mx = Math.max(...totals, 1);
    // grid
    for (let i = 0; i <= 4; i++) {
      const y = p.t + (H - p.t - p.b) * (1 - i / 4);
      ctx.strokeStyle = 'rgba(255,255,255,0.05)';
      ctx.beginPath(); ctx.moveTo(p.l, y); ctx.lineTo(W - p.r, y); ctx.stroke();
      ctx.fillStyle = 'rgba(94,93,88,.75)';
      ctx.font = '9px DM Mono, monospace';
      ctx.textAlign = 'right';
      ctx.fillText(String(Math.round(mx * i / 4)), p.l - 4, y + 3);
    }
    const bW = (W - p.l - p.r) / 24;
    const colors: Record<string, string> = {
      LOW: '#2DC9A8', MODERATE: '#F5B731', HIGH: '#EF4444',
    };
    data.forEach((row, h) => {
      const x = p.l + h * bW + 1;
      let yBase = H - p.b;
      RISK_KEYS.forEach(k => {
        const n = (row[k as keyof typeof row] as number) || 0;
        if (!n) return;
        const hh = Math.max(1, (n / mx) * (H - p.t - p.b));
        ctx.fillStyle = colors[k];
        ctx.globalAlpha = 0.86;
        ctx.fillRect(x, yBase - hh, bW - 2, hh);
        ctx.globalAlpha = 1;
        yBase -= hh;
      });
      if (h % 3 === 0) {
        ctx.fillStyle = 'rgba(94,93,88,.85)';
        ctx.font = '8px DM Mono, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(String(h).padStart(2, '0'), x + bW / 2, H - 14);
      }
    });
    RISK_KEYS.forEach((k, i) => {
      const x = p.l + i * 78;
      ctx.fillStyle = colors[k];
      ctx.fillRect(x, H - 8, 8, 6);
      ctx.fillStyle = 'rgba(94,93,88,.9)';
      ctx.font = '8px DM Mono, monospace';
      ctx.textAlign = 'left';
      ctx.fillText(k, x + 11, H - 2);
    });
  }, [data]);
  return <canvas ref={ref} style={{ display: 'block', width: '100%', height: 180 }} />;
}

function FeedDensityChart({ data }: { data: VlmAggregates['feed_density'] }) {
  const ref = useCanvas(cv => {
    const g = setupCv(cv, 180);
    if (!g) return;
    const { ctx, W, H } = g;
    const p = { l: 150, r: 12, t: 6, b: 6 };
    const mx = Math.max(...data.map(f => f.total), 1);
    const rowH = (H - p.t - p.b) / Math.max(data.length, 1);
    const colors: Record<string, string> = { SPARSE: '#2DC9A8', MODERATE: '#F5B731', DENSE: '#EF4444' };
    data.forEach((f, i) => {
      const y = p.t + i * rowH;
      const fullBw = Math.round((f.total / mx) * (W - p.l - p.r));
      ctx.fillStyle = 'rgba(255,255,255,0.04)';
      ctx.fillRect(p.l, y + 2, W - p.l - p.r, rowH - 4);
      let x = p.l;
      DENSITY_KEYS.forEach(k => {
        const n = (f[k as keyof typeof f] as number) || 0;
        if (!n) return;
        const bw = Math.round((n / f.total) * fullBw);
        ctx.fillStyle = colors[k];
        ctx.globalAlpha = 0.86;
        ctx.fillRect(x, y + 2, bw, rowH - 4);
        ctx.globalAlpha = 1;
        x += bw;
      });
      ctx.fillStyle = 'rgba(216,213,204,.88)';
      ctx.font = '9px Barlow, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(f.feed_label.substring(0, 24), p.l - 4, y + rowH / 2 + 3);
      ctx.fillStyle = 'rgba(94,93,88,.9)';
      ctx.font = 'bold 9px DM Mono, monospace';
      ctx.textAlign = 'left';
      ctx.fillText(String(f.total), p.l + fullBw + 4, y + rowH / 2 + 3);
    });
  }, [data]);
  return <canvas ref={ref} style={{ display: 'block', width: '100%', height: 180 }} />;
}

function DailyDenseChart({ data }: { data: VlmAggregates['daily_dense'] }) {
  const ref = useCanvas(cv => {
    const g = setupCv(cv, 180);
    if (!g) return;
    const { ctx, W, H } = g;
    if (!data.length) return;
    const p = { l: 32, r: 12, t: 14, b: 28 };
    const mxShare = Math.max(...data.map(d => d.share), 0.01);
    // grid
    for (let i = 0; i <= 4; i++) {
      const y = p.t + (H - p.t - p.b) * (1 - i / 4);
      ctx.strokeStyle = 'rgba(255,255,255,0.05)';
      ctx.beginPath(); ctx.moveTo(p.l, y); ctx.lineTo(W - p.r, y); ctx.stroke();
      ctx.fillStyle = 'rgba(94,93,88,.75)';
      ctx.font = '9px DM Mono, monospace';
      ctx.textAlign = 'right';
      ctx.fillText(`${Math.round((mxShare * i / 4) * 100)}%`, p.l - 4, y + 3);
    }
    const n = data.length;
    const xs = data.map((_, i) => p.l + (n === 1 ? 0 : (i * (W - p.l - p.r)) / (n - 1)));
    const ys = data.map(d => p.t + (H - p.t - p.b) * (1 - d.share / mxShare));
    // area fill
    const grad = ctx.createLinearGradient(0, p.t, 0, H - p.b);
    grad.addColorStop(0, 'rgba(239,68,68,.35)');
    grad.addColorStop(1, 'rgba(239,68,68,0)');
    ctx.beginPath();
    ctx.moveTo(xs[0], H - p.b);
    xs.forEach((x, i) => ctx.lineTo(x, ys[i]));
    ctx.lineTo(xs[xs.length - 1], H - p.b);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
    // line + points
    ctx.beginPath();
    xs.forEach((x, i) => i === 0 ? ctx.moveTo(x, ys[i]) : ctx.lineTo(x, ys[i]));
    ctx.strokeStyle = '#EF4444';
    ctx.lineWidth = 2;
    ctx.stroke();
    xs.forEach((x, i) => {
      ctx.beginPath();
      ctx.arc(x, ys[i], 3, 0, Math.PI * 2);
      ctx.fillStyle = '#EF4444';
      ctx.fill();
    });
    // x-axis (every Nth date label)
    const step = Math.max(1, Math.floor(n / 6));
    data.forEach((d, i) => {
      if (i % step !== 0 && i !== n - 1) return;
      ctx.fillStyle = 'rgba(94,93,88,.85)';
      ctx.font = '8px DM Mono, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(d.date.slice(5), xs[i], H - 6);
    });
  }, [data]);
  return <canvas ref={ref} style={{ display: 'block', width: '100%', height: 180 }} />;
}

function ChartCard({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }) {
  return (
    <div style={{ background: 'var(--s0)' }}>
      <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', background: 'var(--s1)' }}>
        <div style={{ fontFamily: 'var(--cond)', fontSize: 11, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase' }}>{title}</div>
        <div style={{ fontSize: 9, color: 'var(--muted)', fontFamily: 'var(--mono)', marginTop: 2 }}>{sub}</div>
      </div>
      <div style={{ padding: '10px 14px' }}>{children}</div>
    </div>
  );
}

export default function VlmPage() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [feedId, setFeedId] = useState<string | undefined>();
  const [runId, setRunId] = useState<string | undefined>();
  const [density, setDensity] = useState<string | undefined>();
  const [risk, setRisk] = useState<string | undefined>();
  const [elevatedRisk, setElevatedRisk] = useState(false);
  const [onlyThreats, setOnlyThreats] = useState(false);
  const [hasPeds, setHasPeds] = useState(false);
  const [search, setSearch] = useState('');

  const params: VlmListParams = useMemo(() => ({
    feed_id: feedId, run_id: runId, density, risk,
    min_risk: elevatedRisk ? 'MODERATE' : undefined,
    only_threats: onlyThreats || undefined,
    has_pedestrians: hasPeds || undefined,
    search: search || undefined,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
    sort: 'captured_at',
    order: 'desc',
  }), [feedId, runId, density, risk, elevatedRisk, onlyThreats, hasPeds, search, page]);

  const { data: list, loading: listLoading, error: listError, refetch: refetchList } = useVlmList(params);
  const { data: feedsResp, refetch: refetchFeeds } = useVlmFeeds();
  const { data: stats, refetch: refetchStats } = useVlmStats();
  const { data: prompts } = useVlmPrompts();
  const { data: aggregates } = useVlmAggregates();
  const { data: runs } = useVlmRuns();
  const { data: detail } = useVlmOne(selectedId);
  const detailSummaries = useMemo(
    () => (detail ? summarizeAnswers(detail.answers) : null),
    [detail],
  );

  const handleReload = async () => {
    try {
      await fetch(`${API_BASE}/api/vlm/reload`, { method: 'POST' });
    } finally {
      refetchList();
      refetchFeeds();
      refetchStats();
    }
  };

  const feeds = feedsResp?.feeds ?? [];
  const loadInfo = feedsResp?.load;
  const total = list?.total ?? 0;
  const items = list?.items ?? [];
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const resetPage = () => setPage(0);

  return (
    <div>
      {/* Header */}
      <div style={{ background: 'var(--s1)', borderBottom: '1px solid var(--border)', padding: '16px 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontFamily: 'var(--cond)', fontSize: 18, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
            VLM Feed Observations
          </div>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
            {stats?.total ?? '—'} frames analyzed · {stats?.feeds ?? '—'} feeds · {stats?.runs ?? '—'} batches · model {MODEL_NAME}
            {loadInfo?.loaded_at && <> · loaded {new Date(loadInfo.loaded_at).toLocaleTimeString('en-US', { hour12: false })}</>}
          </div>
        </div>
        <button
          onClick={handleReload}
          style={{
            fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.06em',
            padding: '6px 14px', borderRadius: 3, background: 'transparent',
            border: '1px solid var(--border)', color: 'var(--muted)', cursor: 'pointer',
          }}
        >Reload Data</button>
      </div>

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 1, background: 'var(--border)', borderBottom: '1px solid var(--border)' }}>
        <StatCell label="Total Frames" value={stats?.total ?? '—'} color="var(--accent)" />
        <StatCell label="Feeds" value={stats?.feeds ?? '—'} color="var(--blue)" />
        <StatCell label="With Pedestrians" value={stats?.with_pedestrians ?? '—'} color="var(--teal)" />
        <StatCell label="Imminent Threats" value={stats?.imminent_threats ?? 0} color="var(--red)" />
        <StatCell label="Weapons" value={stats?.weapons ?? 0} color="var(--red)" />
        <StatCell label="Medical" value={stats?.medical ?? 0} color="var(--purple)" />
        <StatCell label="Fire / Smoke" value={stats?.fire_smoke ?? 0} color="var(--orange)" />
      </div>

      {/* Aggregate charts */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 1, background: 'var(--border)', borderBottom: '1px solid var(--border)' }}>
        <ChartCard title="Hour-of-Day Risk Mix" sub="Stacked frames per UTC hour · LOW · MOD · MED · HIGH">
          {aggregates ? <HourRiskChart data={aggregates.hour_risk} /> : <div className="skeleton" style={{ width: '100%', height: 180 }} />}
        </ChartCard>
        <ChartCard title="Per-Feed Density (top 10)" sub="Stacked share of SPARSE / MODERATE / DENSE per feed">
          {aggregates ? <FeedDensityChart data={aggregates.feed_density} /> : <div className="skeleton" style={{ width: '100%', height: 180 }} />}
        </ChartCard>
        <ChartCard title="DENSE-Frame Share by Day" sub="Daily share of frames classified DENSE">
          {aggregates ? <DailyDenseChart data={aggregates.daily_dense} /> : <div className="skeleton" style={{ width: '100%', height: 180 }} />}
        </ChartCard>
      </div>

      {/* Main grid: list | detail */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 360px', gap: 1, background: 'var(--border)' }}>
        {/* List column */}
        <div style={{ background: 'var(--s0)', display: 'flex', flexDirection: 'column' }}>
          {/* Filter bar */}
          <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', background: 'var(--s1)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontFamily: 'var(--cond)', fontSize: 10, fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.12em', textTransform: 'uppercase', marginRight: 4 }}>Density</span>
              {(['SPARSE', 'MODERATE', 'DENSE'] as const).map(d => (
                <Chip key={d} active={density === d} color={DENSITY_COLOR[d]} onClick={() => { setDensity(density === d ? undefined : d); resetPage(); }}>
                  {d} {stats?.density?.[d] ? `· ${stats.density[d]}` : ''}
                </Chip>
              ))}
              <span style={{ width: 8 }} />
              <span style={{ fontFamily: 'var(--cond)', fontSize: 10, fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.12em', textTransform: 'uppercase', marginRight: 4 }}>Risk</span>
              {(['LOW', 'MODERATE', 'HIGH'] as const).map(r => (
                <Chip key={r} active={risk === r} color={RISK_COLOR[r]} onClick={() => { setRisk(risk === r ? undefined : r); resetPage(); }}>
                  {r} {stats?.risk?.[r] ? `· ${stats.risk[r]}` : ''}
                </Chip>
              ))}
              <span style={{ width: 8 }} />
              <Chip active={elevatedRisk} color="#F97316" onClick={() => { setElevatedRisk(!elevatedRisk); resetPage(); }}>RISK ≥ MODERATE</Chip>
              <Chip active={onlyThreats} color="var(--red)" onClick={() => { setOnlyThreats(!onlyThreats); resetPage(); }}>ONLY THREATS</Chip>
              <Chip active={hasPeds} color="var(--teal)" onClick={() => { setHasPeds(!hasPeds); resetPage(); }}>HAS PEDESTRIANS</Chip>
            </div>
            <input
              type="text" placeholder="search caption / feed / file"
              value={search}
              onChange={e => { setSearch(e.target.value); resetPage(); }}
              style={{
                background: 'var(--s0)', border: '1px solid var(--border)', borderRadius: 3,
                padding: '4px 9px', fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text)',
                outline: 'none', width: 220,
              }}
            />
          </div>

          {/* Batch select */}
          {runs && runs.length > 1 && (
            <div style={{ padding: '6px 14px', borderBottom: '1px solid var(--b2)', display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontFamily: 'var(--cond)', fontSize: 10, fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.12em', textTransform: 'uppercase', marginRight: 4 }}>Batch</span>
              <Chip active={!runId} onClick={() => { setRunId(undefined); resetPage(); }}>ALL · {runs.reduce((s, r) => s + r.count, 0)}</Chip>
              {runs.map(r => {
                const ts = r.run_started_at ? r.run_started_at.replace('T', ' ').slice(0, 16) + ' UTC' : r.run_id;
                return (
                  <Chip key={r.run_id} active={runId === r.run_id} onClick={() => { setRunId(r.run_id === runId ? undefined : r.run_id); resetPage(); }}>
                    {ts} · {r.count}
                  </Chip>
                );
              })}
            </div>
          )}

          {/* Feed select */}
          <div style={{ padding: '8px 14px', borderBottom: '1px solid var(--border)', display: 'flex', gap: 5, flexWrap: 'wrap', maxHeight: 80, overflowY: 'auto' }}>
            <Chip active={!feedId} onClick={() => { setFeedId(undefined); resetPage(); }}>ALL FEEDS</Chip>
            {feeds.map(f => (
              <Chip key={f.feed_id} active={feedId === f.feed_id} onClick={() => { setFeedId(f.feed_id === feedId ? undefined : f.feed_id); resetPage(); }}>
                {f.feed_label.replace(/dean porter park /i, '')} · {f.count}
              </Chip>
            ))}
          </div>

          {/* List */}
          <div style={{ height: 'calc(100vh - 380px)', minHeight: 380, overflowY: 'auto' }} role="region" aria-live="polite">
            {listError && !listLoading ? (
              <div role="alert" style={{ padding: 16, textAlign: 'center' }}>
                <div style={{ fontSize: 11, color: '#EF4444', marginBottom: 8 }}>
                  Failed to load observations — {listError}
                </div>
                <button
                  onClick={() => refetchList()}
                  style={{
                    fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.06em',
                    padding: '4px 12px', borderRadius: 3, cursor: 'pointer',
                    background: 'transparent', border: '1px solid var(--border)', color: 'var(--accent)',
                  }}
                >Retry</button>
              </div>
            ) : listLoading && !items.length ? (
              Array.from({ length: 8 }).map((_, i) => (
                <div key={i} style={{ padding: '10px 14px', borderBottom: '1px solid var(--b2)' }}>
                  <div className="skeleton" style={{ width: '70%', height: 11, marginBottom: 6 }} />
                  <div className="skeleton" style={{ width: '45%', height: 9 }} />
                </div>
              ))
            ) : items.length === 0 ? (
              <div style={{ padding: 24, color: 'var(--muted)', fontSize: 11, textAlign: 'center' }}>No observations match.</div>
            ) : items.map(o => {
              const isSel = selectedId === o.id;
              const dCol = o.density_zone ? DENSITY_COLOR[o.density_zone] : 'var(--border)';
              const rCol = o.risk_level ? RISK_COLOR[o.risk_level] : 'var(--border)';
              const threat = o.has_imminent_threat || o.weapons_visible || o.medical_emergency || o.fire_smoke || o.fallen_person || o.physical_altercation || o.unsupervised_children;
              return (
                <div
                  key={o.id}
                  role="button"
                  tabIndex={0}
                  aria-label={`${o.feed_label} observation`}
                  aria-pressed={isSel}
                  onClick={() => setSelectedId(o.id)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setSelectedId(o.id);
                    }
                  }}
                  className={`row-hover-faint${isSel ? ' row-selected' : ''}`}
                  style={{
                    position: 'relative', padding: '10px 14px',
                    borderBottom: '1px solid var(--b2)',
                    borderLeft: isSel ? `2px solid var(--accent)` : '2px solid transparent',
                    background: isSel ? 'rgba(232,93,47,0.05)' : 'transparent',
                    cursor: 'pointer',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 2 }}>
                    <div style={{ fontSize: 11, fontWeight: 600 }}>
                      🎥 {o.feed_label}
                    </div>
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 8, color: 'var(--muted)' }}>
                      {o.captured_at ? o.captured_at.replace('T', ' ').slice(0, 16) : '—'}
                    </div>
                  </div>
                  <div style={{ fontSize: 9.5, color: 'var(--dim)', marginBottom: 4, fontFamily: 'var(--mono)' }}>
                    👣 {o.pedestrian_count ?? '–'} pedestrians · {o.image_name.split('_').pop()}
                  </div>
                  <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
                    {o.density_zone && <Badge color={dCol}>{o.density_zone}</Badge>}
                    {o.risk_level && <Badge color={rCol}>RISK {o.risk_level}</Badge>}
                    {threat && <Badge color="#EF4444">⚠ THREAT</Badge>}
                    {o.weapons_visible && <Badge color="#EF4444">WEAPON</Badge>}
                    {o.medical_emergency && <Badge color="#A78BFA">MEDICAL</Badge>}
                    {o.fire_smoke && <Badge color="#F97316">FIRE</Badge>}
                    {o.fallen_person && <Badge color="#F97316">FALLEN</Badge>}
                    {o.unsupervised_children && <Badge color="#F5B731">CHILD</Badge>}
                    {o.physical_altercation && <Badge color="#EF4444">ALTERCATION</Badge>}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Pagination */}
          <div style={{ padding: '8px 14px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--s1)' }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--muted)' }}>
              {total === 0 ? '0 records' : `${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, total)} of ${total}`}
            </span>
            <div style={{ display: 'flex', gap: 5 }}>
              <Chip onClick={() => setPage(Math.max(0, page - 1))}>PREV</Chip>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--muted)', padding: '4px 4px' }}>
                {page + 1} / {totalPages}
              </span>
              <Chip onClick={() => setPage(Math.min(totalPages - 1, page + 1))}>NEXT</Chip>
            </div>
          </div>
        </div>

        {/* Detail column */}
        <div style={{ background: 'var(--s0)', display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', background: 'var(--s1)', display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ fontFamily: 'var(--cond)', fontSize: 11, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase' }}>Observation Detail</span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 8, color: 'var(--muted)', background: 'var(--b2)', padding: '2px 7px', borderRadius: 10 }}>
              {selectedId ? selectedId.slice(-6) : 'select'}
            </span>
          </div>

          <div style={{ height: 'calc(100vh - 300px)', minHeight: 380, overflowY: 'auto', padding: 14 }}>
            {!detail ? (
              <div style={{ color: 'var(--muted)', fontSize: 11, textAlign: 'center', padding: 40 }}>
                Select an observation
              </div>
            ) : (
              <>
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10, color: 'var(--accent)' }}>
                  🎥 {detail.feed_label}
                </div>

                {[
                  ['Captured', detail.captured_at?.replace('T', ' ') ?? '—'],
                  ['Processed', detail.processed_at?.slice(0, 19).replace('T', ' ') ?? '—'],
                  ['Batch', detail.run_started_at ? `${detail.run_started_at.replace('T', ' ').slice(0, 16)} UTC` : detail.run_id],
                  ['Image', detail.image_name],
                  ['Model', detail.model],
                  ['Latency', detail.total_seconds ? `${detail.total_seconds.toFixed(2)}s` : '—'],
                ].map(([k, v]) => (
                  <div key={k} style={{ display: 'flex', gap: 8, marginBottom: 4 }}>
                    <div style={{ fontSize: 9, color: 'var(--muted)', minWidth: 72, fontFamily: 'var(--mono)' }}>{k}</div>
                    <div style={{ fontSize: 10, color: 'var(--text)', wordBreak: 'break-all' }}>{v}</div>
                  </div>
                ))}

                <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 10, marginBottom: 14 }}>
                  {detail.density_zone && <Badge color={DENSITY_COLOR[detail.density_zone]}>{detail.density_zone}</Badge>}
                  {detail.risk_level && <Badge color={RISK_COLOR[detail.risk_level]}>RISK {detail.risk_level}</Badge>}
                  {detail.pedestrian_count !== null && <Badge color="#2DC9A8">👣 {detail.pedestrian_count}</Badge>}
                  {detail.weapons_visible && <Badge color="#EF4444">WEAPON</Badge>}
                  {detail.medical_emergency && <Badge color="#A78BFA">MEDICAL</Badge>}
                  {detail.fire_smoke && <Badge color="#F97316">FIRE</Badge>}
                  {detail.fallen_person && <Badge color="#F97316">FALLEN</Badge>}
                  {detail.unsupervised_children && <Badge color="#F5B731">CHILD</Badge>}
                  {detail.has_imminent_threat && <Badge color="#EF4444">THREAT</Badge>}
                </div>

                {/* Section roll-up */}
                <div style={{ fontSize: 8, color: 'var(--muted)', letterSpacing: '0.15em', textTransform: 'uppercase', marginBottom: 6, fontFamily: 'var(--mono)' }}>
                  Section Roll-Up
                </div>
                {detailSummaries && (
                  <div style={{ marginBottom: 14, border: '1px solid var(--border)', borderRadius: 4, overflow: 'hidden' }}>
                    {SECTION_ORDER.map((sec, i) => {
                      const s = detailSummaries[sec];
                      const flagged = s.flagCount > 0;
                      const color = s.highlight ?? (flagged ? '#EF4444' : 'var(--muted)');
                      return (
                        <div key={sec} style={{
                          display: 'grid', gridTemplateColumns: '1fr auto',
                          gap: 8, padding: '7px 10px',
                          borderTop: i === 0 ? 'none' : '1px solid var(--b2)',
                          background: flagged ? 'rgba(239,68,68,0.04)' : 'transparent',
                        }}>
                          <div>
                            <div style={{ fontSize: 9, fontFamily: 'var(--mono)', color: 'var(--accent)', letterSpacing: '0.06em' }}>
                              [{sec}]
                            </div>
                            <div style={{ fontSize: 9, color: 'var(--muted)', marginTop: 1 }}>
                              {s.questionCount} question{s.questionCount === 1 ? '' : 's'}{s.flagCount > 0 ? ` · ${s.flagCount} positive` : ''}
                            </div>
                          </div>
                          <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color, alignSelf: 'center', textAlign: 'right' }}>
                            {s.value}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                <div style={{ fontSize: 8, color: 'var(--muted)', letterSpacing: '0.15em', textTransform: 'uppercase', marginBottom: 6, fontFamily: 'var(--mono)' }}>
                  Per-Prompt Answers
                </div>
                <div style={{ marginBottom: 14 }}>
                  {prompts?.map(p => {
                    const lines = p.q_numbers
                      .map(n => ({ n, ans: detail.answers[String(n)] }))
                      .filter(x => x.ans);
                    if (!lines.length) return null;
                    return (
                      <div key={p.id} style={{ marginBottom: 8 }}>
                        <div style={{ fontSize: 9, color: 'var(--accent)', fontFamily: 'var(--mono)', marginBottom: 2 }}>
                          [{p.section}] · Q{p.q_numbers.join(',')}
                        </div>
                        <div style={{ fontSize: 10, color: 'var(--dim)', lineHeight: 1.45, marginBottom: 3, fontStyle: 'italic' }}>
                          {p.prompt}
                        </div>
                        {lines.map(l => (
                          <div key={l.n} style={{ fontSize: 10.5, color: 'var(--text)', lineHeight: 1.5, paddingLeft: 8, borderLeft: '1px solid var(--border)', marginBottom: 2 }}>
                            <span style={{ color: 'var(--muted)', fontFamily: 'var(--mono)', marginRight: 4 }}>{l.n}.</span>
                            {l.ans}
                          </div>
                        ))}
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

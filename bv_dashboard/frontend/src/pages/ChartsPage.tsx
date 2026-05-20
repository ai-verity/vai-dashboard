// pages/ChartsPage.tsx
import { useMemo, useRef, useState } from 'react';
import {
  useMonthly, useByCategory,
  useSeverityDist, useHeatmap, useTypeRanking,
} from '../hooks/useApi';
import { useIncidentsContext } from '../hooks/IncidentsProvider';
import { CAT_META, sevColor, sevLabel } from '../types';
import type { Category, MonthlyData, SeverityTier, HeatmapCell, TypeRankingItem, CategoryData, Incident } from '../types';
import { setupCanvas, useCanvas, chartColors } from '../utils/canvas';
import { useTheme } from '../hooks/useTheme';

const CATS: Category[] = ['VIOLENT', 'HEALTH', 'ENVIRON', 'ORDER', 'SECURITY'];
const COLORS = ['#EF4444', '#A78BFA', '#4A9EF5', '#F5B731', '#2DC9A8'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May'];
const ACCENT = '#e85d2f';

type Padding = { l: number; r: number; t: number; b: number };

function drawGrid(ctx: CanvasRenderingContext2D, W: number, H: number, p: Padding, mx: number, steps = 5) {
  const { MUTED, GRID } = chartColors();
  for (let i = 0; i <= steps; i++) {
    const y = p.t + (H - p.t - p.b) * (1 - i / steps);
    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(p.l, y);
    ctx.lineTo(W - p.r, y);
    ctx.stroke();
    ctx.fillStyle = MUTED;
    ctx.font = '9px DM Mono, monospace';
    ctx.textAlign = 'right';
    ctx.fillText(String(Math.round((mx * i) / steps)), p.l - 4, y + 3);
  }
}

// ─── Shared panel styles ─────────────────────────────────────────
const S = {
  panel: { background: 'var(--s0)', overflow: 'hidden' as const },
  hdr: {
    padding: '12px 18px 10px',
    borderBottom: '1px solid var(--border)',
    display: 'flex' as const,
    alignItems: 'baseline' as const,
    justifyContent: 'space-between' as const,
  },
  title: {
    fontFamily: 'var(--cond)', fontSize: 12, fontWeight: 700,
    letterSpacing: '0.1em', textTransform: 'uppercase' as const,
  },
  sub: { fontSize: 9, color: 'var(--muted)', fontFamily: 'var(--mono)' },
  body: { padding: '16px 18px' },
};

// ─── 1. Monthly Volume (area + line + value labels) ──────────────
function MonthlyVolume({ data }: { data: MonthlyData[] }) {
  const totals = data.map(m => m.total);
  const delta = totals[totals.length - 1] - totals[0];
  const { tick } = useTheme();

  const ref = useCanvas(cv => {
    const g = setupCanvas(cv, 200);
    if (!g) return;
    const { ctx, W, H } = g;
    const { BG, MUTED, TEXT } = chartColors();
    const p: Padding = { l: 38, r: 18, t: 18, b: 28 };
    const mx = Math.max(...totals, 1);
    drawGrid(ctx, W, H, p, mx);
    const xs = MONTHS.map((_, i) => p.l + (i * (W - p.l - p.r)) / (MONTHS.length - 1));
    const ys = totals.map(v => p.t + (H - p.t - p.b) * (1 - v / mx));

    const grad = ctx.createLinearGradient(0, p.t, 0, H - p.b);
    grad.addColorStop(0, 'rgba(232,93,47,.35)');
    grad.addColorStop(1, 'rgba(232,93,47,0)');
    ctx.beginPath();
    ctx.moveTo(xs[0], H - p.b);
    xs.forEach((x, i) => ctx.lineTo(x, ys[i]));
    ctx.lineTo(xs[xs.length - 1], H - p.b);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(xs[0], ys[0]);
    xs.forEach((x, i) => { if (i > 0) ctx.lineTo(x, ys[i]); });
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 2.5;
    ctx.stroke();

    xs.forEach((x, i) => {
      ctx.beginPath();
      ctx.arc(x, ys[i], 4.5, 0, Math.PI * 2);
      ctx.fillStyle = ACCENT;
      ctx.fill();
      ctx.strokeStyle = BG;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = TEXT;
      ctx.font = 'bold 11px DM Mono, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(String(totals[i]), x, ys[i] - 11);
      ctx.fillStyle = MUTED;
      ctx.font = '9px DM Mono, monospace';
      ctx.fillText(MONTHS[i], x, H - 7);
    });
  }, [data, tick]);

  return (
    <div style={S.panel}>
      <div style={S.hdr}>
        <div>
          <div style={S.title}>Monthly Incident Volume</div>
          <div style={S.sub}>Total incidents per month with trend line overlay</div>
        </div>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: delta > 0 ? 'var(--red)' : 'var(--green)' }}>
          {delta >= 0 ? '↑ +' : '↓ '}{Math.abs(delta)} vs Jan
        </div>
      </div>
      <div style={S.body}>
        <canvas ref={ref} style={{ display: 'block', width: '100%', height: 200 }} />
      </div>
    </div>
  );
}

// ─── 2. Severity Donut (square canvas, center total) ─────────────
function SeverityDonut({ data }: { data: SeverityTier[] }) {
  const total = data.reduce((s, t) => s + t.count, 0);
  const { tick } = useTheme();

  const ref = useCanvas(cv => {
    const side = Math.min(cv.offsetWidth || 200, 200);
    const g = setupCanvas(cv, side);
    if (!g) return;
    const { ctx } = g;
    const { BG, MUTED, TEXT } = chartColors();
    const cx = side / 2, cy = side / 2;
    const outer = side * 0.42, inner = side * 0.26;
    const tot = total || 1;
    let angle = -Math.PI / 2;
    data.forEach(t => {
      const sw = (t.count / tot) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, outer, angle, angle + sw);
      ctx.closePath();
      ctx.fillStyle = t.color;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(cx, cy, inner, 0, Math.PI * 2);
      ctx.fillStyle = BG;
      ctx.fill();
      angle += sw;
    });
    ctx.fillStyle = TEXT;
    ctx.font = 'bold 16px DM Mono, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(String(total), cx, cy + 5);
    ctx.fillStyle = MUTED;
    ctx.font = '8px DM Mono, monospace';
    ctx.fillText('total', cx, cy + 18);
  }, [data, total, tick]);

  return (
    <div style={S.panel}>
      <div style={S.hdr}>
        <div>
          <div style={S.title}>Severity Distribution</div>
          <div style={S.sub}>YTD by severity tier</div>
        </div>
      </div>
      <div style={{ ...S.body, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <canvas ref={ref} style={{ display: 'block', width: '100%', maxWidth: 200, height: 170 }} />
        <div style={{ marginTop: 10, width: '100%' }}>
          {data.map(t => (
            <div key={t.tier} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, fontSize: 9 }}>
              <div style={{ width: 9, height: 9, background: t.color, borderRadius: '50%', flexShrink: 0 }} />
              <span style={{ flex: 1, color: 'var(--dim)' }}>{t.tier}</span>
              <span style={{ fontFamily: 'var(--mono)', color: 'var(--text)' }}>{t.count}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
// ─── 3. Stacked Area by Category ─────────────────────────────────
function StackedCategory({ data }: { data: MonthlyData[] }) {
  const { tick } = useTheme();
  const ref = useCanvas(cv => {
    const g = setupCanvas(cv, 195);
    if (!g) return;
    const { ctx, W, H } = g;
    const { MUTED } = chartColors();
    const p: Padding = { l: 38, r: 16, t: 16, b: 28 };
    const series: number[][] = CATS.map(c => data.map(m => (m[c.toLowerCase() as keyof MonthlyData] as number) || 0));
    const totals = data.map((_, mi) => series.reduce((s, d) => s + d[mi], 0));
    const mx = Math.max(...totals, 1);
    drawGrid(ctx, W, H, p, mx);
    const xs = MONTHS.map((_, i) => p.l + (i * (W - p.l - p.r)) / (MONTHS.length - 1));
    const stacked = data.map((_, mi) => {
      let acc = 0;
      return CATS.map((_, ci) => { acc += series[ci][mi]; return acc; });
    });
    for (let ci = CATS.length - 1; ci >= 0; ci--) {
      const topY = stacked.map(s => p.t + (H - p.t - p.b) * (1 - s[ci] / mx));
      const botY = ci > 0
        ? stacked.map(s => p.t + (H - p.t - p.b) * (1 - s[ci - 1] / mx))
        : MONTHS.map(() => H - p.b);
      ctx.beginPath();
      ctx.moveTo(xs[0], botY[0]);
      xs.forEach((x, i) => ctx.lineTo(x, topY[i]));
      for (let i = xs.length - 1; i >= 0; i--) ctx.lineTo(xs[i], botY[i]);
      ctx.closePath();
      ctx.fillStyle = COLORS[ci] + '80';
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(xs[0], topY[0]);
      xs.forEach((x, i) => { if (i > 0) ctx.lineTo(x, topY[i]); });
      ctx.strokeStyle = COLORS[ci];
      ctx.lineWidth = 1.8;
      ctx.stroke();
    }
    xs.forEach((x, i) => {
      ctx.fillStyle = MUTED;
      ctx.font = '9px DM Mono, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(MONTHS[i], x, H - 7);
    });
    CATS.forEach((c, ci) => {
      const x = p.l + (ci * (W - p.l - p.r)) / CATS.length;
      ctx.fillStyle = COLORS[ci];
      ctx.fillRect(x, H - p.b + 14, 8, 6);
      ctx.fillStyle = MUTED;
      ctx.font = '8px DM Mono, monospace';
      ctx.textAlign = 'left';
      ctx.fillText(CAT_META[c].label, x + 11, H - p.b + 21);
    });
  }, [data, tick]);

  return (
    <div style={S.panel}>
      <div style={S.hdr}>
        <div>
          <div style={S.title}>Category Breakdown by Month</div>
          <div style={S.sub}>Stacked area — Violent, Health, Environmental, Order, Security</div>
        </div>
      </div>
      <div style={S.body}>
        <canvas ref={ref} style={{ display: 'block', width: '100%', height: 195 }} />
      </div>
    </div>
  );
}

// ─── 4. Hotspot Locations — stacked by category ──────────────────
//
// Replaces the old "total incidents per location" bar chart with a
// stacked horizontal bar showing the category mix at each hotspot.
// Reads the live incidents list from the IncidentsProvider context so
// the breakdown stays in sync with filters elsewhere.

type LocBreakdownRow = {
  id: string;
  name: string;
  cats: Record<Category, number>;
  total: number;
};

function useLocationBreakdown(): LocBreakdownRow[] {
  const { incidents } = useIncidentsContext();
  return useMemo(() => {
    const map = new Map<string, LocBreakdownRow>();
    for (const inc of incidents) {
      let row = map.get(inc.location_id);
      if (!row) {
        row = {
          id: inc.location_id,
          name: inc.location_name,
          cats: { VIOLENT: 0, HEALTH: 0, ENVIRON: 0, ORDER: 0, SECURITY: 0 },
          total: 0,
        };
        map.set(inc.location_id, row);
      }
      row.cats[inc.cat] += 1;
      row.total += 1;
    }
    return Array.from(map.values())
      .sort((a, b) => b.total - a.total)
      .slice(0, 8);
  }, [incidents]);
}

function HotspotBreakdown({
  selectedLocation, onSelect,
}: {
  selectedLocation: string | null;
  onSelect: (locationId: string | null) => void;
}) {
  const rows = useLocationBreakdown();
  const { tick } = useTheme();
  // Hit boxes per row — refilled on every redraw, consulted by onClick.
  const hitsRef = useRef<Array<{ id: string; x0: number; x1: number; y0: number; y1: number }>>([]);

  const ref = useCanvas(cv => {
    const g = setupCanvas(cv, 215);
    if (!g) return;
    const { ctx, W, H } = g;
    const { TEXT, MUTED } = chartColors();
    const mx = rows[0]?.total ?? 1;
    const p: Padding = { l: 134, r: 50, t: 14, b: 12 };
    const rowH = (H - p.t - p.b) / Math.max(rows.length, 1);

    hitsRef.current = [];

    rows.forEach((row, i) => {
      const y = p.t + i * rowH;
      const fullW = Math.round((row.total / mx) * (W - p.l - p.r));
      const isSel = selectedLocation === row.id;

      // Selection highlight — soft accent wash on the full row.
      if (isSel) {
        ctx.fillStyle = 'rgba(232,93,47,0.10)';
        ctx.fillRect(0, y, W, rowH);
      }

      // Stack each category as a contiguous segment inside the bar.
      let xCursor = p.l;
      CATS.forEach((cat, ci) => {
        const n = row.cats[cat];
        if (!n) return;
        const segW = Math.round((n / row.total) * fullW);
        ctx.fillStyle = COLORS[ci];
        ctx.globalAlpha = 0.85;
        ctx.fillRect(xCursor, y + 3, segW, rowH - 6);
        ctx.globalAlpha = 1;
        xCursor += segW;
      });

      // Faint outline so even short bars are findable.
      ctx.strokeStyle = isSel ? ACCENT : 'rgba(255,255,255,0.08)';
      ctx.lineWidth = 1;
      ctx.strokeRect(p.l + 0.5, y + 3.5, fullW, rowH - 6);

      // Location label on the left.
      ctx.fillStyle = isSel ? ACCENT : TEXT;
      ctx.font = isSel ? 'bold 10px Barlow, sans-serif' : '10px Barlow, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(row.name.substring(0, 22), p.l - 6, y + rowH / 2 + 3);

      // Total on the right.
      ctx.fillStyle = isSel ? ACCENT : MUTED;
      ctx.font = 'bold 10px DM Mono, monospace';
      ctx.textAlign = 'left';
      ctx.fillText(String(row.total), p.l + fullW + 5, y + rowH / 2 + 3);

      hitsRef.current.push({
        id: row.id,
        x0: 0, x1: W,
        y0: y, y1: y + rowH,
      });
    });
  }, [rows, tick, selectedLocation]);

  function onClick(e: React.MouseEvent<HTMLCanvasElement>) {
    const cv = e.currentTarget;
    const rect = cv.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const hit = hitsRef.current.find(h => x >= h.x0 && x <= h.x1 && y >= h.y0 && y <= h.y1);
    if (!hit) return;
    onSelect(hit.id === selectedLocation ? null : hit.id);
  }

  return (
    <div style={S.panel}>
      <div style={S.hdr}>
        <div>
          <div style={S.title}>Top 8 Hotspot Locations — Type Mix</div>
          <div style={S.sub}>Stacked by category · click a row to filter the list below</div>
        </div>
        {selectedLocation && (
          <button
            onClick={() => onSelect(null)}
            style={{
              fontFamily: 'var(--mono)', fontSize: 9,
              padding: '3px 9px', borderRadius: 3, cursor: 'pointer',
              background: 'rgba(232,93,47,0.10)',
              border: '1px solid var(--accent)',
              color: 'var(--accent)',
            }}
          >
            Clear filter
          </button>
        )}
      </div>
      <div style={S.body}>
        <canvas
          ref={ref}
          onClick={onClick}
          style={{ display: 'block', width: '100%', height: 215, cursor: 'pointer' }}
        />
        {/* HTML legend below — keeps the canvas free of overlapping labels */}
        <div style={{
          display: 'flex', flexWrap: 'wrap', gap: '4px 14px',
          marginTop: 8,
        }}>
          {CATS.map((c, ci) => (
            <div key={c} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 9 }}>
              <span style={{ width: 9, height: 9, background: COLORS[ci], borderRadius: 1 }} />
              <span style={{ fontFamily: 'var(--mono)', color: 'var(--dim)' }}>{CAT_META[c].label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Searchable / filterable incident list ────────────────────────
//
// Sits below the chart grid. Filters live on the same incident dataset
// the chart reads. Plain HTML — no canvas, so it's accessible and
// theme-aware for free.

function IncidentSearchList({
  selectedLocation, onLocationClear,
}: {
  selectedLocation: string | null;
  onLocationClear: () => void;
}) {
  const { incidents } = useIncidentsContext();
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return incidents.filter(inc => {
      if (selectedLocation && inc.location_id !== selectedLocation) return false;
      if (!q) return true;
      return (
        inc.type.toLowerCase().includes(q) ||
        inc.location_name.toLowerCase().includes(q) ||
        inc.desc.toLowerCase().includes(q) ||
        inc.cat.toLowerCase().includes(q) ||
        inc.date.includes(q)
      );
    });
  }, [incidents, query, selectedLocation]);

  // Resolve the selected-location label from the first matching incident.
  const selectedName = useMemo(() => {
    if (!selectedLocation) return null;
    return incidents.find(i => i.location_id === selectedLocation)?.location_name ?? selectedLocation;
  }, [incidents, selectedLocation]);

  return (
    <div style={S.panel}>
      <div style={S.hdr}>
        <div>
          <div style={S.title}>Incidents at Selected Location</div>
          <div style={S.sub}>
            {selectedLocation
              ? <>Filtered to <b>{selectedName}</b> · {filtered.length} of {incidents.length} incidents</>
              : <>All incidents · {filtered.length} match {query ? `“${query}”` : 'current filter'}</>
            }
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {selectedLocation && (
            <button
              onClick={onLocationClear}
              style={{
                fontFamily: 'var(--mono)', fontSize: 9,
                padding: '3px 9px', borderRadius: 3, cursor: 'pointer',
                background: 'rgba(232,93,47,0.10)',
                border: '1px solid var(--accent)',
                color: 'var(--accent)',
              }}
            >
              Clear location filter
            </button>
          )}
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="search type, location, date, description…"
            aria-label="Search incidents"
            style={{
              fontFamily: 'var(--mono)', fontSize: 10,
              padding: '4px 10px', borderRadius: 3,
              border: '1px solid var(--border)',
              background: 'var(--s0)', color: 'var(--text)',
              minWidth: 280,
            }}
          />
        </div>
      </div>

      {/* Scrollable list */}
      <div style={{
        maxHeight: 360,
        overflowY: 'auto',
        background: 'var(--s0)',
      }}>
        {filtered.length === 0 ? (
          <div style={{
            padding: '24px 16px',
            textAlign: 'center',
            fontFamily: 'var(--mono)', fontSize: 10,
            color: 'var(--muted)',
          }}>
            No incidents match the current filter{query ? ` and search “${query}”` : ''}.
          </div>
        ) : filtered.map((inc: Incident) => {
          const col = sevColor(inc.sev);
          return (
            <div
              key={inc.id}
              className="row-hover-faint"
              style={{
                display: 'grid',
                gridTemplateColumns: 'auto 1fr auto auto',
                gap: 10,
                alignItems: 'center',
                padding: '8px 16px',
                borderBottom: '1px solid var(--b2)',
                fontSize: 11,
                borderLeft: `2px solid ${col}`,
              }}
            >
              <span style={{ fontSize: 14 }}>{inc.icon}</span>
              <div style={{ minWidth: 0 }}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
                  <span style={{ fontWeight: 600 }}>{inc.type}</span>
                  <span style={{
                    fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--muted)',
                  }}>
                    {inc.location_name}
                  </span>
                </div>
                <div style={{
                  fontSize: 10, color: 'var(--dim)',
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  marginTop: 2,
                }}>
                  {inc.desc}
                </div>
              </div>
              <span style={{
                fontFamily: 'var(--mono)', fontSize: 9,
                padding: '1px 6px', borderRadius: 3,
                background: col + '22', color: col,
                border: `1px solid ${col}55`,
                whiteSpace: 'nowrap',
              }}>
                {sevLabel(inc.sev)} · {inc.sev.toFixed(2)}
              </span>
              <span style={{
                fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--muted)',
                whiteSpace: 'nowrap',
              }}>
                {inc.date}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── 5. Time-of-Day Heatmap ──────────────────────────────────────
function TimeHeatmap({ data }: { data: HeatmapCell[] }) {
  const { tick } = useTheme();
  const ref = useCanvas(cv => {
    const g = setupCanvas(cv, 195);
    if (!g) return;
    const { ctx, W, H } = g;
    const { MUTED, TEXT } = chartColors();
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const hourLabels = [0, 3, 6, 9, 12, 15, 18, 21];
    const sumByCell: number[][] = Array.from({ length: 8 }, () => Array(7).fill(0));
    const countByCell: number[][] = Array.from({ length: 8 }, () => Array(7).fill(0));
    // hooks/heatmap data already supplies per-(hour_block, weekday) aggregates.
    data.forEach(c => {
      sumByCell[c.hour_block][c.weekday] = c.avg_sev * c.count;
      countByCell[c.hour_block][c.weekday] = c.count;
    });
    const flatAvg = sumByCell.flat().map((v, i) => {
      const cnt = countByCell.flat()[i];
      return cnt ? v / cnt : 0;
    });
    const mx = Math.max(...flatAvg, 0.01);
    const p: Padding = { l: 28, r: 8, t: 22, b: 12 };
    const cW = (W - p.l - p.r) / 7;
    const rH = (H - p.t - p.b) / 8;
    sumByCell.forEach((row, bi) => row.forEach((sum, di) => {
      const cnt = countByCell[bi][di];
      const avg = cnt ? sum / cnt : 0;
      const norm = avg / mx;
      const x = p.l + di * cW;
      const y = p.t + bi * rH;
      ctx.fillStyle = `rgba(239,68,68,${(norm * 0.82).toFixed(2)})`;
      ctx.fillRect(x + 1, y + 1, cW - 2, rH - 2);
      if (cnt > 0) {
        ctx.fillStyle = TEXT;
        ctx.font = '7.5px DM Mono, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(String(cnt), x + cW / 2, y + rH / 2 + 3);
      }
    }));
    days.forEach((d, i) => {
      ctx.fillStyle = MUTED;
      ctx.font = '8px Barlow, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(d, p.l + i * cW + cW / 2, p.t - 6);
    });
    hourLabels.forEach((h, i) => {
      ctx.fillStyle = MUTED;
      ctx.font = '8px DM Mono, monospace';
      ctx.textAlign = 'right';
      ctx.fillText(`${String(h).padStart(2, '0')}h`, p.l - 2, p.t + i * rH + rH / 2 + 3);
    });
  }, [data, tick]);

  return (
    <div style={S.panel}>
      <div style={S.hdr}>
        <div>
          <div style={S.title}>Time-of-Day Heatmap</div>
          <div style={S.sub}>Incident count by 3-hour block × weekday</div>
        </div>
      </div>
      <div style={S.body}>
        <canvas ref={ref} style={{ display: 'block', width: '100%', height: 195 }} />
      </div>
    </div>
  );
}

// ─── 6. Avg Severity Trend (multi-line) ──────────────────────────
function SeverityTrend({ data }: { data: MonthlyData[] }) {
  const { tick } = useTheme();
  const ref = useCanvas(cv => {
    const g = setupCanvas(cv, 195);
    if (!g) return;
    const { ctx, W, H } = g;
    const { MUTED } = chartColors();
    const p: Padding = { l: 36, r: 14, t: 16, b: 30 };
    const series: (number | null)[][] = CATS.map(c => data.map(m => {
      const key = `${c.toLowerCase()}_avg_sev` as keyof MonthlyData;
      const v = m[key] as number;
      return v && v > 0 ? v : null;
    }));
    drawGrid(ctx, W, H, p, 1, 5);
    const xs = MONTHS.map((_, i) => p.l + (i * (W - p.l - p.r)) / (MONTHS.length - 1));
    series.forEach((line, ci) => {
      ctx.beginPath();
      let first = true;
      line.forEach((v, mi) => {
        if (v === null) return;
        const x = xs[mi], y = p.t + (H - p.t - p.b) * (1 - v);
        if (first) { ctx.moveTo(x, y); first = false; }
        else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = COLORS[ci];
      ctx.lineWidth = 2;
      ctx.stroke();
      line.forEach((v, mi) => {
        if (v === null) return;
        const x = xs[mi], y = p.t + (H - p.t - p.b) * (1 - v);
        ctx.beginPath();
        ctx.arc(x, y, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = COLORS[ci];
        ctx.fill();
      });
    });
    xs.forEach((x, i) => {
      ctx.fillStyle = MUTED;
      ctx.font = '9px DM Mono, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(MONTHS[i], x, H - 12);
    });
    CATS.forEach((c, ci) => {
      const x = p.l + (ci * (W - p.l - p.r)) / CATS.length;
      ctx.fillStyle = COLORS[ci];
      ctx.fillRect(x, H - p.b + 18, 8, 6);
      ctx.fillStyle = MUTED;
      ctx.font = '8px DM Mono, monospace';
      ctx.textAlign = 'left';
      ctx.fillText(CAT_META[c].label, x + 11, H - p.b + 25);
    });
  }, [data, tick]);

  return (
    <div style={S.panel}>
      <div style={S.hdr}>
        <div>
          <div style={S.title}>Avg Severity Trend</div>
          <div style={S.sub}>Monthly avg severity per category</div>
        </div>
      </div>
      <div style={S.body}>
        <canvas ref={ref} style={{ display: 'block', width: '100%', height: 195 }} />
      </div>
    </div>
  );
}

// ─── 7. Incident Type Ranking ────────────────────────────────────
function TypeRanking({ data }: { data: TypeRankingItem[] }) {
  const top10 = data.slice(0, 10);
  const { tick } = useTheme();
  const ref = useCanvas(cv => {
    const g = setupCanvas(cv, 195);
    if (!g) return;
    const { ctx, W, H } = g;
    const { TEXT } = chartColors();
    const mx = top10[0]?.count ?? 1;
    const p: Padding = { l: 128, r: 10, t: 10, b: 10 };
    const rowH = (H - p.t - p.b) / Math.max(top10.length, 1);
    top10.forEach((it, i) => {
      const bw = Math.round((it.count / mx) * (W - p.l - p.r));
      const y = p.t + i * rowH;
      ctx.fillStyle = it.color + '22';
      ctx.fillRect(p.l, y + 2, W - p.l - p.r, rowH - 4);
      ctx.fillStyle = it.color + '88';
      ctx.fillRect(p.l, y + 2, bw, rowH - 4);
      ctx.fillStyle = TEXT;
      ctx.font = '9px Barlow, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(`${it.icon} ${it.type.substring(0, 19)}`, p.l - 3, y + rowH / 2 + 3);
      ctx.fillStyle = it.color;
      ctx.font = 'bold 9px DM Mono, monospace';
      ctx.textAlign = 'left';
      ctx.fillText(String(it.count), p.l + bw + 3, y + rowH / 2 + 3);
    });
  }, [data, tick]);

  return (
    <div style={S.panel}>
      <div style={S.hdr}>
        <div>
          <div style={S.title}>Incident Type Ranking</div>
          <div style={S.sub}>Top 10 types YTD</div>
        </div>
      </div>
      <div style={S.body}>
        <canvas ref={ref} style={{ display: 'block', width: '100%', height: 195 }} />
      </div>
    </div>
  );
}

// ─── Insight cards ───────────────────────────────────────────────
const MONTH_LABEL = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function InsightCards({ monthly, cat }: { monthly: MonthlyData[] | null; cat: CategoryData[] | null }) {
  if (!monthly || !cat || monthly.length === 0) return null;

  // Peak month: highest average severity. Latest month: last entry chronologically.
  const peak = monthly.reduce((a, b) => (b.avg_sev > a.avg_sev ? b : a));
  const latest = monthly[monthly.length - 1];
  const baseline = monthly[0];
  const peakDelta = baseline.total > 0
    ? Math.round(((peak.total - baseline.total) / baseline.total) * 100)
    : 0;

  // Annualize the latest (partial) month by extrapolating from days-elapsed.
  const [latestYear, latestMonth] = latest.month.split('-').map(Number);
  const daysInLatest = new Date(latestYear, latestMonth, 0).getDate();
  const now = new Date();
  const isCurrentMonth = now.getFullYear() === latestYear && now.getMonth() + 1 === latestMonth;
  const daysElapsed = isCurrentMonth ? Math.max(1, now.getDate()) : daysInLatest;
  const latestPace = Math.round(latest.total * (daysInLatest / daysElapsed));
  const peakLabel = `${MONTH_LABEL[Number(peak.month.split('-')[1]) - 1]} ${peak.month.split('-')[0]}`;
  const latestLabel = MONTH_LABEL[latestMonth - 1];

  const violent = cat.find(c => c.cat === 'VIOLENT');
  const health = cat.find(c => c.cat === 'HEALTH');

  const cards = [
    { n: peak.total, col: 'var(--red)', label: `${peakLabel} — Peak Severity Month`, desc: `Highest average severity of the period (${peak.avg_sev.toFixed(2)}). Pablo Kisel Blvd and downtown corridors accounted for the bulk of high-severity incidents.`, trend: `${peakDelta >= 0 ? '↑' : '↓'} ${Math.abs(peakDelta)}% vs ${MONTH_LABEL[Number(baseline.month.split('-')[1]) - 1]} baseline`, tc: 'var(--red)' },
    { n: violent?.count ?? 0, col: 'var(--orange)', label: 'Violent Incidents YTD', desc: `Avg violent severity ${(violent?.avg_sev ?? 0).toFixed(2)}. Pablo Kisel Blvd and downtown corridors account for majority of incidents. Two OIS events in 2026.`, trend: '↑ Trend: entertainment district concentration', tc: 'var(--red)' },
    { n: health?.count ?? 0, col: 'var(--purple)', label: 'Health / Medical Calls', desc: 'Cameron County: 30% diabetic, 80% obese/overweight. Medical emergencies are a consistent monthly category. Valley Regional Medical Center is primary EMS destination.', trend: '→ Steady · Seasonal heat will escalate May–Sep', tc: 'var(--muted)' },
    { n: latestPace, col: 'var(--accent)', label: `${latestLabel} Paced Rate`, desc: `${latest.total} incidents in first ${daysElapsed} day(s) of ${latestLabel}. Annualized pace projects ${latestPace} total for ${latestLabel}. Hurricane season begins June 1 — elevated flood risk ahead.`, trend: '⚠ Hurricane season starts Jun 1', tc: 'var(--red)' },
  ];

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 1, background: 'var(--border)', borderTop: '1px solid var(--border)' }}>
      {cards.map(c => (
        <div key={c.label} style={{ background: 'var(--s0)', padding: '14px 18px' }}>
          <div style={{ fontFamily: 'var(--mono)', fontSize: '1.5rem', fontWeight: 500, lineHeight: 1.1, color: c.col, marginBottom: 3 }}>{c.n}</div>
          <div style={{ fontSize: 9, color: 'var(--muted)', letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 5 }}>{c.label}</div>
          <div style={{ fontSize: 10, color: 'var(--dim)', lineHeight: 1.5 }}>{c.desc}</div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10, marginTop: 5, color: c.tc }}>{c.trend}</div>
        </div>
      ))}
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────
type Mode = 'monthly' | 'weekly' | 'category';

function SkeletonPanel({ title }: { title: string }) {
  return (
    <div style={S.panel}>
      <div style={S.hdr}>
        <div style={S.title}>{title}</div>
      </div>
      <div style={S.body}>
        <div className="skeleton" style={{ width: '100%', height: 195 }} />
      </div>
    </div>
  );
}

export default function ChartsPage() {
  const [mode, setMode] = useState<Mode>('monthly');
  const [selectedLocation, setSelectedLocation] = useState<string | null>(null);
  const { data: monthly } = useMonthly();
  const { data: severity } = useSeverityDist();
  const { data: heatmap } = useHeatmap();
  const { data: types } = useTypeRanking();
  const { data: byCategory } = useByCategory();

  return (
    <div>
      {/* Header */}
      <div style={{ background: 'var(--s1)', borderBottom: '1px solid var(--border)', padding: '16px 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontFamily: 'var(--cond)', fontSize: 18, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
            Charts &amp; Trends — Jan–May 2026
          </div>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
            All 16 monitored locations · 5 months · Monthly, weekly &amp; category breakdowns
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {(['monthly', 'weekly', 'category'] as const).map(m => (
            <button
              key={m}
              onClick={() => setMode(m)}
              style={{
                fontFamily: 'var(--mono)', fontSize: 9,
                padding: '5px 12px', borderRadius: 3,
                background: mode === m ? 'rgba(74,158,245,0.12)' : 'transparent',
                border: `1px solid ${mode === m ? 'var(--blue)' : 'var(--border)'}`,
                color: mode === m ? 'var(--blue)' : 'var(--muted)',
                letterSpacing: '0.06em', cursor: 'pointer', transition: 'all .18s',
              }}
            >
              {m === 'category' ? 'By Category' : m[0].toUpperCase() + m.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 1, background: 'var(--border)' }}>
        {/* Row 1 */}
        <div style={{ gridColumn: 'span 2' }}>
          {monthly ? <MonthlyVolume data={monthly} /> : <SkeletonPanel title="Monthly Incident Volume" />}
        </div>
        {severity ? <SeverityDonut data={severity} /> : <SkeletonPanel title="Severity Distribution" />}

        {/* Row 2 */}
        <div style={{ gridColumn: 'span 2' }}>
          {monthly ? <StackedCategory data={monthly} /> : <SkeletonPanel title="Category Breakdown by Month" />}
        </div>
        <HotspotBreakdown selectedLocation={selectedLocation} onSelect={setSelectedLocation} />

        {/* Row 3 */}
        {heatmap ? <TimeHeatmap data={heatmap} /> : <SkeletonPanel title="Time-of-Day Heatmap" />}
        {monthly ? <SeverityTrend data={monthly} /> : <SkeletonPanel title="Avg Severity Trend" />}
        {types ? <TypeRanking data={types} /> : <SkeletonPanel title="Incident Type Ranking" />}

        {/* Row 4 — full-width searchable list, follows the chart's selection */}
        <div style={{ gridColumn: 'span 3' }}>
          <IncidentSearchList
            selectedLocation={selectedLocation}
            onLocationClear={() => setSelectedLocation(null)}
          />
        </div>
      </div>

      <InsightCards monthly={monthly} cat={byCategory} />
    </div>
  );
}

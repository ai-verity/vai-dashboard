// pages/ChartsPage.tsx
import { useState } from 'react';
import {
  useMonthly, useByCategory, useByLocation,
  useSeverityDist, useHeatmap, useTypeRanking,
} from '../hooks/useApi';
import { CAT_META, sevColor } from '../types';
import type { Category, MonthlyData, LocationData, SeverityTier, HeatmapCell, TypeRankingItem, CategoryData } from '../types';
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

// ─── 4. Top Locations (horizontal bars) ──────────────────────────
function TopLocations({ data }: { data: LocationData[] }) {
  const top8 = data.slice(0, 8);
  const { tick } = useTheme();
  const ref = useCanvas(cv => {
    const g = setupCanvas(cv, 195);
    if (!g) return;
    const { ctx, W, H } = g;
    const { TEXT } = chartColors();
    const mx = top8[0]?.count ?? 1;
    const p: Padding = { l: 112, r: 12, t: 12, b: 12 };
    const rowH = (H - p.t - p.b) / Math.max(top8.length, 1);
    top8.forEach((loc, i) => {
      const col = sevColor(loc.avg_sev);
      const y = p.t + i * rowH;
      const bw = Math.round((loc.count / mx) * (W - p.l - p.r));
      ctx.fillStyle = col + '20';
      ctx.fillRect(p.l, y + 2, W - p.l - p.r, rowH - 4);
      ctx.fillStyle = col + '88';
      ctx.fillRect(p.l, y + 2, bw, rowH - 4);
      ctx.fillStyle = TEXT;
      ctx.font = '9px Barlow, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(loc.location_name.substring(0, 18), p.l - 3, y + rowH / 2 + 3);
      ctx.fillStyle = col;
      ctx.font = 'bold 9px DM Mono, monospace';
      ctx.textAlign = 'left';
      ctx.fillText(String(loc.count), p.l + bw + 3, y + rowH / 2 + 3);
    });
  }, [data, tick]);

  return (
    <div style={S.panel}>
      <div style={S.hdr}>
        <div>
          <div style={S.title}>Top 8 Hotspot Locations</div>
          <div style={S.sub}>Total incidents · color = avg severity</div>
        </div>
      </div>
      <div style={S.body}>
        <canvas ref={ref} style={{ display: 'block', width: '100%', height: 195 }} />
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
  const { data: monthly } = useMonthly();
  const { data: severity } = useSeverityDist();
  const { data: locations } = useByLocation();
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
        {locations ? <TopLocations data={locations} /> : <SkeletonPanel title="Top 8 Hotspot Locations" />}

        {/* Row 3 */}
        {heatmap ? <TimeHeatmap data={heatmap} /> : <SkeletonPanel title="Time-of-Day Heatmap" />}
        {monthly ? <SeverityTrend data={monthly} /> : <SkeletonPanel title="Avg Severity Trend" />}
        {types ? <TypeRanking data={types} /> : <SkeletonPanel title="Incident Type Ranking" />}
      </div>

      <InsightCards monthly={monthly} cat={byCategory} />
    </div>
  );
}

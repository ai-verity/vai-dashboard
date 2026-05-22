// pages/AiMetricsPage.tsx
//
// Standalone dashboard for the AI Model Metrics surfaced by the daily
// training pipeline (Precision / Recall / F1, per class). Reached via
// hash route `#/ai-metrics` — does NOT share the public-safety
// TopNav / KpiStrip / AlertTicker chrome, so it can be linked or framed
// independently.

import { Fragment, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import {
  useAiSummary, useAiComparison, useAiByClass, useAiHistory, useAiDataset,
} from '../hooks/useApi';
import type {
  AiPeriod, AiHeadlineRow, AiPerClassRow, AiByClassRow,
  AiDatasetPoint, AiHistory,
} from '../types';
import { AI_METRIC_COLORS, AI_CLASS_COLORS } from '../types';
import { setupCanvas, useCanvas, chartColors } from '../utils/canvas';
import { useTheme } from '../hooks/useTheme';
import ThemeToggle from '../components/ThemeToggle';

const METRICS = ['Precision', 'Recall', 'F1'] as const;

// ─── Shared styles (mirrors ChartsPage panel styles) ────────────────
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

// ─── Helpers ────────────────────────────────────────────────────────

function pct(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return (v * 100).toFixed(1) + '%';
}

function signed(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  const s = (v * 100).toFixed(2);
  return v >= 0 ? `+${s}` : s;
}

function deltaColor(delta: number | null | undefined): string {
  if (delta === null || delta === undefined || Number.isNaN(delta)) return 'var(--muted)';
  if (delta > 0.0005) return 'var(--green)';
  if (delta < -0.0005) return 'var(--red)';
  return 'var(--muted)';
}

function periodLabel(p: AiPeriod) {
  return p === 'daily' ? 'Prior Day' : p === 'weekly' ? 'Prior Week' : 'Prior Month';
}

// ─── Headline KPI cards ─────────────────────────────────────────────
function HeadlineCards({
  rows, period, currentDate, previousDate, awaiting, aggregateOnly,
}: {
  rows: AiHeadlineRow[];
  period: AiPeriod;
  currentDate: string | undefined;
  previousDate: string | null | undefined;
  awaiting: boolean;
  aggregateOnly: boolean;
}) {
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 1,
      background: 'var(--border)',
    }}>
      {rows.map(r => {
        const col = AI_METRIC_COLORS[r.metric];
        return (
          <div key={r.metric} style={{ background: 'var(--s0)', padding: '20px 22px' }}>
            <div style={{
              fontFamily: 'var(--mono)', fontSize: 9,
              color: 'var(--muted)', letterSpacing: '0.14em',
              textTransform: 'uppercase', marginBottom: 8,
              display: 'flex', alignItems: 'center', gap: 8,
            }}>
              <span style={{ width: 8, height: 8, background: col, borderRadius: '50%' }} />
              {r.metric}
              {aggregateOnly && (
                <span
                  title="Macro-averaged across all 6 project classes (person, bicycle, car, motorcycle, bus, truck). No per-class breakdown was emitted for this run."
                  style={{
                    fontSize: 8, letterSpacing: '0.1em',
                    padding: '2px 6px', borderRadius: 2,
                    background: 'rgba(74,158,245,0.12)',
                    color: 'var(--blue)',
                    border: '1px solid rgba(74,158,245,0.35)',
                  }}
                >
                  ALL CLASSES
                </span>
              )}
              <span style={{ marginLeft: 'auto', color: 'var(--dim)' }}>
                {currentDate ?? '—'}
              </span>
            </div>
            <div style={{
              fontFamily: 'var(--mono)', fontSize: 36, fontWeight: 500,
              color: col, lineHeight: 1.05, marginBottom: 6,
            }}>
              {pct(r.current)}
            </div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, fontFamily: 'var(--mono)', fontSize: 11 }}>
              <span style={{ color: deltaColor(r.delta) }}>
                {r.delta === null ? '—' : signed(r.delta) + ' pp'}
              </span>
              <span style={{ color: 'var(--muted)', fontSize: 10 }}>
                vs {periodLabel(period)}
                {previousDate ? ` · ${previousDate}` : ''}
              </span>
            </div>
            {awaiting && (
              <div style={{
                marginTop: 10, fontSize: 10, color: 'var(--amber)',
                fontFamily: 'var(--mono)', letterSpacing: '0.04em',
              }}>
                ⚠ Awaiting more daily runs to populate this comparison
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Time-series chart (multi-line P/R/F1 across runs) ──────────────
type HistoryMode = 'macro' | 'per_class';
type MetricChoice = 'Precision' | 'Recall' | 'F1';

function HistoryChart({
  history, period,
}: {
  history: AiHistory;
  period: AiPeriod;
}) {
  const points = history.points;
  const byClass = history.by_class ?? [];
  const pointsRequired = history.points_required;
  const enough = points.length >= 2;
  const { tick } = useTheme();
  const [mode, setMode] = useState<HistoryMode>('macro');
  const [classMetric, setClassMetric] = useState<MetricChoice>('F1');

  // Per-class mode needs at least one class with at least one non-null
  // value for the chosen metric. Without that we fall back to the
  // empty-state callout below.
  const perClassSeries = useMemo(() => {
    if (mode !== 'per_class') return [] as { cls: string; values: (number | null)[] }[];
    return byClass.map(s => ({
      cls: s.cls,
      values: s.points.map(p => p[classMetric]),
    })).filter(s => s.values.some(v => v !== null));
  }, [mode, byClass, classMetric]);

  const ref = useCanvas(cv => {
    const g = setupCanvas(cv, 240);
    if (!g) return;
    const { ctx, W, H } = g;
    const { BG, MUTED, TEXT, GRID } = chartColors();
    const p = { l: 44, r: 16, t: 18, b: 32 };

    // Grid (0..1)
    for (let i = 0; i <= 5; i++) {
      const y = p.t + (H - p.t - p.b) * (1 - i / 5);
      ctx.strokeStyle = GRID;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(p.l, y);
      ctx.lineTo(W - p.r, y);
      ctx.stroke();
      ctx.fillStyle = MUTED;
      ctx.font = '9px DM Mono, monospace';
      ctx.textAlign = 'right';
      ctx.fillText(`${i * 20}%`, p.l - 6, y + 3);
    }

    if (points.length === 0) return;

    const xFor = (i: number) => {
      if (points.length === 1) return (p.l + W - p.r) / 2;
      return p.l + (i * (W - p.l - p.r)) / (points.length - 1);
    };
    const yFor = (v: number) => p.t + (H - p.t - p.b) * (1 - v);

    // x-axis labels (one per run, ticked from points which both modes share)
    points.forEach((pt, i) => {
      ctx.fillStyle = MUTED;
      ctx.font = '9px DM Mono, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(pt.run_date.slice(5), xFor(i), H - 12);
    });

    // Helper: stroke a polyline that BREAKS on null points (separate
    // sub-paths) so motorcycle/bus's null-score days don't draw straight
    // through zero on the chart.
    const drawSeries = (values: (number | null)[], col: string) => {
      const xs = values.map((_, i) => xFor(i));
      const ys = values.map(v => (v === null ? null : yFor(v)));

      ctx.strokeStyle = col;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      let pendingMove = true;
      ys.forEach((y, i) => {
        if (y === null) { pendingMove = true; return; }
        if (pendingMove) { ctx.moveTo(xs[i], y); pendingMove = false; }
        else ctx.lineTo(xs[i], y);
      });
      ctx.stroke();

      ys.forEach((y, i) => {
        if (y === null) return;
        ctx.beginPath();
        ctx.arc(xs[i], y, 4, 0, Math.PI * 2);
        ctx.fillStyle = col;
        ctx.fill();
        ctx.strokeStyle = BG;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      });
    };

    if (mode === 'macro') {
      METRICS.forEach(metric => {
        const col = AI_METRIC_COLORS[metric];
        drawSeries(points.map(p2 => p2[metric]), col);
      });

      // Legend (top-right) — the 3 metrics
      METRICS.forEach((m, mi) => {
        const x = W - p.r - 200 + mi * 70;
        const y = p.t - 4;
        ctx.fillStyle = AI_METRIC_COLORS[m];
        ctx.fillRect(x, y, 8, 8);
        ctx.fillStyle = TEXT;
        ctx.font = '10px DM Mono, monospace';
        ctx.textAlign = 'left';
        ctx.fillText(m, x + 12, y + 7);
      });
    } else {
      perClassSeries.forEach(s => {
        const col = AI_CLASS_COLORS[s.cls] ?? '#888';
        drawSeries(s.values, col);
      });

      // Legend — one swatch per visible class, wrapped to two rows if needed.
      const swatchW = 78;
      perClassSeries.forEach((s, ci) => {
        const x = W - p.r - swatchW * Math.min(perClassSeries.length, 4) + (ci % 4) * swatchW;
        const y = p.t - 4 + Math.floor(ci / 4) * 12;
        ctx.fillStyle = AI_CLASS_COLORS[s.cls] ?? '#888';
        ctx.fillRect(x, y, 8, 8);
        ctx.fillStyle = TEXT;
        ctx.font = '10px DM Mono, monospace';
        ctx.textAlign = 'left';
        ctx.fillText(s.cls, x + 12, y + 7);
      });
    }
  }, [mode, classMetric, points, perClassSeries, tick]);

  const toggleBtn = (active: boolean, label: string, onClick: () => void) => (
    <button
      onClick={onClick}
      style={{
        fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.06em',
        padding: '4px 10px', borderRadius: 3,
        border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
        background: active ? 'rgba(232,93,47,0.10)' : 'transparent',
        color: active ? 'var(--accent)' : 'var(--muted)',
        cursor: 'pointer',
      }}
    >{label}</button>
  );

  return (
    <div style={S.panel}>
      <div style={S.hdr}>
        <div>
          <div style={S.title}>Metric Trend</div>
          <div style={S.sub}>
            {mode === 'macro'
              ? 'Weighted by val instances across daily training runs'
              : `Per-class ${classMetric} across daily training runs — line breaks where a class has no data`}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ display: 'flex', gap: 4 }}>
            {toggleBtn(mode === 'macro', 'Macro avg', () => setMode('macro'))}
            {toggleBtn(mode === 'per_class', 'Per-class', () => setMode('per_class'))}
          </div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted)' }}>
            {points.length} of {pointsRequired} runs captured ({period})
          </div>
        </div>
      </div>
      {mode === 'per_class' && (
        <div style={{
          padding: '6px 18px', borderBottom: '1px solid var(--b2)',
          display: 'flex', gap: 4, alignItems: 'center',
        }}>
          <span style={{
            fontFamily: 'var(--cond)', fontSize: 10, fontWeight: 700,
            color: 'var(--muted)', letterSpacing: '0.12em',
            textTransform: 'uppercase', marginRight: 6,
          }}>Metric</span>
          {(['F1', 'Precision', 'Recall'] as const).map(m =>
            toggleBtn(classMetric === m, m, () => setClassMetric(m))
          )}
        </div>
      )}
      <div style={S.body}>
        <canvas ref={ref} style={{ display: 'block', width: '100%', height: 240 }} />
        {!enough && (
          <div style={{
            marginTop: 10, padding: '10px 14px',
            border: '1px dashed var(--border)', borderRadius: 4,
            fontSize: 11, color: 'var(--dim)', fontFamily: 'var(--mono)',
          }}>
            Trend line activates once at least 2 daily runs are on disk.
            The first run is plotted as a single point above; subsequent
            pipeline executions will extend the chart automatically.
          </div>
        )}
        {enough && mode === 'per_class' && perClassSeries.length === 0 && (
          <div style={{
            marginTop: 10, padding: '10px 14px',
            border: '1px dashed var(--border)', borderRadius: 4,
            fontSize: 11, color: 'var(--dim)', fontFamily: 'var(--mono)',
          }}>
            No per-class series for {classMetric}. Try Precision or Recall, or
            switch back to Macro avg.
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Per-class grouped bar (current vs prior, single metric) ────────
function PerClassBars({
  rows, metric, period, awaiting,
}: {
  rows: AiPerClassRow[];
  metric: 'Precision' | 'Recall' | 'F1';
  period: AiPeriod;
  awaiting: boolean;
}) {
  const { tick } = useTheme();
  const ref = useCanvas(cv => {
    const g = setupCanvas(cv, 240);
    if (!g) return;
    const { ctx, W, H } = g;
    const { MUTED, TEXT, GRID } = chartColors();
    const p = { l: 44, r: 16, t: 16, b: 36 };
    const usable = rows.length > 0 ? rows : [];

    // Grid 0..1
    for (let i = 0; i <= 5; i++) {
      const y = p.t + (H - p.t - p.b) * (1 - i / 5);
      ctx.strokeStyle = GRID;
      ctx.beginPath();
      ctx.moveTo(p.l, y);
      ctx.lineTo(W - p.r, y);
      ctx.stroke();
      ctx.fillStyle = MUTED;
      ctx.font = '9px DM Mono, monospace';
      ctx.textAlign = 'right';
      ctx.fillText(`${i * 20}%`, p.l - 6, y + 3);
    }

    if (usable.length === 0) return;

    const innerW = W - p.l - p.r;
    const slot = innerW / usable.length;
    const barW = Math.max(8, Math.min(22, slot / 3));
    const gap = 3;
    const groupW = barW * 2 + gap;

    usable.forEach((row, i) => {
      const cell = row.metrics[metric];
      const cx = p.l + slot * i + slot / 2;
      const xPrev = cx - groupW / 2;
      const xCur = xPrev + barW + gap;

      const prevV = cell.previous ?? 0;
      const curV = cell.current ?? 0;
      const prevH = (H - p.t - p.b) * prevV;
      const curH = (H - p.t - p.b) * curV;

      // prior bar — translucent muted swatch; reads the theme so the
      // bar is a desaturated dark on light mode, off-white on dark mode.
      ctx.fillStyle = MUTED;
      ctx.globalAlpha = 0.25;
      ctx.fillRect(xPrev, H - p.b - prevH, barW, prevH);
      ctx.globalAlpha = 1;
      if (cell.previous === null) {
        ctx.fillStyle = MUTED;
        ctx.font = '8px DM Mono, monospace';
        ctx.textAlign = 'center';
        ctx.fillText('—', xPrev + barW / 2, H - p.b - 4);
      }

      // current bar (metric color)
      ctx.fillStyle = AI_METRIC_COLORS[metric];
      ctx.fillRect(xCur, H - p.b - curH, barW, curH);

      // value above current
      if (cell.current !== null) {
        ctx.fillStyle = TEXT;
        ctx.font = 'bold 9px DM Mono, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(
          (cell.current * 100).toFixed(0),
          xCur + barW / 2,
          Math.max(H - p.b - curH - 4, p.t + 8),
        );
      }

      // x-axis label
      ctx.fillStyle = MUTED;
      ctx.font = '9px Barlow, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(row.cls, cx, H - 18);

      // delta below
      if (cell.delta !== null) {
        const c = cell.delta > 0 ? '#2EC98A' : cell.delta < 0 ? '#e84040' : MUTED;
        ctx.fillStyle = c;
        ctx.font = '8.5px DM Mono, monospace';
        ctx.fillText(signed(cell.delta), cx, H - 6);
      }
    });

    // Legend
    const legendItems = [
      { col: MUTED,                    label: periodLabel(period), alpha: 0.5 },
      { col: AI_METRIC_COLORS[metric], label: 'Current',           alpha: 1 },
    ];
    legendItems.forEach((it, li) => {
      const x = W - p.r - 170 + li * 90;
      const y = p.t - 4;
      ctx.globalAlpha = it.alpha;
      ctx.fillStyle = it.col;
      ctx.fillRect(x, y, 10, 8);
      ctx.globalAlpha = 1;
      ctx.fillStyle = TEXT;
      ctx.font = '10px DM Mono, monospace';
      ctx.textAlign = 'left';
      ctx.fillText(it.label, x + 14, y + 7);
    });
  }, [rows, metric, period, tick]);

  return (
    <div style={S.panel}>
      <div style={S.hdr}>
        <div>
          <div style={S.title}>{metric} by class</div>
          <div style={S.sub}>
            Current vs {periodLabel(period).toLowerCase()} · value label is current ×100
          </div>
        </div>
      </div>
      <div style={S.body}>
        <canvas ref={ref} style={{ display: 'block', width: '100%', height: 240 }} />
        {awaiting && (
          <div style={{
            marginTop: 8, fontSize: 10, color: 'var(--amber)',
            fontFamily: 'var(--mono)',
          }}>
            Prior-period bars unavailable — empty bars shown until enough daily runs accumulate.
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Per-class table (detail) ───────────────────────────────────────
function ClassTable({ rows }: { rows: AiByClassRow[] }) {
  return (
    <div style={S.panel}>
      <div style={S.hdr}>
        <div>
          <div style={S.title}>Per-class breakdown — latest run</div>
          <div style={S.sub}>Precision / Recall / F1 with prior-run delta and instance counts</div>
        </div>
      </div>
      <div style={S.body}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{
            width: '100%', borderCollapse: 'collapse',
            fontFamily: 'var(--mono)', fontSize: 11,
          }}>
            <thead>
              <tr style={{ color: 'var(--muted)', textAlign: 'left' }}>
                <th style={th}>Class</th>
                <th style={thNum}>Train</th>
                <th style={thNum}>Val</th>
                {METRICS.map(m => (
                  <th key={m} style={thNum} colSpan={2}>{m}</th>
                ))}
              </tr>
              <tr style={{ color: 'var(--muted)', fontSize: 9 }}>
                <th style={th}></th>
                <th style={thNum}>inst.</th>
                <th style={thNum}>inst.</th>
                {METRICS.map(m => (
                  <Fragment key={`hd-${m}`}>
                    <th style={thNum}>now</th>
                    <th style={thNum}>Δ pp</th>
                  </Fragment>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.cls} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={td}>
                    <span style={{ color: 'var(--text)', fontFamily: 'var(--body)', fontWeight: 600 }}>{r.cls}</span>
                  </td>
                  <td style={tdNum}>{r.instances.train ?? '—'}</td>
                  <td style={tdNum}>{r.instances.val ?? '—'}</td>
                  {METRICS.map(m => {
                    const cell = r.metrics[m];
                    return (
                      <Fragment key={`${r.cls}-${m}`}>
                        <td style={{ ...tdNum, color: AI_METRIC_COLORS[m] }}>
                          {pct(cell.current)}
                        </td>
                        <td style={{ ...tdNum, color: deltaColor(cell.delta) }}>
                          {cell.delta === null ? '—' : signed(cell.delta)}
                        </td>
                      </Fragment>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

const th: CSSProperties = {
  padding: '6px 8px',
  fontWeight: 500, letterSpacing: '0.08em',
  textTransform: 'uppercase', fontSize: 9,
};
const thNum: CSSProperties = { ...th, textAlign: 'right' };
const td: CSSProperties = { padding: '8px', verticalAlign: 'middle' };
const tdNum: CSSProperties = { ...td, textAlign: 'right', fontFamily: 'var(--mono)' };

// ─── Skeleton ───────────────────────────────────────────────────────
function SkeletonPanel({ title, h = 240 }: { title: string; h?: number }) {
  return (
    <div style={S.panel}>
      <div style={S.hdr}><div style={S.title}>{title}</div></div>
      <div style={S.body}>
        <div className="skeleton" style={{ width: '100%', height: h }} />
      </div>
    </div>
  );
}

// Empty state for the case where the API call succeeded but the current
// runs simply don't carry per-class data (e.g. aggregate-only "all" rows
// from the older YOLO summary format). Distinct from the loading skeleton
// — a perpetually-shimmering panel looks broken when data is just absent.
function EmptyPanel({ title, h = 240, message }: { title: string; h?: number; message: string }) {
  return (
    <div style={S.panel}>
      <div style={S.hdr}><div style={S.title}>{title}</div></div>
      <div style={{
        ...S.body,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        minHeight: h, flexDirection: 'column', gap: 6,
        border: '1px dashed var(--border)', margin: 16, padding: 16,
      }}>
        <div style={{
          fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)',
          letterSpacing: '0.06em', textAlign: 'center', lineHeight: 1.6,
        }}>
          {message}
        </div>
      </div>
    </div>
  );
}

// ─── Dataset KPI strip + charts ─────────────────────────────────────
//
// New section driven by the class_mapping.txt files dropped by the
// training pipeline. Surfaces how the training dataset grew over time
// (total / annotated / background images per run) and what the latest
// class mix looks like.

function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  return n.toLocaleString();
}

function DatasetKpiStrip({ latest }: { latest: AiDatasetPoint | null }) {
  const cells: Array<{ label: string; value: string; sub?: string; color: string }> = [
    { label: 'Total Images',     value: fmt(latest?.total_images),     sub: latest ? `train ${fmt(latest.train_images)} · val ${fmt(latest.val_images)}` : '—', color: 'var(--accent)' },
    { label: 'Annotated',        value: fmt(latest?.annotated_images), sub: latest ? `${((latest.annotated_images / Math.max(latest.total_images, 1)) * 100).toFixed(1)}% of total` : '—', color: 'var(--green)' },
    { label: 'Unannotated (bg)', value: fmt(latest?.empty_bg_images),  sub: latest ? `${((latest.empty_bg_images / Math.max(latest.total_images, 1)) * 100).toFixed(1)}% of total` : '—', color: 'var(--amber)' },
    { label: 'Auto-Labeled',     value: latest && latest.auto_labeled_images != null ? fmt(latest.auto_labeled_images) : '—', sub: 'pipeline field not emitted yet', color: 'var(--muted)' },
    { label: 'Dropped Regions',  value: fmt(latest?.dropped_regions),  sub: 'VIA classes outside mapping', color: 'var(--red)' },
    { label: 'Captured On',      value: latest?.run_date ?? '—',       sub: latest?.model ?? '', color: 'var(--blue)' },
  ];
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: 'repeat(6,1fr)', gap: 1,
      background: 'var(--border)',
    }}>
      {cells.map(c => (
        <div key={c.label} style={{ background: 'var(--s0)', padding: '14px 16px' }}>
          <div style={{
            fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--muted)',
            letterSpacing: '0.14em', textTransform: 'uppercase', marginBottom: 4,
          }}>
            {c.label}
          </div>
          <div style={{
            fontFamily: 'var(--mono)', fontSize: 22, color: c.color,
            lineHeight: 1.05, marginBottom: 3,
          }}>
            {c.value}
          </div>
          {c.sub && (
            <div style={{ fontSize: 9, color: 'var(--dim)', fontFamily: 'var(--mono)' }}>
              {c.sub}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function DatasetTrendChart({ points }: { points: AiDatasetPoint[] }) {
  const { tick } = useTheme();
  const ref = useCanvas(cv => {
    const g = setupCanvas(cv, 240);
    if (!g) return;
    const { ctx, W, H } = g;
    const { MUTED, GRID, TEXT } = chartColors();
    const p = { l: 48, r: 16, t: 14, b: 30 };
    const mx = Math.max(...points.map(pt => pt.total_images), 1);

    // grid + y labels
    for (let i = 0; i <= 4; i++) {
      const y = p.t + (H - p.t - p.b) * (1 - i / 4);
      ctx.strokeStyle = GRID;
      ctx.beginPath(); ctx.moveTo(p.l, y); ctx.lineTo(W - p.r, y); ctx.stroke();
      ctx.fillStyle = MUTED;
      ctx.font = '9px DM Mono, monospace';
      ctx.textAlign = 'right';
      ctx.fillText(Math.round(mx * i / 4).toLocaleString(), p.l - 6, y + 3);
    }

    if (points.length === 0) return;
    const colW = (W - p.l - p.r) / points.length;
    const barW = Math.max(8, Math.min(64, colW * 0.62));

    points.forEach((pt, i) => {
      const cx = p.l + colW * i + colW / 2;
      const x = cx - barW / 2;
      const totalH = (pt.total_images / mx) * (H - p.t - p.b);
      const annH = (pt.annotated_images / mx) * (H - p.t - p.b);
      const bgH = totalH - annH;
      // Background (unannotated) — amber, drawn first as the lower portion
      ctx.fillStyle = '#F5B731';
      ctx.globalAlpha = 0.75;
      ctx.fillRect(x, H - p.b - totalH, barW, bgH);
      // Annotated — green, drawn on top of background
      ctx.fillStyle = '#2DC9A8';
      ctx.fillRect(x, H - p.b - totalH + bgH, barW, annH);
      ctx.globalAlpha = 1;
      // x-axis date label
      ctx.fillStyle = MUTED;
      ctx.font = '8.5px DM Mono, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(pt.run_date.slice(5), cx, H - 12);
      // Total above bar
      ctx.fillStyle = TEXT;
      ctx.font = 'bold 9px DM Mono, monospace';
      ctx.fillText(pt.total_images.toLocaleString(), cx, Math.max(H - p.b - totalH - 4, p.t + 8));
    });
  }, [points, tick]);

  return (
    <div style={S.panel}>
      <div style={S.hdr}>
        <div>
          <div style={S.title}>Training Images per Run</div>
          <div style={S.sub}>
            Stacked: annotated <span style={{ color: '#2DC9A8' }}>■</span> + background <span style={{ color: '#F5B731' }}>■</span> = total images
          </div>
        </div>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted)' }}>
          {points.length} run(s)
        </div>
      </div>
      <div style={S.body}>
        <canvas ref={ref} style={{ display: 'block', width: '100%', height: 240 }} />
      </div>
    </div>
  );
}

function DatasetByClassChart({ latest }: { latest: AiDatasetPoint | null }) {
  const { tick } = useTheme();
  const ref = useCanvas(cv => {
    const g = setupCanvas(cv, 240);
    if (!g) return;
    const { ctx, W, H } = g;
    const { MUTED, GRID, TEXT } = chartColors();
    const p = { l: 90, r: 60, t: 14, b: 14 };

    const rows = latest?.by_class ?? [];
    if (rows.length === 0) {
      ctx.fillStyle = MUTED;
      ctx.font = '11px DM Mono, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('No per-class data', W / 2, H / 2);
      return;
    }

    const mx = Math.max(...rows.map(r => r.total), 1);
    const rowH = (H - p.t - p.b) / rows.length;

    // grid
    for (let i = 0; i <= 4; i++) {
      const x = p.l + (W - p.l - p.r) * (i / 4);
      ctx.strokeStyle = GRID;
      ctx.beginPath(); ctx.moveTo(x, p.t); ctx.lineTo(x, H - p.b); ctx.stroke();
      ctx.fillStyle = MUTED;
      ctx.font = '8.5px DM Mono, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(Math.round(mx * i / 4).toLocaleString(), x, H - p.b + 12);
    }

    rows.forEach((r, i) => {
      const y = p.t + i * rowH;
      const trainW = (r.train / mx) * (W - p.l - p.r);
      const valW = (r.val / mx) * (W - p.l - p.r);
      // train bar — accent
      ctx.fillStyle = '#4A9EF5';
      ctx.globalAlpha = 0.85;
      ctx.fillRect(p.l, y + 4, trainW, rowH - 8);
      // val stacked on top of train
      ctx.fillStyle = '#A78BFA';
      ctx.fillRect(p.l + trainW, y + 4, valW, rowH - 8);
      ctx.globalAlpha = 1;
      // class label
      ctx.fillStyle = TEXT;
      ctx.font = '10px Barlow, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(r.cls, p.l - 8, y + rowH / 2 + 4);
      // total right-aligned
      ctx.fillStyle = MUTED;
      ctx.font = 'bold 9.5px DM Mono, monospace';
      ctx.textAlign = 'left';
      ctx.fillText(r.total.toLocaleString(), p.l + trainW + valW + 4, y + rowH / 2 + 3);
    });
  }, [latest, tick]);

  return (
    <div style={S.panel}>
      <div style={S.hdr}>
        <div>
          <div style={S.title}>Latest Dataset — Boxes per Class</div>
          <div style={S.sub}>
            Train <span style={{ color: '#4A9EF5' }}>■</span> + val <span style={{ color: '#A78BFA' }}>■</span> · counts are box instances, not unique images
          </div>
        </div>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted)' }}>
          {latest?.run_date ?? '—'}
        </div>
      </div>
      <div style={S.body}>
        <canvas ref={ref} style={{ display: 'block', width: '100%', height: 240 }} />
      </div>
    </div>
  );
}

// ─── Page header (self-contained — does NOT use TopNav) ─────────────
function AiHeader({
  runDate, model, runName, period, onPeriodChange,
}: {
  runDate: string | undefined;
  model: string | null | undefined;
  runName: string | null | undefined;
  period: AiPeriod;
  onPeriodChange: (p: AiPeriod) => void;
}) {
  return (
    <>
      <nav style={{
        position: 'sticky', top: 0, zIndex: 200,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        height: 52, padding: '0 1.5rem',
        background: 'var(--s0)', borderBottom: '1px solid var(--border)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 22, height: 22, background: 'var(--blue)',
            clipPath: 'polygon(50% 0%,100% 25%,100% 75%,50% 100%,0% 75%,0% 25%)',
          }} />
          <div>
            <div style={{
              fontFamily: 'var(--cond)', fontSize: 15, fontWeight: 700,
              letterSpacing: '0.12em', textTransform: 'uppercase',
            }}>
              AI Model Metrics — Training Pipeline
            </div>
            <div style={{ fontSize: 9, color: 'var(--muted)', letterSpacing: '0.05em' }}>
              {model ?? '—'} · run {runName ?? '—'} · captured {runDate ?? '—'}
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <ThemeToggle compact />
          <a
            href="#/"
            style={{
              fontFamily: 'var(--mono)', fontSize: 10, padding: '6px 14px',
              border: '1px solid var(--border)', borderRadius: 3,
              color: 'var(--muted)', textDecoration: 'none',
              letterSpacing: '0.08em', textTransform: 'uppercase',
            }}
          >
            ← Public Safety Dashboard
          </a>
        </div>
      </nav>

      <div style={{
        background: 'var(--s1)', borderBottom: '1px solid var(--border)',
        padding: '16px 24px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <div>
          <div style={{
            fontFamily: 'var(--cond)', fontSize: 18, fontWeight: 700,
            letterSpacing: '0.08em', textTransform: 'uppercase',
          }}>
            F1 · Precision · Recall
          </div>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
            Object detection metrics emitted by the daily training pipeline
            after each annotation batch · macro-averaged across {''}
            6 project classes
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {(['daily', 'weekly', 'monthly'] as const).map(p => (
            <button
              key={p}
              onClick={() => onPeriodChange(p)}
              style={{
                fontFamily: 'var(--mono)', fontSize: 9,
                padding: '5px 14px', borderRadius: 3,
                background: period === p ? 'rgba(74,158,245,0.12)' : 'transparent',
                border: `1px solid ${period === p ? 'var(--blue)' : 'var(--border)'}`,
                color: period === p ? 'var(--blue)' : 'var(--muted)',
                letterSpacing: '0.06em', cursor: 'pointer', transition: 'all .18s',
                textTransform: 'uppercase',
              }}
            >
              {p}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

// ─── Page ───────────────────────────────────────────────────────────
export default function AiMetricsPage() {
  const [period, setPeriod] = useState<AiPeriod>('daily');
  const { data: summary } = useAiSummary();
  const { data: comparison } = useAiComparison(period);
  const { data: byClass } = useAiByClass();
  const { data: history } = useAiHistory(period);
  const { data: dataset } = useAiDataset();

  // Use comparison.by_class when available (real prior values); otherwise
  // synthesize zero-previous rows from the latest run so weekly/monthly
  // charts can still render the current bars.
  const perClassRows: AiPerClassRow[] = useMemo(() => {
    if (comparison?.by_class && comparison.by_class.length > 0) return comparison.by_class;
    if (byClass?.classes) {
      return byClass.classes.map(c => ({
        cls: c.cls,
        metrics: {
          Precision: { current: c.metrics.Precision.current, previous: null, delta: null },
          Recall:    { current: c.metrics.Recall.current,    previous: null, delta: null },
          F1:        { current: c.metrics.F1.current,        previous: null, delta: null },
        },
      }));
    }
    return [];
  }, [comparison, byClass]);

  const awaiting = comparison?.awaiting ?? false;
  const runsCaptured = comparison?.runs_in_window ?? 0;
  const runsRequired = comparison?.runs_required ?? 1;

  // When the current run only carries the "all" pseudo-class (no per-class
  // breakdown), surface that explicitly so readers know the headline numbers
  // are aggregate, not a single class. byClass === null means still loading.
  const aggregateOnly = byClass !== null && byClass.classes.length === 0;

  if (summary && !summary.available) {
    return (
      <>
        <AiHeader
          runDate={undefined}
          model={undefined}
          runName={undefined}
          period={period}
          onPeriodChange={setPeriod}
        />
        <div style={{ padding: 60, textAlign: 'center', color: 'var(--muted)' }}>
          <div style={{ fontSize: 18, marginBottom: 12, fontFamily: 'var(--cond)' }}>
            No training metrics on disk yet.
          </div>
          <div style={{ fontSize: 12, fontFamily: 'var(--mono)' }}>
            Expected file: backend/data/ai_metrics/comparison.csv
          </div>
          {summary.reason && (
            <div style={{ marginTop: 8, fontSize: 11 }}>{summary.reason}</div>
          )}
        </div>
      </>
    );
  }

  return (
    <div>
      <AiHeader
        runDate={summary?.run_date}
        model={summary?.model}
        runName={summary?.run_name}
        period={period}
        onPeriodChange={setPeriod}
      />

      {/* Headline cards */}
      {comparison ? (
        <HeadlineCards
          rows={comparison.headline}
          period={period}
          currentDate={comparison.current_run_date}
          previousDate={comparison.previous_run_date}
          awaiting={awaiting}
          aggregateOnly={aggregateOnly}
        />
      ) : (
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 1,
          background: 'var(--border)',
        }}>
          {[1, 2, 3].map(i => (
            <div key={i} style={{ background: 'var(--s0)', padding: 22 }}>
              <div className="skeleton" style={{ height: 80 }} />
            </div>
          ))}
        </div>
      )}

      {/* Awaiting banner */}
      {awaiting && (
        <div style={{
          padding: '12px 24px',
          background: 'rgba(245,183,49,0.08)',
          borderTop: '1px solid var(--border)',
          borderBottom: '1px solid var(--border)',
          fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--amber)',
          letterSpacing: '0.04em',
        }}>
          ⚠ {period.toUpperCase()} comparison is awaiting more daily runs —
          {' '}{runsCaptured} of {runsRequired} captured. Daily comparison is
          unaffected and uses the &quot;before/after&quot; values from
          comparison.csv directly.
        </div>
      )}

      {/* Training-dataset section — KPI strip + per-run / per-class charts.
          Source: backend/data/ai_metrics/class-mapping/*.txt files dropped
          by the pipeline. Auto-labeled count is null until the pipeline
          starts emitting that field. */}
      {dataset && dataset.available ? (
        <>
          <DatasetKpiStrip latest={dataset.latest} />
          <div style={{
            display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1,
            background: 'var(--border)', borderBottom: '1px solid var(--border)',
          }}>
            <DatasetTrendChart points={dataset.points} />
            <DatasetByClassChart latest={dataset.latest} />
          </div>
        </>
      ) : dataset === null ? (
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(6,1fr)', gap: 1,
          background: 'var(--border)',
        }}>
          {[1,2,3,4,5,6].map(i => (
            <div key={i} style={{ background: 'var(--s0)', padding: '14px 16px' }}>
              <div className="skeleton" style={{ height: 56 }} />
            </div>
          ))}
        </div>
      ) : null}

      {/* Grid */}
      <div style={{
        display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1,
        background: 'var(--border)',
      }}>
        {/* Row 1: history (wide) */}
        <div style={{ gridColumn: 'span 2' }}>
          {history ? (
            <HistoryChart history={history} period={period} />
          ) : (
            <SkeletonPanel title="Metric Trend" />
          )}
        </div>

        {/* Row 2 + 3 — per-class panels. Three states: still loading (skeleton),
            loaded but the runs only carry aggregate values (empty state), or
            loaded with per-class rows (the actual charts). */}
        {renderPerClassPanel(perClassRows, byClass, comparison, 'F1',        period, awaiting)}
        {renderPerClassPanel(perClassRows, byClass, comparison, 'Precision', period, awaiting)}
        {renderPerClassPanel(perClassRows, byClass, comparison, 'Recall',    period, awaiting)}

        {byClass === null ? (
          <SkeletonPanel title="Per-class breakdown" h={300} />
        ) : byClass.classes.length === 0 ? (
          <EmptyPanel
            title="Per-class breakdown — latest run"
            h={260}
            message={
              'Current run carries only aggregate (“all”) metrics — no per-class rows ' +
              'to break down. The next daily pipeline run that emits per-class P / R / F1 ' +
              'will populate this table automatically.'
            }
          />
        ) : (
          <ClassTable rows={byClass.classes} />
        )}
      </div>
    </div>
  );
}

// Helper kept outside the component to keep the JSX above readable. byClass
// is `null` while the request is in flight, `{ classes: [] }` after the
// request returns but no per-class rows existed in the data.
function renderPerClassPanel(
  perClassRows: AiPerClassRow[],
  byClass: import('../types').AiByClass | null,
  comparison: import('../types').AiComparison | null,
  metric: 'F1' | 'Precision' | 'Recall',
  period: AiPeriod,
  awaiting: boolean,
) {
  const title = `${metric} by class`;
  // Still loading either dependency → skeleton.
  if (byClass === null || comparison === null) return <SkeletonPanel title={title} />;
  // Loaded, but neither the comparison's by_class nor the by_class endpoint
  // produced any rows → aggregate-only data, render an empty state.
  if (perClassRows.length === 0) {
    return (
      <EmptyPanel
        title={title}
        message={
          'No per-class breakdown for this run. Aggregated-only training output ' +
          '(class=“all”) was supplied; once per-class rows are emitted ' +
          'by the daily pipeline this chart will activate.'
        }
      />
    );
  }
  return <PerClassBars rows={perClassRows} metric={metric} period={period} awaiting={awaiting} />;
}

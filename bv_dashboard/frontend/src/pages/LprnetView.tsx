// pages/LprnetView.tsx
//
// The "License Plate OCR" tab body for AiMetricsPage. LPRNet is a character
// RECOGNITION model (reads the plate string off an already-cropped plate), so
// its metrics are OCR-shaped — sequence/character accuracy, character error
// rate (CER), mean edit distance, per-character-position accuracy — each
// reported as baseline (pretrained) vs trained (fine-tuned). The detection
// tabs' P/R/F1 components don't fit, so this renders its own panels, reusing
// the page's canvas / hover / theme utilities and panel styling.

import { useMemo } from 'react';
import type { CSSProperties } from 'react';
import {
  useOcrSummary, useOcrRunComparison, useOcrDetail, useOcrConfusion,
  useOcrDataset, useOcrTraining, useOcrHistory,
} from '../hooks/useApi';
import type {
  OcrRunPositionRow, OcrLenAccRow, OcrEditDistRow,
  OcrConfusion, OcrLatency, OcrTrainingPoint, OcrDatasetSummary,
  OcrPlateLengthRow, OcrHistory, OcrSummary, OcrRunComparison,
} from '../types';
import { OCR_METRIC_COLORS } from '../types';
import { setupCanvas, useCanvas, chartColors } from '../utils/canvas';
import { useChartHover, ChartTooltip } from '../utils/chartHover';
import { useTheme } from '../hooks/useTheme';

// ─── Shared styles (mirror AiMetricsPage panel styles) ──────────────
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

// ─── Formatting helpers ─────────────────────────────────────────────
function pct(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return (v * 100).toFixed(1) + '%';
}
function num(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return v.toFixed(digits);
}
function fmtInt(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return Math.round(v).toLocaleString();
}
// A metric where lower is better (CER, edit distance) "improves" on a negative
// delta. Returns the semantic color.
function improveColor(delta: number | null | undefined, lowerIsBetter: boolean): string {
  if (delta === null || delta === undefined || Number.isNaN(delta)) return 'var(--muted)';
  const good = lowerIsBetter ? delta < 0 : delta > 0;
  const bad = lowerIsBetter ? delta > 0 : delta < 0;
  if (Math.abs(delta) < 1e-6) return 'var(--muted)';
  return good ? 'var(--green)' : bad ? 'var(--red)' : 'var(--muted)';
}

function EmptyPanel({ title, message, h = 200 }: { title: string; message: string; h?: number }) {
  return (
    <div style={S.panel}>
      <div style={S.hdr}><div style={S.title}>{title}</div></div>
      <div style={{
        ...S.body, display: 'flex', alignItems: 'center', justifyContent: 'center',
        minHeight: h, border: '1px dashed var(--border)', margin: 16, padding: 16,
      }}>
        <div style={{
          fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)',
          letterSpacing: '0.06em', textAlign: 'center', lineHeight: 1.6,
        }}>{message}</div>
      </div>
    </div>
  );
}
function SkeletonPanel({ title, h = 220 }: { title: string; h?: number }) {
  return (
    <div style={S.panel}>
      <div style={S.hdr}><div style={S.title}>{title}</div></div>
      <div style={S.body}><div className="skeleton" style={{ width: '100%', height: h }} /></div>
    </div>
  );
}

// ─── Headline cards: current run → prior run per OCR metric ─────────
// Run-over-run comparison (mirrors the detection tab): the big number is the
// current run's trained metric; the delta is versus the previous LPRNet run.
// With only one run on disk the backend falls back to that run's own baseline
// column (compared_to === 'baseline'), which we label accordingly.
function HeadlineCards({ cmp }: { cmp: OcrRunComparison }) {
  const rows = cmp.headline ?? [];
  const priorRun = cmp.compared_to === 'prior_run';
  const cmpLabel = priorRun
    ? `prior run${cmp.previous_run_date ? ` · ${cmp.previous_run_date}` : ''}`
    : 'baseline';
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 1,
      background: 'var(--border)',
    }}>
      {rows.map(r => {
        const col = OCR_METRIC_COLORS[r.key] ?? 'var(--blue)';
        // seq/char accuracy + CER are fractions (show %); edit distance is a raw count.
        const isCount = r.key === 'edit_distance_mean';
        const show = (v: number | null) => (isCount ? num(v) : pct(v));
        return (
          <div key={r.key} style={{ background: 'var(--s0)', padding: '18px 20px' }}>
            <div style={{
              fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--muted)',
              letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 8,
              display: 'flex', alignItems: 'center', gap: 8,
            }}>
              <span style={{ width: 8, height: 8, background: col, borderRadius: '50%' }} />
              {r.label}
              {r.lower_is_better && (
                <span title="Lower is better" style={{
                  fontSize: 7.5, letterSpacing: '0.08em', padding: '1px 5px', borderRadius: 2,
                  background: 'rgba(148,163,184,0.14)', color: 'var(--muted)',
                  border: '1px solid var(--border)',
                }}>↓ BETTER</span>
              )}
              <span style={{ marginLeft: 'auto', color: 'var(--dim)' }}>
                {cmp.current_run_date ?? '—'}
              </span>
            </div>
            <div style={{
              fontFamily: 'var(--mono)', fontSize: 34, fontWeight: 500,
              color: col, lineHeight: 1.05, marginBottom: 6,
            }}>
              {show(r.current)}
            </div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, fontFamily: 'var(--mono)', fontSize: 11 }}>
              <span style={{ color: improveColor(r.delta, r.lower_is_better) }}>
                {r.delta === null ? '—' : `${r.delta >= 0 ? '+' : ''}${isCount ? num(r.delta) : (r.delta * 100).toFixed(2) + ' pp'}`}
              </span>
              <span style={{ color: 'var(--muted)', fontSize: 10 }}>
                vs {cmpLabel} {show(r.previous)}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Per-position accuracy: prior run vs this run grouped bars ───────
// Run-over-run: the grey bar is the previous run's trained accuracy at each
// character slot, the green bar is this run's. `priorLabel` reads "Prior run"
// normally, or "Baseline" when only one run is on disk (the backend falls back
// to that run's baseline column).
function PerPositionBars({ rows, priorLabel }: { rows: OcrRunPositionRow[]; priorLabel: string }) {
  const { tick } = useTheme();
  const { regions, hover, onMouseMove, onMouseLeave } = useChartHover();
  const ref = useCanvas(cv => {
    const g = setupCanvas(cv, 240);
    if (!g) return;
    const { ctx, W, H } = g;
    const { MUTED, TEXT, GRID } = chartColors();
    const p = { l: 44, r: 16, t: 18, b: 34 };
    regions.current = [];

    for (let i = 0; i <= 5; i++) {
      const y = p.t + (H - p.t - p.b) * (1 - i / 5);
      ctx.strokeStyle = GRID; ctx.beginPath(); ctx.moveTo(p.l, y); ctx.lineTo(W - p.r, y); ctx.stroke();
      ctx.fillStyle = MUTED; ctx.font = '9px DM Mono, monospace'; ctx.textAlign = 'right';
      ctx.fillText(`${i * 20}%`, p.l - 6, y + 3);
    }
    if (rows.length === 0) return;

    const innerW = W - p.l - p.r;
    const slot = innerW / rows.length;
    const barW = Math.max(8, Math.min(24, slot / 3));
    const gap = 3;
    const groupW = barW * 2 + gap;
    const ACCENT = OCR_METRIC_COLORS.char_accuracy;

    rows.forEach((row, i) => {
      const cx = p.l + slot * i + slot / 2;
      const xPrev = cx - groupW / 2;
      const xCur = xPrev + barW + gap;
      const prevV = row.previous ?? 0, curV = row.current ?? 0;
      const prevH = (H - p.t - p.b) * prevV, curH = (H - p.t - p.b) * curV;

      ctx.fillStyle = MUTED; ctx.globalAlpha = 0.25;
      ctx.fillRect(xPrev, H - p.b - prevH, barW, prevH); ctx.globalAlpha = 1;
      regions.current.push({
        x: xPrev, y: H - p.b - Math.max(prevH, 12), w: barW, h: Math.max(prevH, 12),
        label: priorLabel, value: pct(row.previous), color: MUTED, bar: `Position ${row.position}`,
      });

      ctx.fillStyle = ACCENT;
      ctx.fillRect(xCur, H - p.b - curH, barW, curH);
      regions.current.push({
        x: xCur, y: H - p.b - Math.max(curH, 12), w: barW, h: Math.max(curH, 12),
        label: 'This run', value: pct(row.current), color: ACCENT, bar: `Position ${row.position}`,
      });

      ctx.fillStyle = TEXT; ctx.font = 'bold 9px DM Mono, monospace'; ctx.textAlign = 'center';
      ctx.fillText((curV * 100).toFixed(0), xCur + barW / 2, Math.max(H - p.b - curH - 4, p.t + 8));
      ctx.fillStyle = MUTED; ctx.font = '9px Barlow, sans-serif';
      ctx.fillText(`p${row.position}`, cx, H - 18);
      if (row.delta !== null) {
        ctx.fillStyle = row.delta > 0 ? '#2EC98A' : row.delta < 0 ? '#e84040' : MUTED;
        ctx.font = '8.5px DM Mono, monospace';
        ctx.fillText(`${row.delta >= 0 ? '+' : ''}${(row.delta * 100).toFixed(0)}`, cx, H - 6);
      }
    });

    [{ col: MUTED, label: priorLabel, alpha: 0.5 }, { col: ACCENT, label: 'This run', alpha: 1 }].forEach((it, li) => {
      const x = W - p.r - 170 + li * 90, y = p.t - 4;
      ctx.globalAlpha = it.alpha; ctx.fillStyle = it.col; ctx.fillRect(x, y, 10, 8); ctx.globalAlpha = 1;
      ctx.fillStyle = TEXT; ctx.font = '10px DM Mono, monospace'; ctx.textAlign = 'left';
      ctx.fillText(it.label, x + 14, y + 7);
    });
  }, [rows, priorLabel, tick]);

  return (
    <div style={S.panel}>
      <div style={S.hdr}>
        <div>
          <div style={S.title}>Per-position character accuracy</div>
          <div style={S.sub}>Accuracy at each character slot · {priorLabel.toLowerCase()} vs this run · value ×100 above bar</div>
        </div>
      </div>
      <div style={S.body}>
        <div style={{ position: 'relative' }} onMouseMove={onMouseMove} onMouseLeave={onMouseLeave}>
          <canvas ref={ref} style={{ display: 'block', width: '100%', height: 240 }} />
          <ChartTooltip hover={hover} />
        </div>
      </div>
    </div>
  );
}

// ─── Generic single-series vertical bar chart (counts) ──────────────
function CountBars({
  title, sub, labels, values, color, fmtVal = fmtInt, xLabel, yLabel,
}: {
  title: string; sub: string; labels: string[]; values: number[];
  color: string; fmtVal?: (v: number) => string;
  xLabel: string; yLabel: string;
}) {
  const { tick } = useTheme();
  const { regions, hover, onMouseMove, onMouseLeave } = useChartHover();
  const ref = useCanvas(cv => {
    const g = setupCanvas(cv, 240);
    if (!g) return;
    const { ctx, W, H } = g;
    const { MUTED, TEXT, GRID } = chartColors();
    // Extra left + bottom room for the rotated y-title and the x-title.
    const p = { l: 56, r: 14, t: 16, b: 46 };
    regions.current = [];
    const mx = Math.max(...values, 1);
    for (let i = 0; i <= 4; i++) {
      const y = p.t + (H - p.t - p.b) * (1 - i / 4);
      ctx.strokeStyle = GRID; ctx.beginPath(); ctx.moveTo(p.l, y); ctx.lineTo(W - p.r, y); ctx.stroke();
      ctx.fillStyle = MUTED; ctx.font = '9px DM Mono, monospace'; ctx.textAlign = 'right';
      ctx.fillText(Math.round(mx * i / 4).toString(), p.l - 6, y + 3);
    }
    if (values.length === 0) return;
    const slot = (W - p.l - p.r) / values.length;
    const barW = Math.max(6, Math.min(48, slot * 0.6));
    values.forEach((v, i) => {
      const cx = p.l + slot * i + slot / 2;
      const x = cx - barW / 2;
      const h = (v / mx) * (H - p.t - p.b);
      ctx.fillStyle = color; ctx.fillRect(x, H - p.b - h, barW, h);
      regions.current.push({
        x, y: H - p.b - Math.max(h, 10), w: barW, h: Math.max(h, 10),
        label: `${xLabel} ${labels[i]}`, value: fmtVal(v), color,
      });
      ctx.fillStyle = TEXT; ctx.font = 'bold 9px DM Mono, monospace'; ctx.textAlign = 'center';
      ctx.fillText(fmtVal(v), cx, Math.max(H - p.b - h - 4, p.t + 8));
      ctx.fillStyle = MUTED; ctx.font = '10px Barlow, sans-serif';
      ctx.fillText(labels[i], cx, H - p.b + 16);
    });

    // Axis titles. X-title centred under the plot; Y-title rotated up the
    // left gutter so the bare tick numbers read as a quantity, not an id.
    ctx.fillStyle = TEXT;
    ctx.font = '10px Barlow, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(xLabel, p.l + (W - p.l - p.r) / 2, H - 6);
    ctx.save();
    ctx.translate(13, p.t + (H - p.t - p.b) / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(yLabel, 0, 0);
    ctx.restore();
  }, [labels, values, color, xLabel, yLabel, tick]);
  return (
    <div style={S.panel}>
      <div style={S.hdr}><div><div style={S.title}>{title}</div><div style={S.sub}>{sub}</div></div></div>
      <div style={S.body}>
        <div style={{ position: 'relative' }} onMouseMove={onMouseMove} onMouseLeave={onMouseLeave}>
          <canvas ref={ref} style={{ display: 'block', width: '100%', height: 240 }} />
          <ChartTooltip hover={hover} />
        </div>
      </div>
    </div>
  );
}

// ─── Confusion heatmap (ground-truth row × predicted col) ───────────
function ConfusionHeatmap({ data }: { data: OcrConfusion }) {
  const { tick } = useTheme();
  const { regions, hover, onMouseMove, onMouseLeave } = useChartHover();
  const labels = data.labels;
  const ref = useCanvas(cv => {
    const g = setupCanvas(cv, 420);
    if (!g) return;
    const { ctx, W, H } = g;
    const { MUTED, TEXT } = chartColors();
    const p = { l: 26, r: 12, t: 26, b: 12 };
    regions.current = [];
    const n = labels.length;
    if (n === 0) return;
    const cell = Math.min((W - p.l - p.r) / n, (H - p.t - p.b) / n);
    const ACCENT = OCR_METRIC_COLORS.char_accuracy;
    // Color intensity by off-diagonal magnitude relative to row total; the
    // diagonal (correct) is drawn in the accent color, errors in red.
    data.rows.forEach((row, ri) => {
      const total = row.total || 1;
      row.counts.forEach((c, ci) => {
        const x = p.l + ci * cell, y = p.t + ri * cell;
        if (c > 0) {
          const frac = c / total;
          const correct = labels[ci] === row.gt;
          ctx.fillStyle = correct ? ACCENT : '#e84040';
          ctx.globalAlpha = correct ? Math.max(0.18, frac) : Math.max(0.25, Math.min(1, frac * 1.4));
          ctx.fillRect(x, y, cell - 1, cell - 1);
          ctx.globalAlpha = 1;
          regions.current.push({
            x, y, w: cell - 1, h: cell - 1,
            label: correct ? 'correct' : 'misread',
            value: `${c}`, color: correct ? ACCENT : '#e84040',
            bar: `${row.gt} → ${labels[ci]}`,
          });
        }
      });
    });
    // Axis labels (sparse to avoid clutter): every char along top + left.
    ctx.font = '7px DM Mono, monospace'; ctx.fillStyle = MUTED;
    labels.forEach((lb, i) => {
      ctx.textAlign = 'center';
      ctx.fillText(lb, p.l + i * cell + cell / 2, p.t - 6);
      ctx.textAlign = 'right';
      ctx.fillText(lb, p.l - 4, p.t + i * cell + cell / 2 + 3);
    });
    ctx.fillStyle = TEXT; ctx.font = '8px DM Mono, monospace'; ctx.textAlign = 'left';
  }, [data, labels, tick]);
  return (
    <div style={S.panel}>
      <div style={S.hdr}>
        <div>
          <div style={S.title}>Character confusion matrix</div>
          <div style={S.sub}>
            Row = ground truth, column = prediction · diagonal <span style={{ color: OCR_METRIC_COLORS.char_accuracy }}>■</span> correct, off-diagonal <span style={{ color: '#e84040' }}>■</span> misread
          </div>
        </div>
      </div>
      <div style={S.body}>
        <div style={{ position: 'relative' }} onMouseMove={onMouseMove} onMouseLeave={onMouseLeave}>
          <canvas ref={ref} style={{ display: 'block', width: '100%', height: 420 }} />
          <ChartTooltip hover={hover} />
        </div>
      </div>
    </div>
  );
}

// ─── Training curve (loss + accuracy over epochs) ───────────────────
function TrainingCurve({ points, bestEpoch }: { points: OcrTrainingPoint[]; bestEpoch: number | null | undefined }) {
  const { tick } = useTheme();
  const { regions, hover, onMouseMove, onMouseLeave } = useChartHover();
  const ref = useCanvas(cv => {
    const g = setupCanvas(cv, 240);
    if (!g) return;
    const { ctx, W, H } = g;
    const { MUTED, TEXT, GRID } = chartColors();
    const p = { l: 44, r: 44, t: 18, b: 30 };
    regions.current = [];
    if (points.length === 0) return;
    const losses = points.map(pt => pt.loss).filter((v): v is number => v !== null);
    const maxLoss = Math.max(...losses, 1);
    const xFor = (i: number) => p.l + (i * (W - p.l - p.r)) / Math.max(points.length - 1, 1);

    // left axis = loss, right axis = accuracy (0..1)
    for (let i = 0; i <= 4; i++) {
      const y = p.t + (H - p.t - p.b) * (1 - i / 4);
      ctx.strokeStyle = GRID; ctx.beginPath(); ctx.moveTo(p.l, y); ctx.lineTo(W - p.r, y); ctx.stroke();
      ctx.fillStyle = MUTED; ctx.font = '8px DM Mono, monospace';
      ctx.textAlign = 'right'; ctx.fillText((maxLoss * i / 4).toFixed(1), p.l - 5, y + 3);
      ctx.textAlign = 'left'; ctx.fillText(`${i * 25}%`, W - p.r + 5, y + 3);
    }

    // best-epoch marker
    if (bestEpoch != null) {
      const idx = points.findIndex(pt => pt.epoch === bestEpoch);
      if (idx >= 0) {
        const x = xFor(idx);
        ctx.strokeStyle = 'rgba(148,163,184,0.5)'; ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(x, p.t); ctx.lineTo(x, H - p.b); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = MUTED; ctx.font = '8px DM Mono, monospace'; ctx.textAlign = 'center';
        ctx.fillText(`best e${bestEpoch}`, x, p.t - 4);
      }
    }

    // loss line (accent)
    ctx.strokeStyle = '#e85d2f'; ctx.lineWidth = 2; ctx.beginPath();
    let move = true;
    points.forEach((pt, i) => {
      if (pt.loss === null) { move = true; return; }
      const x = xFor(i), y = p.t + (H - p.t - p.b) * (1 - pt.loss / maxLoss);
      if (move) { ctx.moveTo(x, y); move = false; } else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // accuracy points (blue, 0..1, right axis) — break on null
    ctx.strokeStyle = '#4A9EF5'; ctx.lineWidth = 2; ctx.beginPath();
    move = true;
    points.forEach((pt, i) => {
      if (pt.accuracy === null) { move = true; return; }
      const x = xFor(i), y = p.t + (H - p.t - p.b) * (1 - pt.accuracy);
      if (move) { ctx.moveTo(x, y); move = false; } else ctx.lineTo(x, y);
      regions.current.push({
        x: x - 5, y: y - 5, w: 10, h: 10, label: `epoch ${pt.epoch}`,
        value: `acc ${pct(pt.accuracy)}`, color: '#4A9EF5', bar: `loss ${num(pt.loss)}`,
      });
    });
    ctx.stroke();

    [{ col: '#e85d2f', label: 'loss' }, { col: '#4A9EF5', label: 'val acc' }].forEach((it, li) => {
      const x = p.l + 4 + li * 70, y = p.t - 6;
      ctx.fillStyle = it.col; ctx.fillRect(x, y, 8, 8);
      ctx.fillStyle = TEXT; ctx.font = '9px DM Mono, monospace'; ctx.textAlign = 'left';
      ctx.fillText(it.label, x + 12, y + 7);
    });
  }, [points, bestEpoch, tick]);
  return (
    <div style={S.panel}>
      <div style={S.hdr}>
        <div>
          <div style={S.title}>Training curve</div>
          <div style={S.sub}>Loss (left, ■ accent) and validation accuracy (right, ■ blue) per epoch</div>
        </div>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted)' }}>{points.length} epochs</div>
      </div>
      <div style={S.body}>
        <div style={{ position: 'relative' }} onMouseMove={onMouseMove} onMouseLeave={onMouseLeave}>
          <canvas ref={ref} style={{ display: 'block', width: '100%', height: 240 }} />
          <ChartTooltip hover={hover} />
        </div>
      </div>
    </div>
  );
}

// ─── Latency KPI strip ──────────────────────────────────────────────
function LatencyStrip({ lat }: { lat: OcrLatency }) {
  const cells = [
    { label: 'Throughput', value: lat.throughput_qps != null ? `${Math.round(lat.throughput_qps)} qps` : '—', color: 'var(--green)' },
    { label: 'Mean Latency', value: lat.mean != null ? `${num(lat.mean, 2)} ms` : '—', color: 'var(--blue)' },
    { label: 'p50', value: lat.p50 != null ? `${num(lat.p50, 2)} ms` : '—', color: 'var(--muted)' },
    { label: 'p90', value: lat.p90 != null ? `${num(lat.p90, 2)} ms` : '—', color: 'var(--muted)' },
    { label: 'p99', value: lat.p99 != null ? `${num(lat.p99, 2)} ms` : '—', color: 'var(--amber)' },
    { label: 'Max', value: lat.max != null ? `${num(lat.max, 2)} ms` : '—', color: 'var(--red)' },
  ];
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6,1fr)', gap: 1, background: 'var(--border)' }}>
      {cells.map(c => (
        <div key={c.label} style={{ background: 'var(--s0)', padding: '14px 16px' }}>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--muted)', letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 4 }}>{c.label}</div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 20, color: c.color, lineHeight: 1.05 }}>{c.value}</div>
        </div>
      ))}
    </div>
  );
}

// ─── Dataset KPI strip ──────────────────────────────────────────────
function DatasetStrip({ ds }: { ds: OcrDatasetSummary }) {
  const skipped = ds.skipped || {};
  const totalSkipped = Object.values(skipped).reduce((a: number, b) => a + (b || 0), 0);
  const cells = [
    { label: 'Plate Crops', value: fmtInt(ds.n_crops), sub: `train ${fmtInt(ds.train_size)} · val ${fmtInt(ds.val_size)}`, color: 'var(--accent)' },
    { label: 'Mean Plate Len', value: num(ds.plate_length_mean, 1), sub: `max ${fmtInt(ds.plate_length_max)} chars`, color: 'var(--blue)' },
    { label: 'Mean Crop Size', value: ds.crop_width_mean != null ? `${Math.round(ds.crop_width_mean)}×${Math.round(ds.crop_height_mean || 0)}` : '—', sub: 'width × height px', color: 'var(--green)' },
    { label: 'Skipped (non-plate)', value: fmtInt(skipped.non_plate), sub: 'not a license plate', color: 'var(--muted)' },
    { label: 'Skipped (no text)', value: fmtInt(skipped.no_text), sub: 'no readable label', color: 'var(--muted)' },
    { label: 'Total Skipped', value: fmtInt(totalSkipped), sub: 'excluded from training', color: 'var(--red)' },
  ];
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6,1fr)', gap: 1, background: 'var(--border)' }}>
      {cells.map(c => (
        <div key={c.label} style={{ background: 'var(--s0)', padding: '14px 16px' }}>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--muted)', letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 4 }}>{c.label}</div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 20, color: c.color, lineHeight: 1.05, marginBottom: 3 }}>{c.value}</div>
          <div style={{ fontSize: 9, color: 'var(--dim)', fontFamily: 'var(--mono)' }}>{c.sub}</div>
        </div>
      ))}
    </div>
  );
}

// ─── History trend across runs ──────────────────────────────────────
function HistoryTrend({ history }: { history: OcrHistory }) {
  const { tick } = useTheme();
  const { regions, hover, onMouseMove, onMouseLeave } = useChartHover();
  const pts = history.points;
  const ref = useCanvas(cv => {
    const g = setupCanvas(cv, 220);
    if (!g) return;
    const { ctx, W, H } = g;
    const { MUTED, TEXT, GRID } = chartColors();
    const p = { l: 44, r: 16, t: 18, b: 30 };
    regions.current = [];
    for (let i = 0; i <= 5; i++) {
      const y = p.t + (H - p.t - p.b) * (1 - i / 5);
      ctx.strokeStyle = GRID; ctx.beginPath(); ctx.moveTo(p.l, y); ctx.lineTo(W - p.r, y); ctx.stroke();
      ctx.fillStyle = MUTED; ctx.font = '9px DM Mono, monospace'; ctx.textAlign = 'right';
      ctx.fillText(`${i * 20}%`, p.l - 6, y + 3);
    }
    if (pts.length === 0) return;
    const xFor = (i: number) => pts.length === 1 ? (p.l + W - p.r) / 2 : p.l + (i * (W - p.l - p.r)) / (pts.length - 1);
    const yFor = (v: number) => p.t + (H - p.t - p.b) * (1 - v);
    const series: { key: 'seq_accuracy' | 'char_accuracy'; label: string }[] = [
      { key: 'seq_accuracy', label: 'Seq acc' },
      { key: 'char_accuracy', label: 'Char acc' },
    ];
    pts.forEach((pt, i) => {
      ctx.fillStyle = MUTED; ctx.font = '8px DM Mono, monospace'; ctx.textAlign = 'center';
      ctx.fillText(pt.run_date.slice(5), xFor(i), H - 12);
    });
    series.forEach(s => {
      const col = OCR_METRIC_COLORS[s.key];
      ctx.strokeStyle = col; ctx.lineWidth = 2.5; ctx.beginPath();
      let move = true;
      pts.forEach((pt, i) => {
        const v = pt[s.key]; if (v === null) { move = true; return; }
        const x = xFor(i), y = yFor(v);
        if (move) { ctx.moveTo(x, y); move = false; } else ctx.lineTo(x, y);
      });
      ctx.stroke();
      pts.forEach((pt, i) => {
        const v = pt[s.key]; if (v === null) return;
        const x = xFor(i), y = yFor(v);
        ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill();
        regions.current.push({ x: x - 6, y: y - 6, w: 12, h: 12, label: s.label, value: pct(v), color: col, bar: pt.run_date });
      });
    });
    series.forEach((s, si) => {
      const x = W - p.r - 150 + si * 75, y = p.t - 4;
      ctx.fillStyle = OCR_METRIC_COLORS[s.key]; ctx.fillRect(x, y, 8, 8);
      ctx.fillStyle = TEXT; ctx.font = '10px DM Mono, monospace'; ctx.textAlign = 'left';
      ctx.fillText(s.label, x + 12, y + 7);
    });
  }, [pts, tick]);
  return (
    <div style={S.panel}>
      <div style={S.hdr}>
        <div>
          <div style={S.title}>Accuracy across runs</div>
          <div style={S.sub}>Trained sequence + character accuracy per LPRNet run</div>
        </div>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted)' }}>{pts.length} run(s)</div>
      </div>
      <div style={S.body}>
        <div style={{ position: 'relative' }} onMouseMove={onMouseMove} onMouseLeave={onMouseLeave}>
          <canvas ref={ref} style={{ display: 'block', width: '100%', height: 220 }} />
          <ChartTooltip hover={hover} />
        </div>
        {pts.length < 2 && (
          <div style={{ marginTop: 10, padding: '10px 14px', border: '1px dashed var(--border)', borderRadius: 4, fontSize: 11, color: 'var(--dim)', fontFamily: 'var(--mono)' }}>
            Trend activates once a second LPRNet run is on disk. The first run is plotted as a single point.
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Run / model meta sub-header ────────────────────────────────────
export function LprnetSubHeader({ summary }: { summary: OcrSummary | null }) {
  const m = summary?.model;
  const tr = summary?.training;
  const tao = summary?.tao_eval;
  return (
    <div style={{
      background: 'var(--s1)', borderBottom: '1px solid var(--border)', padding: '16px 24px',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12,
    }}>
      <div>
        <div style={{ fontFamily: 'var(--cond)', fontSize: 18, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
          License Plate OCR — LPRNet
        </div>
        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
          Character recognition on cropped plates · baseline (pretrained) vs trained (fine-tuned) ·{' '}
          {m?.arch ?? '—'}{m?.nlayers ? ` · ${m.nlayers} layers` : ''}{m?.characters_count ? ` · ${m.characters_count} chars` : ''}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 18, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted)' }}>
        <span>eval samples <b style={{ color: 'var(--text)' }}>{fmtInt(summary?.n_eval_samples)}</b></span>
        <span>best epoch <b style={{ color: 'var(--text)' }}>{fmtInt(tr?.best_epoch)}</b></span>
        <span>TAO acc <b style={{ color: 'var(--text)' }}>{pct(tao?.tao_accuracy)}</b></span>
        <span>epochs <b style={{ color: 'var(--text)' }}>{fmtInt(tr?.epochs_done)}</b></span>
      </div>
    </div>
  );
}

// ─── The tab body ───────────────────────────────────────────────────
export default function LprnetView() {
  const { data: summary } = useOcrSummary();
  const { data: runCmp } = useOcrRunComparison();
  const { data: detail } = useOcrDetail();
  const { data: confusion } = useOcrConfusion();
  const { data: dataset } = useOcrDataset();
  const { data: training } = useOcrTraining();
  const { data: history } = useOcrHistory();

  const lenAcc = detail?.len_acc ?? [];
  const editHist = detail?.editdist_hist ?? [];

  const lenLabels = useMemo(() => lenAcc.map((r: OcrLenAccRow) => `${r.length}`), [lenAcc]);
  const lenValues = useMemo(() => lenAcc.map((r: OcrLenAccRow) => Math.round((r.accuracy ?? 0) * 100)), [lenAcc]);
  const editLabels = useMemo(() => editHist.map((r: OcrEditDistRow) => `${r.edit_distance}`), [editHist]);
  const editValues = useMemo(() => editHist.map((r: OcrEditDistRow) => r.count ?? 0), [editHist]);
  const plateLen: OcrPlateLengthRow[] = dataset?.plate_length ?? [];

  if (summary && !summary.available) {
    return (
      <>
        <LprnetSubHeader summary={summary} />
        <div style={{ padding: 60, textAlign: 'center', color: 'var(--muted)' }}>
          <div style={{ fontSize: 18, marginBottom: 12, fontFamily: 'var(--cond)' }}>No LPRNet runs on disk yet.</div>
          <div style={{ fontSize: 12, fontFamily: 'var(--mono)' }}>
            Expected: backend/data/lprnet/&lt;run&gt;/comparison/comparison.csv
          </div>
          {summary.reason && <div style={{ marginTop: 8, fontSize: 11 }}>{summary.reason}</div>}
        </div>
      </>
    );
  }

  return (
    <div>
      <LprnetSubHeader summary={summary} />

      {/* Headline OCR metrics — current run vs prior run (run-over-run) */}
      {runCmp?.available ? (
        <HeadlineCards cmp={runCmp} />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 1, background: 'var(--border)' }}>
          {[1, 2, 3, 4].map(i => <div key={i} style={{ background: 'var(--s0)', padding: 20 }}><div className="skeleton" style={{ height: 76 }} /></div>)}
        </div>
      )}

      {/* Latency strip */}
      {detail?.available && detail.latency ? <LatencyStrip lat={detail.latency} /> : null}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1, background: 'var(--border)' }}>
        {/* Per-position (wide) — run-over-run: prior run vs this run */}
        <div style={{ gridColumn: 'span 2' }}>
          {runCmp === null ? <SkeletonPanel title="Per-position character accuracy" />
            : (runCmp.per_position && runCmp.per_position.length > 0)
              ? <PerPositionBars rows={runCmp.per_position} priorLabel={runCmp.compared_to === 'prior_run' ? 'Prior run' : 'Baseline'} />
              : <EmptyPanel title="Per-position character accuracy" message="No per-position data in this run." />}
        </div>

        {/* Edit-distance histogram + per-length accuracy */}
        {detail === null ? <SkeletonPanel title="Edit-distance distribution" />
          : editValues.length > 0
            ? <CountBars title="Edit-distance distribution" sub="Plates by Levenshtein distance to ground truth (0 = exact match)" labels={editLabels} values={editValues} color={OCR_METRIC_COLORS.edit_distance_mean} xLabel="Edit distance (chars wrong)" yLabel="Plates" />
            : <EmptyPanel title="Edit-distance distribution" message="No edit-distance histogram for this run." />}

        {detail === null ? <SkeletonPanel title="Accuracy by plate length" />
          : lenValues.length > 0
            ? <CountBars title="Accuracy by plate length" sub="Sequence accuracy (%) for each ground-truth plate length" labels={lenLabels} values={lenValues} color={OCR_METRIC_COLORS.seq_accuracy} fmtVal={(v) => `${v}%`} xLabel="Plate length (chars)" yLabel="Sequence accuracy %" />
            : <EmptyPanel title="Accuracy by plate length" message="No per-length accuracy for this run." />}

        {/* Training curve + history */}
        {training === null ? <SkeletonPanel title="Training curve" />
          : training.points.length > 0
            ? <TrainingCurve points={training.points} bestEpoch={training.best_epoch} />
            : <EmptyPanel title="Training curve" message="No training log for this run." />}

        {history === null ? <SkeletonPanel title="Accuracy across runs" /> : <HistoryTrend history={history} />}

        {/* Confusion (wide) */}
        <div style={{ gridColumn: 'span 2' }}>
          {confusion === null ? <SkeletonPanel title="Character confusion matrix" h={420} />
            : confusion.available
              ? <ConfusionHeatmap data={confusion} />
              : <EmptyPanel title="Character confusion matrix" message="No confusion matrix for this run." h={300} />}
        </div>
      </div>

      {/* Dataset section */}
      {dataset?.available && dataset.summary ? (
        <>
          <DatasetStrip ds={dataset.summary} />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1, background: 'var(--border)', borderBottom: '1px solid var(--border)' }}>
            {plateLen.length > 0
              ? <CountBars title="Plate-length distribution" sub="Number of plate crops at each character length" labels={plateLen.map(r => `${r.length}`)} values={plateLen.map(r => r.count ?? 0)} color={OCR_METRIC_COLORS.char_accuracy} xLabel="Plate length (chars)" yLabel="Plate crops" />
              : <EmptyPanel title="Plate-length distribution" message="No plate-length data for this run." />}
            <WorstCharsPanel summary={summary} />
          </div>
        </>
      ) : null}
    </div>
  );
}

// ─── Worst-characters panel (from run_meta tags) ────────────────────
const tdMeta: CSSProperties = { padding: '8px 10px', fontFamily: 'var(--mono)', fontSize: 12, borderTop: '1px solid var(--border)' };
function WorstCharsPanel({ summary }: { summary: OcrSummary | null }) {
  // worst_chars lives on the comparison payload's worst_chars; the sub-header
  // already has model meta, so this panel surfaces the hardest characters and
  // a couple of training facts side-by-side.
  const tr = summary?.training;
  const m = summary?.model;
  const facts: Array<[string, string]> = [
    ['Architecture', `${m?.arch ?? '—'}${m?.nlayers ? ` · ${m.nlayers}L` : ''}`],
    ['Pretrained', m?.pretrained ?? '—'],
    ['Epochs run', fmtInt(tr?.epochs_done)],
    ['Best epoch', fmtInt(tr?.best_epoch)],
    ['Best seq acc', pct(tr?.best_seq_accuracy)],
    ['Final train loss', num(tr?.final_train_loss, 3)],
    ['Wall-clock', tr?.wall_clock_seconds != null ? `${Math.round(tr.wall_clock_seconds)} s` : '—'],
  ];
  return (
    <div style={S.panel}>
      <div style={S.hdr}><div><div style={S.title}>Run summary</div><div style={S.sub}>Model + training facts for the latest LPRNet run</div></div></div>
      <div style={{ padding: '4px 18px 16px' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <tbody>
            {facts.map(([k, v]) => (
              <tr key={k}>
                <td style={{ ...tdMeta, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: 9.5 }}>{k}</td>
                <td style={{ ...tdMeta, color: 'var(--text)', textAlign: 'right' }}>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

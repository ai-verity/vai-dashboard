// pages/AutolabelEfficacyView.tsx
//
// The "Auto-Label Efficacy" tab body for AiMetricsPage. Distinct from both
// the detection tabs (day-over-day training-pipeline deltas) and the OCR tab
// (baseline-vs-trained): this is a detection-eval SCORECARD — the
// auto-labeling script's raw output scored against a human-verified ground-
// truth sample, per the Auto-Labeling Efficacy Measurement Plan. Precision /
// Recall / F1 / policy band are computed server-side from GT / predicted /
// TP / FP / FN counts, so this view only renders what the backend returns.

import { useState } from 'react';
import {
  useAutolabelSummary, useAutolabelByClass, useAutolabelFrames, useAutolabelHistory,
} from '../hooks/useApi';
import type { AutolabelClassRow, AutolabelFrameRow, AutolabelPolicy } from '../types';
import { AI_METRIC_COLORS, AUTOLABEL_POLICY_COLORS, AUTOLABEL_POLICY_LABELS } from '../types';
import { setupCanvas, useCanvas, chartColors } from '../utils/canvas';
import { useChartHover, ChartTooltip } from '../utils/chartHover';
import { useTheme } from '../hooks/useTheme';

const METRICS = ['Precision', 'Recall', 'F1'] as const;

// ─── Shared styles (mirror AiMetricsPage / LprnetView panel styles) ─────
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

// Chip background per policy — literal rgba (not the CSS-var text color) so
// the chip reads at low opacity regardless of theme.
const POLICY_BG: Record<AutolabelPolicy, string> = {
  pre_label_on: 'rgba(46,201,138,0.14)',
  review_required: 'rgba(245,183,49,0.14)',
  pre_label_off: 'rgba(232,64,64,0.14)',
  insufficient_data: 'rgba(148,163,184,0.14)',
};

function pct(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return (v * 100).toFixed(digits) + '%';
}
function fmtInt(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return Math.round(v).toLocaleString();
}
function num(v: number | null | undefined, digits = 3): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return v.toFixed(digits);
}

function PolicyBadge({ policy }: { policy: AutolabelPolicy }) {
  return (
    <span style={{
      display: 'inline-block', fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 700,
      padding: '3px 9px', borderRadius: 20, whiteSpace: 'nowrap',
      color: AUTOLABEL_POLICY_COLORS[policy],
      background: POLICY_BG[policy],
      border: `1px solid ${AUTOLABEL_POLICY_COLORS[policy]}`,
    }}>
      {AUTOLABEL_POLICY_LABELS[policy]}
    </span>
  );
}

function WarningTag({ warning }: { warning?: string | null }) {
  if (!warning) return null;
  const label = warning === 'small_sample'
    ? 'Small sample — GT < 10 instances'
    : warning === 'zero_predictions'
      ? 'Zero predictions on this GT set — check the model is wired into this run'
      : warning;
  return (
    <div style={{
      marginTop: 4, fontSize: 9.5, color: 'var(--amber)', fontFamily: 'var(--mono)',
      letterSpacing: '0.02em',
    }}>
      ⚠ {label}
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

// ─── Sub-header (self-contained, mirrors LprnetSubHeader) ───────────────
function AutolabelSubHeader({
  cycle, runDate, frameCountTarget, frameCountNote, collectionWindow, cameras, overallPolicy,
}: {
  cycle: number | undefined;
  runDate: string | undefined;
  frameCountTarget: number | undefined;
  frameCountNote: string | undefined;
  collectionWindow: string | undefined;
  cameras: string[] | undefined;
  overallPolicy: AutolabelPolicy | undefined;
}) {
  return (
    <div style={{
      background: 'var(--s1)', borderBottom: '1px solid var(--border)', padding: '16px 24px',
      display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12,
    }}>
      <div>
        <div style={{ fontFamily: 'var(--cond)', fontSize: 18, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
          Auto-Labeling Efficacy — Cycle {cycle ?? '—'}
        </div>
        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2, maxWidth: '70ch' }}>
          Auto-label script scored against a human-verified sample, IoU &ge; 0.5 · {frameCountTarget ?? '—'}-frame pull
          {collectionWindow ? ` · frames captured ${collectionWindow}` : ''}
          {cameras && cameras.length > 0 ? ` · ${cameras.join(', ')}` : ''}
        </div>
        {frameCountNote && (
          <div style={{ fontSize: 10, color: 'var(--dim)', marginTop: 4, fontFamily: 'var(--mono)', maxWidth: '80ch' }}>
            {frameCountNote}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
        {overallPolicy && <PolicyBadge policy={overallPolicy} />}
        <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--muted)' }}>captured {runDate ?? '—'}</div>
      </div>
    </div>
  );
}

// ─── Headline KPI cards: overall Precision / Recall / F1 / mean IoU ─────
function HeadlineCards({ overall }: { overall: AutolabelClassRow }) {
  const cells = [
    { key: 'f1', label: 'Overall F1', value: pct(overall.f1), color: AI_METRIC_COLORS.F1 },
    { key: 'precision', label: 'Precision', value: pct(overall.precision), color: AI_METRIC_COLORS.Precision },
    { key: 'recall', label: 'Recall', value: pct(overall.recall), color: AI_METRIC_COLORS.Recall },
    { key: 'iou', label: 'Mean IoU (matched)', value: num(overall.mean_iou), color: 'var(--blue)' },
  ];
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 1, background: 'var(--border)' }}>
      {cells.map(c => (
        <div key={c.key} style={{ background: 'var(--s0)', padding: '20px 22px' }}>
          <div style={{
            fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--muted)',
            letterSpacing: '0.14em', textTransform: 'uppercase', marginBottom: 8,
            display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <span style={{ width: 8, height: 8, background: c.color, borderRadius: '50%' }} />
            {c.label}
          </div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 36, fontWeight: 500, color: c.color, lineHeight: 1.05 }}>
            {c.value}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Frame-stats callout: the empty-frame / busiest-quartile findings ───
function FrameStatsCallout({
  emptyFrames, framesScored, emptyShare, fpFromEmpty, fpFromEmptyShare, busiest,
}: {
  emptyFrames: number; framesScored: number; emptyShare: number | null;
  fpFromEmpty: number; fpFromEmptyShare: number | null;
  busiest: { frame_count: number; gt_total: number; tp_total: number; recall: number | null } | null;
}) {
  return (
    <div style={S.panel}>
      <div style={S.hdr}>
        <div>
          <div style={S.title}>Where the errors are concentrated</div>
          <div style={S.sub}>Derived from the frame-level counts, not a separate measurement</div>
        </div>
      </div>
      <div style={{
        ...S.body,
        background: 'linear-gradient(135deg, rgba(167,139,250,0.06), rgba(74,158,245,0.04))',
        borderLeft: '3px solid var(--blue)',
        margin: 16, borderRadius: 4, padding: '14px 18px',
        fontSize: 12.5, lineHeight: 1.7, color: 'var(--text)',
      }}>
        <strong>{emptyFrames} of {framesScored} scored frames</strong> ({pct(emptyShare, 0)}) have confirmed ground
        truth of zero objects — genuinely empty scenes — yet the script still produced boxes on every one of them,
        contributing <strong>{fmtInt(fpFromEmpty)} false positives</strong> ({pct(fpFromEmptyShare, 0)} of all FPs
        this cycle). That reads as the script hallucinating on empty frames, not a localization problem.
        {busiest && busiest.recall !== null && (
          <> On the busiest quarter of frames ({busiest.frame_count} frames, {fmtInt(busiest.gt_total)} ground-truth
          instances), recall drops to <strong>{pct(busiest.recall, 0)}</strong> ({fmtInt(busiest.tp_total)} of{' '}
          {fmtInt(busiest.gt_total)} recovered) — a separate, capacity-shaped gap in dense scenes.</>
        )}
      </div>
    </div>
  );
}

// ─── Per-class grouped bar chart: Precision / Recall / F1 ───────────────
function PerClassBars({ rows }: { rows: AutolabelClassRow[] }) {
  const { tick } = useTheme();
  const { regions, hover, onMouseMove, onMouseLeave } = useChartHover();
  const ref = useCanvas(cv => {
    const g = setupCanvas(cv, 260);
    if (!g) return;
    const { ctx, W, H } = g;
    const { MUTED, TEXT, GRID } = chartColors();
    const p = { l: 44, r: 16, t: 18, b: 40 };
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
    const barW = Math.max(6, Math.min(18, slot / (METRICS.length + 1.5)));
    const gap = 3;
    const groupW = barW * METRICS.length + gap * (METRICS.length - 1);

    rows.forEach((row, i) => {
      const cx = p.l + slot * i + slot / 2;
      const groupStart = cx - groupW / 2;
      METRICS.forEach((m, mi) => {
        const v = row[m.toLowerCase() as 'precision' | 'recall' | 'f1'] ?? 0;
        const x = groupStart + mi * (barW + gap);
        const h = (H - p.t - p.b) * v;
        const col = AI_METRIC_COLORS[m];
        ctx.fillStyle = col;
        ctx.fillRect(x, H - p.b - h, barW, h);
        regions.current.push({
          x, y: H - p.b - Math.max(h, 10), w: barW, h: Math.max(h, 10),
          label: m, value: pct(v), color: col, bar: row.cls,
        });
      });
      ctx.fillStyle = TEXT; ctx.font = '10px Barlow, sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(row.cls, cx, H - 18);
      if (row.gt < 10) {
        ctx.fillStyle = MUTED; ctx.font = '8px DM Mono, monospace';
        ctx.fillText(`(n=${row.gt})`, cx, H - 6);
      }
    });

    METRICS.forEach((m, mi) => {
      const x = W - p.r - 150 + mi * 52, y = p.t - 4;
      ctx.fillStyle = AI_METRIC_COLORS[m]; ctx.fillRect(x, y, 8, 8);
      ctx.fillStyle = TEXT; ctx.font = '10px DM Mono, monospace'; ctx.textAlign = 'left';
      ctx.fillText(m, x + 12, y + 7);
    });
  }, [rows, tick]);

  return (
    <div style={S.panel}>
      <div style={S.hdr}>
        <div>
          <div style={S.title}>Precision / Recall / F1 by class</div>
          <div style={S.sub}>(n=…) flags a ground-truth count under 10 — too small to score reliably</div>
        </div>
      </div>
      <div style={S.body}>
        <div style={{ position: 'relative' }} onMouseMove={onMouseMove} onMouseLeave={onMouseLeave}>
          <canvas ref={ref} style={{ display: 'block', width: '100%', height: 260 }} />
          <ChartTooltip hover={hover} />
        </div>
      </div>
    </div>
  );
}

// ─── Per-class table (detail) ───────────────────────────────────────────
const th: React.CSSProperties = { padding: '6px 8px', fontWeight: 500, letterSpacing: '0.08em', textTransform: 'uppercase', fontSize: 9 };
const thNum: React.CSSProperties = { ...th, textAlign: 'right' };
const td: React.CSSProperties = { padding: '8px', verticalAlign: 'middle' };
const tdNum: React.CSSProperties = { ...td, textAlign: 'right', fontFamily: 'var(--mono)' };

function ClassTable({ rows, overall }: { rows: AutolabelClassRow[]; overall: AutolabelClassRow | null }) {
  const all = overall ? [...rows, overall] : rows;
  return (
    <div style={S.panel}>
      <div style={S.hdr}>
        <div>
          <div style={S.title}>Per-class scorecard</div>
          <div style={S.sub}>Raw counts + derived Precision / Recall / F1 · policy per Measurement Plan §04</div>
        </div>
      </div>
      <div style={S.body}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--mono)', fontSize: 11 }}>
            <thead>
              <tr style={{ color: 'var(--muted)', textAlign: 'left' }}>
                <th style={th}>Class</th>
                <th style={thNum}>GT</th>
                <th style={thNum}>Pred</th>
                <th style={thNum}>TP</th>
                <th style={thNum}>FP</th>
                <th style={thNum}>FN</th>
                <th style={thNum}>Precision</th>
                <th style={thNum}>Recall</th>
                <th style={thNum}>F1</th>
                <th style={thNum}>Mean IoU</th>
                <th style={th}>Policy</th>
              </tr>
            </thead>
            <tbody>
              {all.map(r => (
                <tr key={r.cls} style={{ borderTop: r.cls === 'ALL' ? '2px solid var(--text)' : '1px solid var(--border)' }}>
                  <td style={td}>
                    <span style={{ color: 'var(--text)', fontFamily: 'var(--body)', fontWeight: 600 }}>{r.cls}</span>
                    <WarningTag warning={r.warning} />
                  </td>
                  <td style={tdNum}>{fmtInt(r.gt)}</td>
                  <td style={tdNum}>{fmtInt(r.pred)}</td>
                  <td style={tdNum}>{fmtInt(r.tp)}</td>
                  <td style={tdNum}>{fmtInt(r.fp)}</td>
                  <td style={tdNum}>{fmtInt(r.fn)}</td>
                  <td style={{ ...tdNum, color: AI_METRIC_COLORS.Precision }}>{pct(r.precision)}</td>
                  <td style={{ ...tdNum, color: AI_METRIC_COLORS.Recall }}>{pct(r.recall)}</td>
                  <td style={{ ...tdNum, color: AI_METRIC_COLORS.F1, fontWeight: 700 }}>{pct(r.f1)}</td>
                  <td style={tdNum}>{r.mean_iou !== null ? num(r.mean_iou) : '—'}</td>
                  <td style={td}><PolicyBadge policy={r.policy} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ─── Frame-level detail (toggle, not always rendered — 50+ rows) ────────
function FrameTable({ frames }: { frames: AutolabelFrameRow[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={S.panel}>
      <div style={S.hdr}>
        <div>
          <div style={S.title}>Frame-level detail</div>
          <div style={S.sub}>All classes combined, per scored frame</div>
        </div>
        <button
          onClick={() => setOpen(o => !o)}
          style={{
            fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.06em',
            padding: '4px 10px', borderRadius: 3,
            border: '1px solid var(--border)', background: 'transparent',
            color: 'var(--muted)', cursor: 'pointer',
          }}
        >
          {open ? 'Hide' : `Show all ${frames.length} frames`}
        </button>
      </div>
      {open && (
        <div style={S.body}>
          <div style={{ overflowX: 'auto', maxHeight: 420, overflowY: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--mono)', fontSize: 10.5 }}>
              <thead>
                <tr style={{ color: 'var(--muted)', textAlign: 'left', position: 'sticky', top: 0, background: 'var(--s0)' }}>
                  <th style={th}>Frame</th>
                  <th style={thNum}>GT</th>
                  <th style={thNum}>Pred</th>
                  <th style={thNum}>TP</th>
                  <th style={thNum}>FP</th>
                  <th style={thNum}>FN</th>
                  <th style={thNum}>Mean IoU</th>
                  <th style={th}>Note</th>
                </tr>
              </thead>
              <tbody>
                {frames.map((f, i) => (
                  <tr key={`${f.frame}-${i}`} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ ...td, color: 'var(--muted)' }}>{f.frame}</td>
                    <td style={tdNum}>{f.gt}</td>
                    <td style={tdNum}>{f.pred}</td>
                    <td style={tdNum}>{f.tp}</td>
                    <td style={tdNum}>{f.fp}</td>
                    <td style={tdNum}>{f.fn}</td>
                    <td style={tdNum}>{f.mean_iou !== null ? num(f.mean_iou) : '—'}</td>
                    <td style={{ ...td, color: 'var(--amber)', fontSize: 9 }}>
                      {f.confirmed_empty ? 'CONFIRMED EMPTY · ALL FP' : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Methodology + notes panel ───────────────────────────────────────────
function MethodologyPanel({ methodology, notes }: { methodology: string[]; notes: string[] }) {
  return (
    <div style={S.panel}>
      <div style={S.hdr}>
        <div>
          <div style={S.title}>Measurement loop</div>
          <div style={S.sub}>Repeats at increasing scale — this cycle is the first pass</div>
        </div>
      </div>
      <div style={S.body}>
        <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: 'var(--text)', lineHeight: 1.9 }}>
          {methodology.map((step, i) => <li key={i}>{step}</li>)}
        </ol>
        {notes.length > 0 && (
          <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
            {notes.map((n, i) => (
              <div key={i} style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 6, lineHeight: 1.6 }}>
                • {n}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────
export default function AutolabelEfficacyView() {
  const { data: summary } = useAutolabelSummary();
  const { data: byClass } = useAutolabelByClass();
  const { data: frames } = useAutolabelFrames();
  // Cross-cycle trend isn't rendered until a second cycle lands; fetched now
  // so the hook (and the endpoint it exercises) stay covered end-to-end.
  useAutolabelHistory();

  if (summary && !summary.available) {
    return (
      <div style={{ padding: 60, textAlign: 'center', color: 'var(--muted)' }}>
        <div style={{ fontSize: 18, marginBottom: 12, fontFamily: 'var(--cond)' }}>
          No auto-labeling efficacy cycles on disk yet.
        </div>
        <div style={{ fontSize: 12, fontFamily: 'var(--mono)' }}>
          Expected: backend/data/autolabel_efficacy/&lt;cycle&gt;/summary.json
        </div>
        {summary.reason && <div style={{ marginTop: 8, fontSize: 11 }}>{summary.reason}</div>}
      </div>
    );
  }

  return (
    <div>
      <AutolabelSubHeader
        cycle={summary?.cycle}
        runDate={summary?.run_date}
        frameCountTarget={summary?.frame_count_target}
        frameCountNote={summary?.frame_count_note}
        collectionWindow={summary?.collection_window}
        cameras={summary?.cameras}
        overallPolicy={summary?.overall?.policy}
      />

      {summary?.overall ? (
        <HeadlineCards overall={summary.overall} />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 1, background: 'var(--border)' }}>
          {[1, 2, 3, 4].map(i => (
            <div key={i} style={{ background: 'var(--s0)', padding: 22 }}><div className="skeleton" style={{ height: 80 }} /></div>
          ))}
        </div>
      )}

      {summary?.frame_stats && (
        <FrameStatsCallout
          emptyFrames={summary.frame_stats.confirmed_empty_frames}
          framesScored={summary.frame_stats.frames_scored}
          emptyShare={summary.frame_stats.confirmed_empty_share}
          fpFromEmpty={summary.frame_stats.fp_from_empty_frames}
          fpFromEmptyShare={summary.frame_stats.fp_from_empty_frames_share}
          busiest={summary.frame_stats.busiest_quartile}
        />
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1, background: 'var(--border)' }}>
        <div style={{ gridColumn: 'span 2' }}>
          {byClass === null
            ? <SkeletonPanel title="Precision / Recall / F1 by class" />
            : <PerClassBars rows={byClass.classes} />}
        </div>
        <div style={{ gridColumn: 'span 2' }}>
          {byClass === null
            ? <SkeletonPanel title="Per-class scorecard" h={260} />
            : <ClassTable rows={byClass.classes} overall={byClass.overall} />}
        </div>
        <div style={{ gridColumn: 'span 2' }}>
          {frames === null
            ? <SkeletonPanel title="Frame-level detail" h={120} />
            : <FrameTable frames={frames.frames} />}
        </div>
        <div style={{ gridColumn: 'span 2' }}>
          <MethodologyPanel methodology={summary?.methodology ?? []} notes={summary?.notes ?? []} />
        </div>
      </div>
    </div>
  );
}

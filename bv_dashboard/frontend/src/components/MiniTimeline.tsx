// components/MiniTimeline.tsx
import { useMonthly } from '../hooks/useApi';
import { useTheme } from '../hooks/useTheme';
import { CAT_META } from '../types';
import type { Category } from '../types';
import { setupCanvas, useCanvas, chartColors } from '../utils/canvas';
import { useChartHover, ChartTooltip } from '../utils/chartHover';

const CATS: Category[] = ['VIOLENT', 'HEALTH', 'ENVIRON', 'ORDER', 'SECURITY'];
const COLORS = ['#EF4444', '#A78BFA', '#4A9EF5', '#F5B731', '#2DC9A8'];
// The series is now a per-day breakdown across the rolling last-31-day window,
// so each entry's `month` field carries an ISO date "YYYY-MM-DD".
const dayLabel = (d: string) => {
  const p = d.split('-');
  return p.length === 3 ? `${parseInt(p[1], 10)}/${parseInt(p[2], 10)}` : d;
};
// Show ~7 evenly-spaced labels so 31 daily bars don't overlap their captions.
const labelStep = (n: number) => Math.max(1, Math.ceil(n / 7));

export default function MiniTimeline() {
  const { data, loading } = useMonthly();
  const { tick } = useTheme();
  const { regions, hover, onMouseMove, onMouseLeave } = useChartHover();

  const canvasRef = useCanvas(cv => {
    if (!data) return;
    const g = setupCanvas(cv, 128);
    if (!g) return;
    const { ctx, W, H } = g;
    const { MUTED, TEXT } = chartColors();

    const byCat: Record<Category, number[]> = {
      VIOLENT:  data.map(m => m.violent),
      HEALTH:   data.map(m => m.health),
      ENVIRON:  data.map(m => m.environ),
      ORDER:    data.map(m => m.order),
      SECURITY: data.map(m => m.security),
    };
    const totals = data.map((_, mi) => CATS.reduce((s, c) => s + byCat[c][mi], 0));
    const mx = Math.max(...totals, 1);

    // Bars use the full canvas width — no more overlap with the in-canvas
    // legend; the legend now lives in HTML above the canvas (see the
    // return value below).
    const bW = ((W - 32) / data.length) * 0.72;
    const step = labelStep(data.length);
    regions.current = [];
    data.forEach((d, mi) => {
      const m = dayLabel(d.month);
      const x = 16 + (mi * (W - 32)) / data.length + (((W - 32) / data.length) * 0.14);
      let yBase = H - 20;
      CATS.forEach((cat, ci) => {
        const n = byCat[cat][mi];
        if (!n) return;
        const hh = Math.max(2, (n / mx) * (H - 38));
        ctx.fillStyle = COLORS[ci];
        ctx.globalAlpha = 0.8;
        ctx.fillRect(x, yBase - hh, bW, hh);
        ctx.globalAlpha = 1;
        regions.current.push({
          x, y: yBase - hh, w: bW, h: hh,
          label: CAT_META[cat].label, value: n, color: COLORS[ci], bar: m,
        });
        yBase -= hh;
      });
      if (mi % step === 0 || mi === data.length - 1) {
        ctx.fillStyle = MUTED;
        ctx.font = '9px DM Mono, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(m, x + bW / 2, H - 6);
      }
      // Per-bar total only on days with incidents — keeps zero-days uncluttered.
      if (totals[mi] > 0) {
        ctx.fillStyle = TEXT;
        ctx.font = 'bold 9px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(String(totals[mi]), x + bW / 2, yBase - 5);
      }
    });
  }, [data, tick]);

  if (loading || !data) {
    return <div className="skeleton" style={{ height: 152, margin: 8 }} />;
  }

  return (
    <div>
      {/* HTML legend — keeps category labels off the bars regardless of
          canvas width or how short January's column is. */}
      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: '4px 14px',
        padding: '8px 14px 6px',
        borderBottom: '1px solid var(--b2)',
      }}>
        {CATS.map((c, ci) => (
          <div key={c} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 9 }}>
            <span style={{
              width: 9, height: 9, background: COLORS[ci],
              borderRadius: 1, flexShrink: 0,
            }} />
            <span style={{
              fontFamily: 'var(--mono)', letterSpacing: '0.04em',
              color: 'var(--dim)',
            }}>
              {CAT_META[c].label}
            </span>
          </div>
        ))}
      </div>
      <div style={{ position: 'relative' }} onMouseMove={onMouseMove} onMouseLeave={onMouseLeave}>
        <canvas
          ref={canvasRef}
          style={{ display: 'block', width: '100%', height: 128 }}
        />
        <ChartTooltip hover={hover} />
      </div>
    </div>
  );
}

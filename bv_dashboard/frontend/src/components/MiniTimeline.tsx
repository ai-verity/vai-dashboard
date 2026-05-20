// components/MiniTimeline.tsx
import { useMonthly } from '../hooks/useApi';
import { useTheme } from '../hooks/useTheme';
import { CAT_META } from '../types';
import type { Category } from '../types';
import { setupCanvas, useCanvas, chartColors } from '../utils/canvas';

const CATS: Category[] = ['VIOLENT', 'HEALTH', 'ENVIRON', 'ORDER', 'SECURITY'];
const COLORS = ['#EF4444', '#A78BFA', '#4A9EF5', '#F5B731', '#2DC9A8'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May'];

export default function MiniTimeline() {
  const { data, loading } = useMonthly();
  const { tick } = useTheme();

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
    const bW = ((W - 32) / MONTHS.length) * 0.58;
    MONTHS.forEach((m, mi) => {
      const x = 16 + (mi * (W - 32)) / MONTHS.length + (((W - 32) / MONTHS.length) * 0.21);
      let yBase = H - 20;
      CATS.forEach((cat, ci) => {
        const n = byCat[cat][mi];
        if (!n) return;
        const hh = Math.max(2, (n / mx) * (H - 38));
        ctx.fillStyle = COLORS[ci];
        ctx.globalAlpha = 0.8;
        ctx.fillRect(x, yBase - hh, bW, hh);
        ctx.globalAlpha = 1;
        yBase -= hh;
      });
      ctx.fillStyle = MUTED;
      ctx.font = '9px DM Mono, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(m, x + bW / 2, H - 6);
      ctx.fillStyle = TEXT;
      ctx.font = 'bold 9px monospace';
      ctx.fillText(String(totals[mi]), x + bW / 2, yBase - 5);
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
      <canvas
        ref={canvasRef}
        style={{ display: 'block', width: '100%', height: 128 }}
      />
    </div>
  );
}

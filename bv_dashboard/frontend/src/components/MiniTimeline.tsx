// components/MiniTimeline.tsx
import { useMonthly } from '../hooks/useApi';
import { CAT_META } from '../types';
import type { Category } from '../types';
import { setupCanvas, useCanvas } from '../utils/canvas';

const CATS: Category[] = ['VIOLENT', 'HEALTH', 'ENVIRON', 'ORDER', 'SECURITY'];
const COLORS = ['#EF4444', '#A78BFA', '#4A9EF5', '#F5B731', '#2DC9A8'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May'];

export default function MiniTimeline() {
  const { data, loading } = useMonthly();

  const canvasRef = useCanvas(cv => {
    if (!data) return;
    const g = setupCanvas(cv, 128);
    if (!g) return;
    const { ctx, W, H } = g;

    const byCat: Record<Category, number[]> = {
      VIOLENT:  data.map(m => m.violent),
      HEALTH:   data.map(m => m.health),
      ENVIRON:  data.map(m => m.environ),
      ORDER:    data.map(m => m.order),
      SECURITY: data.map(m => m.security),
    };
    const totals = data.map((_, mi) => CATS.reduce((s, c) => s + byCat[c][mi], 0));
    const mx = Math.max(...totals, 1);

    const bW = ((W - 70) / MONTHS.length) * 0.58;
    const pad = 70 / MONTHS.length + bW * 0.21;

    MONTHS.forEach((m, mi) => {
      const x = 32 + (mi * (W - 70)) / MONTHS.length + pad;
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
      ctx.fillStyle = 'rgba(94,93,88,.75)';
      ctx.font = '9px DM Mono, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(m, x + bW / 2, H - 6);
      ctx.fillStyle = 'rgba(216,213,204,.85)';
      ctx.font = 'bold 9px monospace';
      ctx.fillText(String(totals[mi]), x + bW / 2, yBase - 5);
    });

    CATS.forEach((c, ci) => {
      ctx.fillStyle = COLORS[ci];
      ctx.fillRect(8, 8 + ci * 14, 9, 7);
      ctx.fillStyle = 'rgba(94,93,88,.85)';
      ctx.font = '8px DM Mono, monospace';
      ctx.textAlign = 'left';
      ctx.fillText(CAT_META[c].label, 20, 15 + ci * 14);
    });
  }, [data]);

  if (loading || !data) {
    return <div className="skeleton" style={{ height: 128, margin: 8 }} />;
  }

  return (
    <canvas
      ref={canvasRef}
      style={{ display: 'block', width: '100%', height: 128 }}
    />
  );
}

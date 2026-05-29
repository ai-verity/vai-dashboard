// utils/chartHover.tsx
//
// Shared hover-tooltip plumbing for canvas charts. The pattern is:
//
//   const { regions, hover, onMouseMove, onMouseLeave } = useChartHover();
//   const ref = useCanvas(cv => {
//     ...
//     regions.current = [];
//     regions.current.push({ x, y, w, h, label, value, color, bar });
//     ...
//   }, [data, tick]);
//   return (
//     <div style={{ position: 'relative' }}
//          onMouseMove={onMouseMove} onMouseLeave={onMouseLeave}>
//       <canvas ref={ref} ... />
//       <ChartTooltip hover={hover} />
//     </div>
//   );
//
// Coordinates pushed into `regions` are CSS-pixel space (matching the
// W/H surface used by `setupCanvas` after the DPR scale is applied).

import { useRef, useState } from 'react';
import type { MutableRefObject } from 'react';

export type HitRegion = {
  x: number; y: number; w: number; h: number;
  label: string;
  value: number | string;
  color: string;
  bar?: string;   // optional group key, shown as the tooltip's small caption
};

export function useChartHover() {
  const regions: MutableRefObject<HitRegion[]> = useRef<HitRegion[]>([]);
  const [hover, setHover] = useState<{ x: number; y: number; region: HitRegion } | null>(null);

  const onMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    // setupCanvas sets css width = offsetWidth, so rect.{width,height}
    // match the canvas's CSS-pixel W/H. Direct subtraction is enough.
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const hit = regions.current.find(r => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
    if (hit) {
      setHover(prev =>
        prev && prev.region === hit && prev.x === x && prev.y === y
          ? prev
          : { x, y, region: hit }
      );
    } else if (hover) {
      setHover(null);
    }
  };
  const onMouseLeave = () => setHover(null);

  return { regions, hover, onMouseMove, onMouseLeave };
}

export function ChartTooltip({ hover }: { hover: { x: number; y: number; region: HitRegion } | null }) {
  if (!hover) return null;
  const { x, y, region } = hover;
  // Offset the tooltip slightly off the cursor so it doesn't flicker
  // when the mouse moves between adjacent segments.
  return (
    <div style={{
      position: 'absolute',
      left: x + 12,
      top: y + 12,
      pointerEvents: 'none',
      zIndex: 4,
      background: 'var(--s1)',
      border: '1px solid var(--border)',
      borderLeft: `3px solid ${region.color}`,
      padding: '5px 9px',
      fontFamily: 'var(--mono)',
      fontSize: 10,
      color: 'var(--text)',
      whiteSpace: 'nowrap',
      boxShadow: '0 4px 10px rgba(0,0,0,0.25)',
      borderRadius: 2,
    }}>
      {region.bar && (
        <div style={{ color: 'var(--muted)', fontSize: 8.5, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 2 }}>
          {region.bar}
        </div>
      )}
      <span style={{ color: region.color, fontWeight: 700 }}>{region.label}</span>
      <span style={{ marginLeft: 8, color: 'var(--text)' }}>{region.value}</span>
    </div>
  );
}

// utils/canvas.ts
//
// Shared DPI-aware canvas setup. Centralized here so future tweaks
// (debounce, off-thread render, theme refresh) land in one place.
//
// Chart colors come from CSS custom properties (--chart-bg, --chart-text,
// etc.) so light/dark themes swap without per-chart changes. The helpers
// resolve those variables at call time — call `chartColors()` inside
// your draw function (not at module load) so the latest theme wins.

import { useEffect, useRef } from 'react';

function readVar(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export interface ChartColors {
  BG: string;
  MUTED: string;
  TEXT: string;
  GRID: string;
  GRID_SOFT: string;
}

export function chartColors(): ChartColors {
  return {
    BG:        readVar('--chart-bg',        '#0b0d14'),
    MUTED:     readVar('--chart-muted',     'rgba(94,93,88,.85)'),
    TEXT:      readVar('--chart-text',      'rgba(216,213,204,.9)'),
    GRID:      readVar('--chart-grid',      'rgba(255,255,255,0.05)'),
    GRID_SOFT: readVar('--chart-grid-soft', 'rgba(255,255,255,0.04)'),
  };
}

// Convenience: when a chart only needs the single color, these match the
// previous `BG / MUTED / TEXT` API but always read fresh CSS values.
export function BG():    string { return readVar('--chart-bg',    '#0b0d14'); }
export function MUTED(): string { return readVar('--chart-muted', 'rgba(94,93,88,.85)'); }
export function TEXT():  string { return readVar('--chart-text',  'rgba(216,213,204,.9)'); }
export function GRID():  string { return readVar('--chart-grid',  'rgba(255,255,255,0.05)'); }

export interface CanvasSetup {
  ctx: CanvasRenderingContext2D;
  W: number;
  H: number;
}

export function setupCanvas(
  cv: HTMLCanvasElement,
  H: number,
  bg?: string,
): CanvasSetup | null {
  const W = cv.offsetWidth || 600;
  const dpr = window.devicePixelRatio || 1;
  cv.width = W * dpr;
  cv.height = H * dpr;
  cv.style.height = `${H}px`;
  const ctx = cv.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(dpr, dpr);
  ctx.fillStyle = bg ?? BG();
  ctx.fillRect(0, 0, W, H);
  return { ctx, W, H };
}

// useCanvas: runs `draw` once on mount and again on window resize,
// re-running whenever `deps` changes. Returns a ref to bind to <canvas>.
export function useCanvas(
  draw: (cv: HTMLCanvasElement) => void,
  deps: unknown[],
) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    const cv = ref.current;
    const run = () => draw(cv);
    run();
    window.addEventListener('resize', run);
    return () => window.removeEventListener('resize', run);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return ref;
}

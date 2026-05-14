// utils/canvas.ts
//
// Shared DPI-aware canvas setup. Previously duplicated in ChartsPage,
// VlmPage and MiniTimeline with diverging background colors and resize
// listeners. Centralized here so future tweaks (debounce, off-thread render)
// land in one place.

import { useEffect, useRef } from 'react';

export const BG = '#0b0d14';
export const MUTED = 'rgba(94,93,88,.85)';
export const TEXT = 'rgba(216,213,204,.9)';

export interface CanvasSetup {
  ctx: CanvasRenderingContext2D;
  W: number;
  H: number;
}

export function setupCanvas(
  cv: HTMLCanvasElement,
  H: number,
  bg: string = BG,
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
  ctx.fillStyle = bg;
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

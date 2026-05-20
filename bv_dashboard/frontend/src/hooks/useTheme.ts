// hooks/useTheme.ts
//
// Tiny theme manager: keeps a 'dark' | 'light' state, mirrors it onto
// <html data-theme="..."> so CSS variable overrides in index.css fire,
// and persists across reloads via localStorage.
//
// The hook also exposes a `tick` counter that increments on every
// theme change — chart components add it to their canvas deps so the
// canvases re-paint with the new --chart-* CSS variables.

import { useEffect, useState, useCallback } from 'react';

export type ThemeMode = 'dark' | 'light';

const STORAGE_KEY = 'vai-theme';

function readInitial(): ThemeMode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    /* localStorage may be unavailable (SSR / private mode) — fall through */
  }
  return 'dark';
}

function apply(mode: ThemeMode) {
  if (mode === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
}

// Apply the stored theme synchronously at module load so the very first
// paint already matches — avoids a dark→light flash on light-mode users.
if (typeof document !== 'undefined') {
  apply(readInitial());
}

interface ThemeStore {
  mode: ThemeMode;
  tick: number;
  listeners: Set<() => void>;
}

const store: ThemeStore = {
  mode: typeof document === 'undefined' ? 'dark' : readInitial(),
  tick: 0,
  listeners: new Set(),
};

function setMode(next: ThemeMode) {
  if (store.mode === next) return;
  store.mode = next;
  store.tick += 1;
  apply(next);
  try { localStorage.setItem(STORAGE_KEY, next); } catch { /* ignore */ }
  store.listeners.forEach(fn => fn());
}

export function useTheme() {
  const [, force] = useState(0);
  useEffect(() => {
    const fn = () => force(t => t + 1);
    store.listeners.add(fn);
    return () => { store.listeners.delete(fn); };
  }, []);

  const toggle = useCallback(() => {
    setMode(store.mode === 'dark' ? 'light' : 'dark');
  }, []);

  const set = useCallback((mode: ThemeMode) => setMode(mode), []);

  return { mode: store.mode, tick: store.tick, toggle, set };
}

// hooks/IncidentsProvider.tsx
//
// Single source of truth for `/api/incidents` on the Dashboard view. Three
// consumers (AlertTicker, IncidentFeed, IncidentMap) previously triggered
// independent fetches — the union of their needs ("first 500, no filter")
// is one request. Each consumer derives its filtered slice via useMemo.

import { createContext, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';
import { useIncidents } from './useApi';
import type { Incident } from '../types';

interface IncidentsContextValue {
  incidents: Incident[];
  total: number;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

const IncidentsContext = createContext<IncidentsContextValue | null>(null);

// Fetch a full working set once. Backend caps `limit` at 1000; 500 is the
// established upper bound used by IncidentMap pre-refactor.
const FETCH_PARAMS = { limit: 500 } as const;

export function IncidentsProvider({ children }: { children: ReactNode }) {
  const { data, loading, error, refetch } = useIncidents(FETCH_PARAMS);

  const value = useMemo<IncidentsContextValue>(() => ({
    incidents: data?.incidents ?? [],
    total: data?.total ?? 0,
    loading,
    error,
    refetch,
  }), [data, loading, error, refetch]);

  return (
    <IncidentsContext.Provider value={value}>{children}</IncidentsContext.Provider>
  );
}

export function useIncidentsContext(): IncidentsContextValue {
  const ctx = useContext(IncidentsContext);
  if (!ctx) {
    throw new Error('useIncidentsContext must be used inside <IncidentsProvider>');
  }
  return ctx;
}

// Derived selectors — each consumer gets a memoized view.

export function useHighSeverityIncidents(limit: number, minSev = 0.7): Incident[] {
  const { incidents } = useIncidentsContext();
  return useMemo(
    () => incidents.filter(i => i.sev >= minSev).slice(0, limit),
    [incidents, limit, minSev],
  );
}

export function useIncidentsByCategory(cat: string, limit: number): {
  incidents: Incident[];
  total: number;
} {
  const { incidents } = useIncidentsContext();
  return useMemo(() => {
    const filtered = cat === 'ALL'
      ? incidents
      : incidents.filter(i => i.cat === cat);
    return { incidents: filtered.slice(0, limit), total: filtered.length };
  }, [incidents, cat, limit]);
}

export function useIncidentsForMap(filter: 'all' | 'violent' | 'health' | 'environ'): Incident[] {
  const { incidents } = useIncidentsContext();
  return useMemo(() => {
    if (filter === 'violent') return incidents.filter(i => i.cat === 'VIOLENT');
    if (filter === 'health')  return incidents.filter(i => i.cat === 'HEALTH');
    if (filter === 'environ') return incidents.filter(i => i.cat === 'ENVIRON');
    return incidents;
  }, [incidents, filter]);
}

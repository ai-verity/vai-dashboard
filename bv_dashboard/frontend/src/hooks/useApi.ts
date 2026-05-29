// hooks/useApi.ts
import { useState, useEffect, useCallback, useRef } from 'react';
import { API_BASE } from '../types';
import type {
  Incident, KpiData, MonthlyData, CategoryData, LocationData,
  SeverityTier, HeatmapCell, TypeRankingItem, Location,
  VlmObservation, VlmDetail, VlmFeed, VlmStats, VlmPrompt, VlmAggregates, VlmRun,
  AiSummary, AiByClass, AiComparison, AiHistory, AiPeriod, AiDataset,
} from '../types';

function useFetch<T>(url: string) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetch_ = useCallback(async () => {
    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`${API_BASE}${url}`, { signal: ctrl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = await r.json();
      if (!ctrl.signal.aborted) setData(body);
    } catch (e: unknown) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!ctrl.signal.aborted) setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    fetch_();
    return () => { abortRef.current?.abort(); };
  }, [fetch_]);

  return { data, loading, error, refetch: fetch_ };
}

export function useKpi() {
  return useFetch<KpiData>('/api/stats/kpi');
}

export function useMonthly() {
  return useFetch<MonthlyData[]>('/api/stats/monthly');
}

export function useByCategory() {
  return useFetch<CategoryData[]>('/api/stats/by_category');
}

export function useByLocation() {
  return useFetch<LocationData[]>('/api/stats/by_location');
}

export function useSeverityDist() {
  return useFetch<SeverityTier[]>('/api/stats/severity_distribution');
}

export function useHeatmap() {
  return useFetch<HeatmapCell[]>('/api/stats/heatmap');
}

export function useTypeRanking() {
  return useFetch<TypeRankingItem[]>('/api/stats/type_ranking');
}

export function useLocations() {
  return useFetch<Location[]>('/api/locations');
}

// Incidents with filters
interface IncidentParams {
  cat?: string;
  month?: string;
  min_sev?: number;
  limit?: number;
  offset?: number;
  search?: string;
}

export function useIncidents(params: IncidentParams = {}) {
  const [data, setData] = useState<{ total: number; incidents: Incident[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const paramsKey = JSON.stringify(params);

  const fetch_ = useCallback(async () => {
    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    setError(null);
    const q = new URLSearchParams();
    if (params.cat && params.cat !== 'ALL') q.set('cat', params.cat);
    if (params.month) q.set('month', params.month);
    if (params.min_sev) q.set('min_sev', String(params.min_sev));
    if (params.limit)   q.set('limit',   String(params.limit));
    if (params.offset)  q.set('offset',  String(params.offset));
    if (params.search)  q.set('search',  params.search);
    try {
      const r = await fetch(`${API_BASE}/api/incidents?${q}`, { signal: ctrl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = await r.json();
      if (!ctrl.signal.aborted) setData(body);
    } catch (e: unknown) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!ctrl.signal.aborted) setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paramsKey]);

  useEffect(() => {
    fetch_();
    return () => { abortRef.current?.abort(); };
  }, [fetch_]);

  return { data, loading, error, refetch: fetch_ };
}

// ─── VLM hooks ───────────────────────────────────────────────────────────

export interface VlmListParams {
  feed_id?: string;
  run_id?: string;
  location_id?: string;
  preset?: string;                  // crowd_behavior | vehicle_prompts
  density?: string;
  risk?: string;
  min_risk?: string;
  only_threats?: boolean;
  has_pedestrians?: boolean;
  only_vehicle_issues?: boolean;
  collision?: boolean;
  speeding?: boolean;
  fire_lane?: boolean;
  // illegal_dumping filters
  only_dumping?: boolean;
  chronic_site?: boolean;
  water_proximity?: boolean;
  priority?: string;             // LOW / MEDIUM / HIGH
  waste_type?: string;
  // license_plate filters
  has_plate?: boolean;
  plate_state?: string;          // normalized 2-letter code (TX, CA, …)
  min_confidence?: number;       // best-plate confidence threshold
  search?: string;
  limit?: number;
  offset?: number;
  sort?: 'captured_at' | 'processed_at';
  order?: 'asc' | 'desc';
}

export function useVlmList(params: VlmListParams = {}) {
  const [data, setData] = useState<{ total: number; limit: number; offset: number; items: VlmObservation[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const paramsKey = JSON.stringify(params);

  const fetch_ = useCallback(async () => {
    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    setError(null);
    const q = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v === undefined || v === '' || v === false || v === null) return;
      q.set(k, String(v));
    });
    try {
      const r = await fetch(`${API_BASE}/api/vlm?${q}`, { signal: ctrl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = await r.json();
      if (!ctrl.signal.aborted) setData(body);
    } catch (e: unknown) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!ctrl.signal.aborted) setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paramsKey]);

  useEffect(() => {
    fetch_();
    return () => { abortRef.current?.abort(); };
  }, [fetch_]);

  return { data, loading, error, refetch: fetch_ };
}

export function useVlmFeeds() {
  return useFetch<{ feeds: VlmFeed[]; load: { loaded_at: string | null; row_count: number; files: Array<{ name: string; rows: number }> } }>('/api/vlm/feeds');
}

export function useVlmStats() {
  return useFetch<VlmStats>('/api/vlm/stats');
}

export function useVlmAggregates() {
  return useFetch<VlmAggregates>('/api/vlm/aggregates');
}

export function useVlmRuns() {
  return useFetch<VlmRun[]>('/api/vlm/runs');
}

export function useVlmPrompts() {
  return useFetch<VlmPrompt[]>('/api/vlm/prompts');
}

export function useVlmOne(id: string | null) {
  const [data, setData] = useState<VlmDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (abortRef.current) abortRef.current.abort();
    if (!id) { setData(null); setError(null); return; }

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    setError(null);
    fetch(`${API_BASE}/api/vlm/${id}`, { signal: ctrl.signal })
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d: VlmDetail) => { if (!ctrl.signal.aborted) setData(d); })
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => { if (!ctrl.signal.aborted) setLoading(false); });

    return () => { ctrl.abort(); };
  }, [id]);

  return { data, loading, error };
}

// ─── AI Model Metrics hooks ──────────────────────────────────────────────

export function useAiSummary() {
  return useFetch<AiSummary>('/api/ai_metrics/summary');
}

export function useAiByClass() {
  return useFetch<AiByClass>('/api/ai_metrics/by_class');
}

export function useAiComparison(period: AiPeriod) {
  return useFetch<AiComparison>(`/api/ai_metrics/comparison?period=${period}`);
}

export function useAiHistory(period: AiPeriod) {
  return useFetch<AiHistory>(`/api/ai_metrics/history?period=${period}`);
}

export function useAiDataset() {
  return useFetch<AiDataset>('/api/ai_metrics/dataset');
}

// Streaming AI analysis
export function useAnalysis() {
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const analyze = useCallback(async (incident: Incident) => {
    if (abortRef.current) abortRef.current.abort();
    abortRef.current = new AbortController();
    setText('');
    setLoading(true);

    try {
      const r = await fetch(`${API_BASE}/api/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: abortRef.current.signal,
        body: JSON.stringify({
          incident_id:   incident.id,
          type:          incident.type,
          location_name: incident.location_name,
          date:          incident.date,
          severity:      incident.sev,
          sev_label:     incident.sev >= 0.9 ? 'CRITICAL' : incident.sev >= 0.7 ? 'HIGH' : incident.sev >= 0.5 ? 'MODERATE' : 'LOW',
          desc:          incident.desc,
          cat:           incident.cat,
        }),
      });

      if (!r.body) throw new Error('No stream body');
      const reader = r.body.getReader();
      const dec    = new TextDecoder();
      let buffer   = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += dec.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6);
          if (payload === '[DONE]') { setLoading(false); return; }
          try {
            const evt = JSON.parse(payload);
            if (evt.token) setText(prev => prev + evt.token);
          } catch {/* ignore */}
        }
      }
    } catch (e: unknown) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
      setText('Analysis unavailable — rule-based fallback applied.');
    } finally {
      setLoading(false);
    }
  }, []);

  return { text, loading, analyze };
}

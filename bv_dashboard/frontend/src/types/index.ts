// types/index.ts

export interface Incident {
  id: string;
  date: string;
  time: string;
  type: string;
  cat: Category;
  icon: string;
  color: string;
  sev: number;
  location_id: string;
  location_name: string;
  lat: number;
  lon: number;
  source: string;
  desc: string;
  verified: boolean;
}

export type Category = 'VIOLENT' | 'HEALTH' | 'ENVIRON' | 'ORDER' | 'SECURITY';

export interface KpiData {
  total: number;
  violent: number;
  health: number;
  environ: number;
  order: number;
  security: number;
  critical: number;
  avg_daily: number;
  avg_sev: number;
}

export interface MonthlyData {
  month: string;
  label: string;
  total: number;
  violent: number;
  health: number;
  environ: number;
  order: number;
  security: number;
  avg_sev: number;
  violent_avg_sev: number;
  health_avg_sev: number;
  environ_avg_sev: number;
  order_avg_sev: number;
  security_avg_sev: number;
}

export interface CategoryData {
  cat: Category;
  count: number;
  avg_sev: number;
}

export interface LocationData {
  location_id: string;
  location_name: string;
  icon: string;
  count: number;
  avg_sev: number;
}

export interface SeverityTier {
  tier: string;
  min: number;
  max: number;
  count: number;
  color: string;
}

export interface HeatmapCell {
  hour_block: number;
  hour_label: string;
  weekday: number;
  weekday_label: string;
  count: number;
  avg_sev: number;
}

export interface TypeRankingItem {
  type: string;
  icon: string;
  color: string;
  cat: Category;
  count: number;
  avg_sev: number;
}

export interface Location {
  id: string;
  name: string;
  lat: number;
  lon: number;
  icon: string;
}

export const CAT_META: Record<Category, { label: string; icon: string; color: string }> = {
  VIOLENT:  { label: 'Violent Crime',         icon: '⚔️',  color: '#EF4444' },
  HEALTH:   { label: 'Health / Medical',       icon: '🏥',  color: '#A78BFA' },
  ENVIRON:  { label: 'Environmental',          icon: '🌊',  color: '#4A9EF5' },
  ORDER:    { label: 'Public Order',           icon: '🚨',  color: '#F5B731' },
  SECURITY: { label: 'Perimeter / Security',   icon: '🔒',  color: '#2DC9A8' },
};

export const CAT_COLORS: Record<Category, string> = {
  VIOLENT:  '#EF4444',
  HEALTH:   '#A78BFA',
  ENVIRON:  '#4A9EF5',
  ORDER:    '#F5B731',
  SECURITY: '#2DC9A8',
};

export function sevColor(s: number): string {
  if (s >= 0.9) return '#7f1d1d';
  if (s >= 0.7) return '#EF4444';
  if (s >= 0.5) return '#F97316';
  if (s >= 0.3) return '#F5B731';
  return '#22C55E';
}

export function sevLabel(s: number): string {
  if (s >= 0.9) return 'CRITICAL';
  if (s >= 0.7) return 'HIGH';
  if (s >= 0.5) return 'MODERATE';
  if (s >= 0.3) return 'LOW';
  return 'MINIMAL';
}

// Empty string means "same origin": in dev, Vite proxies /api → :8000
// (see vite.config.ts); in prod, deploy the frontend behind a reverse proxy
// that routes /api to the backend. Override per-build with VITE_API_BASE.
export const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? '';

// ─── VLM types ───────────────────────────────────────────────────────────────

export interface VlmObservation {
  id: string;
  run_id: string;
  run_started_at: string | null;
  feed_id: string;
  feed_label: string;
  location_id: string | null;
  image_name: string;
  captured_at: string | null;
  processed_at: string | null;
  preset: string;
  model: string;
  total_seconds: number | null;
  pedestrian_count: number | null;
  density_zone: 'SPARSE' | 'MODERATE' | 'DENSE' | null;
  // Parser canonicalizes "MEDIUM" → "MODERATE" so the wire only carries
  // these three tiers (plus null). Kept narrow on purpose.
  risk_level: 'LOW' | 'MODERATE' | 'HIGH' | null;
  has_imminent_threat: boolean;
  weapons_visible: boolean;
  medical_emergency: boolean;
  fire_smoke: boolean;
  fallen_person: boolean;
  unsupervised_children: boolean;
  physical_altercation: boolean;
}

export interface VlmDetail extends VlmObservation {
  answers: Record<string, string>;
  full_caption: string;
}

export interface VlmFeed {
  feed_id: string;
  feed_label: string;
  location_id: string | null;
  count: number;
  threats: number;
}

export interface VlmStats {
  total: number;
  feeds: number;
  runs: number;
  with_pedestrians: number;
  imminent_threats: number;
  weapons: number;
  medical: number;
  fire_smoke: number;
  density: Record<string, number>;
  risk: Record<string, number>;
  loaded_at: string | null;
}

export interface VlmRun {
  run_id: string;
  run_started_at: string | null;
  count: number;
  feeds: number;
}

export interface VlmPrompt {
  id: number;
  section: string;
  q_numbers: number[];
  prompt: string;
}

export interface VlmHourRiskRow { hour: number; LOW: number; MODERATE: number; HIGH: number; }
export interface VlmFeedDensityRow {
  feed_id: string; feed_label: string;
  SPARSE: number; MODERATE: number; DENSE: number; total: number;
}
export interface VlmDailyDenseRow { date: string; dense: number; total: number; share: number; }
export interface VlmAggregates {
  hour_risk: VlmHourRiskRow[];
  feed_density: VlmFeedDensityRow[];
  daily_dense: VlmDailyDenseRow[];
}

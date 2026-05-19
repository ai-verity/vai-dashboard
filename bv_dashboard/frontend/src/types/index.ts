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

export type VlmPreset = 'crowd_behavior' | 'vehicle_prompts' | 'illegal_dumping';

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
  // crowd_behavior fields (null/false for vehicle frames)
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
  // vehicle_prompts fields (null/false for non-vehicle frames)
  speeding: boolean;
  collision: boolean;
  near_miss_count: number | null;
  fire_lane_violation: boolean;
  erratic_maneuver: boolean;
  person_near_vehicle: boolean;
  vehicle_tamper: boolean;
  wrong_way: boolean;
  building_contact: boolean;
  no_plate_count: number | null;
  pedestrian_struck: boolean;            // Q15 — actual strike
  pedestrian_near_miss: boolean;         // Q16 — near miss only
  child_struck: boolean;                 // Q17 — prompt merges struck + near-miss
  vehicle_description: string | null;
  // illegal_dumping fields (null/false for non-dumping frames)
  dumping_present: boolean;
  ordinance_violation: boolean;
  waste_type: string | null;
  waste_volume: string | null;
  waste_origin: string | null;
  property_type: string | null;
  gutter_alley: boolean;
  water_proximity: boolean;
  chronic_site: boolean;
  severity: number | null;
  ordinance: string | null;
  priority: string | null;
  dumping_summary: string | null;
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
  presets: Record<string, number>;
}

export interface VlmVehicleStats {
  total: number;
  with_vehicle_desc: number;
  collisions: number;
  speeding: number;
  fire_lane: number;
  erratic: number;
  wrong_way: number;
  tamper: number;
  building_contact: number;
  person_near_vehicle: number;
  pedestrian_struck: number;
  pedestrian_near_miss: number;
  child_struck: number;
  no_plate_frames: number;
}

export interface VlmDumpingStats {
  total: number;
  dumping_present: number;
  ordinance_violation: number;
  chronic_site: number;
  water_proximity: number;
  gutter_alley: number;
  high_priority: number;
  with_summary: number;
  priority: Record<string, number>;
  ordinance: Record<string, number>;
  waste_type: Record<string, number>;
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
  presets: Record<string, number>;
  vehicle: VlmVehicleStats;
  dumping: VlmDumpingStats;
}

export interface VlmRun {
  run_id: string;
  run_started_at: string | null;
  count: number;
  feeds: number;
}

export interface VlmPrompt {
  // Composite id like "crowd_behavior:7" — namespaced per preset on the wire.
  id: string;
  section: string;
  q_numbers: number[];
  prompt: string;
  preset: string;
}

export interface VlmHourRiskRow { hour: number; LOW: number; MODERATE: number; HIGH: number; }
export interface VlmFeedDensityRow {
  feed_id: string; feed_label: string;
  SPARSE: number; MODERATE: number; DENSE: number; total: number;
}
export interface VlmDailyDenseRow { date: string; dense: number; total: number; share: number; }

export interface VlmVehicleHourRow { hour: number; collisions: number; speeding: number; fire_lane: number; }
export interface VlmVehicleFeedRow {
  feed_id: string; feed_label: string;
  collisions: number; speeding: number; fire_lane: number; other: number; total: number;
}
export interface VlmVehicleDailyRow { date: string; collisions: number; total: number; share: number; }

export interface VlmDumpingSeverityRow { severity: number; count: number; }
export interface VlmDumpingWasteRow { waste_type: string; count: number; }
export interface VlmDumpingFeedRow {
  feed_id: string; feed_label: string;
  dumping: number; chronic: number; high_priority: number; total: number;
}
export interface VlmDumpingDailyRow { date: string; dumping: number; total: number; share: number; }

export interface VlmAggregates {
  hour_risk: VlmHourRiskRow[];
  feed_density: VlmFeedDensityRow[];
  daily_dense: VlmDailyDenseRow[];
  vehicle_hour_issue: VlmVehicleHourRow[];
  vehicle_feed_issue: VlmVehicleFeedRow[];
  vehicle_daily_collision: VlmVehicleDailyRow[];
  dumping_severity: VlmDumpingSeverityRow[];
  dumping_waste_type: VlmDumpingWasteRow[];
  dumping_feed: VlmDumpingFeedRow[];
  dumping_daily: VlmDumpingDailyRow[];
}

// ─── AI Model Metrics types ─────────────────────────────────────────────────

export type AiMetricName = 'Precision' | 'Recall' | 'F1';
export type AiPeriod = 'daily' | 'weekly' | 'monthly';

export interface AiHeadlineRow {
  metric: AiMetricName;
  current: number | null;
  previous: number | null;
  delta: number | null;
}

export interface AiPerClassMetricCell {
  current: number | null;
  previous: number | null;
  delta: number | null;
}

export interface AiPerClassRow {
  cls: string;
  metrics: Record<AiMetricName, AiPerClassMetricCell>;
}

export interface AiSummary {
  available: boolean;
  reason?: string;
  run_date?: string;
  run_timestamp?: string | null;
  run_name?: string | null;
  model?: string | null;
  classes?: string[];
  headline?: AiHeadlineRow[];
}

export interface AiByClassMetricCell {
  current: number | null;
  previous: number | null;
  delta: number | null;
}

export interface AiByClassRow {
  cls: string;
  instances: { train?: number; val?: number; total?: number };
  metrics: Record<AiMetricName, AiByClassMetricCell>;
  extras: Record<string, AiByClassMetricCell>;
}

export interface AiByClass {
  available: boolean;
  run_date?: string;
  classes: AiByClassRow[];
}

export interface AiComparison {
  available: boolean;
  period: AiPeriod;
  awaiting: boolean;
  current_run_date: string;
  previous_run_date: string | null;
  runs_in_window: number;
  runs_required: number;
  headline: AiHeadlineRow[];
  by_class?: AiPerClassRow[];
}

export interface AiHistoryPoint {
  run_date: string;
  Precision: number | null;
  Recall: number | null;
  F1: number | null;
}

export interface AiHistory {
  available: boolean;
  period: AiPeriod;
  points: AiHistoryPoint[];
  points_captured: number;
  points_required: number;
}

export const AI_METRIC_COLORS: Record<AiMetricName, string> = {
  Precision: '#4A9EF5',
  Recall:    '#2DC9A8',
  F1:        '#e85d2f',
};

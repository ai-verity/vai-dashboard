// pages/VlmPage.tsx
import { useMemo, useState } from 'react';
import {
  useVlmList, useVlmFeeds, useVlmStats, useVlmPrompts, useVlmOne, useVlmAggregates, useVlmRuns,
} from '../hooks/useApi';
import { API_BASE } from '../types';
import type { VlmAggregates } from '../types';
import type { VlmListParams } from '../hooks/useApi';
import { setupCanvas, useCanvas, chartColors } from '../utils/canvas';
import { useTheme } from '../hooks/useTheme';

const MODEL_NAME = 'nvidia/cosmos-reason2-8b';

const PAGE_SIZE = 50;

// Wire preset values; the empty string sentinel = "all presets".
type PresetFilter = '' | 'crowd_behavior' | 'vehicle_prompts' | 'illegal_dumping';

// Partial<Record<...>> instead of Record so a lookup with an unknown key
// is typed `string | undefined` — forces callers to deal with the miss
// (every call site uses `?? fallback`).
const PRESET_LABEL: Partial<Record<string, string>> = {
  crowd_behavior: 'CROWD',
  vehicle_prompts: 'VEHICLE',
  illegal_dumping: 'DUMPING',
};

// Priority tier colors — shared by KPI, chips, and badges.
const PRIORITY_COLOR: Partial<Record<string, string>> = {
  LOW:    '#2DC9A8',
  MEDIUM: '#F5B731',
  HIGH:   '#EF4444',
};

const DENSITY_COLOR: Partial<Record<string, string>> = {
  SPARSE: '#2DC9A8',
  MODERATE: '#F5B731',
  DENSE: '#EF4444',
};
const RISK_COLOR: Partial<Record<string, string>> = {
  LOW: '#2DC9A8',
  MODERATE: '#F5B731',
  HIGH: '#EF4444',
};

// Vehicle issue colors — used in chips, badges, charts.
const VEH_COLLISION   = '#EF4444';
const VEH_SPEEDING    = '#F97316';
const VEH_FIRE_LANE   = '#F5B731';
const VEH_WRONG_WAY   = '#F5B731';
const VEH_OTHER       = '#A78BFA';

// Illegal-dumping colors — separate from vehicle so the eye learns the
// preset palette quickly.
const DMP_PRESENT     = '#EF4444';
const DMP_CHRONIC     = '#7f1d1d';
const DMP_WATER       = '#4A9EF5';
const DMP_GUTTER      = '#F5B731';

// Per-frame section roll-up definition.
// Each section knows which Q-numbers feed it and how to summarize them.
type SectionSummary = { value: string; flagCount: number; questionCount: number; highlight?: string };

function isYes(text: string | undefined): boolean {
  if (!text) return false;
  const t = text.trim().toLowerCase();
  if (t.startsWith('no') || t.startsWith('not applicable') || t.startsWith('none') || t.startsWith('zero')) return false;
  if (t.startsWith('yes')) return true;
  return false;
}
function extractNumber(text: string | undefined): number | null {
  if (!text) return null;
  if (/\bzero\b/i.test(text) || /\bno (pedestrian|individual|people|person|crowd|attend)/i.test(text)) return 0;
  const m1 = text.match(/(?:approximately\s+)?(\d+)\s+(pedestrian|individual|person|attendee|people|child|children)/i);
  if (m1) return parseInt(m1[1], 10);
  const m2 = text.trim().match(/^(\d+)/);
  if (m2) return parseInt(m2[1], 10);
  return null;
}
function summarizeAnswers(answers: Record<string, string> | undefined): Record<string, SectionSummary> {
  const a = answers ?? {};
  const get = (n: number) => a[String(n)];
  const yesIn = (qs: number[]) => qs.filter(n => isYes(get(n))).length;

  const density = (get(2) ?? '').toUpperCase().match(/DENSE|MODERATE|SPARSE/)?.[0] ?? '—';
  const risk = (get(6) ?? '').toUpperCase().match(/HIGH|MODERATE|MEDIUM|LOW/)?.[0]?.replace('MEDIUM', 'MODERATE') ?? '—';
  const peds = extractNumber(get(3));
  const attendance = extractNumber(get(11));
  const childCount = extractNumber(get(14));

  return {
    'CROWD DENSITY & ZONES':   { value: density, flagCount: 0, questionCount: 2, highlight: DENSITY_COLOR[density] },
    'PEDESTRIAN ACTIVITY':     { value: peds === null ? '—' : `${peds} ped${peds === 1 ? '' : 's'}`, flagCount: yesIn([4]), questionCount: 2 },
    'RISK ASSESSMENT':         { value: risk, flagCount: yesIn([7]), questionCount: 3, highlight: RISK_COLOR[risk] },
    'CROWD SAFETY & SPACING':  { value: yesIn([9, 10]) === 0 ? 'clear' : `${yesIn([9, 10])} flag${yesIn([9, 10]) === 1 ? '' : 's'}`, flagCount: yesIn([8, 9, 10]), questionCount: 3 },
    'EVENT / VENUE ASSESSMENT':{ value: attendance === null ? '—' : `attend: ${attendance}${childCount ? ` · ${childCount} kids unsup.` : ''}`, flagCount: yesIn([13, 15]), questionCount: 5 },
    'THREAT & SAFETY':         { value: `${yesIn([16, 18, 20, 21])} / 4 flags`, flagCount: yesIn([16, 18, 20, 21]), questionCount: 6 },
    'HAZARDS & INCIDENTS':     { value: `${yesIn([22, 23])} / 2 flags`, flagCount: yesIn([22, 23]), questionCount: 2 },
    'CRITICAL INCIDENTS':      { value: `${yesIn([24, 25, 26, 27, 28, 29])} / 6 flags`, flagCount: yesIn([24, 25, 26, 27, 28, 29]), questionCount: 6 },
  };
}
const SECTION_ORDER = [
  'CROWD DENSITY & ZONES',
  'PEDESTRIAN ACTIVITY',
  'RISK ASSESSMENT',
  'CROWD SAFETY & SPACING',
  'EVENT / VENUE ASSESSMENT',
  'THREAT & SAFETY',
  'HAZARDS & INCIDENTS',
  'CRITICAL INCIDENTS',
];

// Vehicle-preset section roll-up. Mirrors the crowd version but for the
// 6 vehicle sections — caller branches on detail.preset to pick a map.
function summarizeVehicleAnswers(answers: Record<string, string> | undefined): Record<string, SectionSummary> {
  const a = answers ?? {};
  const get = (n: number) => a[String(n)];
  const yesIn = (qs: number[]) => qs.filter(n => isYes(get(n))).length;
  const num = (n: number) => extractNumber(get(n));

  const speedingFlag = isYes(get(2)) ? 'SPEEDING' : (get(1)?.toLowerCase().startsWith('yes') ? 'safe' : '—');
  const collisionTxt = isYes(get(3)) ? 'COLLISION' : 'none';
  const nearMiss = num(4);
  const parkingFlags = yesIn([5, 6, 7]);
  const suspiciousFlags = yesIn([8, 9, 10]);
  const noPlate = num(11);
  const desc = get(13);
  const idValue = (() => {
    const trimmed = desc?.trim();
    if (trimmed && !/^(not visible|not applicable|none|no)/i.test(trimmed)) {
      return trimmed.length > 36 ? `${trimmed.slice(0, 36)}…` : trimmed;
    }
    return noPlate !== null ? `no-plate: ${noPlate}` : '—';
  })();
  const safetyFlags = yesIn([14, 15, 16, 17]);

  return {
    'GENERAL VEHICLE SAFETY':       { value: speedingFlag, flagCount: isYes(get(2)) ? 1 : 0, questionCount: 2, highlight: isYes(get(2)) ? VEH_SPEEDING : undefined },
    'COLLISIONS & NEAR MISSES':     { value: nearMiss ? `${collisionTxt} · near=${nearMiss}` : collisionTxt, flagCount: (isYes(get(3)) ? 1 : 0) + ((nearMiss ?? 0) > 0 ? 1 : 0), questionCount: 2, highlight: isYes(get(3)) ? VEH_COLLISION : undefined },
    'PARKING & ACCESS VIOLATIONS':  { value: parkingFlags === 0 ? 'clear' : `${parkingFlags} flag${parkingFlags === 1 ? '' : 's'}`, flagCount: parkingFlags, questionCount: 3 },
    'SUSPICIOUS VEHICLE BEHAVIOR':  { value: suspiciousFlags === 0 ? 'clear' : `${suspiciousFlags} flag${suspiciousFlags === 1 ? '' : 's'}`, flagCount: suspiciousFlags, questionCount: 3 },
    'VEHICLE IDENTIFICATION':       { value: idValue, flagCount: (noPlate ?? 0) > 0 ? 1 : 0, questionCount: 3 },
    'PEDESTRIAN & CHILD SAFETY':    { value: safetyFlags === 0 ? 'clear' : `${safetyFlags} flag${safetyFlags === 1 ? '' : 's'}`, flagCount: safetyFlags, questionCount: 4 },
  };
}

const VEHICLE_SECTION_ORDER = [
  'GENERAL VEHICLE SAFETY',
  'COLLISIONS & NEAR MISSES',
  'PARKING & ACCESS VIOLATIONS',
  'SUSPICIOUS VEHICLE BEHAVIOR',
  'VEHICLE IDENTIFICATION',
  'PEDESTRIAN & CHILD SAFETY',
];

// Illegal-dumping section roll-up. The dumping preset emits KEY:value
// answers (not numbered) but the backend remaps each key to a q_number
// 1–16, so the existing answers dict still works.
function summarizeDumpingAnswers(answers: Record<string, string> | undefined): Record<string, SectionSummary> {
  const a = answers ?? {};
  const get = (n: number) => a[String(n)];
  const present = isYes(get(1));
  const ord = isYes(get(2));
  const wasteType = get(3);
  const wasteVol = get(4);
  const propType = get(6);
  const gutter = isYes(get(8));
  const water = isYes(get(9));
  const chronic = isYes(get(10));
  const vehicles = get(11);
  const idents = get(12);
  const severityRaw = (get(13) ?? '').trim();
  const priority = (get(15) ?? '').trim();
  const ordinance = (get(14) ?? '').trim();

  // Match a 1–5 digit anywhere in the SEVERITY answer so values like
  // "Severity 5", "5/5", or just "3" all yield the same canonical int.
  const sevMatch = severityRaw.match(/[1-5]/);
  const sevLabel = sevMatch ? `sev ${sevMatch[0]}` : '';

  const idHas = (s: string | undefined) => !!s && !/^(none|not visible|no\b|unknown)/i.test(s);

  return {
    DETECTION:           { value: present ? (ord ? 'PRESENT · violation' : 'PRESENT') : (ord ? 'violation' : 'absent'), flagCount: (present ? 1 : 0) + (ord ? 1 : 0), questionCount: 2, highlight: present ? DMP_PRESENT : undefined },
    'WASTE PROFILE':     { value: wasteType ? `${wasteType.slice(0, 24)}${wasteVol ? ` · ${wasteVol.slice(0, 20)}` : ''}` : '—', flagCount: 0, questionCount: 3 },
    LOCATION:            { value: propType ? `${propType.slice(0, 28)}${gutter ? ' · gutter' : ''}` : (gutter ? 'gutter/alley' : '—'), flagCount: gutter ? 1 : 0, questionCount: 3, highlight: gutter ? DMP_GUTTER : undefined },
    'CHRONIC / HAZARD':  { value: chronic && water ? 'CHRONIC · WATER' : chronic ? 'CHRONIC' : water ? 'WATER PROX.' : 'clear', flagCount: (chronic ? 1 : 0) + (water ? 1 : 0), questionCount: 2, highlight: water ? DMP_WATER : chronic ? DMP_CHRONIC : undefined },
    IDENTIFIERS:         { value: [idHas(vehicles) ? 'vehicles' : null, idHas(idents) ? 'identifiers' : null].filter(Boolean).join(' · ') || 'none', flagCount: (idHas(vehicles) ? 1 : 0) + (idHas(idents) ? 1 : 0), questionCount: 2 },
    ENFORCEMENT:         { value: [sevLabel, priority, ordinance].filter(Boolean).join(' · ') || '—', flagCount: /high/i.test(priority) ? 1 : 0, questionCount: 4, highlight: PRIORITY_COLOR[priority.toUpperCase()] },
  };
}

const DUMPING_SECTION_ORDER = [
  'DETECTION',
  'WASTE PROFILE',
  'LOCATION',
  'CHRONIC / HAZARD',
  'IDENTIFIERS',
  'ENFORCEMENT',
];

function StatCell({ label, value, color }: { label: string; value: number | string; color?: string }) {
  return (
    <div style={{ background: 'var(--s0)', padding: '13px 16px' }}>
      <div style={{ fontFamily: 'var(--mono)', fontSize: '1.45rem', fontWeight: 500, lineHeight: 1.1, color: color ?? 'var(--text)' }}>{value}</div>
      <div style={{ fontSize: 8.5, color: 'var(--muted)', letterSpacing: '0.15em', textTransform: 'uppercase', marginTop: 4 }}>{label}</div>
    </div>
  );
}

function Chip({ active, onClick, color, children }: { active?: boolean; onClick: () => void; color?: string; children: React.ReactNode }) {
  const c = color ?? 'var(--accent)';
  return (
    <button onClick={onClick} style={{
      fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.06em',
      padding: '4px 10px', borderRadius: 3,
      border: `1px solid ${active ? c : 'var(--border)'}`,
      background: active ? `${c}1f` : 'transparent',
      color: active ? c : 'var(--muted)',
      cursor: 'pointer', transition: 'all .18s',
    }}>
      {children}
    </button>
  );
}

function Badge({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span style={{
      fontSize: 7.5, padding: '1px 5px', borderRadius: 2, fontFamily: 'var(--mono)',
      background: `${color}18`, color, border: `1px solid ${color}44`,
    }}>
      {children}
    </span>
  );
}

// ─── Aggregate charts ───────────────────────────────────────────────────────
const RISK_KEYS = ['LOW', 'MODERATE', 'HIGH'] as const;
const DENSITY_KEYS = ['SPARSE', 'MODERATE', 'DENSE'] as const;

// Canvas helpers live in utils/canvas.ts; alias setupCanvas → setupCv to
// keep this file's call sites unchanged.
const setupCv = setupCanvas;

function HourRiskChart({ data }: { data: VlmAggregates['hour_risk'] }) {
  const { tick } = useTheme();
  const ref = useCanvas(cv => {
    const g = setupCv(cv, 180);
    if (!g) return;
    const { ctx, W, H } = g;
    const { MUTED, GRID } = chartColors();
    const p = { l: 30, r: 10, t: 14, b: 28 };
    const totals = data.map(r => r.LOW + r.MODERATE + r.HIGH);
    const mx = Math.max(...totals, 1);
    // grid
    for (let i = 0; i <= 4; i++) {
      const y = p.t + (H - p.t - p.b) * (1 - i / 4);
      ctx.strokeStyle = GRID;
      ctx.beginPath(); ctx.moveTo(p.l, y); ctx.lineTo(W - p.r, y); ctx.stroke();
      ctx.fillStyle = MUTED;
      ctx.font = '9px DM Mono, monospace';
      ctx.textAlign = 'right';
      ctx.fillText(String(Math.round(mx * i / 4)), p.l - 4, y + 3);
    }
    const bW = (W - p.l - p.r) / 24;
    const colors: Record<string, string> = {
      LOW: '#2DC9A8', MODERATE: '#F5B731', HIGH: '#EF4444',
    };
    data.forEach((row, h) => {
      const x = p.l + h * bW + 1;
      let yBase = H - p.b;
      RISK_KEYS.forEach(k => {
        const n = (row[k as keyof typeof row] as number) || 0;
        if (!n) return;
        const hh = Math.max(1, (n / mx) * (H - p.t - p.b));
        ctx.fillStyle = colors[k];
        ctx.globalAlpha = 0.86;
        ctx.fillRect(x, yBase - hh, bW - 2, hh);
        ctx.globalAlpha = 1;
        yBase -= hh;
      });
      if (h % 3 === 0) {
        ctx.fillStyle = MUTED;
        ctx.font = '8px DM Mono, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(String(h).padStart(2, '0'), x + bW / 2, H - 14);
      }
    });
    RISK_KEYS.forEach((k, i) => {
      const x = p.l + i * 78;
      ctx.fillStyle = colors[k];
      ctx.fillRect(x, H - 8, 8, 6);
      ctx.fillStyle = MUTED;
      ctx.font = '8px DM Mono, monospace';
      ctx.textAlign = 'left';
      ctx.fillText(k, x + 11, H - 2);
    });
  }, [data, tick]);
  return <canvas ref={ref} style={{ display: 'block', width: '100%', height: 180 }} />;
}

function FeedDensityChart({ data }: { data: VlmAggregates['feed_density'] }) {
  const { tick } = useTheme();
  const ref = useCanvas(cv => {
    const g = setupCv(cv, 180);
    if (!g) return;
    const { ctx, W, H } = g;
    const { MUTED, TEXT, GRID_SOFT } = chartColors();
    const p = { l: 150, r: 12, t: 6, b: 6 };
    const mx = Math.max(...data.map(f => f.total), 1);
    const rowH = (H - p.t - p.b) / Math.max(data.length, 1);
    const colors: Record<string, string> = { SPARSE: '#2DC9A8', MODERATE: '#F5B731', DENSE: '#EF4444' };
    data.forEach((f, i) => {
      const y = p.t + i * rowH;
      const fullBw = Math.round((f.total / mx) * (W - p.l - p.r));
      ctx.fillStyle = GRID_SOFT;
      ctx.fillRect(p.l, y + 2, W - p.l - p.r, rowH - 4);
      let x = p.l;
      DENSITY_KEYS.forEach(k => {
        const n = (f[k as keyof typeof f] as number) || 0;
        if (!n) return;
        const bw = Math.round((n / f.total) * fullBw);
        ctx.fillStyle = colors[k];
        ctx.globalAlpha = 0.86;
        ctx.fillRect(x, y + 2, bw, rowH - 4);
        ctx.globalAlpha = 1;
        x += bw;
      });
      ctx.fillStyle = TEXT;
      ctx.font = '9px Barlow, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(f.feed_label.substring(0, 24), p.l - 4, y + rowH / 2 + 3);
      ctx.fillStyle = MUTED;
      ctx.font = 'bold 9px DM Mono, monospace';
      ctx.textAlign = 'left';
      ctx.fillText(String(f.total), p.l + fullBw + 4, y + rowH / 2 + 3);
    });
  }, [data, tick]);
  return <canvas ref={ref} style={{ display: 'block', width: '100%', height: 180 }} />;
}

function DailyDenseChart({ data }: { data: VlmAggregates['daily_dense'] }) {
  const { tick } = useTheme();
  const ref = useCanvas(cv => {
    const g = setupCv(cv, 180);
    if (!g) return;
    const { ctx, W, H } = g;
    const { MUTED, GRID } = chartColors();
    if (!data.length) return;
    const p = { l: 32, r: 12, t: 14, b: 28 };
    const mxShare = Math.max(...data.map(d => d.share), 0.01);
    // grid
    for (let i = 0; i <= 4; i++) {
      const y = p.t + (H - p.t - p.b) * (1 - i / 4);
      ctx.strokeStyle = GRID;
      ctx.beginPath(); ctx.moveTo(p.l, y); ctx.lineTo(W - p.r, y); ctx.stroke();
      ctx.fillStyle = MUTED;
      ctx.font = '9px DM Mono, monospace';
      ctx.textAlign = 'right';
      ctx.fillText(`${Math.round((mxShare * i / 4) * 100)}%`, p.l - 4, y + 3);
    }
    const n = data.length;
    const xs = data.map((_, i) => p.l + (n === 1 ? 0 : (i * (W - p.l - p.r)) / (n - 1)));
    const ys = data.map(d => p.t + (H - p.t - p.b) * (1 - d.share / mxShare));
    // area fill
    const grad = ctx.createLinearGradient(0, p.t, 0, H - p.b);
    grad.addColorStop(0, 'rgba(239,68,68,.35)');
    grad.addColorStop(1, 'rgba(239,68,68,0)');
    ctx.beginPath();
    ctx.moveTo(xs[0], H - p.b);
    xs.forEach((x, i) => ctx.lineTo(x, ys[i]));
    ctx.lineTo(xs[xs.length - 1], H - p.b);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
    // line + points
    ctx.beginPath();
    xs.forEach((x, i) => i === 0 ? ctx.moveTo(x, ys[i]) : ctx.lineTo(x, ys[i]));
    ctx.strokeStyle = '#EF4444';
    ctx.lineWidth = 2;
    ctx.stroke();
    xs.forEach((x, i) => {
      ctx.beginPath();
      ctx.arc(x, ys[i], 3, 0, Math.PI * 2);
      ctx.fillStyle = '#EF4444';
      ctx.fill();
    });
    // x-axis (every Nth date label)
    const step = Math.max(1, Math.floor(n / 6));
    data.forEach((d, i) => {
      if (i % step !== 0 && i !== n - 1) return;
      ctx.fillStyle = MUTED;
      ctx.font = '8px DM Mono, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(d.date.slice(5), xs[i], H - 6);
    });
  }, [data, tick]);
  return <canvas ref={ref} style={{ display: 'block', width: '100%', height: 180 }} />;
}

// ─── Vehicle-preset charts ─────────────────────────────────────────────────
const VEH_ISSUE_KEYS = ['collisions', 'speeding', 'fire_lane'] as const;
const VEH_ISSUE_COLOR: Partial<Record<string, string>> = {
  collisions: VEH_COLLISION,
  speeding:   VEH_SPEEDING,
  fire_lane:  VEH_FIRE_LANE,
  other:      VEH_OTHER,
};

function VehicleHourChart({ data }: { data: VlmAggregates['vehicle_hour_issue'] }) {
  const { tick } = useTheme();
  const ref = useCanvas(cv => {
    const g = setupCv(cv, 180);
    if (!g) return;
    const { ctx, W, H } = g;
    const { MUTED, GRID } = chartColors();
    const p = { l: 30, r: 10, t: 14, b: 28 };
    const totals = data.map(r => r.collisions + r.speeding + r.fire_lane);
    const mx = Math.max(...totals, 1);
    for (let i = 0; i <= 4; i++) {
      const y = p.t + (H - p.t - p.b) * (1 - i / 4);
      ctx.strokeStyle = GRID;
      ctx.beginPath(); ctx.moveTo(p.l, y); ctx.lineTo(W - p.r, y); ctx.stroke();
      ctx.fillStyle = MUTED;
      ctx.font = '9px DM Mono, monospace';
      ctx.textAlign = 'right';
      ctx.fillText(String(Math.round(mx * i / 4)), p.l - 4, y + 3);
    }
    const bW = (W - p.l - p.r) / 24;
    data.forEach((row, h) => {
      const x = p.l + h * bW + 1;
      let yBase = H - p.b;
      VEH_ISSUE_KEYS.forEach(k => {
        const n = (row[k] as number) || 0;
        if (!n) return;
        const hh = Math.max(1, (n / mx) * (H - p.t - p.b));
        ctx.fillStyle = VEH_ISSUE_COLOR[k] ?? '#888';
        ctx.globalAlpha = 0.86;
        ctx.fillRect(x, yBase - hh, bW - 2, hh);
        ctx.globalAlpha = 1;
        yBase -= hh;
      });
      if (h % 3 === 0) {
        ctx.fillStyle = MUTED;
        ctx.font = '8px DM Mono, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(String(h).padStart(2, '0'), x + bW / 2, H - 14);
      }
    });
    VEH_ISSUE_KEYS.forEach((k, i) => {
      const x = p.l + i * 78;
      ctx.fillStyle = VEH_ISSUE_COLOR[k] ?? '#888';
      ctx.fillRect(x, H - 8, 8, 6);
      ctx.fillStyle = MUTED;
      ctx.font = '8px DM Mono, monospace';
      ctx.textAlign = 'left';
      ctx.fillText(k.toUpperCase(), x + 11, H - 2);
    });
  }, [data, tick]);
  return <canvas ref={ref} style={{ display: 'block', width: '100%', height: 180 }} />;
}

function VehicleFeedChart({ data }: { data: VlmAggregates['vehicle_feed_issue'] }) {
  const { tick } = useTheme();
  const ref = useCanvas(cv => {
    const g = setupCv(cv, 180);
    if (!g) return;
    const { ctx, W, H } = g;
    const { MUTED, TEXT, GRID_SOFT } = chartColors();
    const p = { l: 150, r: 12, t: 6, b: 6 };
    const issueTotals = data.map(f => f.collisions + f.speeding + f.fire_lane + f.other);
    const mx = Math.max(...issueTotals, 1);
    const rowH = (H - p.t - p.b) / Math.max(data.length, 1);
    data.forEach((f, i) => {
      const y = p.t + i * rowH;
      const issueTotal = issueTotals[i];
      const fullBw = Math.round((issueTotal / mx) * (W - p.l - p.r));
      ctx.fillStyle = GRID_SOFT;
      ctx.fillRect(p.l, y + 2, W - p.l - p.r, rowH - 4);
      let x = p.l;
      (['collisions', 'speeding', 'fire_lane', 'other'] as const).forEach(k => {
        const n = (f[k] as number) || 0;
        if (!n || !issueTotal) return;
        const bw = Math.round((n / issueTotal) * fullBw);
        ctx.fillStyle = VEH_ISSUE_COLOR[k] ?? '#888';
        ctx.globalAlpha = 0.86;
        ctx.fillRect(x, y + 2, bw, rowH - 4);
        ctx.globalAlpha = 1;
        x += bw;
      });
      ctx.fillStyle = TEXT;
      ctx.font = '9px Barlow, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(f.feed_label.substring(0, 24), p.l - 4, y + rowH / 2 + 3);
      ctx.fillStyle = MUTED;
      ctx.font = 'bold 9px DM Mono, monospace';
      ctx.textAlign = 'left';
      ctx.fillText(String(issueTotal), p.l + fullBw + 4, y + rowH / 2 + 3);
    });
  }, [data, tick]);
  return <canvas ref={ref} style={{ display: 'block', width: '100%', height: 180 }} />;
}

function VehicleDailyChart({ data }: { data: VlmAggregates['vehicle_daily_collision'] }) {
  const { tick } = useTheme();
  const ref = useCanvas(cv => {
    const g = setupCv(cv, 180);
    if (!g) return;
    const { ctx, W, H } = g;
    const { MUTED, GRID } = chartColors();
    if (!data.length) return;
    const p = { l: 32, r: 12, t: 14, b: 28 };
    const mxShare = Math.max(...data.map(d => d.share), 0.01);
    for (let i = 0; i <= 4; i++) {
      const y = p.t + (H - p.t - p.b) * (1 - i / 4);
      ctx.strokeStyle = GRID;
      ctx.beginPath(); ctx.moveTo(p.l, y); ctx.lineTo(W - p.r, y); ctx.stroke();
      ctx.fillStyle = MUTED;
      ctx.font = '9px DM Mono, monospace';
      ctx.textAlign = 'right';
      ctx.fillText(`${Math.round((mxShare * i / 4) * 100)}%`, p.l - 4, y + 3);
    }
    const n = data.length;
    const xs = data.map((_, i) => p.l + (n === 1 ? 0 : (i * (W - p.l - p.r)) / (n - 1)));
    const ys = data.map(d => p.t + (H - p.t - p.b) * (1 - d.share / mxShare));
    const grad = ctx.createLinearGradient(0, p.t, 0, H - p.b);
    grad.addColorStop(0, 'rgba(239,68,68,.35)');
    grad.addColorStop(1, 'rgba(239,68,68,0)');
    ctx.beginPath();
    ctx.moveTo(xs[0], H - p.b);
    xs.forEach((x, i) => ctx.lineTo(x, ys[i]));
    ctx.lineTo(xs[xs.length - 1], H - p.b);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.beginPath();
    xs.forEach((x, i) => i === 0 ? ctx.moveTo(x, ys[i]) : ctx.lineTo(x, ys[i]));
    ctx.strokeStyle = VEH_COLLISION;
    ctx.lineWidth = 2;
    ctx.stroke();
    xs.forEach((x, i) => {
      ctx.beginPath();
      ctx.arc(x, ys[i], 3, 0, Math.PI * 2);
      ctx.fillStyle = VEH_COLLISION;
      ctx.fill();
    });
    const step = Math.max(1, Math.floor(n / 6));
    data.forEach((d, i) => {
      if (i % step !== 0 && i !== n - 1) return;
      ctx.fillStyle = MUTED;
      ctx.font = '8px DM Mono, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(d.date.slice(5), xs[i], H - 6);
    });
  }, [data, tick]);
  return <canvas ref={ref} style={{ display: 'block', width: '100%', height: 180 }} />;
}

// ─── Illegal-dumping charts ─────────────────────────────────────────────────
function DumpingSeverityChart({ data }: { data: VlmAggregates['dumping_severity'] }) {
  const { tick } = useTheme();
  const ref = useCanvas(cv => {
    const g = setupCv(cv, 180);
    if (!g) return;
    const { ctx, W, H } = g;
    const { MUTED, GRID } = chartColors();
    const p = { l: 30, r: 12, t: 14, b: 28 };
    const mx = Math.max(...data.map(r => r.count), 1);
    for (let i = 0; i <= 4; i++) {
      const y = p.t + (H - p.t - p.b) * (1 - i / 4);
      ctx.strokeStyle = GRID;
      ctx.beginPath(); ctx.moveTo(p.l, y); ctx.lineTo(W - p.r, y); ctx.stroke();
      ctx.fillStyle = MUTED;
      ctx.font = '9px DM Mono, monospace';
      ctx.textAlign = 'right';
      ctx.fillText(String(Math.round(mx * i / 4)), p.l - 4, y + 3);
    }
    const bW = (W - p.l - p.r) / 5;
    // Severity 1 → green, 5 → red. Linear interpolation through orange.
    const sevColor = (s: number) => ['#22C55E', '#84CC16', '#F5B731', '#F97316', '#EF4444'][s - 1] ?? '#888';
    data.forEach((row, i) => {
      const x = p.l + i * bW + 4;
      const bw = bW - 8;
      const h = Math.max(1, (row.count / mx) * (H - p.t - p.b));
      ctx.fillStyle = sevColor(row.severity);
      ctx.globalAlpha = 0.86;
      ctx.fillRect(x, H - p.b - h, bw, h);
      ctx.globalAlpha = 1;
      ctx.fillStyle = MUTED;
      ctx.font = '9px DM Mono, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`sev ${row.severity}`, x + bw / 2, H - 14);
      ctx.fillText(String(row.count), x + bw / 2, H - 4);
    });
  }, [data, tick]);
  return <canvas ref={ref} style={{ display: 'block', width: '100%', height: 180 }} />;
}

function DumpingFeedChart({ data }: { data: VlmAggregates['dumping_feed'] }) {
  const { tick } = useTheme();
  const ref = useCanvas(cv => {
    const g = setupCv(cv, 180);
    if (!g) return;
    const { ctx, W, H } = g;
    const { MUTED, TEXT, GRID_SOFT } = chartColors();
    const p = { l: 150, r: 12, t: 6, b: 6 };
    const mx = Math.max(...data.map(f => f.dumping), 1);
    const rowH = (H - p.t - p.b) / Math.max(data.length, 1);
    data.forEach((f, i) => {
      const y = p.t + i * rowH;
      const fullBw = Math.round((f.dumping / mx) * (W - p.l - p.r));
      ctx.fillStyle = GRID_SOFT;
      ctx.fillRect(p.l, y + 2, W - p.l - p.r, rowH - 4);
      // dumping bar
      ctx.fillStyle = DMP_PRESENT;
      ctx.globalAlpha = 0.78;
      ctx.fillRect(p.l, y + 2, fullBw, rowH - 4);
      ctx.globalAlpha = 1;
      // chronic overlay — darker stripe at the start
      if (f.chronic) {
        const cw = Math.min(fullBw, Math.round((f.chronic / mx) * (W - p.l - p.r)));
        ctx.fillStyle = DMP_CHRONIC;
        ctx.fillRect(p.l, y + 2, cw, rowH - 4);
      }
      ctx.fillStyle = TEXT;
      ctx.font = '9px Barlow, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(f.feed_label.substring(0, 24), p.l - 4, y + rowH / 2 + 3);
      ctx.fillStyle = MUTED;
      ctx.font = 'bold 9px DM Mono, monospace';
      ctx.textAlign = 'left';
      ctx.fillText(String(f.dumping), p.l + fullBw + 4, y + rowH / 2 + 3);
    });
  }, [data, tick]);
  return <canvas ref={ref} style={{ display: 'block', width: '100%', height: 180 }} />;
}

function DumpingDailyChart({ data }: { data: VlmAggregates['dumping_daily'] }) {
  const { tick } = useTheme();
  const ref = useCanvas(cv => {
    const g = setupCv(cv, 180);
    if (!g) return;
    const { ctx, W, H } = g;
    const { MUTED, GRID } = chartColors();
    if (!data.length) return;
    const p = { l: 32, r: 12, t: 14, b: 28 };
    const mxShare = Math.max(...data.map(d => d.share), 0.01);
    for (let i = 0; i <= 4; i++) {
      const y = p.t + (H - p.t - p.b) * (1 - i / 4);
      ctx.strokeStyle = GRID;
      ctx.beginPath(); ctx.moveTo(p.l, y); ctx.lineTo(W - p.r, y); ctx.stroke();
      ctx.fillStyle = MUTED;
      ctx.font = '9px DM Mono, monospace';
      ctx.textAlign = 'right';
      ctx.fillText(`${Math.round((mxShare * i / 4) * 100)}%`, p.l - 4, y + 3);
    }
    const n = data.length;
    const xs = data.map((_, i) => p.l + (n === 1 ? 0 : (i * (W - p.l - p.r)) / (n - 1)));
    const ys = data.map(d => p.t + (H - p.t - p.b) * (1 - d.share / mxShare));
    const grad = ctx.createLinearGradient(0, p.t, 0, H - p.b);
    grad.addColorStop(0, 'rgba(239,68,68,.35)');
    grad.addColorStop(1, 'rgba(239,68,68,0)');
    ctx.beginPath();
    ctx.moveTo(xs[0], H - p.b);
    xs.forEach((x, i) => ctx.lineTo(x, ys[i]));
    ctx.lineTo(xs[xs.length - 1], H - p.b);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.beginPath();
    xs.forEach((x, i) => i === 0 ? ctx.moveTo(x, ys[i]) : ctx.lineTo(x, ys[i]));
    ctx.strokeStyle = DMP_PRESENT;
    ctx.lineWidth = 2;
    ctx.stroke();
    xs.forEach((x, i) => {
      ctx.beginPath();
      ctx.arc(x, ys[i], 3, 0, Math.PI * 2);
      ctx.fillStyle = DMP_PRESENT;
      ctx.fill();
    });
    const step = Math.max(1, Math.floor(n / 6));
    data.forEach((d, i) => {
      if (i % step !== 0 && i !== n - 1) return;
      ctx.fillStyle = MUTED;
      ctx.font = '8px DM Mono, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(d.date.slice(5), xs[i], H - 6);
    });
  }, [data, tick]);
  return <canvas ref={ref} style={{ display: 'block', width: '100%', height: 180 }} />;
}

function ChartCard({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }) {
  return (
    <div style={{ background: 'var(--s0)' }}>
      <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', background: 'var(--s1)' }}>
        <div style={{ fontFamily: 'var(--cond)', fontSize: 11, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase' }}>{title}</div>
        <div style={{ fontSize: 9, color: 'var(--muted)', fontFamily: 'var(--mono)', marginTop: 2 }}>{sub}</div>
      </div>
      <div style={{ padding: '10px 14px' }}>{children}</div>
    </div>
  );
}

export default function VlmPage() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [feedId, setFeedId] = useState<string | undefined>();
  const [runId, setRunId] = useState<string | undefined>();
  const [preset, setPreset] = useState<PresetFilter>('');
  const [density, setDensity] = useState<string | undefined>();
  const [risk, setRisk] = useState<string | undefined>();
  const [elevatedRisk, setElevatedRisk] = useState(false);
  const [onlyThreats, setOnlyThreats] = useState(false);
  const [hasPeds, setHasPeds] = useState(false);
  const [collisionOnly, setCollisionOnly] = useState(false);
  const [speedingOnly, setSpeedingOnly] = useState(false);
  const [fireLaneOnly, setFireLaneOnly] = useState(false);
  const [onlyVehicleIssues, setOnlyVehicleIssues] = useState(false);
  // illegal_dumping filters
  const [onlyDumping, setOnlyDumping] = useState(false);
  const [chronicOnly, setChronicOnly] = useState(false);
  const [waterOnly, setWaterOnly] = useState(false);
  const [priorityFilter, setPriorityFilter] = useState<string | undefined>();
  const [search, setSearch] = useState('');

  const isVehicleView = preset === 'vehicle_prompts';
  const isCrowdView = preset === 'crowd_behavior';
  const isDumpingView = preset === 'illegal_dumping';
  const isAllView = preset === '';

  // Switching presets clears filters whose chips ARE NOT visible in the
  // destination view. The filter chip row shows: crowd chips in CROWD or
  // ALL view, vehicle chips only in VEHICLE view, dumping chips only in
  // DUMPING view. Clearing on entry means a filter the user enabled can
  // never silently re-apply when they return to a view where the chip is
  // hidden. Page resets for the same "fresh slate" reason.
  function switchPreset(target: PresetFilter) {
    const crowdChipsShown   = target === 'crowd_behavior' || target === '';
    const vehicleChipsShown = target === 'vehicle_prompts';
    const dumpingChipsShown = target === 'illegal_dumping';
    if (!crowdChipsShown) {
      setDensity(undefined);
      setRisk(undefined);
      setElevatedRisk(false);
      setOnlyThreats(false);
      setHasPeds(false);
    }
    if (!vehicleChipsShown) {
      setCollisionOnly(false);
      setSpeedingOnly(false);
      setFireLaneOnly(false);
      setOnlyVehicleIssues(false);
    }
    if (!dumpingChipsShown) {
      setOnlyDumping(false);
      setChronicOnly(false);
      setWaterOnly(false);
      setPriorityFilter(undefined);
    }
    setPreset(target);
    setPage(0);
  }

  const params: VlmListParams = useMemo(() => ({
    feed_id: feedId, run_id: runId,
    preset: preset || undefined,
    // Crowd filters apply only when the active view can contain crowd rows.
    density: isCrowdView || isAllView ? density : undefined,
    risk: isCrowdView || isAllView ? risk : undefined,
    min_risk: (isCrowdView || isAllView) && elevatedRisk ? 'MODERATE' : undefined,
    only_threats: (isCrowdView || isAllView) && onlyThreats ? true : undefined,
    has_pedestrians: (isCrowdView || isAllView) && hasPeds ? true : undefined,
    // Vehicle filters apply only when the active view can contain vehicle rows.
    only_vehicle_issues: (isVehicleView || isAllView) && onlyVehicleIssues ? true : undefined,
    collision: (isVehicleView || isAllView) && collisionOnly ? true : undefined,
    speeding: (isVehicleView || isAllView) && speedingOnly ? true : undefined,
    fire_lane: (isVehicleView || isAllView) && fireLaneOnly ? true : undefined,
    // Dumping filters apply only when the active view can contain dumping rows.
    only_dumping: (isDumpingView || isAllView) && onlyDumping ? true : undefined,
    chronic_site: (isDumpingView || isAllView) && chronicOnly ? true : undefined,
    water_proximity: (isDumpingView || isAllView) && waterOnly ? true : undefined,
    priority: (isDumpingView || isAllView) && priorityFilter ? priorityFilter : undefined,
    search: search || undefined,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
    sort: 'captured_at',
    order: 'desc',
  }), [
    feedId, runId, preset, density, risk, elevatedRisk, onlyThreats, hasPeds,
    onlyVehicleIssues, collisionOnly, speedingOnly, fireLaneOnly,
    onlyDumping, chronicOnly, waterOnly, priorityFilter,
    search, page, isCrowdView, isVehicleView, isDumpingView, isAllView,
  ]);

  const { data: list, loading: listLoading, error: listError, refetch: refetchList } = useVlmList(params);
  const { data: feedsResp, refetch: refetchFeeds } = useVlmFeeds();
  const { data: stats, refetch: refetchStats } = useVlmStats();
  const { data: prompts } = useVlmPrompts();
  const { data: aggregates } = useVlmAggregates();
  const { data: runs } = useVlmRuns();
  const { data: detail } = useVlmOne(selectedId);
  const detailIsVehicle = detail?.preset === 'vehicle_prompts';
  const detailIsDumping = detail?.preset === 'illegal_dumping';
  const detailSummaries = useMemo(() => {
    if (!detail) return null;
    if (detailIsVehicle) return summarizeVehicleAnswers(detail.answers);
    if (detailIsDumping) return summarizeDumpingAnswers(detail.answers);
    return summarizeAnswers(detail.answers);
  }, [detail, detailIsVehicle, detailIsDumping]);
  const detailSectionOrder = detailIsVehicle
    ? VEHICLE_SECTION_ORDER
    : detailIsDumping
      ? DUMPING_SECTION_ORDER
      : SECTION_ORDER;

  const handleReload = async () => {
    try {
      await fetch(`${API_BASE}/api/vlm/reload`, { method: 'POST' });
    } finally {
      refetchList();
      refetchFeeds();
      refetchStats();
    }
  };

  const feeds = feedsResp?.feeds ?? [];
  const loadInfo = feedsResp?.load;
  const total = list?.total ?? 0;
  const items = list?.items ?? [];
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const resetPage = () => setPage(0);

  return (
    <div>
      {/* Header */}
      <div style={{ background: 'var(--s1)', borderBottom: '1px solid var(--border)', padding: '16px 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontFamily: 'var(--cond)', fontSize: 18, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
            VLM Feed Observations
          </div>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
            {stats?.total ?? '—'} frames analyzed · {stats?.feeds ?? '—'} feeds · {stats?.runs ?? '—'} batches · model {MODEL_NAME}
            {loadInfo?.loaded_at && <> · loaded {new Date(loadInfo.loaded_at).toLocaleTimeString('en-US', { hour12: false })}</>}
          </div>
        </div>
        <button
          onClick={handleReload}
          style={{
            fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.06em',
            padding: '6px 14px', borderRadius: 3, background: 'transparent',
            border: '1px solid var(--border)', color: 'var(--muted)', cursor: 'pointer',
          }}
        >Reload Data</button>
      </div>

      {/* Preset chip row — sits between header and KPI strip so users see
          which lens drives the strip / charts / filters below. */}
      <div style={{ padding: '8px 24px', borderBottom: '1px solid var(--border)', background: 'var(--s1)', display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontFamily: 'var(--cond)', fontSize: 10, fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.12em', textTransform: 'uppercase', marginRight: 4 }}>Preset</span>
        <Chip active={isAllView} onClick={() => switchPreset('')}>
          ALL · {stats?.total ?? '—'}
        </Chip>
        <Chip active={isCrowdView} color="#2DC9A8" onClick={() => switchPreset(isCrowdView ? '' : 'crowd_behavior')}>
          CROWD BEHAVIOR · {stats?.presets?.crowd_behavior ?? 0}
        </Chip>
        <Chip active={isVehicleView} color="#4A9EF5" onClick={() => switchPreset(isVehicleView ? '' : 'vehicle_prompts')}>
          VEHICLE PROMPTS · {stats?.presets?.vehicle_prompts ?? 0}
        </Chip>
        <Chip active={isDumpingView} color="#F97316" onClick={() => switchPreset(isDumpingView ? '' : 'illegal_dumping')}>
          ILLEGAL DUMPING · {stats?.presets?.illegal_dumping ?? 0}
        </Chip>
      </div>

      {/* KPI strip — swaps based on active preset. */}
      {isVehicleView ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 1, background: 'var(--border)', borderBottom: '1px solid var(--border)' }}>
          <StatCell label="Vehicle Frames" value={stats?.vehicle.total ?? '—'} color="var(--accent)" />
          <StatCell label="With Vehicles" value={stats?.vehicle.with_vehicle_desc ?? '—'} color="var(--blue)" />
          <StatCell label="Collisions" value={stats?.vehicle.collisions ?? 0} color={VEH_COLLISION} />
          <StatCell label="Speeding" value={stats?.vehicle.speeding ?? 0} color={VEH_SPEEDING} />
          <StatCell label="Fire-Lane" value={stats?.vehicle.fire_lane ?? 0} color={VEH_FIRE_LANE} />
          <StatCell label="Wrong-Way" value={stats?.vehicle.wrong_way ?? 0} color={VEH_WRONG_WAY} />
          <StatCell label="No-Plate Frames" value={stats?.vehicle.no_plate_frames ?? 0} color="var(--purple)" />
        </div>
      ) : isDumpingView ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 1, background: 'var(--border)', borderBottom: '1px solid var(--border)' }}>
          <StatCell label="Dumping Frames" value={stats?.dumping.total ?? '—'} color="var(--accent)" />
          <StatCell label="Dumping Present" value={stats?.dumping.dumping_present ?? 0} color={DMP_PRESENT} />
          <StatCell label="Ordinance Viol." value={stats?.dumping.ordinance_violation ?? 0} color={DMP_PRESENT} />
          <StatCell label="Chronic Sites" value={stats?.dumping.chronic_site ?? 0} color={DMP_CHRONIC} />
          <StatCell label="Gutter / Alley" value={stats?.dumping.gutter_alley ?? 0} color={DMP_GUTTER} />
          <StatCell label="Near Water" value={stats?.dumping.water_proximity ?? 0} color={DMP_WATER} />
          <StatCell label="High Priority" value={stats?.dumping.high_priority ?? 0} color={PRIORITY_COLOR.HIGH} />
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 1, background: 'var(--border)', borderBottom: '1px solid var(--border)' }}>
          <StatCell label="Total Frames" value={stats?.total ?? '—'} color="var(--accent)" />
          <StatCell label="Feeds" value={stats?.feeds ?? '—'} color="var(--blue)" />
          <StatCell label="With Pedestrians" value={stats?.with_pedestrians ?? '—'} color="var(--teal)" />
          <StatCell label="Imminent Threats" value={stats?.imminent_threats ?? 0} color="var(--red)" />
          <StatCell label="Weapons" value={stats?.weapons ?? 0} color="var(--red)" />
          <StatCell label="Medical" value={stats?.medical ?? 0} color="var(--purple)" />
          <StatCell label="Fire / Smoke" value={stats?.fire_smoke ?? 0} color="var(--orange)" />
        </div>
      )}

      {/* Aggregate charts — swap to vehicle / dumping versions per preset. */}
      {isVehicleView ? (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 1, background: 'var(--border)', borderBottom: '1px solid var(--border)' }}>
          <ChartCard title="Hour-of-Day Vehicle Issues" sub="Stacked frames per UTC hour · collision · speeding · fire-lane">
            {aggregates ? <VehicleHourChart data={aggregates.vehicle_hour_issue} /> : <div className="skeleton" style={{ width: '100%', height: 180 }} />}
          </ChartCard>
          <ChartCard title="Per-Feed Issue Mix (top 10)" sub="Stacked issue counts per feed · collision · speeding · fire-lane · other">
            {aggregates ? <VehicleFeedChart data={aggregates.vehicle_feed_issue} /> : <div className="skeleton" style={{ width: '100%', height: 180 }} />}
          </ChartCard>
          <ChartCard title="Collision-Frame Share by Day" sub="Daily share of vehicle frames flagged as collision">
            {aggregates ? <VehicleDailyChart data={aggregates.vehicle_daily_collision} /> : <div className="skeleton" style={{ width: '100%', height: 180 }} />}
          </ChartCard>
        </div>
      ) : isDumpingView ? (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 1, background: 'var(--border)', borderBottom: '1px solid var(--border)' }}>
          <ChartCard title="Severity Distribution" sub="Dumping frames bucketed by reported severity (1 lowest, 5 highest)">
            {aggregates ? <DumpingSeverityChart data={aggregates.dumping_severity} /> : <div className="skeleton" style={{ width: '100%', height: 180 }} />}
          </ChartCard>
          <ChartCard title="Per-Feed Dumping (top 10)" sub="Dumping-present count per feed · darker = chronic site">
            {aggregates ? <DumpingFeedChart data={aggregates.dumping_feed} /> : <div className="skeleton" style={{ width: '100%', height: 180 }} />}
          </ChartCard>
          <ChartCard title="Dumping-Frame Share by Day" sub="Daily share of dumping frames flagged as 'dumping present'">
            {aggregates ? <DumpingDailyChart data={aggregates.dumping_daily} /> : <div className="skeleton" style={{ width: '100%', height: 180 }} />}
          </ChartCard>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 1, background: 'var(--border)', borderBottom: '1px solid var(--border)' }}>
          <ChartCard title="Hour-of-Day Risk Mix" sub="Stacked frames per UTC hour · LOW · MOD · MED · HIGH">
            {aggregates ? <HourRiskChart data={aggregates.hour_risk} /> : <div className="skeleton" style={{ width: '100%', height: 180 }} />}
          </ChartCard>
          <ChartCard title="Per-Feed Density (top 10)" sub="Stacked share of SPARSE / MODERATE / DENSE per feed">
            {aggregates ? <FeedDensityChart data={aggregates.feed_density} /> : <div className="skeleton" style={{ width: '100%', height: 180 }} />}
          </ChartCard>
          <ChartCard title="DENSE-Frame Share by Day" sub="Daily share of frames classified DENSE">
            {aggregates ? <DailyDenseChart data={aggregates.daily_dense} /> : <div className="skeleton" style={{ width: '100%', height: 180 }} />}
          </ChartCard>
        </div>
      )}

      {/* Main grid: list | detail */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 360px', gap: 1, background: 'var(--border)' }}>
        {/* List column */}
        <div style={{ background: 'var(--s0)', display: 'flex', flexDirection: 'column' }}>
          {/* Filter bar — chips swap based on preset. In ALL view we keep
              the crowd chips visible since those rows dominate the data. */}
          <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', background: 'var(--s1)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap' }}>
              {isVehicleView ? (
                <>
                  <span style={{ fontFamily: 'var(--cond)', fontSize: 10, fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.12em', textTransform: 'uppercase', marginRight: 4 }}>Vehicle</span>
                  <Chip active={collisionOnly} color={VEH_COLLISION} onClick={() => { setCollisionOnly(!collisionOnly); resetPage(); }}>COLLISION</Chip>
                  <Chip active={speedingOnly} color={VEH_SPEEDING} onClick={() => { setSpeedingOnly(!speedingOnly); resetPage(); }}>SPEEDING</Chip>
                  <Chip active={fireLaneOnly} color={VEH_FIRE_LANE} onClick={() => { setFireLaneOnly(!fireLaneOnly); resetPage(); }}>FIRE-LANE</Chip>
                  <Chip active={onlyVehicleIssues} color="var(--red)" onClick={() => { setOnlyVehicleIssues(!onlyVehicleIssues); resetPage(); }}>ANY ISSUE</Chip>
                </>
              ) : isDumpingView ? (
                <>
                  <span style={{ fontFamily: 'var(--cond)', fontSize: 10, fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.12em', textTransform: 'uppercase', marginRight: 4 }}>Dumping</span>
                  <Chip active={onlyDumping} color={DMP_PRESENT} onClick={() => { setOnlyDumping(!onlyDumping); resetPage(); }}>DUMPING PRESENT</Chip>
                  <Chip active={chronicOnly} color={DMP_CHRONIC} onClick={() => { setChronicOnly(!chronicOnly); resetPage(); }}>CHRONIC</Chip>
                  <Chip active={waterOnly} color={DMP_WATER} onClick={() => { setWaterOnly(!waterOnly); resetPage(); }}>NEAR WATER</Chip>
                  <span style={{ width: 8 }} />
                  <span style={{ fontFamily: 'var(--cond)', fontSize: 10, fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.12em', textTransform: 'uppercase', marginRight: 4 }}>Priority</span>
                  {(['LOW', 'MEDIUM', 'HIGH'] as const).map(p => (
                    <Chip key={p} active={priorityFilter === p} color={PRIORITY_COLOR[p]} onClick={() => { setPriorityFilter(priorityFilter === p ? undefined : p); resetPage(); }}>
                      {p} {stats?.dumping?.priority?.[p] ? `· ${stats.dumping.priority[p]}` : ''}
                    </Chip>
                  ))}
                </>
              ) : (
                <>
                  <span style={{ fontFamily: 'var(--cond)', fontSize: 10, fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.12em', textTransform: 'uppercase', marginRight: 4 }}>Density</span>
                  {(['SPARSE', 'MODERATE', 'DENSE'] as const).map(d => (
                    <Chip key={d} active={density === d} color={DENSITY_COLOR[d]} onClick={() => { setDensity(density === d ? undefined : d); resetPage(); }}>
                      {d} {stats?.density?.[d] ? `· ${stats.density[d]}` : ''}
                    </Chip>
                  ))}
                  <span style={{ width: 8 }} />
                  <span style={{ fontFamily: 'var(--cond)', fontSize: 10, fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.12em', textTransform: 'uppercase', marginRight: 4 }}>Risk</span>
                  {(['LOW', 'MODERATE', 'HIGH'] as const).map(r => (
                    <Chip key={r} active={risk === r} color={RISK_COLOR[r]} onClick={() => { setRisk(risk === r ? undefined : r); resetPage(); }}>
                      {r} {stats?.risk?.[r] ? `· ${stats.risk[r]}` : ''}
                    </Chip>
                  ))}
                  <span style={{ width: 8 }} />
                  <Chip active={elevatedRisk} color="#F97316" onClick={() => { setElevatedRisk(!elevatedRisk); resetPage(); }}>RISK ≥ MODERATE</Chip>
                  <Chip active={onlyThreats} color="var(--red)" onClick={() => { setOnlyThreats(!onlyThreats); resetPage(); }}>ONLY THREATS</Chip>
                  <Chip active={hasPeds} color="var(--teal)" onClick={() => { setHasPeds(!hasPeds); resetPage(); }}>HAS PEDESTRIANS</Chip>
                </>
              )}
            </div>
            <input
              type="text" placeholder="search caption / feed / file"
              value={search}
              onChange={e => { setSearch(e.target.value); resetPage(); }}
              style={{
                background: 'var(--s0)', border: '1px solid var(--border)', borderRadius: 3,
                padding: '4px 9px', fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text)',
                outline: 'none', width: 220,
              }}
            />
          </div>

          {/* Batch select */}
          {runs && runs.length > 1 && (
            <div style={{ padding: '6px 14px', borderBottom: '1px solid var(--b2)', display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontFamily: 'var(--cond)', fontSize: 10, fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.12em', textTransform: 'uppercase', marginRight: 4 }}>Batch</span>
              <Chip active={!runId} onClick={() => { setRunId(undefined); resetPage(); }}>ALL · {runs.reduce((s, r) => s + r.count, 0)}</Chip>
              {runs.map(r => {
                const ts = r.run_started_at
                  ? r.run_started_at.replace('T', ' ').slice(0, 16) + ' UTC'
                  : r.run_id && /^\d{8}T\d{6}Z$/.test(r.run_id)
                    ? `${r.run_id.slice(0,4)}-${r.run_id.slice(4,6)}-${r.run_id.slice(6,8)} ${r.run_id.slice(9,11)}:${r.run_id.slice(11,13)} UTC`
                    : r.run_id;
                return (
                  <Chip key={r.run_id} active={runId === r.run_id} onClick={() => { setRunId(r.run_id === runId ? undefined : r.run_id); resetPage(); }}>
                    {ts} · {r.count}
                  </Chip>
                );
              })}
            </div>
          )}

          {/* Feed select */}
          <div style={{ padding: '8px 14px', borderBottom: '1px solid var(--border)', display: 'flex', gap: 5, flexWrap: 'wrap', maxHeight: 80, overflowY: 'auto' }}>
            <Chip active={!feedId} onClick={() => { setFeedId(undefined); resetPage(); }}>ALL FEEDS</Chip>
            {feeds.map(f => (
              <Chip key={f.feed_id} active={feedId === f.feed_id} onClick={() => { setFeedId(f.feed_id === feedId ? undefined : f.feed_id); resetPage(); }}>
                {f.feed_label.replace(/dean porter park /i, '')} · {f.count}
              </Chip>
            ))}
          </div>

          {/* List */}
          <div style={{ height: 'calc(100vh - 380px)', minHeight: 380, overflowY: 'auto' }} role="region" aria-live="polite">
            {listError && !listLoading ? (
              <div role="alert" style={{ padding: 16, textAlign: 'center' }}>
                <div style={{ fontSize: 11, color: '#EF4444', marginBottom: 8 }}>
                  Failed to load observations — {listError}
                </div>
                <button
                  onClick={() => refetchList()}
                  style={{
                    fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.06em',
                    padding: '4px 12px', borderRadius: 3, cursor: 'pointer',
                    background: 'transparent', border: '1px solid var(--border)', color: 'var(--accent)',
                  }}
                >Retry</button>
              </div>
            ) : listLoading && !items.length ? (
              Array.from({ length: 8 }).map((_, i) => (
                <div key={i} style={{ padding: '10px 14px', borderBottom: '1px solid var(--b2)' }}>
                  <div className="skeleton" style={{ width: '70%', height: 11, marginBottom: 6 }} />
                  <div className="skeleton" style={{ width: '45%', height: 9 }} />
                </div>
              ))
            ) : items.length === 0 ? (
              <div style={{ padding: 24, color: 'var(--muted)', fontSize: 11, textAlign: 'center' }}>No observations match.</div>
            ) : items.map(o => {
              const isSel = selectedId === o.id;
              const rowIsVehicle = o.preset === 'vehicle_prompts';
              const rowIsDumping = o.preset === 'illegal_dumping';
              const dCol = (o.density_zone && DENSITY_COLOR[o.density_zone]) || 'var(--border)';
              const rCol = (o.risk_level && RISK_COLOR[o.risk_level]) || 'var(--border)';
              const crowdThreat = o.has_imminent_threat || o.weapons_visible || o.medical_emergency || o.fire_smoke || o.fallen_person || o.physical_altercation || o.unsupervised_children;
              const vehSubtitle = o.vehicle_description
                ? `🚗 ${o.vehicle_description.slice(0, 48)}${o.vehicle_description.length > 48 ? '…' : ''}`
                : '🚗 no vehicle visible';
              const dmpSubtitle = (() => {
                const parts: string[] = [];
                if (o.waste_type) parts.push(o.waste_type);
                if (o.severity) parts.push(`sev ${o.severity}`);
                if (o.priority) parts.push(o.priority);
                return parts.length ? `🗑 ${parts.join(' · ').slice(0, 56)}` : '🗑 no waste detected';
              })();
              return (
                <div
                  key={o.id}
                  role="button"
                  tabIndex={0}
                  aria-label={`${o.feed_label} observation`}
                  aria-pressed={isSel}
                  onClick={() => setSelectedId(o.id)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setSelectedId(o.id);
                    }
                  }}
                  className={`row-hover-faint${isSel ? ' row-selected' : ''}`}
                  style={{
                    position: 'relative', padding: '10px 14px',
                    borderBottom: '1px solid var(--b2)',
                    borderLeft: isSel ? `2px solid var(--accent)` : '2px solid transparent',
                    background: isSel ? 'rgba(232,93,47,0.05)' : 'transparent',
                    cursor: 'pointer',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 2 }}>
                    <div style={{ fontSize: 11, fontWeight: 600 }}>
                      🎥 {o.feed_label}
                    </div>
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 8, color: 'var(--muted)' }}>
                      {o.captured_at ? o.captured_at.replace('T', ' ').slice(0, 16) : '—'}
                    </div>
                  </div>
                  <div style={{ fontSize: 9.5, color: 'var(--dim)', marginBottom: 4, fontFamily: 'var(--mono)' }}>
                    {rowIsVehicle
                      ? `${vehSubtitle} · ${o.image_name.split('_').pop()}`
                      : rowIsDumping
                        ? `${dmpSubtitle} · ${o.image_name.split('_').pop()}`
                        : `👣 ${o.pedestrian_count ?? '–'} pedestrians · ${o.image_name.split('_').pop()}`}
                  </div>
                  <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
                    {/* Preset tag — only visible in ALL view to disambiguate
                        rows of different presets in the same list. */}
                    {isAllView && o.preset && (
                      <Badge color={rowIsVehicle ? '#4A9EF5' : rowIsDumping ? '#F97316' : '#2DC9A8'}>{PRESET_LABEL[o.preset] ?? o.preset.toUpperCase()}</Badge>
                    )}
                    {rowIsVehicle ? (
                      <>
                        {o.collision && <Badge color={VEH_COLLISION}>COLLISION</Badge>}
                        {o.speeding && <Badge color={VEH_SPEEDING}>SPEEDING</Badge>}
                        {o.fire_lane_violation && <Badge color={VEH_FIRE_LANE}>FIRE-LANE</Badge>}
                        {o.wrong_way && <Badge color={VEH_WRONG_WAY}>WRONG-WAY</Badge>}
                        {o.erratic_maneuver && <Badge color={VEH_OTHER}>ERRATIC</Badge>}
                        {o.vehicle_tamper && <Badge color={VEH_COLLISION}>TAMPER</Badge>}
                        {o.building_contact && <Badge color={VEH_COLLISION}>BUILDING-HIT</Badge>}
                        {o.pedestrian_struck && <Badge color={VEH_COLLISION}>PED-STRUCK</Badge>}
                        {o.pedestrian_near_miss && <Badge color={VEH_SPEEDING}>PED-NEAR-MISS</Badge>}
                        {o.child_struck && <Badge color={VEH_COLLISION}>CHILD-STRUCK</Badge>}
                        {(o.no_plate_count ?? 0) > 0 && <Badge color="#F5B731">NO-PLATE×{o.no_plate_count}</Badge>}
                      </>
                    ) : rowIsDumping ? (
                      <>
                        {o.dumping_present && <Badge color={DMP_PRESENT}>DUMPING</Badge>}
                        {o.ordinance_violation && <Badge color={DMP_PRESENT}>ORDINANCE</Badge>}
                        {o.chronic_site && <Badge color={DMP_CHRONIC}>CHRONIC</Badge>}
                        {o.water_proximity && <Badge color={DMP_WATER}>WATER PROX</Badge>}
                        {o.gutter_alley && <Badge color={DMP_GUTTER}>GUTTER</Badge>}
                        {o.priority && <Badge color={PRIORITY_COLOR[o.priority] ?? 'var(--muted)'}>{o.priority}</Badge>}
                        {o.severity !== null && o.severity !== undefined && <Badge color={PRIORITY_COLOR.HIGH ?? '#EF4444'}>SEV {o.severity}</Badge>}
                      </>
                    ) : (
                      <>
                        {o.density_zone && <Badge color={dCol}>{o.density_zone}</Badge>}
                        {o.risk_level && <Badge color={rCol}>RISK {o.risk_level}</Badge>}
                        {crowdThreat && <Badge color="#EF4444">⚠ THREAT</Badge>}
                        {o.weapons_visible && <Badge color="#EF4444">WEAPON</Badge>}
                        {o.medical_emergency && <Badge color="#A78BFA">MEDICAL</Badge>}
                        {o.fire_smoke && <Badge color="#F97316">FIRE</Badge>}
                        {o.fallen_person && <Badge color="#F97316">FALLEN</Badge>}
                        {o.unsupervised_children && <Badge color="#F5B731">CHILD</Badge>}
                        {o.physical_altercation && <Badge color="#EF4444">ALTERCATION</Badge>}
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Pagination */}
          <div style={{ padding: '8px 14px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--s1)' }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--muted)' }}>
              {total === 0 ? '0 records' : `${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, total)} of ${total}`}
            </span>
            <div style={{ display: 'flex', gap: 5 }}>
              <Chip onClick={() => setPage(Math.max(0, page - 1))}>PREV</Chip>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--muted)', padding: '4px 4px' }}>
                {page + 1} / {totalPages}
              </span>
              <Chip onClick={() => setPage(Math.min(totalPages - 1, page + 1))}>NEXT</Chip>
            </div>
          </div>
        </div>

        {/* Detail column */}
        <div style={{ background: 'var(--s0)', display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', background: 'var(--s1)', display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ fontFamily: 'var(--cond)', fontSize: 11, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase' }}>Observation Detail</span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 8, color: 'var(--muted)', background: 'var(--b2)', padding: '2px 7px', borderRadius: 10 }}>
              {selectedId ? selectedId.slice(-6) : 'select'}
            </span>
          </div>

          <div style={{ height: 'calc(100vh - 300px)', minHeight: 380, overflowY: 'auto', padding: 14 }}>
            {!detail ? (
              <div style={{ color: 'var(--muted)', fontSize: 11, textAlign: 'center', padding: 40 }}>
                Select an observation
              </div>
            ) : (
              <>
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10, color: 'var(--accent)' }}>
                  🎥 {detail.feed_label}
                </div>

                {[
                  ['Captured', detail.captured_at?.replace('T', ' ') ?? '—'],
                  ['Processed', detail.processed_at?.slice(0, 19).replace('T', ' ') ?? '—'],
                  // Prefer parsed ISO timestamp; fall back to a humanized
                  // version of the run_id (YYYYMMDDTHHMMSSZ → YYYY-MM-DD HH:MM UTC)
                  // so we never display the raw compact code.
                  ['Batch', detail.run_started_at
                    ? `${detail.run_started_at.replace('T', ' ').slice(0, 16)} UTC`
                    : detail.run_id && /^\d{8}T\d{6}Z$/.test(detail.run_id)
                      ? `${detail.run_id.slice(0,4)}-${detail.run_id.slice(4,6)}-${detail.run_id.slice(6,8)} ${detail.run_id.slice(9,11)}:${detail.run_id.slice(11,13)} UTC`
                      : detail.run_id || '—'],
                  ['Image', detail.image_name],
                  ['Model', detail.model],
                  ['Latency', detail.total_seconds ? `${detail.total_seconds.toFixed(2)}s` : '—'],
                ].map(([k, v]) => (
                  <div key={k} style={{ display: 'flex', gap: 8, marginBottom: 4 }}>
                    <div style={{ fontSize: 9, color: 'var(--muted)', minWidth: 72, fontFamily: 'var(--mono)' }}>{k}</div>
                    <div style={{ fontSize: 10, color: 'var(--text)', wordBreak: 'break-all' }}>{v}</div>
                  </div>
                ))}

                <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 10, marginBottom: 14 }}>
                  {detail.preset && (
                    <Badge color={detailIsVehicle ? '#4A9EF5' : detailIsDumping ? '#F97316' : '#2DC9A8'}>{PRESET_LABEL[detail.preset] ?? detail.preset.toUpperCase()}</Badge>
                  )}
                  {detailIsVehicle ? (
                    <>
                      {detail.vehicle_description && <Badge color="#4A9EF5">🚗 {detail.vehicle_description.slice(0, 32)}{detail.vehicle_description.length > 32 ? '…' : ''}</Badge>}
                      {detail.collision && <Badge color={VEH_COLLISION}>COLLISION</Badge>}
                      {detail.speeding && <Badge color={VEH_SPEEDING}>SPEEDING</Badge>}
                      {detail.fire_lane_violation && <Badge color={VEH_FIRE_LANE}>FIRE-LANE</Badge>}
                      {detail.wrong_way && <Badge color={VEH_WRONG_WAY}>WRONG-WAY</Badge>}
                      {detail.erratic_maneuver && <Badge color={VEH_OTHER}>ERRATIC</Badge>}
                      {detail.vehicle_tamper && <Badge color={VEH_COLLISION}>TAMPER</Badge>}
                      {detail.building_contact && <Badge color={VEH_COLLISION}>BUILDING-HIT</Badge>}
                      {detail.pedestrian_struck && <Badge color={VEH_COLLISION}>PED-STRUCK</Badge>}
                      {detail.pedestrian_near_miss && <Badge color={VEH_SPEEDING}>PED-NEAR-MISS</Badge>}
                      {detail.child_struck && <Badge color={VEH_COLLISION}>CHILD-STRUCK</Badge>}
                      {(detail.no_plate_count ?? 0) > 0 && <Badge color="#F5B731">NO-PLATE×{detail.no_plate_count}</Badge>}
                      {(detail.near_miss_count ?? 0) > 0 && <Badge color="#F97316">NEAR-MISS×{detail.near_miss_count}</Badge>}
                    </>
                  ) : detailIsDumping ? (
                    <>
                      {detail.dumping_present && <Badge color={DMP_PRESENT}>DUMPING</Badge>}
                      {detail.ordinance_violation && <Badge color={DMP_PRESENT}>ORDINANCE</Badge>}
                      {detail.chronic_site && <Badge color={DMP_CHRONIC}>CHRONIC</Badge>}
                      {detail.water_proximity && <Badge color={DMP_WATER}>WATER PROX</Badge>}
                      {detail.gutter_alley && <Badge color={DMP_GUTTER}>GUTTER</Badge>}
                      {detail.priority && <Badge color={PRIORITY_COLOR[detail.priority] ?? 'var(--muted)'}>{detail.priority}</Badge>}
                      {detail.severity !== null && detail.severity !== undefined && <Badge color={PRIORITY_COLOR.HIGH ?? '#EF4444'}>SEV {detail.severity}</Badge>}
                      {detail.ordinance && <Badge color="#4A9EF5">{detail.ordinance}</Badge>}
                      {detail.waste_type && <Badge color="#A78BFA">{detail.waste_type.slice(0, 16)}</Badge>}
                    </>
                  ) : (
                    <>
                      {detail.density_zone && <Badge color={DENSITY_COLOR[detail.density_zone] ?? 'var(--border)'}>{detail.density_zone}</Badge>}
                      {detail.risk_level && <Badge color={RISK_COLOR[detail.risk_level] ?? 'var(--border)'}>RISK {detail.risk_level}</Badge>}
                      {detail.pedestrian_count !== null && <Badge color="#2DC9A8">👣 {detail.pedestrian_count}</Badge>}
                      {detail.weapons_visible && <Badge color="#EF4444">WEAPON</Badge>}
                      {detail.medical_emergency && <Badge color="#A78BFA">MEDICAL</Badge>}
                      {detail.fire_smoke && <Badge color="#F97316">FIRE</Badge>}
                      {detail.fallen_person && <Badge color="#F97316">FALLEN</Badge>}
                      {detail.unsupervised_children && <Badge color="#F5B731">CHILD</Badge>}
                      {detail.has_imminent_threat && <Badge color="#EF4444">THREAT</Badge>}
                    </>
                  )}
                </div>

                {/* Section roll-up */}
                <div style={{ fontSize: 8, color: 'var(--muted)', letterSpacing: '0.15em', textTransform: 'uppercase', marginBottom: 6, fontFamily: 'var(--mono)' }}>
                  Section Roll-Up
                </div>
                {detailSummaries && (
                  <div style={{ marginBottom: 14, border: '1px solid var(--border)', borderRadius: 4, overflow: 'hidden' }}>
                    {detailSectionOrder.map((sec, i) => {
                      const s = detailSummaries[sec];
                      if (!s) return null;
                      const flagged = s.flagCount > 0;
                      const color = s.highlight ?? (flagged ? '#EF4444' : 'var(--muted)');
                      return (
                        <div key={sec} style={{
                          display: 'grid', gridTemplateColumns: '1fr auto',
                          gap: 8, padding: '7px 10px',
                          borderTop: i === 0 ? 'none' : '1px solid var(--b2)',
                          background: flagged ? 'rgba(239,68,68,0.04)' : 'transparent',
                        }}>
                          <div>
                            <div style={{ fontSize: 9, fontFamily: 'var(--mono)', color: 'var(--accent)', letterSpacing: '0.06em' }}>
                              [{sec}]
                            </div>
                            <div style={{ fontSize: 9, color: 'var(--muted)', marginTop: 1 }}>
                              {s.questionCount} question{s.questionCount === 1 ? '' : 's'}{s.flagCount > 0 ? ` · ${s.flagCount} positive` : ''}
                            </div>
                          </div>
                          <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color, alignSelf: 'center', textAlign: 'right' }}>
                            {s.value}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                <div style={{ fontSize: 8, color: 'var(--muted)', letterSpacing: '0.15em', textTransform: 'uppercase', marginBottom: 6, fontFamily: 'var(--mono)' }}>
                  Per-Prompt Answers
                </div>
                <div style={{ marginBottom: 14 }}>
                  {prompts?.filter(p => p.preset === detail.preset).map(p => {
                    const lines = p.q_numbers
                      .map(n => ({ n, ans: detail.answers[String(n)] }))
                      .filter(x => x.ans);
                    if (!lines.length) return null;
                    return (
                      <div key={p.id} style={{ marginBottom: 8 }}>
                        <div style={{ fontSize: 9, color: 'var(--accent)', fontFamily: 'var(--mono)', marginBottom: 2 }}>
                          [{p.section}] · Q{p.q_numbers.join(',')}
                        </div>
                        <div style={{ fontSize: 10, color: 'var(--dim)', lineHeight: 1.45, marginBottom: 3, fontStyle: 'italic' }}>
                          {p.prompt}
                        </div>
                        {lines.map(l => (
                          <div key={l.n} style={{ fontSize: 10.5, color: 'var(--text)', lineHeight: 1.5, paddingLeft: 8, borderLeft: '1px solid var(--border)', marginBottom: 2 }}>
                            <span style={{ color: 'var(--muted)', fontFamily: 'var(--mono)', marginRight: 4 }}>{l.n}.</span>
                            {l.ans}
                          </div>
                        ))}
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

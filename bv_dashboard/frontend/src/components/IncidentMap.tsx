// components/IncidentMap.tsx
import { useMemo, useState } from 'react';
import { useLocations } from '../hooks/useApi';
import { useIncidentsForMap } from '../hooks/IncidentsProvider';
import { sevColor } from '../types';
import type { Incident } from '../types';

const LAT0 = 25.82, LAT1 = 25.97, LON0 = -97.60, LON1 = -97.36;
const W = 700, H = 400;

function geo(lat: number, lon: number) {
  return {
    x: ((lon - LON0) / (LON1 - LON0)) * W,
    y: ((LAT1 - lat) / (LAT1 - LAT0)) * H,
  };
}

type MapFilter = 'all' | 'violent' | 'health' | 'environ';

interface Props {
  onSelect: (i: Incident) => void;
}

export default function IncidentMap({ onSelect }: Props) {
  const [filter, setFilter] = useState<MapFilter>('all');
  const incidents = useIncidentsForMap(filter);
  const { data: locations } = useLocations();

  // Cluster incidents by location once per filter change instead of on
  // every render. The previous inline forEach + .find ran O(N*M) per render.
  const byLoc = useMemo<Record<string, Incident[]>>(() => {
    const out: Record<string, Incident[]> = {};
    for (const i of incidents) {
      (out[i.location_id] ??= []).push(i);
    }
    return out;
  }, [incidents]);

  const buttons: Array<{ key: MapFilter; label: string }> = [
    { key: 'all', label: 'ALL' }, { key: 'violent', label: 'VIOLENT' },
    { key: 'health', label: 'HEALTH' }, { key: 'environ', label: 'ENVIRON' },
  ];

  return (
    <div style={{ position: 'relative', height: 400, overflow: 'hidden', background: 'var(--bg)' }}>
      {/* Background gradient */}
      <div style={{
        position: 'absolute', inset: 0,
        background: 'radial-gradient(ellipse at 55% 40%,rgba(74,158,245,0.06) 0%,transparent 55%), radial-gradient(ellipse at 25% 70%,rgba(232,93,47,0.05) 0%,transparent 45%)',
      }} />

      <svg viewBox={`0 0 ${W} ${H}`} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
        {/* Roads / resacas */}
        <path d="M80,210 Q220,188 370,218 Q480,235 620,205" fill="none" stroke="rgba(59,130,246,.18)" strokeWidth={4} />
        <path d="M40,285 Q180,265 320,295 Q430,315 580,282" fill="none" stroke="rgba(59,130,246,.12)" strokeWidth={3} />
        <line x1={600} y1={0} x2={600} y2={400} stroke="rgba(255,255,255,.04)" strokeWidth={8} />
        <line x1={0} y1={340} x2={700} y2={370} stroke="rgba(255,255,255,.03)" strokeWidth={5} />
        <rect x={600} y={130} width={70} height={18} rx={3} fill="rgba(245,158,11,.06)" stroke="rgba(245,158,11,.2)" strokeWidth={1} />
        <line x1={215} y1={248} x2={188} y2={288} stroke="rgba(245,158,11,.28)" strokeWidth={5} />

        {/* Heat blobs */}
        {Object.entries(byLoc).map(([lid, incs]) => {
          const loc = locations?.find(l => l.id === lid);
          if (!loc) return null;
          const p   = geo(loc.lat, loc.lon);
          const maxS = Math.max(...incs.map(i => i.sev));
          const r    = Math.min(52, 14 + incs.length * 1.8);
          const col  = sevColor(maxS);
          return <circle key={lid} cx={p.x} cy={p.y} r={r} fill={`${col}14`} stroke={`${col}22`} strokeWidth={1} />;
        })}

        {/* Incident dots */}
        {incidents.slice(0, 220).map(inc => {
          const p   = geo(inc.lat, inc.lon);
          const col = sevColor(inc.sev);
          const r   = Math.max(3, inc.sev * 8.5);
          return (
            <circle
              key={inc.id} cx={p.x} cy={p.y} r={r}
              fill={col} fillOpacity={0.72}
              stroke={col} strokeWidth={inc.verified ? 1.5 : 0.4}
              style={{ cursor: 'pointer' }}
              onClick={() => onSelect(inc)}
            >
              <title>{inc.type} @ {inc.location_name}</title>
            </circle>
          );
        })}

        {/* Location labels */}
        {locations?.map(loc => {
          const cnt = (byLoc[loc.id] || []).length;
          if (!cnt) return null;
          const p = geo(loc.lat, loc.lon);
          return (
            <text key={loc.id} x={p.x} y={p.y - 13} fontSize={8}
              fill="rgba(216,213,204,.44)" textAnchor="middle" fontFamily="monospace">
              {loc.name.split(' ').slice(0, 2).join(' ')}
            </text>
          );
        })}
      </svg>

      {/* Legend */}
      <div style={{ position: 'absolute', top: 10, right: 10, background: 'var(--overlay-bg)', border: '1px solid var(--border)', borderRadius: 6, padding: '9px 11px' }}>
        <div style={{ fontSize: 8, color: 'var(--muted)', letterSpacing: '0.12em', marginBottom: 6, fontFamily: 'var(--mono)' }}>SEVERITY</div>
        {[['#7f1d1d','Critical ≥0.9'],['#EF4444','High 0.7–0.9'],['#F97316','Moderate 0.5–0.7'],['#F5B731','Low 0.3–0.5'],['#22C55E','Minimal <0.3']].map(([c, l]) => (
          <div key={l} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3, fontSize: 8.5 }}>
            <div style={{ width: 7, height: 7, borderRadius: '50%', background: c, flexShrink: 0 }} />
            {l}
          </div>
        ))}
      </div>

      {/* Filter buttons */}
      <div style={{ position: 'absolute', bottom: 10, left: 10, display: 'flex', gap: 5 }}>
        {buttons.map(b => (
          <button
            key={b.key}
            onClick={() => setFilter(b.key)}
            style={{
              background: filter === b.key ? 'rgba(232,93,47,0.18)' : 'var(--overlay-bg-soft)',
              border: `1px solid ${filter === b.key ? 'var(--accent)' : 'var(--border)'}`,
              color: filter === b.key ? 'var(--accent)' : 'var(--muted)',
              fontFamily: 'var(--mono)', fontSize: 9, padding: '4px 9px', borderRadius: 3, transition: 'all .18s',
            }}
          >{b.label}</button>
        ))}
      </div>
    </div>
  );
}

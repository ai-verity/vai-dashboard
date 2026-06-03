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
  const allIncidents = useIncidentsForMap(filter);
  const { data: locations } = useLocations();

  // The live feed is statewide (Austin, Midland, …) but this is the Brownsville
  // map: keep only incidents with finite coords inside the map's bounding box,
  // so out-of-area items can't project off-screen and crowd out / blank the map.
  const incidents = useMemo<Incident[]>(() => allIncidents.filter(i =>
    Number.isFinite(i.lat) && Number.isFinite(i.lon) &&
    i.lat >= LAT0 && i.lat <= LAT1 && i.lon >= LON0 && i.lon <= LON1
  ), [allIncidents]);

  // Cluster incidents by location once per filter change instead of on
  // every render. The previous inline forEach + .find ran O(N*M) per render.
  const byLoc = useMemo<Record<string, Incident[]>>(() => {
    const out: Record<string, Incident[]> = {};
    for (const i of incidents) {
      (out[i.location_id] ??= []).push(i);
    }
    return out;
  }, [incidents]);

  // Ranked monitored locations for the always-readable overlay panel — sidesteps
  // the on-map label overlap in the dense downtown cluster. Active (with
  // incidents) sites sort to the top; show the top 8.
  const rankedLocations = useMemo(() => {
    if (!locations) return [];
    return locations
      .map(loc => {
        const incs = byLoc[loc.id] || [];
        const cnt  = incs.length;
        return { loc, cnt, col: cnt ? sevColor(Math.max(...incs.map(i => i.sev))) : '#9aa0aa' };
      })
      .sort((a, b) => b.cnt - a.cnt)
      .slice(0, 8);
  }, [locations, byLoc]);

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

        {/* Monitored locations — a pin + haloed label for every primary site
            (always shown, even with 0 incidents), so the key locations stay
            readable over the heat blobs. The dark text halo (paint-order:stroke)
            separates labels from the colored background. */}
        {locations?.map(loc => {
          const incs = byLoc[loc.id] || [];
          const cnt  = incs.length;
          const col  = cnt ? sevColor(Math.max(...incs.map(i => i.sev))) : '#9aa0aa';
          const p    = geo(loc.lat, loc.lon);
          return (
            <g key={loc.id} style={{ pointerEvents: 'none' }}>
              <circle cx={p.x} cy={p.y} r={cnt ? 4 : 3} fill={col}
                style={{ stroke: 'var(--bg)', strokeWidth: 1.5 }} />
              <text x={p.x} y={p.y - 9} fontSize={9.5} textAnchor="middle"
                style={{
                  fill: 'var(--text)', stroke: 'var(--bg)', strokeWidth: 3,
                  paintOrder: 'stroke', fontFamily: 'var(--mono)', fontWeight: 600,
                  opacity: cnt ? 1 : 0.6,
                }}>
                {loc.name.split(' ').slice(0, 2).join(' ')}{cnt ? ` · ${cnt}` : ''}
              </text>
            </g>
          );
        })}
      </svg>

      {/* Monitored-locations panel — always-readable ranked list (name · count),
          so primary sites are legible even where on-map labels overlap. Anchored
          bottom-right (the only free corner) so it grows upward and leaves the
          map's denser center/left area unobscured. */}
      <div style={{ position: 'absolute', bottom: 10, right: 10, background: 'var(--overlay-bg)', border: '1px solid var(--border)', borderRadius: 6, padding: '9px 11px', maxWidth: 210 }}>
        <div style={{ fontSize: 8, color: 'var(--muted)', letterSpacing: '0.12em', marginBottom: 6, fontFamily: 'var(--mono)' }}>MONITORED LOCATIONS</div>
        {rankedLocations.map(({ loc, cnt, col }) => (
          <div key={loc.id} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3, fontSize: 9 }}>
            <div style={{ width: 7, height: 7, borderRadius: '50%', background: col, flexShrink: 0 }} />
            <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: 'var(--text)' }}>
              {loc.icon} {loc.name}
            </span>
            <span style={{ fontFamily: 'var(--mono)', color: cnt ? 'var(--text)' : 'var(--muted)' }}>{cnt}</span>
          </div>
        ))}
      </div>

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

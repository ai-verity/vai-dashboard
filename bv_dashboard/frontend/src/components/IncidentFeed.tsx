// components/IncidentFeed.tsx
import { useState } from 'react';
import { useIncidentsByCategory, useIncidentsContext } from '../hooks/IncidentsProvider';
import { sevColor, sevLabel } from '../types';
import type { Incident } from '../types';

const FILTERS: Array<{ key: string; label: string }> = [
  { key: 'ALL',      label: 'ALL'      },
  { key: 'VIOLENT',  label: 'VIOLENT'  },
  { key: 'HEALTH',   label: 'HEALTH'   },
  { key: 'ENVIRON',  label: 'ENVIRON'  },
  { key: 'ORDER',    label: 'ORDER'    },
  { key: 'SECURITY', label: 'SECURITY' },
];

interface Props {
  selected: Incident | null;
  onSelect: (i: Incident) => void;
}

export default function IncidentFeed({ selected, onSelect }: Props) {
  const [activeCat, setActiveCat] = useState('ALL');
  const { loading, error, refetch } = useIncidentsContext();
  const { incidents, total } = useIncidentsByCategory(activeCat, 120);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--s0)' }}>
      {/* Header */}
      <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', background: 'var(--s1)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
        <span style={{ fontFamily: 'var(--cond)', fontSize: 11, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase' }}>Incident Feed</span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 8, color: 'var(--muted)', background: 'var(--b2)', padding: '2px 7px', borderRadius: 10 }}>
          {total} records
        </span>
      </div>

      {/* Filters */}
      <div style={{ padding: '8px 12px', display: 'flex', gap: 5, flexWrap: 'wrap', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        {FILTERS.map(f => (
          <button
            key={f.key}
            onClick={() => setActiveCat(f.key)}
            style={{
              fontFamily: 'var(--mono)', fontSize: 8.5, letterSpacing: '0.06em',
              padding: '3px 9px', borderRadius: 3, transition: 'all .18s',
              border: `1px solid ${activeCat === f.key ? 'var(--accent)' : 'var(--border)'}`,
              background: activeCat === f.key ? 'rgba(232,93,47,0.12)' : 'transparent',
              color: activeCat === f.key ? 'var(--accent)' : 'var(--muted)',
            }}
          >{f.label}</button>
        ))}
      </div>

      {/* List */}
      <div style={{ height: 'calc(100vh - 335px)', minHeight: 380, overflowY: 'auto' }} role="region" aria-live="polite">
        {error && !loading ? (
          <div role="alert" style={{ padding: 16, textAlign: 'center' }}>
            <div style={{ fontSize: 11, color: 'var(--red, #EF4444)', marginBottom: 8 }}>
              Failed to load incidents — {error}
            </div>
            <button
              onClick={() => refetch()}
              style={{
                fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.06em',
                padding: '4px 12px', borderRadius: 3, cursor: 'pointer',
                background: 'transparent', border: '1px solid var(--border)', color: 'var(--accent)',
              }}
            >Retry</button>
          </div>
        ) : loading ? (
          Array.from({ length: 8 }).map((_, i) => (
            <div key={i} style={{ padding: '10px 12px', borderBottom: '1px solid var(--b2)' }}>
              <div className="skeleton" style={{ width: '70%', height: 11, marginBottom: 6 }} />
              <div className="skeleton" style={{ width: '45%', height: 9 }} />
            </div>
          ))
        ) : incidents.map((inc, idx) => {
          const isSel = selected?.id === inc.id;
          const col   = sevColor(inc.sev);
          return (
            <div
              key={inc.id}
              role="button"
              tabIndex={0}
              aria-label={`${inc.type} at ${inc.location_name}, ${sevLabel(inc.sev)} severity`}
              aria-pressed={isSel}
              onClick={() => onSelect(inc)}
              onKeyDown={e => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelect(inc);
                }
              }}
              className={`fade-up row-hover-faint${isSel ? ' row-selected' : ''}`}
              style={{
                position: 'relative', padding: '10px 12px',
                borderBottom: '1px solid var(--b2)',
                borderLeft: isSel ? `2px solid var(--accent)` : '2px solid transparent',
                background: isSel ? 'rgba(232,93,47,0.05)' : 'transparent',
                cursor: 'pointer',
                animationDelay: `${Math.min(idx * 0.015, 0.8)}s`,
              }}
            >
              {/* Left severity bar */}
              <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 2, background: col }} />
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 2 }}>
                <div style={{ fontSize: 11, fontWeight: 600 }}>{inc.icon} {inc.type}</div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 8, color: 'var(--muted)' }}>{inc.date}</div>
              </div>
              <div style={{ fontSize: 9.5, color: 'var(--dim)', marginBottom: 4 }}>
                📍 <span style={{ color: 'var(--teal)' }}>{inc.location_name}</span>
              </div>
              <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 7.5, padding: '1px 5px', borderRadius: 2, fontFamily: 'var(--mono)', background: `${col}18`, color: col, border: `1px solid ${col}44` }}>
                  {sevLabel(inc.sev)}
                </span>
                <span style={{ fontSize: 7.5, padding: '1px 5px', borderRadius: 2, fontFamily: 'var(--mono)', background: 'var(--b2)', color: 'var(--dim)', border: '1px solid var(--border)' }}>
                  {inc.cat}
                </span>
                {inc.verified && (
                  <span style={{ fontSize: 7.5, padding: '1px 5px', borderRadius: 2, fontFamily: 'var(--mono)', background: 'rgba(45,201,168,.1)', color: 'var(--teal)', border: '1px solid rgba(45,201,168,.3)' }}>
                    ✓ VERIFIED
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

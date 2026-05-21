// components/AlertTicker.tsx
//
// Today-only static strip of high-severity incidents. Replaces the old
// horizontally-scrolling ticker (the marquee animation was distracting
// and the historical items it cycled through weren't actionable). Now
// shows only incidents dated `today`, with a clear fallback when the
// day is quiet.

import { useMemo } from 'react';
import { useIncidentsContext } from '../hooks/IncidentsProvider';
import type { Incident } from '../types';

function todayISO(): string {
  // YYYY-MM-DD in the viewer's local timezone — matches the date string
  // shape stored on each incident.
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function useTodayHighSeverity(minSev = 0.7): Incident[] {
  const { incidents } = useIncidentsContext();
  return useMemo(() => {
    const today = todayISO();
    return incidents
      .filter(i => i.date === today && i.sev >= minSev)
      .sort((a, b) => b.sev - a.sev);
  }, [incidents, minSev]);
}

export default function AlertTicker() {
  const items = useTodayHighSeverity();
  const today = todayISO();

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="High-severity incidents — today"
      style={{
        background: 'var(--alert-bg)',
        borderBottom: '1px solid rgba(232,93,47,0.18)',
        padding: '6px 14px',
        display: 'flex',
        alignItems: 'center',
        gap: 18,
        overflowX: 'auto',
        whiteSpace: 'nowrap',
      }}
    >
      <span style={{
        fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.12em',
        textTransform: 'uppercase', color: 'var(--accent)',
        padding: '2px 8px', border: '1px solid rgba(232,93,47,0.45)',
        borderRadius: 3, flexShrink: 0,
      }}>
        Today · {today}
      </span>

      {items.length === 0 ? (
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted)' }}>
          <span style={{ color: 'var(--green)' }}>⬥</span> No high-severity incidents recorded today. All monitoring channels active.
        </span>
      ) : (
        items.map(i => (
          <span key={i.id} style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--accent)' }}>
            <span style={{ color: 'var(--muted)' }}>⬥</span> {i.icon}{' '}
            <b>{i.type.toUpperCase()}</b> · {i.location_name} · SEV {i.sev.toFixed(2)}
          </span>
        ))
      )}
    </div>
  );
}

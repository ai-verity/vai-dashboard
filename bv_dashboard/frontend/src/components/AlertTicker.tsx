// components/AlertTicker.tsx
import { useHighSeverityIncidents } from '../hooks/IncidentsProvider';
import type { Incident } from '../types';

function TickerRow({ items, copyId, fallback }: { items: Incident[]; copyId: 'a' | 'b'; fallback: boolean }) {
  if (fallback) {
    return (
      <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--accent)', padding: '0 2.5rem' }}>
        <span style={{ color: 'var(--muted)' }}>⬥</span> System monitoring active · All 16 locations tracked · Jan 1 – May 13, 2026
      </span>
    );
  }
  return (
    <>
      {items.map(i => (
        <span key={`${copyId}-${i.id}`} style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--accent)', padding: '0 2.5rem' }}>
          <span style={{ color: 'var(--muted)' }}>⬥</span> {i.date} · {i.icon}{' '}
          <b>{i.type.toUpperCase()}</b> · {i.location_name} · SEV {i.sev.toFixed(2)}
        </span>
      ))}
    </>
  );
}

export default function AlertTicker() {
  const items = useHighSeverityIncidents(20, 0.70);
  const fallback = items.length === 0;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="High-severity incident ticker"
      style={{
        background: '#0d0804',
        borderBottom: '1px solid rgba(232,93,47,0.18)',
        padding: '6px 0',
        overflow: 'hidden',
        whiteSpace: 'nowrap',
      }}
    >
      <div style={{
        display: 'inline-flex',
        animation: 'tickerScroll 70s linear infinite',
      }}>
        <TickerRow items={items} copyId="a" fallback={fallback} />
        <TickerRow items={items} copyId="b" fallback={fallback} />
      </div>
    </div>
  );
}

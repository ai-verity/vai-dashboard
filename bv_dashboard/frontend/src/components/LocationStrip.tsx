// components/LocationStrip.tsx
import { useByLocation } from '../hooks/useApi';


export default function LocationStrip() {
  const { data, loading } = useByLocation();
  const top8 = data?.slice(0, 8) ?? [];
  const maxCount = top8[0]?.count ?? 1;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8,1fr)', gap: 1, background: 'var(--border)', borderTop: '1px solid var(--border)' }}>
      {loading
        ? Array.from({ length: 8 }).map((_, i) => (
            <div key={i} style={{ background: 'var(--s0)', padding: '9px 11px' }}>
              <div className="skeleton" style={{ width: '80%', height: 8, marginBottom: 5 }} />
              <div className="skeleton" style={{ width: 30, height: 16 }} />
            </div>
          ))
        : top8.map(loc => {
            const col = loc.count > 35 ? '#EF4444' : loc.count > 22 ? '#F97316' : loc.count > 12 ? '#F5B731' : '#2DC9A8';
            const pct = Math.round((loc.count / maxCount) * 100);
            return (
              <div
                key={loc.location_id}
                style={{ background: 'var(--s0)', padding: '9px 11px' }}
              >
                <div style={{ fontSize: 8, color: 'var(--muted)', marginBottom: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {loc.icon} {loc.location_name}
                </div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: '1.05rem', fontWeight: 500, color: col }}>{loc.count}</div>
                <div style={{ height: 2, borderRadius: 1, marginTop: 4, background: col, width: `${pct}%`, transition: 'width 1.2s' }} />
              </div>
            );
          })
      }
    </div>
  );
}

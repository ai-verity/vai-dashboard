// components/CategoryPanel.tsx
import { useByCategory } from '../hooks/useApi';
import { CAT_META } from '../types';
import type { Category } from '../types';

interface Props { onFilter?: (cat: Category) => void; }

export default function CategoryPanel({ onFilter }: Props) {
  const { data, loading } = useByCategory();

  const maxCount = data ? Math.max(...data.map(d => d.count)) : 1;

  return (
    <div>
      <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', background: 'var(--s1)', display: 'flex', justifyContent: 'space-between' }}>
        <span style={{ fontFamily: 'var(--cond)', fontSize: 11, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase' }}>By Category</span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 8, color: 'var(--muted)', background: 'var(--b2)', padding: '2px 7px', borderRadius: 10 }}>2026 YTD</span>
      </div>
      {loading
        ? Array.from({ length: 5 }).map((_, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 14px', borderBottom: '1px solid var(--b2)' }}>
              <div className="skeleton" style={{ width: 20, height: 20, borderRadius: '50%' }} />
              <div className="skeleton" style={{ flex: 1, height: 10 }} />
              <div className="skeleton" style={{ width: 28, height: 10 }} />
            </div>
          ))
        : data?.map(row => {
            const meta = CAT_META[row.cat];
            const pct  = Math.round((row.count / maxCount) * 100);
            return (
              <div
                key={row.cat}
                role="button"
                tabIndex={0}
                aria-label={`Filter by ${meta.label}`}
                onClick={() => onFilter?.(row.cat)}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onFilter?.(row.cat);
                  }
                }}
                className="row-hover-faint"
                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', borderBottom: '1px solid var(--b2)', cursor: 'pointer' }}
              >
                <div style={{ fontSize: 13, width: 20, textAlign: 'center', flexShrink: 0 }}>{meta.icon}</div>
                <div style={{ fontSize: 10.5, flex: 1 }}>{meta.label}</div>
                <div style={{ width: 70, height: 3, background: 'var(--b2)', borderRadius: 1, overflow: 'hidden' }}>
                  <div style={{ height: '100%', borderRadius: 1, background: meta.color, width: `${pct}%`, transition: 'width 1.2s cubic-bezier(.4,0,.2,1)' }} />
                </div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--muted)', minWidth: 26, textAlign: 'right' }}>{row.count}</div>
              </div>
            );
          })
      }
    </div>
  );
}

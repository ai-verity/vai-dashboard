// components/KpiStrip.tsx
import { useKpi } from '../hooks/useApi';

interface KpiCellProps {
  value: string | number;
  label: string;
  sub: string;
  color: string;
}

function KpiCell({ value, label, sub, color }: KpiCellProps) {
  return (
    <div
      className="row-hover-s1"
      style={{
        background: 'var(--s0)', padding: '13px 16px',
        display: 'flex', flexDirection: 'column', gap: 3,
        cursor: 'default',
      }}
    >
      <div style={{ fontFamily: 'var(--mono)', fontSize: '1.65rem', fontWeight: 500, lineHeight: 1.1, color }}>{value}</div>
      <div style={{ fontSize: 8.5, color: 'var(--muted)', letterSpacing: '0.15em', textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: 9, fontFamily: 'var(--mono)', color: 'var(--muted)' }}>{sub}</div>
    </div>
  );
}

export default function KpiStrip() {
  const { data, loading } = useKpi();
  if (loading || !data) {
    return (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 1, background: 'var(--border)', borderBottom: '1px solid var(--border)' }}>
        {Array.from({ length: 7 }).map((_, i) => (
          <div key={i} style={{ background: 'var(--s0)', padding: '13px 16px' }}>
            <div className="skeleton" style={{ width: 60, height: 28, marginBottom: 6 }} />
            <div className="skeleton" style={{ width: 80, height: 10 }} />
          </div>
        ))}
      </div>
    );
  }

  const cells = [
    { value: data.total,     label: 'Total Incidents',  sub: 'Jan 1 – May 13',          color: 'var(--red)'    },
    { value: data.violent,   label: 'Violent Crime',    sub: 'assault · weapons · fight',color: 'var(--orange)' },
    { value: data.health,    label: 'Health / Medical', sub: 'diabetes · cardiac · MH',  color: 'var(--purple)' },
    { value: data.environ,   label: 'Environmental',    sub: 'flood · fire · smoke',      color: 'var(--blue)'   },
    { value: data.order,     label: 'Public Order',     sub: 'mob · vandal · homeless',  color: 'var(--amber)'  },
    { value: data.critical,  label: 'Critical Severity',sub: '≥ 0.75 score',             color: 'var(--teal)'   },
    { value: data.avg_daily, label: 'Avg / Day',        sub: 'incidents per day',         color: 'var(--accent)' },
  ];

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 1, background: 'var(--border)', borderBottom: '1px solid var(--border)' }}>
      {cells.map(c => <KpiCell key={c.label} {...c} />)}
    </div>
  );
}

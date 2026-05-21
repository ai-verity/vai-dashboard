// components/SourcesPanel.tsx
//
// Scrollable roll-up of the upstream data sources that feed the public
// safety dashboard. Aggregates the `source` string carried on each
// incident, shows count and most-recent date per source. Mounted as a
// thin strip below the AlertTicker on the dashboard / charts views.

import { useMemo } from 'react';
import { useIncidentsContext } from '../hooks/IncidentsProvider';

interface SourceRow {
  source: string;
  count: number;
  latest_date: string;
  display: string;       // collapsed label — date suffixes folded together
}

function collapse(source: string): string {
  // KRGV May 11 2026, KRGV Apr 29 → all collapse to "KRGV" so the list
  // shows one row per upstream agency rather than one per scraped article.
  // Anything not matching falls through verbatim.
  const lower = source.trim();
  if (/^krgv/i.test(lower)) return 'KRGV';
  if (/^bpd\b/i.test(lower) || /^bpd cad/i.test(lower)) return 'BPD (Brownsville PD)';
  if (/city of brownsville/i.test(lower)) return 'City of Brownsville';
  if (/city oem/i.test(lower)) return 'City OEM';
  if (/city commission/i.test(lower)) return 'City Commission';
  if (/valley regional/i.test(lower)) return 'Valley Regional Med Ctr';
  if (/nextdoor/i.test(lower)) return 'Nextdoor';
  return source;
}

function useSources(): { rows: SourceRow[]; latestOverall: string } {
  const { incidents } = useIncidentsContext();
  return useMemo(() => {
    const buckets = new Map<string, { count: number; latest_date: string }>();
    let latestOverall = '';
    for (const inc of incidents) {
      const display = collapse(inc.source || 'Unknown');
      const cur = buckets.get(display);
      if (cur) {
        cur.count += 1;
        if (inc.date > cur.latest_date) cur.latest_date = inc.date;
      } else {
        buckets.set(display, { count: 1, latest_date: inc.date });
      }
      if (inc.date > latestOverall) latestOverall = inc.date;
    }
    const rows: SourceRow[] = [];
    for (const [display, v] of buckets) {
      rows.push({ source: display, display, count: v.count, latest_date: v.latest_date });
    }
    rows.sort((a, b) => b.count - a.count);
    return { rows, latestOverall };
  }, [incidents]);
}

export default function SourcesPanel() {
  const { rows, latestOverall } = useSources();

  return (
    <div
      aria-label="Data sources feeding the public safety dashboard"
      style={{
        background: 'var(--s1)',
        borderBottom: '1px solid var(--border)',
        padding: '0',
      }}
    >
      {/* Header bar */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '8px 16px',
        borderBottom: '1px solid var(--border)',
      }}>
        <span style={{
          fontFamily: 'var(--cond)', fontSize: 11, fontWeight: 700,
          letterSpacing: '0.12em', textTransform: 'uppercase',
        }}>
          Data Sources
        </span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--muted)' }}>
          {rows.length} sources · last update {latestOverall || '—'}
        </span>
      </div>

      {/* Scrollable list */}
      <div style={{
        maxHeight: 132,
        overflowY: 'auto',
        background: 'var(--s0)',
      }}>
        {rows.length === 0 ? (
          <div style={{
            padding: '12px 16px',
            fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted)',
            textAlign: 'center',
          }}>
            No sources loaded yet.
          </div>
        ) : (
          rows.map(r => (
            <div
              key={r.source}
              className="row-hover-faint"
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr auto auto',
                gap: 12,
                alignItems: 'center',
                padding: '6px 16px',
                borderBottom: '1px solid var(--b2)',
                fontSize: 11,
              }}
            >
              <span style={{ color: 'var(--text)' }}>
                <span style={{ color: 'var(--teal)', marginRight: 8 }}>◆</span>
                {r.source}
              </span>
              <span style={{
                fontFamily: 'var(--mono)', fontSize: 9,
                color: 'var(--muted)', whiteSpace: 'nowrap',
              }}>
                latest {r.latest_date}
              </span>
              <span style={{
                fontFamily: 'var(--mono)', fontSize: 10,
                padding: '1px 8px', borderRadius: 10,
                background: 'var(--b2)', color: 'var(--accent)',
                minWidth: 36, textAlign: 'center',
              }}>
                {r.count}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

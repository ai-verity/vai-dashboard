// pages/DashboardPage.tsx
import { useState } from 'react';
import type { Incident } from '../types';
import IncidentFeed from '../components/IncidentFeed';
import IncidentMap  from '../components/IncidentMap';
import CategoryPanel from '../components/CategoryPanel';
import DetailPanel  from '../components/DetailPanel';
import LocationStrip from '../components/LocationStrip';
import MiniTimeline from '../components/MiniTimeline';

export default function DashboardPage() {
  const [selected, setSelected] = useState<Incident | null>(null);

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {/* 3-column grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '300px 1fr 320px', gap: 1, background: 'var(--border)' }}>

        {/* LEFT: Incident feed */}
        <div style={{ background: 'var(--s0)', minHeight: 600 }}>
          <IncidentFeed selected={selected} onSelect={setSelected} />
        </div>

        {/* CENTER: Map + mini timeline */}
        <div style={{ background: 'var(--s0)', display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', background: 'var(--s1)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
            <span style={{ fontFamily: 'var(--cond)', fontSize: 11, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase' }}>Incident Map — Brownsville TX</span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 8, color: 'var(--muted)', background: 'var(--b2)', padding: '2px 7px', borderRadius: 10 }}>Geo-coded</span>
          </div>
          <IncidentMap onSelect={setSelected} />
          <div style={{ padding: '10px 14px', borderTop: '1px solid var(--border)', borderBottom: '1px solid var(--border)', background: 'var(--s1)', display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ fontFamily: 'var(--cond)', fontSize: 11, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase' }}>Monthly Overview</span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 8, color: 'var(--muted)', background: 'var(--b2)', padding: '2px 7px', borderRadius: 10 }}>Stacked by category</span>
          </div>
          <MiniTimeline />
        </div>

        {/* RIGHT: Category + Detail */}
        <div style={{ background: 'var(--s0)', display: 'flex', flexDirection: 'column' }}>
          <CategoryPanel />
          <div style={{ padding: '10px 14px', borderTop: '1px solid var(--border)', borderBottom: '1px solid var(--border)', background: 'var(--s1)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
            <span style={{ fontFamily: 'var(--cond)', fontSize: 11, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase' }}>Incident Detail</span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 8, color: 'var(--muted)', background: 'var(--b2)', padding: '2px 7px', borderRadius: 10 }}>
              {selected ? selected.id : 'select'}
            </span>
          </div>
          <DetailPanel incident={selected} />
        </div>

      </div>

      {/* Location strip */}
      <LocationStrip />
    </div>
  );
}

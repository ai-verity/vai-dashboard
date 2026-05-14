// components/TopNav.tsx
import { useState, useEffect } from 'react';

type ViewKey = 'dashboard' | 'charts' | 'vlm';

interface Props {
  activeView: ViewKey;
  onViewChange: (v: ViewKey) => void;
}

export default function TopNav({ activeView, onViewChange }: Props) {
  const [clock, setClock] = useState('');

  useEffect(() => {
    const tick = () => setClock(new Date().toLocaleTimeString('en-US', { hour12: false }));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <nav style={{
      position: 'sticky', top: 0, zIndex: 200,
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      height: 52, padding: '0 1.5rem',
      background: 'var(--s0)', borderBottom: '1px solid var(--border)',
    }}>
      {/* Brand */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{
          width: 22, height: 22,
          background: 'var(--accent)',
          clipPath: 'polygon(50% 0%,100% 25%,100% 75%,50% 100%,0% 75%,0% 25%)',
          flexShrink: 0,
        }} />
        <div>
          <div style={{ fontFamily: 'var(--cond)', fontSize: 15, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase' }}>
            Brownsville, TX — Public Safety Intelligence
          </div>
          <div style={{ fontSize: 9, color: 'var(--muted)', letterSpacing: '0.05em' }}>
            Cameron County · Jan 1 – May 13, 2026 · 16 Monitored Locations
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 2 }}>
        {(['dashboard', 'charts', 'vlm'] as const).map(v => (
          <button
            key={v}
            onClick={() => onViewChange(v)}
            style={{
              fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.08em',
              textTransform: 'uppercase', padding: '6px 16px',
              border: `1px solid ${activeView === v ? 'var(--accent)' : 'transparent'}`,
              borderRadius: 4, cursor: 'pointer',
              color: activeView === v ? 'var(--accent)' : 'var(--muted)',
              background: activeView === v ? 'rgba(232,93,47,0.08)' : 'transparent',
              transition: 'all .2s',
            }}
          >
            {v === 'dashboard' ? '⬡ Dashboard' : v === 'charts' ? '📊 Charts & Trends' : '🎥 VLM Feeds'}
          </button>
        ))}
      </div>

      {/* Right */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--green)', letterSpacing: '0.12em' }}>
          <div style={{ width: 6, height: 6, background: 'var(--green)', borderRadius: '50%', animation: 'blink 1.6s ease-in-out infinite' }} />
          LIVE
        </div>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted)' }}>{clock}</div>
      </div>
    </nav>
  );
}

// components/DetailPanel.tsx
import { useEffect } from 'react';
import { CAT_META, sevColor, sevLabel } from '../types';
import type { Incident } from '../types';
import { useAnalysis } from '../hooks/useApi';

interface Props { incident: Incident | null; }

export default function DetailPanel({ incident }: Props) {
  const { text: aiText, loading: aiLoading, analyze } = useAnalysis();
  useEffect(() => {
    if (incident) analyze(incident);
  }, [incident?.id]);

  if (!incident) {
    return (
      <div style={{ height: 'calc(100vh - 335px)', minHeight: 380, overflowY: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
        <div style={{ textAlign: 'center', color: 'var(--muted)', fontSize: 11 }}>
          <div style={{ fontSize: 24, marginBottom: 8 }}>⬡</div>
          Select an incident from the feed
        </div>
      </div>
    );
  }

  const col = sevColor(incident.sev);
  const cat = CAT_META[incident.cat];

  return (
    <div style={{ height: 'calc(100vh - 335px)', minHeight: 380, overflowY: 'auto', padding: 14 }}>
      {/* Title */}
      <div style={{ fontSize: 14, fontWeight: 600, color: col, marginBottom: 10 }}>
        {incident.icon} {incident.type}
      </div>

      {/* Fields */}
      {[
        ['Date / Time', `${incident.date}  ${incident.time}`],
        ['Location',    incident.location_name],
        ['Category',    cat?.label ?? incident.cat],
        ['Source',      incident.source],
      ].map(([k, v]) => (
        <div key={k} style={{ display: 'flex', gap: 8, marginBottom: 5 }}>
          <div style={{ fontSize: 9, color: 'var(--muted)', minWidth: 72, flexShrink: 0, fontFamily: 'var(--mono)', paddingTop: 1 }}>{k}</div>
          <div style={{ fontSize: 10, color: k === 'Location' ? 'var(--teal)' : 'var(--text)', lineHeight: 1.5 }}>{v}</div>
        </div>
      ))}

      {/* Severity chip */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 5 }}>
        <div style={{ fontSize: 9, color: 'var(--muted)', minWidth: 72, flexShrink: 0, fontFamily: 'var(--mono)', paddingTop: 1 }}>Severity</div>
        <span style={{ display: 'inline-block', padding: '2px 7px', borderRadius: 2, fontFamily: 'var(--mono)', fontSize: 8, fontWeight: 500, background: `${col}18`, color: col, border: `1px solid ${col}44` }}>
          {sevLabel(incident.sev)} · {incident.sev.toFixed(2)}
        </span>
      </div>

      {incident.verified && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 5 }}>
          <div style={{ fontSize: 9, color: 'var(--muted)', minWidth: 72, flexShrink: 0, fontFamily: 'var(--mono)', paddingTop: 1 }}>Status</div>
          <div style={{ fontSize: 10, color: 'var(--teal)' }}>✓ Verified incident</div>
        </div>
      )}

      {/* Description */}
      <div style={{ marginTop: 12, marginBottom: 14 }}>
        <div style={{ fontSize: 8, color: 'var(--muted)', letterSpacing: '0.15em', textTransform: 'uppercase', marginBottom: 6, fontFamily: 'var(--mono)' }}>Description</div>
        <div style={{ fontSize: 10.5, lineHeight: 1.65, color: 'var(--text)' }}>{incident.desc}</div>
      </div>

      {/* AI Analysis */}
      <div>
        <div style={{ fontSize: 8, color: 'var(--muted)', letterSpacing: '0.15em', textTransform: 'uppercase', marginBottom: 6, fontFamily: 'var(--mono)' }}>AI Analysis</div>
        <div style={{
          background: 'rgba(232,93,47,0.045)',
          border: '1px solid rgba(232,93,47,0.14)',
          borderRadius: 5, padding: 11,
        }}>
          <div style={{ fontSize: 8, color: 'var(--accent)', letterSpacing: '0.14em', marginBottom: 7, fontFamily: 'var(--mono)' }}>⬡ GRAPH-RAG ANALYSIS</div>
          <div style={{ fontSize: 10.5, lineHeight: 1.7, color: '#a09d98' }}>
            {aiLoading && !aiText
              ? <><span style={{ color: 'var(--muted)', fontStyle: 'italic' }}>Analyzing</span><span style={{ display: 'inline-block', width: 5, height: 10, background: 'var(--accent)', animation: 'cur .9s step-end infinite', verticalAlign: 'middle', marginLeft: 2 }} /></>
              : aiText || 'No analysis available.'}
            {aiLoading && aiText && <span style={{ display: 'inline-block', width: 5, height: 10, background: 'var(--accent)', animation: 'cur .9s step-end infinite', verticalAlign: 'middle', marginLeft: 2 }} />}
          </div>
        </div>
      </div>
    </div>
  );
}

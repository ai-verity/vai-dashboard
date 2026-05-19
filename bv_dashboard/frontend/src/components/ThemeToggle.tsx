// components/ThemeToggle.tsx
//
// Single-button toggle between dark and light themes. State lives in
// useTheme (which also persists to localStorage and mirrors the
// `data-theme` attribute on <html>).

import { useTheme } from '../hooks/useTheme';

interface Props {
  /** Compact variant uses a smaller chip; default is the full pill. */
  compact?: boolean;
}

export default function ThemeToggle({ compact }: Props) {
  const { mode, toggle } = useTheme();
  const next = mode === 'dark' ? 'light' : 'dark';
  const icon = mode === 'dark' ? '☀' : '☾';
  const label = mode === 'dark' ? 'LIGHT' : 'DARK';

  return (
    <button
      onClick={toggle}
      title={`Switch to ${next} theme`}
      aria-label={`Switch to ${next} theme`}
      style={{
        fontFamily: 'var(--mono)', fontSize: compact ? 9 : 10,
        padding: compact ? '4px 8px' : '5px 10px',
        borderRadius: 3,
        border: '1px solid var(--border)',
        background: 'transparent',
        color: 'var(--text)',
        letterSpacing: '0.08em', textTransform: 'uppercase',
        display: 'inline-flex', alignItems: 'center', gap: 6,
        cursor: 'pointer', transition: 'border-color .18s, color .18s',
      }}
      onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--accent)'; }}
      onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--text)'; }}
    >
      <span aria-hidden style={{ fontSize: 12, lineHeight: 1 }}>{icon}</span>
      {label}
    </button>
  );
}

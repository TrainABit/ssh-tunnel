import { AlertTriangle, Info, X } from 'lucide-react';

const TONES = {
  error: { color: 'var(--red)', background: 'rgba(200,32,32,0.08)', border: 'rgba(200,32,32,0.25)', Icon: AlertTriangle },
  warning: { color: 'var(--amber)', background: 'rgba(240,165,0,0.08)', border: 'rgba(240,165,0,0.3)', Icon: AlertTriangle },
  info: { color: 'var(--text-mid)', background: 'var(--surface2)', border: 'var(--border)', Icon: Info },
};

/** Inline status message. `onDismiss` adds a close button. */
export default function Banner({ tone = 'error', children, onDismiss, style }) {
  const t = TONES[tone] || TONES.error;
  const Icon = t.Icon;
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      style={{
        display: 'flex', alignItems: 'flex-start', gap: '10px',
        padding: '10px 14px', borderRadius: '8px', fontSize: '13px', lineHeight: 1.5,
        color: t.color, background: t.background, border: `1px solid ${t.border}`,
        ...style,
      }}
    >
      <Icon size={14} style={{ flexShrink: 0, marginTop: '3px' }} />
      <div style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{children}</div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', padding: '2px', display: 'flex' }}
        >
          <X size={13} />
        </button>
      )}
    </div>
  );
}

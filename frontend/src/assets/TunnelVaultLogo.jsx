/**
 * TunnelVault wordmark: a tunnel arch inside a vault outline plus the product name.
 * tone="auto" follows the current theme; tone="light" is for dark/coloured backgrounds.
 */
export default function TunnelVaultLogo({ height = 22, tone = 'auto', className = '' }) {
  const textColor = tone === 'light' ? '#ffffff' : 'var(--text)';
  const accent = tone === 'light' ? 'rgba(255,255,255,0.72)' : 'var(--accent)';
  return (
    <span
      className={className}
      role="img"
      aria-label="TunnelVault"
      style={{ display: 'inline-flex', alignItems: 'center', gap: Math.round(height * 0.4), lineHeight: 1 }}
    >
      <svg width={height} height={height} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <rect x="1.5" y="1.5" width="21" height="21" rx="5" fill="none" stroke={accent} strokeWidth="2" />
        <path d="M6 19v-6.5a6 6 0 0 1 12 0V19" fill="none" stroke={accent} strokeWidth="2" strokeLinecap="round" />
        <path d="M10 19v-6a2 2 0 0 1 4 0v6" fill="none" stroke={textColor} strokeWidth="2" strokeLinecap="round" />
      </svg>
      <span
        aria-hidden="true"
        style={{
          fontFamily: 'var(--font-mono)', fontWeight: 600, fontSize: Math.round(height * 0.75),
          letterSpacing: '-0.01em', color: textColor, whiteSpace: 'nowrap',
        }}
      >
        Tunnel<span style={{ color: accent }}>Vault</span>
      </span>
    </span>
  );
}

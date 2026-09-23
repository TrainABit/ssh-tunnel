/**
 * TunnelVault wordmark.
 * Renders in full colour regardless of theme; size controlled by props.
 */
export default function TunnelVaultLogo({ height = 22, className = '' }) {
  const w = height * 5; // preserve approximate aspect ratio
  return (
    <svg
      width={w}
      height={height}
      viewBox="0 0 150 30"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-label="TunnelVault"
    >
      <defs>
        <linearGradient id="tv-grad" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#0632A0" />
          <stop offset="100%" stopColor="#1EB4E6" />
        </linearGradient>
      </defs>
      <text
        x="75"
        y="21"
        textAnchor="middle"
        fontSize="20"
        fontFamily="'Inter','Segoe UI',system-ui,sans-serif"
        fontWeight="700"
        letterSpacing="0.5"
        fill="url(#tv-grad)"
      >
        TunnelVault
      </text>
    </svg>
  );
}

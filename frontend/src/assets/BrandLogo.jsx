/**
 * TunnelVault wordmark — matches corporate brand gradient.
 * Renders in full colour regardless of theme; size controlled by props.
 */
export default function BrandLogo({ height = 22, className = '' }) {
  const w = height * 4.5; // preserve approximate aspect ratio
  return (
    <svg
      width={w}
      height={height}
      viewBox="0 0 135 30"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-label="TunnelVault"
    >
      <defs>
        <linearGradient id="syn-grad" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#0632A0" />
          <stop offset="100%" stopColor="#1EB4E6" />
        </linearGradient>
      </defs>

      {/* S */}
      <path
        d="M7.5 6.5C5.8 6.5 4.5 7.4 4.5 8.8c0 1.2.9 1.9 2.8 2.4l2 .6c2.6.8 4 2.2 4 4.4 0 2.8-2.3 4.8-5.8 4.8-3.3 0-5.5-1.8-5.8-4.6h2.5c.3 1.5 1.5 2.4 3.3 2.4 1.9 0 3.1-.9 3.1-2.3 0-1.2-.8-2-2.7-2.5l-2-.6C3 12.7 1.8 11.3 1.8 9.1 1.8 6.5 4 4.6 7.5 4.6c3.1 0 5.1 1.7 5.4 4.2H10.5C10.2 7.4 9.1 6.5 7.5 6.5Z"
        fill="url(#syn-grad)"
      />
      {/* Y */}
      <path
        d="M20.5 14.2 15.2 4.8h2.8l3.9 7.2 3.9-7.2h2.7L23.2 14.2V21h-2.7V14.2Z"
        fill="url(#syn-grad)"
      />
      {/* N */}
      <path
        d="M30 4.8h2.5l7 11.8V4.8h2.5V21h-2.5L32.5 9.2V21H30V4.8Z"
        fill="url(#syn-grad)"
      />
      {/* T */}
      <path
        d="M47.5 7h-4.3V4.8H54.3V7H50V21h-2.5V7Z"
        fill="url(#syn-grad)"
      />
      {/* A */}
      <path
        d="M61 4.8h2.7L69 21h-2.7l-1.4-4H59l-1.4 4h-2.7L61 4.8Zm3.2 10-2-5.8-2 5.8h4Z"
        fill="url(#syn-grad)"
      />
      {/* X */}
      <path
        d="M75.5 12.5 69.8 4.8h3l4 5.8 4-5.8h3L78 12.5l6 8.5h-3l-4.3-6.2L72.4 21h-3l6-8.5Z"
        fill="url(#syn-grad)"
      />

      {/* Separator dot */}
      <circle cx="88" cy="13" r="1.5" fill="#1EB4E6" opacity="0.6" />

      {/* SYSTEMS in smaller text */}
      <text
        x="93"
        y="17.5"
        fontSize="9"
        fontFamily="'IBM Plex Mono','JetBrains Mono',monospace"
        fontWeight="500"
        letterSpacing="1.5"
        fill="#1EB4E6"
        opacity="0.85"
      >
        SYSTEMS
      </text>
    </svg>
  );
}

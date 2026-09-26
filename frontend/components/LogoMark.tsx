// TradeJournal mark: three rising candlesticks on a teal tile.
export default function LogoMark({ size = 36 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 36 36" role="img" aria-label="TradeJournal" className="logo-mark">
      <defs>
        <linearGradient id="tj-logo-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#57a6a8" />
          <stop offset="1" stopColor="#346365" />
        </linearGradient>
      </defs>
      <rect width="36" height="36" rx="10" fill="url(#tj-logo-bg)" />
      <g fill="#fff" stroke="#fff" strokeLinecap="round">
        <line x1="11" y1="17" x2="11" y2="27" strokeWidth="1.6" />
        <rect x="8.5" y="19.5" width="5" height="5.5" rx="1" stroke="none" />
        <line x1="18" y1="12" x2="18" y2="25" strokeWidth="1.6" />
        <rect x="15.5" y="14" width="5" height="8" rx="1" stroke="none" />
        <line x1="25" y1="7" x2="25" y2="22" strokeWidth="1.6" />
        <rect x="22.5" y="9" width="5" height="9.5" rx="1" stroke="none" />
      </g>
    </svg>
  );
}

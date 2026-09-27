import { BarChart3, BookOpenCheck, Bot, CandlestickChart, RefreshCw } from 'lucide-react';
import LogoMark from '@/components/LogoMark';

// Left half of the sign-in and create-account pages: what the journal does,
// with a small illustration (a replayed chart with a position and the stats
// it feeds). Hidden on narrow screens, where only the tagline shows.

const POINTS = [
  { icon: RefreshCw, title: 'Every trade, synced', text: 'MT5 and cTrader history, commission and swap included. No spreadsheets.' },
  { icon: BookOpenCheck, title: 'Journal against your playbook', text: 'Checklists, grades, emotions, notes and screenshots on every trade.' },
  { icon: BarChart3, title: 'Stats that don’t fool you', text: 'Every number comes with how many trades back it and its likely range.' },
  { icon: CandlestickChart, title: 'Backtest without hindsight', text: 'Replay history bar by bar with the future hidden and real lot sizes.' },
  { icon: Bot, title: 'Let AI find the leaks', text: 'Connect Claude, or export your journal to any AI for a coach’s review.' },
];

// Candles for the illustration: [open, high, low, close] in chart units (0 = top).
const CANDLES: [number, number, number, number][] = [
  [150, 140, 162, 156], [156, 146, 170, 164], [164, 150, 168, 152], [152, 136, 156, 140], [140, 128, 146, 132],
  [132, 124, 140, 138], [138, 120, 142, 124], [124, 110, 130, 114], [114, 108, 126, 122], [122, 104, 126, 108],
  [108, 96, 114, 100], [100, 92, 110, 106], [106, 88, 110, 92], [92, 80, 98, 84],
];

function Illustration() {
  const w = 18, gap = 8, x0 = 20;
  const entryY = 106, stopY = 130, targetY = 58, boxX = x0 + 9 * (w + gap) - 4;
  return (
    <svg viewBox="0 0 420 230" className="auth-illustration" role="img" aria-label="A replayed price chart with a long position, its stop and target, and journal statistics">
      {[50, 100, 150, 200].map(y => <line key={y} x1="0" x2="420" y1={y} y2={y} className="auth-ill-grid" />)}
      <rect x={boxX} y={targetY} width={170} height={entryY - targetY} className="auth-ill-win" rx="3" />
      <rect x={boxX} y={entryY} width={170} height={stopY - entryY} className="auth-ill-loss" rx="3" />
      <line x1={boxX} x2={boxX + 170} y1={entryY} y2={entryY} className="auth-ill-entry" />
      {CANDLES.map(([o, h, l, c], i) => {
        const x = x0 + i * (w + gap);
        const up = c < o; // y grows downward
        return (
          <g key={i} className={up ? 'auth-ill-up' : 'auth-ill-down'}>
            <line x1={x + w / 2} x2={x + w / 2} y1={h} y2={l} strokeWidth="2" />
            <rect x={x} y={Math.min(o, c)} width={w} height={Math.max(3, Math.abs(c - o))} rx="2" />
          </g>
        );
      })}
      <g className="auth-ill-chip" transform="translate(268 8)">
        <rect width="144" height="40" rx="8" />
        <text x="12" y="17" className="auth-ill-chip-label">WIN RATE · 128 TRADES</text>
        <text x="12" y="32" className="auth-ill-chip-value">58% <tspan className="auth-ill-chip-sub">likely 49–66%</tspan></text>
      </g>
      <g className="auth-ill-chip" transform="translate(268 182)">
        <rect width="144" height="40" rx="8" />
        <text x="12" y="17" className="auth-ill-chip-label">LONG · 0.35 LOTS</text>
        <text x="12" y="32" className="auth-ill-chip-value auth-ill-pos">+2.00R <tspan className="auth-ill-chip-sub">+$200</tspan></text>
      </g>
    </svg>
  );
}

export default function AuthShowcase() {
  return (
    <aside className="auth-showcase">
      <div className="auth-brand"><LogoMark size={34} /><span>TradeJournal</span></div>
      <div className="auth-pitch">
        <h1>Know your edge.<br />Prove it.</h1>
        <p>The trading journal that syncs your trades, shows what&apos;s really working, and lets you test ideas before you risk money on them.</p>
      </div>
      <Illustration />
      <ul className="auth-points">
        {POINTS.map(({ icon: Icon, title, text }) => (
          <li key={title}>
            <span className="auth-point-icon"><Icon size={16} /></span>
            <span><b>{title}</b>{text}</span>
          </li>
        ))}
      </ul>
    </aside>
  );
}

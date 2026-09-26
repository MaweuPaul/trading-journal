'use client';
import type { CSSProperties } from 'react';
import type { Confidence, SampleLevel } from './confidenceMath';

// The one way the app shows how far to trust a number: a sample-size tag and
// a 95% "likely" range. Plain inline styles on the app's CSS variables, so it
// looks the same on the classic pages and inside the Backtest section.

const LEVEL: Record<SampleLevel, { label: string; color: string; bg: string; hint: string }> = {
  insufficient: { label: 'too few to judge', color: 'var(--text-muted)', bg: 'var(--bg-hover)', hint: 'Under 10 trades: this number could easily be luck.' },
  early: { label: 'early', color: 'var(--amber)', bg: 'var(--amber-bg, rgba(245, 158, 11, 0.12))', hint: '10–29 trades: an early read that can still change a lot.' },
  developing: { label: 'developing', color: 'var(--accent)', bg: 'var(--accent-light)', hint: '30–99 trades: taking shape, but still has a wide margin.' },
  reliable: { label: 'reliable', color: 'var(--green)', bg: 'var(--green-bg)', hint: '100+ trades: a reasonably dependable sample.' },
};

/** "12 trades · early" pill. */
export function SampleTag({ n, level, style }: { n: number; level: SampleLevel; style?: CSSProperties }) {
  const l = LEVEL[level];
  return (
    <span title={`${l.hint} The ranges shown are 95% intervals: where the true value most likely lies.`}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '1px 7px', borderRadius: 999, fontSize: 10.5, fontWeight: 600, lineHeight: 1.6, whiteSpace: 'nowrap', color: l.color, background: l.bg, ...style }}>
      {n} trade{n === 1 ? '' : 's'} · {l.label}
    </span>
  );
}

/** "likely 38–71%" for a 95% range; nothing when there's no range. */
export function LikelyRange({ range, format, style }: { range: [number, number] | null | undefined; format: (v: number) => string; style?: CSSProperties }) {
  if (!range) return null;
  return (
    <span title="95% range: given this many trades, the true value most likely lies in here." style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap', ...style }}>
      likely {format(range[0])} to {format(range[1])}
    </span>
  );
}

/** Tag plus range on one line, the usual pairing under a headline number. */
export function ConfidenceLine({ confidence, range, format, style }: {
  confidence: Confidence | null | undefined;
  range?: 'winRate' | 'avg' | 'avgR';
  format?: (v: number) => string;
  style?: CSSProperties;
}) {
  if (!confidence) return null;
  const r = range === 'winRate' ? confidence.winRateRange : range === 'avg' ? confidence.avgRange : range === 'avgR' ? confidence.avgRRange : null;
  const fmt = format ?? (range === 'winRate' ? (v: number) => `${v.toFixed(0)}%` : (v: number) => v.toFixed(2));
  return (
    <span style={{ display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, ...style }}>
      <SampleTag n={confidence.n} level={confidence.level} />
      {range && <LikelyRange range={r} format={fmt} />}
    </span>
  );
}

/** Dim a table row whose numbers rest on too few trades to mean much. */
export function thinRowStyle(confidence: Confidence | null | undefined): CSSProperties | undefined {
  return confidence && confidence.level === 'insufficient' ? { opacity: 0.55 } : undefined;
}

/** A signed money formatter for ranges: "-$12" / "+$40". */
export const signedUSD = (v: number) => `${v < 0 ? '-' : '+'}$${Math.abs(v).toFixed(Math.abs(v) >= 100 ? 0 : 2)}`;
/** A signed R formatter for ranges. */
export const signedR = (v: number) => `${v < 0 ? '-' : '+'}${Math.abs(v).toFixed(2)}R`;

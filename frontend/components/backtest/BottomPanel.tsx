'use client';
// The backtest workspace's bottom panel, like cTrader's replay: Positions,
// Orders, History and Statistics tabs over an account strip.
import { useMemo, useState } from 'react';
import { Icon } from './BacktestShell';
import { fmtR, fmtUSD } from './data';
import type { SessionTrade } from './session';
import { ClosedTrade, OpenTrade, fmtPrice } from '../backtest-tools/types';
import { openFraction, orderLabel, rAt } from '../backtest-tools/positionTool';

type Tab = 'positions' | 'orders' | 'history' | 'stats';

export interface BottomPanelProps {
  openTrade: OpenTrade | null;
  closedTrade: ClosedTrade | null;
  tradeLive: boolean;
  unrealizedR: number;
  marketPrice: number | null;
  sessionLog: SessionTrade[];
  startBalance: number | null;
  balance: number | null;
  open: boolean;
  onToggle: () => void;
  fmtTime: (unixSeconds: number) => string;
}

/** Session statistics from the logged outcomes. */
export function sessionStats(log: SessionTrade[], startBalance: number | null) {
  const wins = log.filter(t => t.rMultiple > 0.005), losses = log.filter(t => t.rMultiple < -0.005);
  const grossWin = wins.reduce((s, t) => s + t.pnlUSD, 0), grossLoss = -losses.reduce((s, t) => s + t.pnlUSD, 0);
  const netR = log.reduce((s, t) => s + t.rMultiple, 0);
  // Max drawdown of the balance, from its running peak, in % of that peak.
  let bal = startBalance ?? 0, peak = bal, maxDd = 0;
  for (const t of log) { bal += t.pnlUSD; peak = Math.max(peak, bal); if (peak > 0) maxDd = Math.max(maxDd, (peak - bal) / peak); }
  return {
    trades: log.length, wins: wins.length, losses: losses.length,
    winRate: log.length ? wins.length / log.length : 0,
    netR, avgR: log.length ? netR / log.length : 0,
    netUSD: log.reduce((s, t) => s + t.pnlUSD, 0),
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    bestR: log.length ? Math.max(...log.map(t => t.rMultiple)) : 0,
    worstR: log.length ? Math.min(...log.map(t => t.rMultiple)) : 0,
    maxDrawdownPct: startBalance ? maxDd * 100 : null,
  };
}

const th = 'tw:text-left tw:font-semibold tw:text-on-surface-variant tw:px-2 tw:py-1 tw:whitespace-nowrap';
const td = 'tw:px-2 tw:py-1 tw:font-mono-metric-md tw:whitespace-nowrap';
const sideCls = (d: 'long' | 'short') => (d === 'long' ? 'tw:text-secondary' : 'tw:text-tertiary');
const pnlCls = (n: number) => (n >= 0 ? 'tw:text-secondary' : 'tw:text-tertiary');

export default function BottomPanel(p: BottomPanelProps) {
  const [tab, setTab] = useState<Tab>('positions');
  const t = p.openTrade;
  const position = t && !t.pending ? t : null;
  const order = t && t.pending ? t : null;
  const stats = useMemo(() => sessionStats(p.sessionLog, p.startBalance), [p.sessionLog, p.startBalance]);
  const openR = position && !p.closedTrade ? p.unrealizedR : 0;
  const openUSD = position ? openR * position.riskAmount : 0;

  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: 'positions', label: 'Positions', count: position ? 1 : 0 },
    { id: 'orders', label: 'Orders', count: order ? 1 : 0 },
    { id: 'history', label: 'History', count: p.sessionLog.length },
    { id: 'stats', label: 'Statistics' },
  ];

  const empty = (text: string) => <p className="tw:px-3 tw:py-3 tw:text-[11px] tw:text-on-surface-variant">{text}</p>;
  const stat = (label: string, value: string, cls = 'tw:text-on-surface') => (
    <div className="tw:flex tw:flex-col tw:bg-surface-container-lowest tw:border tw:border-outline-variant tw:rounded tw:px-2.5 tw:py-1.5 tw:min-w-[96px]">
      <span className="tw:text-[10px] tw:text-on-surface-variant">{label}</span>
      <span className={`tw:font-mono-metric-md tw:text-[13px] tw:font-bold ${cls}`}>{value}</span>
    </div>
  );

  return (
    <section className={`tw:shrink-0 tw:bg-surface-container-low tw:border-t tw:border-outline-variant tw:flex tw:flex-col tw:select-text ${p.open ? 'tw:h-[220px]' : ''}`} aria-label="Trades">
      <div className="tw:flex tw:items-center tw:justify-between tw:border-b tw:border-outline-variant tw:px-1">
        <div className="tw:flex" role="tablist">
          {tabs.map(x => (
            <button key={x.id} type="button" role="tab" aria-selected={p.open && tab === x.id} onClick={() => { setTab(x.id); if (!p.open) p.onToggle(); }}
              className={`tw:px-3 tw:py-1.5 tw:text-[11px] tw:font-semibold tw:border-b-2 ${p.open && tab === x.id ? 'tw:border-primary-container tw:text-on-surface' : 'tw:border-transparent tw:text-on-surface-variant tw:hover:text-on-surface'}`}>
              {x.label}{x.count ? <span className="tw:ml-1 tw:px-1 tw:rounded tw:bg-surface-container-high tw:text-[10px]">{x.count}</span> : null}
            </button>
          ))}
        </div>
        <button type="button" onClick={p.onToggle} aria-label={p.open ? 'Collapse panel' : 'Expand panel'} title={p.open ? 'Collapse' : 'Expand'}
          className="tw:w-7 tw:h-7 tw:flex tw:items-center tw:justify-center tw:rounded tw:text-on-surface-variant tw:hover:text-on-surface tw:hover:bg-surface-container-high">
          <Icon name={p.open ? 'expand_more' : 'expand_less'} className="tw:text-[18px]" />
        </button>
      </div>

      {p.open && (
        <div className="tw:flex-1 tw:min-h-0 tw:overflow-auto tw:text-[11px]">
          {tab === 'positions' && (position ? (
            <table className="tw:w-full">
              <thead><tr><th className={th}>Side</th><th className={th}>Opened</th><th className={th}>Entry</th><th className={th}>Stop</th><th className={th}>Target</th><th className={th}>Size</th><th className={th}>Open</th><th className={th}>Current</th><th className={th}>P/L</th></tr></thead>
              <tbody><tr className="tw:bg-surface-container-lowest/60">
                <td className={`${td} ${sideCls(position.direction)}`}>{position.direction === 'long' ? 'Buy' : 'Sell'}</td>
                <td className={td}>{p.fmtTime(position.entryTime)}</td>
                <td className={td}>{fmtPrice(position.entryPrice)}</td>
                <td className={td}>{fmtPrice(position.stopLoss)}</td>
                <td className={td}>{position.takeProfit != null ? fmtPrice(position.takeProfit) : '—'}{position.takeProfit2 != null ? ` / ${fmtPrice(position.takeProfit2)}` : ''}</td>
                <td className={td}>{position.lots != null ? `${position.lots} lot${position.lots === 1 ? '' : 's'}` : `$${position.riskAmount.toFixed(0)} risk`}</td>
                <td className={td}>{Math.round(openFraction(position) * 100)}%</td>
                <td className={td}>{p.marketPrice != null ? fmtPrice(p.marketPrice) : '—'}</td>
                <td className={`${td} tw:font-bold ${pnlCls(p.closedTrade?.rMultiple ?? openR)}`}>
                  {p.closedTrade ? `${fmtR(p.closedTrade.rMultiple)} (${fmtUSD(p.closedTrade.pnlUSD)}) · closed` : `${fmtR(openR)} (${fmtUSD(openUSD)})`}
                </td>
              </tr></tbody>
            </table>
          ) : empty('No open position. Place one from the order ticket on the right, or press L / S and click the chart.'))}

          {tab === 'orders' && (order ? (
            <table className="tw:w-full">
              <thead><tr><th className={th}>Type</th><th className={th}>Placed</th><th className={th}>Price</th><th className={th}>Stop</th><th className={th}>Target</th><th className={th}>Distance</th></tr></thead>
              <tbody><tr className="tw:bg-surface-container-lowest/60">
                <td className={`${td} ${sideCls(order.direction)}`}>{orderLabel(order)}</td>
                <td className={td}>{p.fmtTime(order.entryTime)}</td>
                <td className={td}>{fmtPrice(order.entryPrice)}</td>
                <td className={td}>{fmtPrice(order.stopLoss)}</td>
                <td className={td}>{order.takeProfit != null ? `${fmtPrice(order.takeProfit)} (${fmtR(rAt(order, order.takeProfit), 1)})` : '—'}</td>
                <td className={td}>{p.marketPrice != null ? fmtPrice(Math.abs(order.entryPrice - p.marketPrice)) : '—'}</td>
              </tr></tbody>
            </table>
          ) : empty('No pending orders. Choose Limit or Stop on the order ticket to place one.'))}

          {tab === 'history' && (p.sessionLog.length ? (
            <table className="tw:w-full">
              <thead><tr><th className={th}>#</th><th className={th}>Side</th><th className={th}>Type</th><th className={th}>Opened</th><th className={th}>Entry</th><th className={th}>Closed</th><th className={th}>Exit</th><th className={th}>Size</th><th className={th}>R</th><th className={th}>Net</th></tr></thead>
              <tbody>
                {[...p.sessionLog].reverse().map((x, i) => (
                  <tr key={x.id} className="tw:border-b tw:border-outline-variant/40" title={x.name}>
                    <td className={`${td} tw:text-on-surface-variant`}>{p.sessionLog.length - i}</td>
                    <td className={`${td} ${sideCls(x.direction)}`}>{x.direction === 'long' ? 'Buy' : 'Sell'}</td>
                    <td className={td}>{x.orderType ?? 'market'}</td>
                    <td className={td}>{p.fmtTime(x.entryTime)}</td>
                    <td className={td}>{fmtPrice(x.entryPrice)}</td>
                    <td className={td}>{p.fmtTime(x.exitTime)}</td>
                    <td className={td}>{fmtPrice(x.exitPrice)}</td>
                    <td className={td}>{x.lots != null ? `${x.lots} lot${x.lots === 1 ? '' : 's'}` : '—'}</td>
                    <td className={`${td} ${pnlCls(x.rMultiple)}`}>{fmtR(x.rMultiple)}</td>
                    <td className={`${td} tw:font-bold ${pnlCls(x.pnlUSD)}`}>{fmtUSD(x.pnlUSD)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : empty('Outcomes you log in this backtest are listed here.'))}

          {tab === 'stats' && (stats.trades ? (
            <div className="tw:flex tw:flex-wrap tw:gap-2 tw:p-2.5">
              {stat('Trades', String(stats.trades))}
              {stat('Win rate', `${(stats.winRate * 100).toFixed(0)}%`)}
              {stat('Wins / losses', `${stats.wins} / ${stats.losses}`)}
              {stat('Net R', fmtR(stats.netR), pnlCls(stats.netR))}
              {stat('Avg R', fmtR(stats.avgR), pnlCls(stats.avgR))}
              {stat('Net P/L', fmtUSD(stats.netUSD), pnlCls(stats.netUSD))}
              {stat('Profit factor', Number.isFinite(stats.profitFactor) ? stats.profitFactor.toFixed(2) : '∞')}
              {stat('Best / worst', `${fmtR(stats.bestR, 1)} / ${fmtR(stats.worstR, 1)}`)}
              {stats.maxDrawdownPct != null && stat('Max drawdown', `${stats.maxDrawdownPct.toFixed(2)}%`, stats.maxDrawdownPct > 0 ? 'tw:text-tertiary' : 'tw:text-on-surface')}
            </div>
          ) : empty('Statistics appear once you log an outcome in this backtest.'))}
        </div>
      )}

      {/* Account strip */}
      <div className="tw:flex tw:items-center tw:gap-5 tw:px-3 tw:py-1 tw:border-t tw:border-outline-variant tw:bg-surface-container-lowest tw:font-mono-metric-md tw:text-[11px] tw:whitespace-nowrap tw:overflow-x-auto">
        {p.startBalance != null && <span><span className="tw:text-on-surface-variant">Start </span>${p.startBalance.toLocaleString()}</span>}
        {p.balance != null && <span><span className="tw:text-on-surface-variant">Balance </span><b>${p.balance.toLocaleString(undefined, { maximumFractionDigits: 2 })}</b></span>}
        {p.balance != null && <span><span className="tw:text-on-surface-variant">Equity </span>${(p.balance + openUSD).toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>}
        <span><span className="tw:text-on-surface-variant">Open P/L </span><span className={pnlCls(openUSD)}>{fmtUSD(openUSD)}</span></span>
        <span><span className="tw:text-on-surface-variant">Net R </span><span className={pnlCls(stats.netR)}>{fmtR(stats.netR)}</span></span>
        <span><span className="tw:text-on-surface-variant">Trades </span>{stats.trades}{stats.trades ? ` · ${(stats.winRate * 100).toFixed(0)}% won` : ''}</span>
      </div>
    </section>
  );
}

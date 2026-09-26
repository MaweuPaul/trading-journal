'use client';
import Link from 'next/link';
import { useMemo } from 'react';
import { Icon } from './BacktestShell';
import { BacktestTrade, fmtDate, fmtR, fmtUSD, hashTag, intervalLabel, tagsOf, useBacktest } from './data';
import { computeStats } from './stats';
import { draftProgress, sessionIdFor, useActiveSession } from './session';
import { downloadLogCsv } from './exporting';

// Below this many trades, win rate and R stats are mostly noise -- the
// "completed" bar fills toward it so the sample size reads at a glance.
const SAMPLE_TARGET = 30;
const WEEK_MS = 7 * 86_400_000;

function Kpi({ label, icon, value, valueCls, aside, asideCls = 'tw:text-on-surface-variant', bar }: {
  label: string; icon: string; value: string; valueCls: string; aside: React.ReactNode; asideCls?: string; bar: React.ReactNode;
}) {
  return (
    <div className="tw:bg-surface-container tw:border tw:border-outline-variant tw:rounded-lg tw:p-3 tw:flex tw:flex-col tw:justify-between">
      <div className="tw:flex tw:items-center tw:justify-between tw:text-on-surface-variant">
        <span className="tw:text-label-caps tw:font-label-caps tw:tracking-wider tw:uppercase">{label}</span>
        <Icon name={icon} className="tw:text-sm" />
      </div>
      <div className="tw:mt-1.5 tw:flex tw:items-baseline tw:justify-between tw:gap-2">
        <span className={`tw:text-headline-lg tw:font-mono-metric-lg tw:font-bold ${valueCls}`}>{value}</span>
        <span className={`tw:font-mono-metric-md tw:text-mono-metric-md tw:flex tw:items-center tw:gap-0.5 tw:text-right ${asideCls}`}>{aside}</span>
      </div>
      <div className="tw:mt-2 tw:flex tw:h-1 tw:w-full tw:bg-surface-container-highest tw:rounded-full tw:overflow-hidden">{bar}</div>
    </div>
  );
}

const STEPS = [
  { n: 1, title: 'Pick a market and dates', body: 'Choose a symbol and a past date range on New Backtest.' },
  { n: 2, title: 'Replay and trade', body: 'Step through candles one at a time and place Long or Short trades.' },
  { n: 3, title: 'Review and log', body: 'Rate the setup and note one lesson; your stats build in Metrics.' },
];

function outcomeBadge(t: BacktestTrade) {
  if (t.outcome === 'win') return { label: 'WIN', cls: 'tw:bg-secondary/10 tw:border-secondary tw:text-secondary', dot: 'tw:bg-secondary' };
  if (t.outcome === 'loss') return { label: 'LOSS', cls: 'tw:bg-tertiary/10 tw:border-tertiary tw:text-tertiary', dot: 'tw:bg-tertiary' };
  return { label: 'BE', cls: 'tw:bg-surface-container-highest tw:border-outline-variant tw:text-on-surface-variant', dot: 'tw:bg-outline' };
}
const tone = (n: number) => (n > 0 ? 'tw:text-secondary' : n < 0 ? 'tw:text-tertiary' : 'tw:text-on-surface-variant');

export default function BacktestOverview() {
  const { trades, loading } = useBacktest();
  const draft = useActiveSession();
  const s = useMemo(() => computeStats(trades), [trades]);
  const thisWeek = useMemo(() => trades.filter(t => Date.now() - new Date(t.createdAt).getTime() < WEEK_MS).length, [trades]);
  const recent = trades.slice(0, 5);
  const grossWin = s.avgWinR * s.wins;
  const grossLoss = Math.abs(s.avgLossR * s.losses);
  const winShare = grossWin + grossLoss > 0 ? (grossWin / (grossWin + grossLoss)) * 100 : 0;
  const dash = loading ? '…' : '—';
  const progress = draft ? draftProgress(draft) : null;

  return (
    <div className="tw:flex-1 tw:bg-surface-container-lowest tw:px-5 tw:py-4 tw:flex tw:flex-col tw:gap-4">
      {/* 1. Welcome banner & session status */}
      <section className="tw:bg-surface-container-low tw:border tw:border-outline-variant tw:rounded-lg tw:p-3.5 tw:flex tw:flex-col tw:md:flex-row tw:md:items-center tw:justify-between tw:gap-3">
        <div className="tw:flex tw:flex-col tw:gap-0.5">
          <div className="tw:flex tw:flex-wrap tw:items-center tw:gap-2">
            <h1 className="tw:text-headline-md tw:font-headline-md tw:font-semibold tw:text-on-surface tw:tracking-tight">Manual Backtesting</h1>
          </div>
          <p className="tw:text-body-sm tw:font-body-sm tw:text-on-surface-variant">Replay past markets candle by candle and practise your setups without seeing the future.</p>
        </div>
        <div className="tw:flex tw:flex-wrap tw:items-center tw:gap-2 tw:shrink-0">
          <Link href="/backtest/new" className="tw:px-3.5 tw:py-1.5 tw:rounded tw:bg-primary-container tw:hover:bg-surface-tint tw:text-on-primary tw:font-label-action tw:text-label-action tw:font-semibold tw:flex tw:items-center tw:gap-1.5 tw:transition-all tw:active:scale-[0.98]">
            <Icon name="add" className="tw:text-base" /><span>Start New Backtest</span>
          </Link>
          {draft && progress ? (
            <Link href={`/backtest/workspace?session=${encodeURIComponent(draft.id ?? sessionIdFor(draft.strategy))}`} className="tw:px-3.5 tw:py-1.5 tw:rounded tw:bg-surface-container-highest tw:hover:bg-surface-bright tw:border tw:border-outline-variant tw:text-on-surface tw:font-label-action tw:text-label-action tw:font-medium tw:flex tw:items-center tw:gap-2 tw:transition-colors">
              <Icon name="play_circle" className="tw:text-primary tw:text-base" />
              <span>Resume Active Session</span>
              <span className="tw:px-1.5 tw:rounded tw:bg-surface-container-lowest tw:border tw:border-outline-variant tw:font-mono-metric-md tw:text-[10px] tw:text-primary">
                {draft.symbol} {intervalLabel(draft.interval)} • Bar {progress.bar}{progress.total != null ? `/${progress.total}` : ''}
              </span>
            </Link>
          ) : (
            <span className="tw:px-3.5 tw:py-1.5 tw:rounded tw:bg-surface-container-highest tw:border tw:border-outline-variant tw:text-on-surface-variant tw:font-label-action tw:text-label-action tw:flex tw:items-center tw:gap-2 tw:opacity-70" title="No session in progress">
              <Icon name="play_circle" className="tw:text-base" /><span>No Active Session</span>
            </span>
          )}
        </div>
      </section>

      {/* 2. KPI cards */}
      <section className="tw:grid tw:grid-cols-1 tw:sm:grid-cols-2 tw:lg:grid-cols-4 tw:gap-2.5" aria-label="Backtest summary">
        <Kpi label="Completed Backtests" icon="history_edu" value={loading ? '…' : String(s.n)} valueCls="tw:text-on-surface"
          aside={thisWeek > 0 ? <><Icon name="trending_up" className="tw:text-xs" />+{thisWeek} this week</> : 'none this week'}
          asideCls={thisWeek > 0 ? 'tw:text-secondary' : 'tw:text-on-surface-variant'}
          bar={<div className="tw:h-full tw:bg-primary" style={{ width: `${Math.min(100, (s.n / SAMPLE_TARGET) * 100)}%` }} title={`${s.n} of the ${SAMPLE_TARGET}-trade minimum sample`} />} />
        <Kpi label="Win Rate" icon="pie_chart" value={s.n ? `${s.winRate.toFixed(1)}%` : dash} valueCls={s.winRate >= 50 ? 'tw:text-secondary' : s.n ? 'tw:text-tertiary' : 'tw:text-on-surface'}
          aside={`${s.wins}W / ${s.losses}L`}
          bar={s.n ? <><div className="tw:h-full tw:bg-secondary" style={{ width: `${(s.wins / s.n) * 100}%` }} /><div className="tw:h-full tw:bg-tertiary" style={{ width: `${(s.losses / s.n) * 100}%` }} /></> : null} />
        <Kpi label="Average R Multiple" icon="insights" value={s.n ? fmtR(s.avgR).replace('R', ' R') : dash} valueCls={s.n ? (s.avgR >= 0 ? 'tw:text-primary' : 'tw:text-tertiary') : 'tw:text-on-surface'}
          aside={s.n ? `Win avg: ${fmtR(s.avgWinR)}` : 'Win avg: —'}
          bar={<div className="tw:h-full tw:bg-primary-container" style={{ width: `${Math.min(100, Math.max(0, s.avgR / 3) * 100)}%` }} title="Average R against a 3R ceiling" />} />
        <Kpi label="Simulated Return" icon="monetization_on" value={s.n ? fmtR(s.totalR).replace('R', ' R') : dash} valueCls={s.n ? tone(s.totalR) : 'tw:text-on-surface'}
          aside={s.n ? `${fmtUSD(s.totalPnl)} hyp.` : '$0.00 hyp.'} asideCls={tone(s.totalPnl)}
          bar={<div className="tw:h-full tw:bg-secondary-container" style={{ width: `${winShare}%` }} title="Share of gross R that came from winners" />} />
      </section>

      {/* 3. How it works -- only until the first backtest is logged */}
      {!loading && s.n === 0 && (
        <section className="tw:grid tw:grid-cols-1 tw:md:grid-cols-3 tw:gap-2.5">
          {STEPS.map(step => (
            <div key={step.n} className="tw:bg-surface-container tw:border tw:border-outline-variant tw:rounded-lg tw:p-3 tw:flex tw:items-start tw:gap-2.5">
              <span className="tw:w-6 tw:h-6 tw:shrink-0 tw:rounded-full tw:bg-primary/15 tw:text-primary tw:flex tw:items-center tw:justify-center tw:text-xs tw:font-bold">{step.n}</span>
              <div>
                <p className="tw:font-semibold tw:text-on-surface">{step.title}</p>
                <p className="tw:text-body-sm tw:text-on-surface-variant tw:mt-0.5">{step.body}</p>
              </div>
            </div>
          ))}
        </section>
      )}

      {/* 5. Recent sessions */}
      <section className="tw:bg-surface-container tw:border tw:border-outline-variant tw:rounded-lg tw:overflow-hidden">
        <div className="tw:px-3.5 tw:py-2.5 tw:bg-surface-container-high tw:border-b tw:border-outline-variant tw:flex tw:flex-wrap tw:items-center tw:justify-between tw:gap-2">
          <div className="tw:flex tw:items-center tw:gap-2">
            <Icon name="table_rows" className="tw:text-primary tw:text-base" />
            <h2 className="tw:font-headline-md tw:text-on-surface tw:font-semibold tw:text-xs tw:tracking-tight">Recent Simulated Sessions</h2>
            <span className="tw:px-1.5 tw:py-0.5 tw:rounded tw:bg-surface-container-lowest tw:border tw:border-outline-variant tw:font-mono-metric-md tw:text-[10px] tw:text-on-surface-variant">Showing {recent.length} of {trades.length} records</span>
          </div>
          <Link href="/backtest/log" className="tw:font-label-action tw:text-primary tw:hover:text-surface-tint tw:flex tw:items-center tw:gap-1 tw:text-xs tw:transition-colors">
            <span>View All in Backtest Log</span><Icon name="arrow_forward" className="tw:text-sm" />
          </Link>
        </div>
        {recent.length ? (
          <div className="tw:overflow-x-auto">
            <table className="tw:w-full tw:text-left tw:border-collapse">
              <thead>
                <tr className="tw:bg-surface-container-low tw:border-b tw:border-outline-variant tw:text-label-caps tw:font-label-caps tw:text-on-surface-variant tw:select-none">
                  {['STATUS / RESULT', 'SYMBOL', 'STRATEGY TAG', 'TIMEFRAME', 'DIRECTION'].map(h => <th key={h} className="tw:py-2 tw:px-3 tw:text-[10px]">{h}</th>)}
                  <th className="tw:py-2 tw:px-3 tw:text-[10px] tw:text-right">FINAL R</th>
                  <th className="tw:py-2 tw:px-3 tw:text-[10px] tw:text-right">HYP. P&amp;L</th>
                  <th className="tw:py-2 tw:px-3 tw:text-[10px]">DATE TESTED</th>
                  <th className="tw:py-2 tw:px-3 tw:text-[10px] tw:text-right">ACTION</th>
                </tr>
              </thead>
              <tbody className="tw:divide-y tw:divide-outline-variant/60 tw:font-body-sm tw:text-xs">
                {recent.map(t => {
                  const badge = outcomeBadge(t);
                  const tag = tagsOf(t)[0];
                  const long = t.direction === 'long';
                  return (
                    <tr key={t._id} className="tw:hover:bg-surface-container-high/60 tw:transition-colors">
                      <td className="tw:py-2.5 tw:px-3 tw:whitespace-nowrap">
                        <span className={`tw:inline-flex tw:items-center tw:gap-1 tw:px-1.5 tw:py-0.5 tw:rounded tw:border tw:font-mono-metric-md tw:text-[11px] tw:font-bold ${badge.cls}`}><span className={`tw:w-1.5 tw:h-1.5 tw:rounded-full ${badge.dot}`} />{badge.label}</span>
                      </td>
                      <td className="tw:py-2.5 tw:px-3 tw:font-mono-metric-md tw:font-semibold tw:text-on-surface tw:whitespace-nowrap">{t.symbol}</td>
                      <td className="tw:py-2.5 tw:px-3 tw:whitespace-nowrap">
                        {tag ? <span className="tw:px-2 tw:py-0.5 tw:rounded tw:bg-surface-container-highest tw:border tw:border-outline-variant tw:text-[11px] tw:font-mono-metric-md tw:text-primary">{hashTag(tag)}</span>
                          : <span className="tw:text-[11px] tw:text-on-surface-variant">Unclassified</span>}
                      </td>
                      <td className="tw:py-2.5 tw:px-3 tw:font-mono-metric-md tw:text-on-surface-variant tw:whitespace-nowrap">{intervalLabel(t.interval)}</td>
                      <td className="tw:py-2.5 tw:px-3 tw:whitespace-nowrap">
                        <span className={`tw:font-semibold tw:font-mono-metric-md tw:flex tw:items-center tw:gap-0.5 ${long ? 'tw:text-secondary' : 'tw:text-tertiary'}`}><Icon name={long ? 'north_east' : 'south_east'} className="tw:text-xs" />{long ? 'LONG' : 'SHORT'}</span>
                      </td>
                      <td className={`tw:py-2.5 tw:px-3 tw:text-right tw:font-mono-metric-md tw:font-bold tw:whitespace-nowrap ${tone(t.rMultiple)}`}>{fmtR(t.rMultiple).replace('R', ' R')}</td>
                      <td className={`tw:py-2.5 tw:px-3 tw:text-right tw:font-mono-metric-md tw:font-semibold tw:whitespace-nowrap ${tone(t.pnlUSD)}`}>{fmtUSD(t.pnlUSD)}</td>
                      <td className="tw:py-2.5 tw:px-3 tw:font-mono-metric-md tw:text-on-surface-variant tw:text-[11px] tw:whitespace-nowrap">{fmtDate(t.createdAt)}</td>
                      <td className="tw:py-2.5 tw:px-3 tw:text-right tw:whitespace-nowrap">
                        <Link href={`/backtest/${t._id}`} className="tw:px-2 tw:py-1 tw:rounded tw:bg-surface-container-highest tw:hover:bg-surface-bright tw:border tw:border-outline-variant tw:text-on-surface tw:text-[11px] tw:font-label-action tw:transition-colors tw:inline-flex tw:items-center tw:gap-1">
                          <span>Review Case Study</span><Icon name="arrow_forward" className="tw:text-xs tw:text-primary" />
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="tw:px-3.5 tw:py-6 tw:text-center tw:text-body-sm tw:text-on-surface-variant">{loading ? 'Loading sessions…' : 'No simulated sessions yet — your completed backtests will be listed here.'}</p>
        )}
      </section>

      {/* 6. Footer links & status */}
      <footer className="tw:pt-1 tw:pb-4 tw:flex tw:flex-col tw:sm:flex-row tw:items-center tw:justify-between tw:gap-3 tw:text-xs tw:border-t tw:border-outline-variant/50 tw:text-on-surface-variant">
        <div className="tw:flex tw:flex-wrap tw:items-center tw:gap-3 tw:font-mono-metric-md tw:text-[11px]">
          <span className="tw:flex tw:items-center tw:gap-1.5"><span className={`tw:w-2 tw:h-2 tw:rounded-full ${draft ? 'tw:bg-secondary' : 'tw:bg-outline'}`} />{draft ? 'Session autosaved' : 'No session open'}</span>
          <span className="tw:text-outline-variant">|</span>
          <span>Hindsight Protection: Future candles locked</span>
          <span className="tw:text-outline-variant">|</span>
          <span>{trades.length} sessions logged</span>
        </div>
        <div className="tw:flex tw:flex-wrap tw:items-center tw:gap-4">
          <Link href="/backtest/log" className="tw:hover:text-primary tw:transition-colors tw:flex tw:items-center tw:gap-1 tw:font-label-action tw:text-label-action"><Icon name="receipt_long" className="tw:text-sm" /><span>Backtest Log Archive</span></Link>
          <Link href="/backtest/metrics" className="tw:hover:text-primary tw:transition-colors tw:flex tw:items-center tw:gap-1 tw:font-label-action tw:text-label-action"><Icon name="query_stats" className="tw:text-sm" /><span>Comprehensive Quant Metrics</span></Link>
          <button type="button" onClick={() => downloadLogCsv(trades)} disabled={!trades.length} className="tw:hover:text-primary tw:transition-colors tw:flex tw:items-center tw:gap-1 tw:font-label-action tw:text-label-action tw:disabled:opacity-40"><Icon name="cloud_download" className="tw:text-sm" /><span>Export CSV</span></button>
        </div>
      </footer>
    </div>
  );
}

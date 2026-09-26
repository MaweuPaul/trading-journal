'use client';
import Link from 'next/link';
import { FormEvent, useMemo, useState } from 'react';
import { Icon } from './BacktestShell';
import { fmtR, intervalLabel, tagsOf, useBacktest } from './data';
import { computeStats } from './stats';
import { ConfidenceLine } from '../Confidence';
import type { BacktestTrade, StrategyInfo } from './data';

/** Every version of a strategy's rules, newest first, with how each version's trades did. */
function RuleHistory({ info, trades }: { info: StrategyInfo; trades: BacktestTrade[] }) {
  const versions = [...(info.versions ?? [])].sort((a, b) => b.version - a.version);
  if (!versions.length) return null;
  return (
    <details className="tw:rounded tw:border tw:border-surface-container-highest tw:bg-surface-container-low tw:px-3 tw:py-2">
      <summary className="tw:cursor-pointer tw:text-body-sm tw:font-semibold tw:text-on-surface">Rules history ({versions.length} versions)</summary>
      <ol className="tw:mt-2 tw:flex tw:flex-col tw:gap-3">
        {versions.map(v => {
          const own = trades.filter(t => (t.strategyVersion ?? 1) === v.version);
          const s = own.length ? computeStats(own) : null;
          return (
            <li key={v.version} className="tw:flex tw:flex-col tw:gap-1">
              <div className="tw:flex tw:flex-wrap tw:items-center tw:gap-2 tw:text-body-sm">
                <span className="tw:font-mono-metric-md tw:font-bold tw:text-primary">v{v.version}</span>
                {v.createdAt && <span className="tw:text-outline tw:text-[11px]">{new Date(v.createdAt).toLocaleDateString()}</span>}
                <span className="tw:text-on-surface-variant tw:text-[11px]">{s ? `${s.n} backtests · ${s.winRate.toFixed(0)}% win · ${fmtR(s.avgR)}` : 'no backtests yet'}</span>
                {s && <ConfidenceLine confidence={s.confidence} />}
              </div>
              {v.change && <p className="tw:text-body-sm tw:text-on-surface"><span className="tw:font-semibold">What changed: </span>{v.change}</p>}
              <p className="tw:text-[12px] tw:leading-relaxed tw:text-on-surface-variant tw:whitespace-pre-wrap">{v.rules}</p>
              {v.holdoutSeenBefore && <p className="tw:text-[11px] tw:text-error">Written after held-out results were seen, so its held-out test isn&apos;t clean.</p>}
            </li>
          );
        })}
      </ol>
    </details>
  );
}
import { draftProgress, sessionIdFor, useSessions, clearDraft, WorkspaceDraft } from './session';

const card = 'tw:bg-surface-container tw:border tw:border-surface-container-highest tw:rounded-lg tw:p-4 tw:flex tw:flex-col tw:gap-3';
const btn = 'tw:px-3 tw:py-1.5 tw:rounded tw:text-label-action tw:font-medium tw:flex tw:items-center tw:gap-1.5 tw:transition-colors';
const input = 'tw:w-full tw:bg-surface-container-lowest tw:border tw:border-outline-variant tw:rounded tw:px-3 tw:py-2 tw:text-body-md tw:text-on-surface tw:focus:outline-none tw:focus:border-primary';

function SessionLine({ d }: { d: WorkspaceDraft }) {
  const p = draftProgress(d);
  return (
    <div className="tw:flex tw:flex-col tw:gap-1.5">
      <div className="tw:flex tw:items-center tw:justify-between tw:gap-2 tw:text-body-sm">
        <span className="tw:text-on-surface">
          <span className="tw:font-mono-metric-md tw:font-semibold">{d.symbol}</span> {intervalLabel(d.interval)} · {d.fromDate} → {d.toDate}
          {d.openTrade && <span className="tw:ml-1.5 tw:text-primary">· open trade</span>}
        </span>
        <span className="tw:text-outline tw:text-[11px]">saved {new Date(d.savedAt).toLocaleDateString()}</span>
      </div>
      {p.pct != null && (
        <div className="tw:flex tw:items-center tw:gap-2">
          <div className="tw:flex-1 tw:h-1.5 tw:rounded-full tw:bg-surface-container-highest tw:overflow-hidden">
            <div className="tw:h-full tw:bg-primary" style={{ width: `${p.pct}%` }} />
          </div>
          <span className="tw:text-[11px] tw:text-on-surface-variant tw:font-mono-metric-md">{Math.round(p.pct)}%{p.at ? ` · at ${p.at.toISOString().slice(0, 16).replace('T', ' ')}` : ''}</span>
        </div>
      )}
    </div>
  );
}

/** Every strategy with its results, and a one-click way to continue testing it. */
export default function StrategiesView() {
  const { trades, allTrades, strategies, strategyInfo, createStrategy, removeStrategy } = useBacktest();
  const sessions = useSessions();
  const [name, setName] = useState('');
  const [idea, setIdea] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const rows = useMemo(() => strategies.map(s => {
    const info = strategyInfo.find(i => i.name === s);
    const own = trades.filter(t => tagsOf(t).includes(s));
    return { name: s, info, own, stats: own.length ? computeStats(own) : null, session: sessions[sessionIdFor(s)] ?? null };
  }).sort((a, b) => (b.session?.savedAt ?? 0) - (a.session?.savedAt ?? 0) || a.name.localeCompare(b.name)), [strategies, strategyInfo, trades, sessions]);
  const untagged = sessions[sessionIdFor('')];

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError('');
    const res = await createStrategy(name, idea);
    setBusy(false);
    if (res.ok) { setName(''); setIdea(''); } else setError(res.error || 'Could not create the strategy');
  };
  const remove = async (label: string) => {
    // Every logged backtest carrying the tag, whichever runs view is selected.
    const tagged = allTrades.filter(t => tagsOf(t).includes(label)).length;
    const message = tagged
      ? `Delete the strategy "${label}"?\n\n${tagged} logged backtest${tagged === 1 ? ' is' : 's are'} tagged with it. The tag will be removed from ${tagged === 1 ? 'it' : 'them'}; the backtests themselves are kept.`
      : `Delete the strategy "${label}"?`;
    if (!window.confirm(message)) return;
    setError('');
    const res = await removeStrategy(label);
    if (!res.ok) { setError(res.error || 'Could not delete the strategy'); return; }
    clearDraft(sessionIdFor(label)); // its saved replay on this device
  };

  return (
    <div className="tw:flex-1 tw:bg-background tw:p-4 tw:sm:p-6 tw:flex tw:flex-col tw:gap-4">
      <div>
        <h1 className="tw:text-headline-md tw:font-semibold tw:text-on-surface">Strategies</h1>
        <p className="tw:text-body-sm tw:text-on-surface-variant tw:mt-1">Each strategy keeps its own replay session, so you can switch between them and pick up where you left off.</p>
      </div>

      <form onSubmit={e => void add(e)} className={`${card} tw:sm:flex-row tw:sm:items-end`}>
        <label className="tw:flex tw:flex-col tw:gap-1 tw:flex-1">
          <span className="tw:text-body-sm tw:font-semibold tw:text-on-surface">New strategy</span>
          <input value={name} maxLength={60} onChange={e => setName(e.target.value)} placeholder="e.g. London Breakout" className={input} />
        </label>
        <label className="tw:flex tw:flex-col tw:gap-1 tw:flex-[2]">
          <span className="tw:text-body-sm tw:text-on-surface-variant">The idea in one line (optional)</span>
          <input value={idea} maxLength={200} onChange={e => setIdea(e.target.value)} placeholder="Trade the break of the Asian range after 8am London" className={input} />
        </label>
        <button type="submit" disabled={busy || !name.trim()} className={`${btn} tw:bg-primary tw:text-on-primary tw:disabled:opacity-50 tw:justify-center`}>
          <Icon name="add" className="tw:text-[16px]" />Add
        </button>
      </form>
      {error && <p className="tw:text-error tw:text-body-sm">{error}</p>}

      {rows.length === 0 && !untagged && (
        <p className="tw:text-body-sm tw:text-on-surface-variant">No strategies yet — add one above, or pick “+ New strategy…” when starting a backtest.</p>
      )}

      <div className="tw:grid tw:grid-cols-1 tw:xl:grid-cols-2 tw:gap-3">
        {rows.map(r => (
          <section key={r.name} className={card} aria-label={r.name}>
            <div className="tw:flex tw:items-start tw:justify-between tw:gap-3">
              <div className="tw:min-w-0">
                <h2 className="tw:font-semibold tw:text-on-surface tw:truncate tw:flex tw:items-center tw:gap-2">
                  {r.name}
                  {!!r.info?.versions?.length && (
                    <span title={`Version ${r.info.versions[r.info.versions.length - 1].version} of this strategy's rules`} className="tw:shrink-0 tw:px-1.5 tw:py-0.5 tw:rounded tw:bg-primary-container/40 tw:text-primary tw:text-[10px] tw:font-bold tw:font-mono-metric-md">
                      v{r.info.versions[r.info.versions.length - 1].version}
                    </span>
                  )}
                </h2>
                {r.info?.description && <p className="tw:text-body-sm tw:text-on-surface-variant tw:mt-0.5">{r.info.description}</p>}
              </div>
              <button type="button" onClick={() => void remove(r.name)} title="Delete strategy" aria-label={`Delete ${r.name}`}
                className="tw:p-1 tw:rounded tw:text-on-surface-variant tw:hover:text-error tw:hover:bg-error/10"><Icon name="delete" className="tw:text-[18px]" /></button>
            </div>

            <div className="tw:grid tw:grid-cols-3 tw:gap-2 tw:text-center">
              {[
                ['Backtests', r.stats ? String(r.stats.n) : '0'],
                ['Win rate', r.stats ? `${r.stats.winRate.toFixed(0)}%` : '—'],
                ['Avg R', r.stats ? fmtR(r.stats.avgR) : '—'],
              ].map(([k, v]) => (
                <div key={k} className="tw:rounded tw:bg-surface-container-low tw:border tw:border-surface-container-highest tw:py-1.5">
                  <div className="tw:text-[10px] tw:uppercase tw:tracking-wider tw:text-on-surface-variant">{k}</div>
                  <div className="tw:font-mono-metric-md tw:font-semibold tw:text-on-surface">{v}</div>
                </div>
              ))}
            </div>

            {r.stats && <ConfidenceLine confidence={r.stats.confidence} range="winRate" />}

            {r.info && <RuleHistory info={r.info} trades={r.own} />}

            {r.session ? <SessionLine d={r.session} /> : <p className="tw:text-body-sm tw:text-outline">No replay in progress.</p>}

            <div className="tw:flex tw:flex-wrap tw:items-center tw:gap-2 tw:pt-1">
              {r.session && (
                <Link href={`/backtest/workspace?session=${encodeURIComponent(sessionIdFor(r.name))}`} className={`${btn} tw:bg-primary tw:text-on-primary`}>
                  <Icon name="play_arrow" className="tw:text-[16px]" />Continue
                </Link>
              )}
              <Link href={`/backtest/new?strategy=${encodeURIComponent(r.name)}`} className={`${btn} tw:border tw:border-outline-variant tw:text-on-surface tw:hover:bg-surface-container-high`}>
                <Icon name="add" className="tw:text-[16px]" />{r.session ? 'New session' : 'Start backtest'}
              </Link>
              {r.stats && (
                <Link href={`/backtest/metrics?strategy=${encodeURIComponent(r.name)}`} className={`${btn} tw:text-primary tw:hover:bg-primary/10`}>
                  <Icon name="insights" className="tw:text-[16px]" />Metrics
                </Link>
              )}
              {r.session && (
                <button type="button" onClick={() => { if (window.confirm(`Discard the saved ${r.name} replay? Logged backtests are not affected.`)) clearDraft(sessionIdFor(r.name)); }}
                  className={`${btn} tw:ml-auto tw:text-on-surface-variant tw:hover:text-error`}>Discard replay</button>
              )}
            </div>
          </section>
        ))}

        {untagged && (
          <section className={card} aria-label="No strategy">
            <h2 className="tw:font-semibold tw:text-on-surface">No strategy</h2>
            <SessionLine d={untagged} />
            <div className="tw:flex tw:items-center tw:gap-2">
              <Link href={`/backtest/workspace?session=${sessionIdFor('')}`} className={`${btn} tw:bg-primary tw:text-on-primary`}><Icon name="play_arrow" className="tw:text-[16px]" />Continue</Link>
              <button type="button" onClick={() => { if (window.confirm('Discard this saved replay?')) clearDraft(sessionIdFor('')); }}
                className={`${btn} tw:ml-auto tw:text-on-surface-variant tw:hover:text-error`}>Discard replay</button>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

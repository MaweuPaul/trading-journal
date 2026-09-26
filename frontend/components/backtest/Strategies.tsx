'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Icon } from './BacktestShell';
import NewStrategyModal from './NewStrategyModal';
import { fmtR, useBacktest } from './data';

export default function Strategies() {
  const router = useRouter();
  const { strategyInfo, setCurrentStrategy } = useBacktest();
  const [showNew, setShowNew] = useState(false);

  const openStrategy = (name: string) => {
    setCurrentStrategy(name);
    router.push('/backtest/workspace');
  };

  return (
    <div className="tw:flex tw:flex-col tw:w-full tw:p-gutter tw:gap-space-lg">
      <div className="tw:flex tw:items-center tw:justify-between tw:gap-space-sm">
        <div className="tw:flex tw:flex-col">
          <h1 className="tw:font-headline-md tw:text-headline-md tw:font-bold tw:text-on-surface tw:tracking-tight">Strategies</h1>
          <p className="tw:font-body-sm tw:text-body-sm tw:text-on-surface-variant">Pick one to continue backtesting, or create a new one.</p>
        </div>
        <button type="button" onClick={() => setShowNew(true)}
          className="tw:min-h-[44px] tw:px-space-md tw:flex tw:items-center tw:gap-space-xs tw:rounded tw:bg-primary-container tw:hover:bg-primary-fixed-dim tw:text-on-primary-container tw:font-label-action tw:text-label-action tw:font-semibold tw:shadow-md tw:active:scale-95 tw:transition-all tw:shrink-0">
          <Icon name="add_circle" className="tw:text-[18px]" />
          <span>New Strategy</span>
        </button>
      </div>

      {strategyInfo.length === 0 ? (
        <div className="tw:flex tw:flex-col tw:items-center tw:justify-center tw:gap-space-sm tw:text-center tw:py-space-xl tw:bg-surface-container-low tw:rounded-xl">
          <Icon name="rule" className="tw:text-[32px] tw:text-primary" />
          <h3 className="tw:font-headline-md tw:text-headline-md tw:text-on-surface">No strategies yet</h3>
          <p className="tw:font-body-sm tw:text-body-sm tw:text-on-surface-variant tw:max-w-sm">
            Create a strategy to name your setup once, then reuse it every time you backtest.
          </p>
          <button type="button" onClick={() => setShowNew(true)}
            className="tw:mt-space-xs tw:px-space-md tw:py-space-xs tw:rounded-full tw:bg-primary tw:text-on-primary tw:font-label-action tw:text-label-action">
            Create Strategy
          </button>
        </div>
      ) : (
        <div className="tw:grid tw:grid-cols-1 tw:sm:grid-cols-2 tw:lg:grid-cols-3 tw:gap-space-md">
          {strategyInfo.map(s => (
            <button key={s.name} type="button" onClick={() => openStrategy(s.name)}
              className="tw:flex tw:flex-col tw:gap-space-sm tw:text-left tw:p-space-md tw:bg-surface-container-low tw:hover:bg-surface-container tw:rounded-xl tw:shadow-sm tw:hover:shadow-md tw:transition-all tw:border tw:border-transparent tw:hover:border-primary/30">
              <div className="tw:flex tw:items-center tw:justify-between tw:gap-space-sm">
                <span className="tw:font-headline-md tw:text-headline-md tw:font-bold tw:text-on-surface tw:truncate">{s.name}</span>
                <Icon name="chevron_right" className="tw:text-[18px] tw:text-on-surface-variant tw:shrink-0" />
              </div>
              {s.description && (
                <p className="tw:font-body-sm tw:text-body-sm tw:text-on-surface-variant tw:line-clamp-2">{s.description}</p>
              )}
              <div className="tw:flex tw:items-center tw:gap-space-md tw:font-mono-metric-md tw:text-mono-metric-md tw:mt-space-xs">
                <div className="tw:flex tw:flex-col">
                  <span className="tw:text-on-surface tw:font-semibold">{s.trades}</span>
                  <span className="tw:font-label-caps tw:text-label-caps tw:text-on-surface-variant tw:uppercase">Trades</span>
                </div>
                <div className="tw:flex tw:flex-col">
                  <span className="tw:text-on-surface tw:font-semibold">{s.trades ? `${s.winRate.toFixed(0)}%` : '—'}</span>
                  <span className="tw:font-label-caps tw:text-label-caps tw:text-on-surface-variant tw:uppercase">Win Rate</span>
                </div>
                <div className="tw:flex tw:flex-col">
                  <span className={`tw:font-semibold ${s.trades === 0 ? 'tw:text-on-surface' : s.avgR >= 0 ? 'tw:text-secondary' : 'tw:text-error'}`}>{s.trades ? fmtR(s.avgR) : '—'}</span>
                  <span className="tw:font-label-caps tw:text-label-caps tw:text-on-surface-variant tw:uppercase">Avg R</span>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}

      {showNew && (
        <NewStrategyModal existing={strategyInfo} onClose={() => setShowNew(false)}
          onCreated={name => { setShowNew(false); openStrategy(name); }} />
      )}
    </div>
  );
}

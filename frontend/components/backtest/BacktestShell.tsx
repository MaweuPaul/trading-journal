'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { fmtUSD, useBacktest } from './data';

const TABS = [
  { key: 'workspace', label: 'Workspace', icon: 'query_stats', href: '/backtest/workspace' },
  { key: 'log', label: 'Log', icon: 'table_chart', href: '/backtest' },
  { key: 'metrics', label: 'Metrics', icon: 'analytics', href: '/backtest/metrics' },
] as const;
type TabKey = typeof TABS[number]['key'];

const SECTION_LABEL: Record<TabKey, string> = { workspace: 'Workspace', log: 'Log', metrics: 'Metrics' };

function activeTab(pathname: string): TabKey {
  if (pathname.startsWith('/backtest/metrics')) return 'metrics';
  if (pathname.startsWith('/backtest/workspace')) return 'workspace';
  return 'log';
}

export function Icon({ name, className = '' }: { name: string; className?: string }) {
  return <span aria-hidden="true" className={`material-symbols-outlined ${className}`}>{name}</span>;
}

export default function BacktestShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const tab = activeTab(pathname);
  const { simBalance, activeSymbol } = useBacktest();
  const [initials, setInitials] = useState('');

  useEffect(() => {
    try {
      const user = JSON.parse(localStorage.getItem('user') || '{}') as { name?: string; email?: string };
      const source = (user.name || user.email || '').trim();
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time read of the signed-in user
      setInitials(source.split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map(p => p[0]!.toUpperCase()).join(''));
    } catch { /* no stored user */ }
  }, []);

  // Header and tab bar are position:fixed (as in the design). Sticky can't be
  // used: globals.css gives both html and body overflow, which makes body a
  // non-scrolling scroll container. Offsets clear the app's 240px sidebar on
  // desktop and its 58px top bar on mobile.
  return (
    <div className="bt-shell tw:flex tw:flex-col tw:min-h-dvh tw:pt-14 tw:pb-16">
      <header className="tw:fixed tw:top-0 tw:right-0 tw:left-[240px] tw:max-[900px]:left-0 tw:max-[900px]:top-[58px] tw:z-40 tw:bg-surface-container-lowest/90 tw:backdrop-blur-xl tw:shadow-[0_1px_8px_rgba(0,0,0,0.4)]">
        <div className="tw:h-14 tw:px-gutter tw:flex tw:items-center tw:justify-between tw:gap-space-sm">
          <div className="tw:flex tw:items-center tw:gap-space-sm tw:min-w-0">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img alt="TradeJournal" className="tw:h-8 tw:w-auto tw:object-contain tw:rounded-lg" src="/backtest-logo.png" />
            <div className="tw:flex tw:flex-col tw:min-w-0">
              <div className="tw:flex tw:items-center tw:gap-space-xs tw:min-w-0">
                <span className="tw:font-headline-md tw:text-headline-md tw:font-bold tw:tracking-tight tw:text-on-surface tw:truncate">TradeJournal</span>
                <span className="tw:font-label-caps tw:text-label-caps tw:text-on-surface-variant tw:uppercase tw:hidden tw:sm:inline-block">Backtest</span>
              </div>
              <div className="tw:flex tw:items-center tw:gap-space-xs tw:min-w-0">
                <span className="tw:font-label-caps tw:text-label-caps tw:text-primary tw:uppercase tw:whitespace-nowrap">{SECTION_LABEL[tab]}</span>
                <span className="tw:text-on-surface-variant tw:font-body-sm tw:text-body-sm">•</span>
                <span className="tw:font-mono-metric-md tw:text-mono-metric-md tw:text-on-surface tw:font-bold tw:bg-surface-container-high tw:px-space-xs tw:py-0.5 tw:rounded tw:truncate">{activeSymbol}</span>
              </div>
            </div>
          </div>
          <div className="tw:flex tw:items-center tw:gap-space-sm tw:shrink-0">
            <div className="tw:flex tw:flex-col tw:items-end tw:text-right">
              <span className="tw:font-label-caps tw:text-label-caps tw:text-on-surface-variant tw:uppercase">Sim Balance</span>
              <span className={`tw:font-mono-metric-md tw:text-mono-metric-md tw:font-semibold ${simBalance >= 100_000 ? 'tw:text-secondary' : 'tw:text-error'}`}>{fmtUSD(simBalance, false)}</span>
            </div>
            <div className="tw:flex tw:items-center tw:bg-surface-container-high tw:rounded tw:p-0.5 tw:gap-space-xs">
              <span className="tw:min-h-[40px] tw:min-w-[36px] tw:sm:min-h-[44px] tw:sm:min-w-[44px] tw:flex tw:items-center tw:justify-center tw:rounded tw:px-space-xs tw:bg-primary-container tw:text-on-primary-container" title="Backtest mode (active)">
                <Icon name="replay" className="tw:text-[18px]" />
              </span>
              <Link href="/pretrade" className="tw:min-h-[40px] tw:min-w-[36px] tw:sm:min-h-[44px] tw:sm:min-w-[44px] tw:flex tw:items-center tw:justify-center tw:rounded tw:px-space-xs tw:text-on-surface-variant tw:hover:text-on-surface" title="Live chart (Pre-Trade Analysis)">
                <Icon name="candlestick_chart" className="tw:text-[18px]" />
              </Link>
            </div>
            <Link href="/accounts" className="tw:w-8 tw:h-8 tw:rounded-full tw:bg-primary tw:flex tw:items-center tw:justify-center tw:flex-shrink-0 tw:text-on-primary tw:font-label-caps tw:text-label-caps" title="Account">
              {initials || <Icon name="person" className="tw:text-[18px]" />}
            </Link>
          </div>
        </div>
      </header>

      <main className="tw:flex tw:flex-col tw:flex-1 tw:relative tw:w-full tw:bg-surface tw:pb-2">{children}</main>

      <nav className="tw:fixed tw:bottom-0 tw:right-0 tw:left-[240px] tw:max-[900px]:left-0 tw:z-40 tw:bg-surface-container-lowest/95 tw:backdrop-blur-xl tw:shadow-[0_-1px_12px_rgba(0,0,0,0.5)]" aria-label="Backtest sections">
        <div className="tw:flex tw:justify-around tw:items-center tw:h-16 tw:px-gutter">
          {TABS.map(t => (
            <Link key={t.key} href={t.href} aria-current={tab === t.key ? 'page' : undefined}
              className={`tw:flex tw:flex-col tw:items-center tw:justify-center tw:min-w-[64px] tw:min-h-[44px] tw:py-1 tw:px-space-md tw:rounded tw:transition-colors ${tab === t.key ? 'tw:text-primary tw:bg-surface-container-high' : 'tw:text-on-surface-variant tw:hover:text-on-surface'}`}>
              <Icon name={t.icon} className="tw:text-[20px]" />
              <span className="tw:font-label-action tw:text-label-action tw:mt-0.5">{t.label}</span>
            </Link>
          ))}
        </div>
      </nav>
    </div>
  );
}

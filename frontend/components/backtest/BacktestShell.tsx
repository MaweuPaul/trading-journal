'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { AgentRunsToggle } from './AgentRuns';
import { intervalLabel, useBacktest } from './data';
import { useActiveSession } from './session';

const TABS = [
  { key: 'overview', label: 'Overview', icon: 'space_dashboard', href: '/backtest' },
  { key: 'new', label: 'New', desktopLabel: 'New Backtest', icon: 'add_circle', href: '/backtest/new' },
  { key: 'workspace', label: 'Active', desktopLabel: 'Active Session', icon: 'query_stats', href: '/backtest/workspace' },
  { key: 'strategies', label: 'Strategies', icon: 'rule', href: '/backtest/strategies' },
  { key: 'log', label: 'Log', desktopLabel: 'Backtest Log', icon: 'table_chart', href: '/backtest/log' },
  { key: 'metrics', label: 'Metrics', icon: 'analytics', href: '/backtest/metrics' },
] as const;
type TabKey = typeof TABS[number]['key'];

const SECTION_LABEL: Record<TabKey, string> = { overview: 'Overview', new: 'New Backtest', workspace: 'Active Session', strategies: 'Strategies', log: 'Log', metrics: 'Metrics' };

function activeTab(pathname: string): TabKey {
  if (pathname.startsWith('/backtest/metrics')) return 'metrics';
  if (pathname.startsWith('/backtest/new')) return 'new';
  if (pathname.startsWith('/backtest/workspace')) return 'workspace';
  if (pathname.startsWith('/backtest/strategies')) return 'strategies';
  if (pathname.startsWith('/backtest/log') || (/^\/backtest\/[^/]+$/.test(pathname) && pathname !== '/backtest')) return 'log';
  return 'overview';
}

function sectionLabel(pathname: string, tab: TabKey): string {
  if (pathname.startsWith('/backtest/strategies')) return 'Strategies';
  return SECTION_LABEL[tab];
}

export function Icon({ name, className = '' }: { name: string; className?: string }) {
  return <span aria-hidden="true" className={`material-symbols-outlined ${className}`}>{name}</span>;
}

export default function BacktestShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const tab = activeTab(pathname);
  const { activeSymbol, currentStrategy } = useBacktest();
  const session = useActiveSession();

  // Headers and the mobile tab bar are position:fixed (as in the design).
  // Sticky can't be used: globals.css gives both html and body overflow,
  // which makes body a non-scrolling scroll container. Offsets clear the
  // app's sidebar (240px, or 68px collapsed: --sidebar-w) at >=900px and its 58px top bar below that.
  return (
    <div className="bt-shell tw:flex tw:flex-col tw:min-h-dvh tw:pt-[114px] tw:pb-16 tw:min-[900px]:pt-11 tw:min-[900px]:pb-0">
      {/* Desktop: terminal top bar with the section tabs */}
      <header className="tw:hidden tw:min-[900px]:flex tw:fixed tw:top-0 tw:right-0 tw:left-[var(--sidebar-w)] tw:z-40 tw:justify-between tw:items-center tw:gap-3 tw:px-4 tw:h-11 tw:bg-surface-container tw:border-b tw:border-outline-variant tw:select-none">
        <div className="tw:flex tw:items-center tw:gap-3 tw:shrink-0">
          <span className="tw:text-body-md tw:font-semibold tw:text-on-surface">Backtest</span>
        </div>
        <nav className="tw:flex tw:items-center tw:gap-1 tw:h-full tw:min-w-0" aria-label="Backtest sections">
          {TABS.map(t => {
            const active = tab === t.key;
            return (
              <Link key={t.key} href={t.href} aria-current={active ? 'page' : undefined}
                className={`tw:font-label-action tw:text-label-action tw:px-2 tw:min-[1280px]:px-3 tw:flex tw:items-center tw:gap-1.5 tw:h-full tw:whitespace-nowrap tw:transition-colors tw:border-b-2 ${active ? 'tw:border-primary tw:text-primary' : 'tw:border-transparent tw:text-on-surface-variant tw:hover:text-on-surface'}`}>
                <span>{'desktopLabel' in t ? t.desktopLabel : t.label}</span>
                {t.key === 'workspace' && session && (
                  <span className="tw:hidden tw:min-[1500px]:flex tw:items-center tw:gap-1 tw:px-1.5 tw:py-0.5 tw:rounded tw:bg-surface-container-highest tw:border tw:border-outline-variant tw:text-[10px] tw:font-mono-metric-md tw:text-primary">
                    <span className="tw:w-1.5 tw:h-1.5 tw:rounded-full tw:bg-primary-container tw:animate-ping tw:inline-block" />
                    <span>{session.symbol} {intervalLabel(session.interval)} In Progress</span>
                  </span>
                )}
              </Link>
            );
          })}
        </nav>
        {/* Agent-runs view when agents have logged anything; otherwise balances the title so the tabs stay centred. */}
        <div className="tw:shrink-0 tw:min-w-16 tw:flex tw:justify-end"><AgentRunsToggle /></div>
      </header>

      {/* Mobile: compact header */}
      <header className="tw:min-[900px]:hidden tw:fixed tw:top-[58px] tw:right-0 tw:left-0 tw:z-40 tw:bg-surface-container-lowest/90 tw:backdrop-blur-xl tw:shadow-[0_1px_8px_rgba(0,0,0,0.4)]">
        <div className="tw:h-14 tw:px-gutter tw:flex tw:items-center tw:justify-between tw:gap-space-sm">
          <div className="tw:flex tw:items-center tw:gap-space-sm tw:min-w-0">
            <div className="tw:flex tw:flex-col tw:min-w-0">
              <span className="tw:text-body-md tw:font-semibold tw:text-on-surface">Backtest</span>
              <div className="tw:flex tw:items-center tw:gap-space-xs tw:min-w-0">
                <span className="tw:font-label-caps tw:text-label-caps tw:text-primary tw:uppercase tw:whitespace-nowrap">{sectionLabel(pathname, tab)}</span>
                <span className="tw:text-on-surface-variant tw:font-body-sm tw:text-body-sm">•</span>
                <span className="tw:font-mono-metric-md tw:text-mono-metric-md tw:text-on-surface tw:font-bold tw:bg-surface-container-high tw:px-space-xs tw:py-0.5 tw:rounded tw:truncate">{activeSymbol}</span>
                {tab === 'workspace' && currentStrategy && (
                  <>
                    <span className="tw:text-on-surface-variant tw:font-body-sm tw:text-body-sm">•</span>
                    <span className="tw:font-label-action tw:text-label-action tw:text-primary tw:bg-primary-container/40 tw:px-space-xs tw:py-0.5 tw:rounded tw:truncate" title="Active strategy">{currentStrategy}</span>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      </header>

      <main className="tw:flex tw:flex-col tw:flex-1 tw:relative tw:w-full tw:bg-surface tw:pb-2 tw:min-[900px]:pb-0">{children}</main>

      {/* Mobile: bottom tab bar */}
      <nav className="tw:min-[900px]:hidden tw:fixed tw:bottom-0 tw:right-0 tw:left-0 tw:z-40 tw:bg-surface-container-lowest/95 tw:backdrop-blur-xl tw:shadow-[0_-1px_12px_rgba(0,0,0,0.5)]" aria-label="Backtest sections">
        <div className="tw:flex tw:justify-around tw:items-center tw:h-16 tw:px-gutter tw:overflow-x-auto">
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

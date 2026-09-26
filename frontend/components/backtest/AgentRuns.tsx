'use client';
import { AgentRunsView, BacktestTrade, useBacktest } from './data';

// Not BacktestShell's Icon: the shell imports this file, so that would be circular.
function Icon({ name, className = '' }: { name: string; className?: string }) {
  return <span aria-hidden="true" className={`material-symbols-outlined ${className}`}>{name}</span>;
}

/** Marks a backtest logged by an AI agent over MCP (blind = dates/prices were hidden from it). */
export function AgentBadge({ trade, className = '' }: { trade: Pick<BacktestTrade, 'source' | 'blind'>; className?: string }) {
  if (trade.source !== 'agent') return null;
  return (
    <span title={trade.blind ? 'Logged by an AI agent that could not see the real dates or prices' : 'Logged by an AI agent through the MCP backtest tools'}
      className={`tw:inline-flex tw:items-center tw:gap-0.5 tw:shrink-0 tw:px-1.5 tw:py-0.5 tw:rounded tw:border tw:border-outline tw:bg-surface-container-highest tw:text-on-surface tw:font-label-caps tw:text-label-caps tw:font-bold tw:whitespace-nowrap ${className}`}>
      <Icon name="smart_toy" className="tw:text-[12px]" />AGENT{trade.blind ? ' · BLIND' : ''}
    </span>
  );
}

const OPTIONS: [AgentRunsView, string][] = [['mine', 'Mine'], ['agent', 'Agent'], ['all', 'All']];

/**
 * Which backtests every Backtest view counts: your own (the default), the ones
 * AI agents logged, or both. Agent runs never mix into your numbers unless
 * you ask for it. Hidden until an agent has logged something.
 */
export function AgentRunsToggle({ size = 'sm' }: { size?: 'sm' | 'lg' }) {
  const { agentRuns, setAgentRuns, agentTradeCount } = useBacktest();
  if (!agentTradeCount && agentRuns === 'mine') return null;
  const h = size === 'lg' ? 'tw:min-h-[44px] tw:px-space-md' : 'tw:py-1 tw:px-2';
  return (
    <div role="radiogroup" aria-label="Which backtests to show" title="Agent runs are kept out of your stats unless you choose Agent or All"
      className="tw:flex tw:items-center tw:rounded tw:border tw:border-outline-variant tw:bg-surface-container-high tw:overflow-hidden tw:text-body-sm tw:font-label-action">
      <span className="tw:hidden tw:min-[1100px]:flex tw:items-center tw:pl-2 tw:pr-1 tw:text-on-surface-variant"><Icon name="smart_toy" className="tw:text-sm" /></span>
      {OPTIONS.map(([value, label]) => (
        <button key={value} type="button" role="radio" aria-checked={agentRuns === value} onClick={() => setAgentRuns(value)}
          className={`${h} tw:transition-colors ${agentRuns === value ? 'tw:bg-primary-container/40 tw:text-primary' : 'tw:text-on-surface-variant tw:hover:text-on-surface'}`}>
          {label}{value === 'agent' ? ` (${agentTradeCount})` : ''}
        </button>
      ))}
    </div>
  );
}

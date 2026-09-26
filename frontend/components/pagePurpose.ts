// The one question each main page answers, so it's clear where to look after
// a trading session. Used by the sidebar tooltips, the page headers and the
// Dashboard's "After a session" guide.

export interface PagePurpose { question: string; detail: string }

export const PAGE_PURPOSE: Record<string, PagePurpose> = {
  '/': { question: 'What happened?', detail: 'Balance, results and equity for the period at a glance.' },
  '/trades': { question: 'What did I do on each trade?', detail: 'Journal every trade: plan answers, screenshots, grades and notes.' },
  '/calendar': { question: 'Which days made or lost money?', detail: 'Daily P&L on a month grid.' },
  '/stats': { question: 'Where does my edge come from?', detail: 'Results split by session, direction, grade, mindset, tag and instrument.' },
  '/performance': { question: 'How much risk am I taking?', detail: 'Equity curve, drawdown and risk-adjusted results.' },
  '/coach': { question: 'What am I doing wrong?', detail: 'Rule-by-rule evidence of where your execution helps or hurts your results.' },
  '/backtest': { question: 'Does the strategy work historically?', detail: 'Replay past markets and measure a setup before risking money on it.' },
  '/rules': { question: 'What exactly is my strategy?', detail: 'Versioned rules every trade is measured against.' },
  '/knowledge': { question: 'What have I learned?', detail: 'Notes that aren’t tied to a single trade.' },
};

/** The review routine after a trading session, in order. */
export const AFTER_SESSION: { href: string; label: string }[] = [
  { href: '/trades', label: 'Journal new trades' },
  { href: '/', label: 'See what happened' },
  { href: '/coach', label: 'Find what went wrong' },
  { href: '/stats', label: 'See where the edge is' },
  { href: '/backtest', label: 'Test a fix' },
];

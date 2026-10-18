'use client';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { BookMarked, Download } from 'lucide-react';
import ThemeToggle from '@/components/ThemeToggle';
import type { ReactNode } from 'react';

interface Section { id: string; num: string; route?: string; group?: string; title: string; }

const SECTIONS: Section[] = [
  { id: 'getting-started', num: '00', title: 'Getting started' },
  { id: 'dashboard', num: '01', route: '/', group: 'Journal', title: 'Dashboard' },
  { id: 'trades', num: '02', route: '/trades', group: 'Journal', title: 'Trades' },
  { id: 'calendar', num: '03', route: '/calendar', group: 'Journal', title: 'Calendar' },
  { id: 'analytics', num: '04', route: '/stats', group: 'Analysis', title: 'Analytics' },
  { id: 'performance', num: '05', route: '/performance', group: 'Analysis', title: 'Performance' },
  { id: 'edge-coach', num: '06', route: '/coach', group: 'Analysis', title: 'Edge Coach' },
  { id: 'playbooks', num: '07', route: '/rules', group: 'Strategy', title: 'Playbooks' },
  { id: 'pretrade', num: '08', route: '/pretrade', group: 'Strategy', title: 'Pre-Trade Analysis' },
  { id: 'knowledge', num: '09', route: '/knowledge', group: 'Strategy', title: 'Knowledge Base' },
  { id: 'backtest', num: '10', route: '/backtest', group: 'Strategy', title: 'Backtest' },
  { id: 'ai-agents', num: '11', route: '/api/mcp', group: 'Strategy', title: 'AI agents (experimental)' },
  { id: 'accounts', num: '12', route: '/accounts', group: 'Account & data', title: 'Accounts & syncing' },
  { id: 'backup', num: '13', route: '/archive', group: 'Account & data', title: 'Backup & export' },
  { id: 'investor', num: '14', route: '/investor', group: 'Account & data', title: 'Investor mode' },
  { id: 'glossary', num: '—', title: 'Glossary' },
];

function Callout({ icon, warn, children }: { icon: string; warn?: boolean; children: ReactNode }) {
  return (
    <div className={`manual-callout${warn ? ' warn' : ''}`}>
      <span className="icon">{icon}</span>
      <p>{children}</p>
    </div>
  );
}
function KvGrid({ items }: { items: { label: string; value: string }[] }) {
  return (
    <div className="manual-kv-grid">
      {items.map(item => (
        <div className="manual-kv-card" key={item.label}>
          <div className="label">{item.label}</div>
          <div className="value">{item.value}</div>
        </div>
      ))}
    </div>
  );
}
function Pills({ items }: { items: string[] }) {
  return (
    <div className="manual-pill-row">
      {items.map(item => <span className="manual-pill" key={item}>{item}</span>)}
    </div>
  );
}
function Code({ children }: { children: string }) {
  return <pre className="manual-code"><code>{children}</code></pre>;
}

// The manual is served by the same site the MCP endpoint lives on, so the
// snippets show this installation's real address.
const noSubscribe = () => () => {};
function useSignedIn() {
  return useSyncExternalStore(noSubscribe, () => Boolean(localStorage.getItem('token')), () => true);
}
function useMcpUrl() {
  return useSyncExternalStore(noSubscribe, () => `${window.location.origin}/api/mcp`, () => 'https://YOUR-JOURNAL-ADDRESS/api/mcp');
}
const claudeCodeCmd = (url: string) => `claude mcp add --transport http tradejournal \\
  ${url} \\
  --header "Authorization: Bearer tjk_YOUR_KEY"`;
const desktopConfig = (url: string) => `{
  "mcpServers": {
    "tradejournal": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "${url}",
        "--transport",
        "http-only",${url.startsWith('http://') ? `
        "--allow-http",` : ''}
        "--header",
        "Authorization:\${TJ_AUTH}"
      ],
      "env": {
        "TJ_AUTH": "Bearer tjk_YOUR_KEY"
      }
    }
  }
}`;
const agentHeaders = (url: string) => `POST ${url}
Authorization: Bearer tjk_YOUR_KEY
Content-Type: application/json
Accept: application/json, text/event-stream`;
const FIRST_PROMPT = `List my backtest strategies. Start a blind 15-minute session on XAUUSD
for the Breakout strategy, trade it strictly by the strategy's description,
log every trade with notes explaining the setup, and show me the metrics
at the end.`;

function Chapter({ id, num, route, title, purpose, children }: { id: string; num: string; route?: string; title: string; purpose: string; children: ReactNode }) {
  return (
    <section className="manual-chapter" id={id}>
      <div className="manual-chapter-kicker">
        <span className="manual-chapter-num">{num}</span>
        {route && <span className="manual-chapter-route">{route}</span>}
      </div>
      <h2>{title}</h2>
      <p className="manual-chapter-purpose">{purpose}</p>
      {children}
    </section>
  );
}

export default function ManualPage() {
  const mcpUrl = useMcpUrl();
  const signedIn = useSignedIn();
  const [active, setActive] = useState('getting-started');
  const observerRef = useRef<IntersectionObserver | null>(null);

  useEffect(() => {
    const targets = SECTIONS.map(s => document.getElementById(s.id)).filter(Boolean) as HTMLElement[];
    if (!targets.length) return;
    observerRef.current = new IntersectionObserver(entries => {
      const visible = entries.filter(e => e.isIntersecting);
      if (visible.length) {
        visible.sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        setActive(visible[0].target.id);
      }
    }, { rootMargin: '-15% 0px -70% 0px', threshold: [0, 1] });
    targets.forEach(t => observerRef.current?.observe(t));
    return () => observerRef.current?.disconnect();
  }, []);

  const jump = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const groups = Array.from(new Set(SECTIONS.map(s => s.group).filter(Boolean))) as string[];

  return (
    <main className={`page-content manual-page${signedIn ? '' : ' public'}`}>
      {!signedIn && (
        <div className="manual-public-bar">
          <span>You&apos;re reading the TradeJournal manual.</span>
          <span className="links"><Link href="/login">Sign in</Link><span>·</span><Link href="/signup">Create an account</Link></span>
          <ThemeToggle className="manual-public-theme" />
        </div>
      )}
      <header className="page-header">
        <div className="page-header-inner">
          <div>
            <h2><BookMarked size={22} style={{ verticalAlign: 'middle', marginRight: 8 }} />Manual</h2>
            <p>A complete walkthrough of every page and feature in TradeJournal.</p>
          </div>
          <a className="btn-primary" href="/manual/TradeJournal-Manual.pdf" download>
            <Download size={15} /> Download PDF
          </a>
        </div>
      </header>

      <div className="manual-shell">
        <nav className="manual-toc" aria-label="Manual contents">
          <div className="manual-toc-group">
            <button type="button" className={`manual-toc-link${active === 'getting-started' ? ' active' : ''}`} onClick={() => jump('getting-started')}>
              <span className="n">00</span> Getting started
            </button>
          </div>
          {groups.map(group => (
            <div className="manual-toc-group" key={group}>
              <div className="manual-toc-label">{group}</div>
              {SECTIONS.filter(s => s.group === group).map(s => (
                <button type="button" key={s.id} className={`manual-toc-link${active === s.id ? ' active' : ''}`} onClick={() => jump(s.id)}>
                  <span className="n">{s.num}</span> {s.title}
                </button>
              ))}
            </div>
          ))}
          <div className="manual-toc-group">
            <button type="button" className={`manual-toc-link${active === 'glossary' ? ' active' : ''}`} onClick={() => jump('glossary')}>
              <span className="n">—</span> Glossary
            </button>
          </div>
        </nav>

        <div className="manual-content">
          <div className="manual-intro">
            <span className="manual-eyebrow">Reference guide</span>
            <h1>Everything TradeJournal does, page by page.</h1>
            <p className="lede">TradeJournal syncs your closed trades from MT5 or cTrader, then helps you turn that history into an edge — through statistics, a chart-annotated pre-trade checklist, and a coach that looks for the psychological patterns behind your P&amp;L.</p>
            <div className="manual-intro-stack">
              <div className="item"><b>15</b> sections</div>
              <div className="item"><b>MT5 + cTrader</b> data sources</div>
              <div className="item"><b>Owner &amp; investor</b> access levels</div>
            </div>
          </div>

          <Chapter id="getting-started" num="00" title="Getting started" purpose="The shortest path from a fresh account to seeing your first synced trade on the Dashboard.">
            <aside className="manual-manifesto" aria-labelledby="you-vs-you">
              <span className="manual-manifesto-eyebrow">Read this first</span>
              <h3 id="you-vs-you">You vs. You</h3>
              <p className="manual-manifesto-lead">This app won&apos;t make you profitable. Nothing will, except you.</p>
              <p>Your broker already knows your trades. What it doesn&apos;t know is why you took them, why you closed early, or why you doubled your size after that loss. Only you know that. If you don&apos;t write it down, this journal is just an expensive P&amp;L statement.</p>
              <p>Every blank field is a question you avoided. Skip the grades, the emotions, the exit reasons, and Edge Coach stays empty. Not because it&apos;s broken, but because you gave it nothing to work with.</p>
              <p>Here&apos;s the uncomfortable part. The trades you least want to log are the ones that matter most: the revenge trade, the FOMO entry, the stop you moved &quot;just this once.&quot; If your journal only records your good days, you&apos;re not journaling. You&apos;re keeping a highlight reel, and it will lie to you exactly the way you want it to.</p>
              <p>There&apos;s no leaderboard here. No one to beat, no one to impress. Just you this month against you last month. Either the same mistakes are shrinking, or they aren&apos;t. The numbers will tell you which, if you let them.</p>
              <div className="manual-manifesto-sub">The minimum. Not optional.</div>
              <ul className="manual-manifesto-list">
                <li><b>Every trade:</b> analysis grade, execution grade, emotion, exit reason. Especially the losers.</li>
                <li><b>Before every serious setup:</b> a Pre-Trade Analysis. If you can&apos;t be bothered to plan it, don&apos;t take it.</li>
                <li><b>Every week:</b> open Edge Coach, find your worst habit, and fix that one thing.</li>
              </ul>
              <p className="manual-manifesto-close"><strong>Log it honestly. Anything less, and you&apos;re only fooling yourself.</strong></p>
            </aside>
            <div className="manual-sub">How trades get in</div>
            <ul className="manual-feature-list">
              <li><b>MT5</b> — via the free <b>Desktop Sync App</b>, a small Windows program that logs into your MT5 terminal in the background and pushes closed trades to your journal. It never places trades; it only reads history. On Linux, a setup script does the same job (beta, see Accounts &amp; syncing).</li>
              <li><b>cTrader</b> — via an official OAuth connection. You approve access on cTrader&apos;s own site, and the journal pulls trade history, balances, and candlestick data directly from cTrader&apos;s API — no desktop app needed. Trade Replay, AI backtesting, and the Pre-Trade chart use cTrader candles, even when your trade history comes from MT5.</li>
              <li><b>MT5 statement import</b> — for MT5 on a Mac, or without the Windows app. Save a report in MT5 (History → right-click → Report → HTML) and upload it on the Trades page. Import again whenever you want newer trades; the ones already in your journal are skipped.</li>
            </ul>
            <div className="manual-sub">First-time setup</div>
            <ol className="manual-steps">
              <li><b>Create your account</b><span className="d">Sign up with your name, email, and a password (8+ characters). You&apos;re taken straight to the Dashboard.</span></li>
              <li><b>Connect a broker account</b><span className="d">Open Accounts in the sidebar and either add an MT5 login (you&apos;ll need its investor/read-only password) or connect cTrader through the OAuth button.</span></li>
              <li><b>Start syncing</b><span className="d">For MT5: generate your personal sync key, install the Desktop Sync App, paste the key in, and click Start Sync. For cTrader: click Sync Now whenever you want fresh trades.</span></li>
              <li><b>Watch the Dashboard fill in</b><span className="d">Balance, win rate, and the equity curve populate automatically once trades arrive. Everything else — journaling, playbooks, analytics — builds on top of that history.</span></li>
            </ol>
            <Callout icon="Tip">Want a coach fast? On Trades, Export for AI turns your current filters into one Markdown brief. Copy or download it and paste it into any AI chat. No connector, key or setup needed.</Callout>
            <Callout icon="Good to know">Trades themselves are <b>read-only</b> everywhere in the app — TradeJournal never edits your price, lot size, or P&amp;L. What you add on top (notes, grades, playbook answers, screenshots, tags) is the &quot;journal&quot; part.</Callout>
          </Chapter>

          <Chapter id="dashboard" num="01" route="/" title="Dashboard" purpose="A live, auto-refreshing overview of account health — balance, edge metrics, cash flow, and the equity curve.">
            <div className="manual-sub">Key metrics</div>
            <KvGrid items={[
              { label: 'Account balance', value: 'Live from MT5/cTrader' },
              { label: 'Win rate', value: '+ avg win / avg loss' },
              { label: 'Expectancy', value: '$ per trade' },
              { label: 'Avg R', value: 'Trades with a recorded stop' },
              { label: 'Streaks', value: 'Current win / loss run' },
              { label: 'Drawdown', value: 'Current vs. max' },
              { label: 'Profit factor', value: 'Gross profit ÷ gross loss' },
            ]} />
            <div className="manual-sub">Controls</div>
            <ul className="manual-feature-list">
              <li><b>Time range</b> <span className="muted">— All Time, Today, 7/30 Days, 3/6 Months.</span></li>
              <li><b>View: Tickets vs. Setups</b> <span className="muted">— Setups rolls re-entry trades up under their original parent, so a scaled-in position counts as one setup instead of three separate tickets.</span></li>
              <li><b>Account selector</b> <span className="muted">— appears once you&apos;ve connected more than one broker account; scopes every number on the page to just that account.</span></li>
            </ul>
            <div className="manual-sub">Cash flow &amp; equity curve</div>
            <ul className="manual-feature-list">
              <li>A running total of <b>Deposits</b>, <b>Withdrawals</b>, and <b>Net Cash Flow</b> for the selected range, with Deposit / Withdrawal buttons for logging manual cash movements. Manually-logged entries can be deleted; entries synced from your broker cannot.</li>
              <li>The <b>Equity Curve</b> plots balance over time — hover any point for that day&apos;s exact balance and P&amp;L.</li>
            </ul>
            <div className="manual-sub">Maintenance tools</div>
            <ul className="manual-feature-list">
              <li><b>Resync</b> <span className="muted">— requests a fresh pull from your broker (the Desktop Sync App or cTrader connection needs to be active).</span></li>
            </ul>
            <Callout icon="Tip">A warning banner appears whenever the numbers on screen are blending more than one broker account — balance and drawdown aren&apos;t meaningful mixed together, so switch to the account selector when you see it.</Callout>
          </Chapter>

          <Chapter id="trades" num="02" route="/trades" title="Trades" purpose="Your full trade log — and the place where journaling, playbook answers, and screenshots actually get attached to each trade.">
            <div className="manual-sub">Finding trades</div>
            <ul className="manual-feature-list">
              <li>Filter by <b>Symbol</b>, <b>Direction</b>, <b>Account type</b> (Live/Demo), <b>Trading account</b>, and a date range — filters are saved in the URL, so a filtered view can be bookmarked or shared.</li>
              <li><b>Group by session</b> clusters trades under Tokyo / London / London–NY Overlap / New York / Pacific headers, each with its own trade count, net P&amp;L, and win rate.</li>
              <li>Re-entries appear nested under their parent trade (indented, tagged &quot;RE-ENT of #ticket&quot;); trades sharing a position get a colored stripe down the left edge.</li>
              <li><b>Add Trade</b> <span className="muted">— for a fill your broker never recorded. Type in symbol, direction, entry/exit price, lot size, P&amp;L, and open/close time; it&apos;s saved as a real trade (running balance chained off the trade before it) and tagged &quot;MANUAL&quot; in the symbol column so it&apos;s never confused with a synced one.</span></li>
              <li><b>Import MT5 statement</b> <span className="muted">— upload a report saved from MT5 (History → right-click → Custom Period, then Report → HTML). It shows how many trades are new before adding anything, matches the report to your account by its number (or creates an import account), and brings in deposits and withdrawals too. Each position becomes one trade, even if you closed it in parts; stop loss and take profit are the levels at close.</span></li>
            </ul>
            <div className="manual-sub">The Journal Drawer</div>
            <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 10 }}>Click any row to open it. This is where a closed trade turns into a journaled one.</p>
            <ul className="manual-feature-list">
              <li><b>Post-Trade Review</b> <span className="muted">— Analysis Grade and Execution Grade (A–F), scored separately so you can see when good analysis met poor execution, or vice versa.</span></li>
              <li><b>Strategy Playbook</b> <span className="muted">— attach a published playbook; your answers to its rule checklist are saved per-trade, organized into phase tabs with an &quot;X / Y answered&quot; counter. Rules that require a screenshot accept a pasted image (Ctrl+V) or file upload.</span></li>
              <li><b>Inherit From Pre-Trade Analysis</b> <span className="muted">— if you ran a Pre-Trade Analysis for this setup beforehand, one click pulls those answers and notes straight into the trade&apos;s journal.</span></li>
              <li><b>Setup details</b> <span className="muted">— setup type, confirmation tags, planned Risk:Reward, confidence score (1–10), exit reason, and whether you manually intervened on SL/TP.</span></li>
              <li><b>Re-entry linking</b> <span className="muted">— mark a trade as a re-entry, search for its parent by ticket number, and note why you re-entered. The parent can be any earlier trade on the same symbol, not just one on the current page. A ticket that opened after this trade can&apos;t be its parent; the search says so, so you can link them the other way round.</span></li>
              <li><b>Same trade on other accounts</b> <span className="muted">— when the same symbol and side was opened on another account within 15 minutes, the drawer lists those trades. <b>Copy from this</b> brings that trade&apos;s journal into this one; <b>Copy this journal to all</b> sends this trade&apos;s saved journal to the others. Grades, notes, tags, setup, checklists, playbook answers and screenshots are copied; stop, risk and P&amp;L stay each account&apos;s own. A trade already attached to a different playbook version can&apos;t be overwritten.</span></li>
              <li><b>Trade Replay</b> <span className="muted">— opens a candlestick chart of exactly what happened, with Prev/Next buttons to step to the next trade without closing the modal.</span></li>
            </ul>
            <div className="manual-sub">Export for AI</div>
            <ul className="manual-feature-list">
              <li><b>Export for AI</b> builds one Markdown document from the trades matching the filters on this page: a review brief, statistics with likely ranges, breakdowns, playbooks, and the newest trades with their journal fields. Copy it to clipboard or download it, then paste or upload it into ChatGPT, Claude, Gemini, or any other chat.</li>
            </ul>
            <Callout icon="Not here" warn>Synced trades can&apos;t be edited, deleted, or bulk-actioned — a broker-synced fill&apos;s price, lot size, and P&amp;L are permanent facts. Manually-added trades are the one exception where you control those numbers, since you typed them in yourself. Full exports live under Backup.</Callout>
          </Chapter>

          <Chapter id="calendar" num="03" route="/calendar" title="Calendar" purpose="A month grid of daily P&L, for spotting the days and weeks that actually make or break your month.">
            <ul className="manual-feature-list">
              <li>Each day cell shows net $ (colored by win/loss), trade count, and either <b>avg R</b> or <b>win rate</b> for that day — avg R is shown whenever at least one of that day&apos;s trades has a recorded stop-loss (so a real R-multiple can be computed); otherwise the cell falls back to that day&apos;s win rate (winning trades ÷ total trades for the day).</li>
              <li>A <b>Weekly P&amp;L</b> column runs down the right edge of the grid — each box sits in the exact same row as the 7 days it summarizes, so Week 3&apos;s box is always beside Week 3&apos;s row, not just listed in order.</li>
              <li>Below the grid, a flat stats line totals the month: <b>Month P&amp;L</b>, <b>Total Trades</b>, <b>Profit Days</b>, <b>Loss Days</b>, <b>Day Win Rate</b> (% of trading days that closed net positive).</li>
              <li>Filter by <b>Symbol</b>, <b>Setup Grade</b> (F is labeled &quot;Boredom&quot; setups), and <b>Trading account</b>.</li>
              <li>Click any day with trades to open a drawer listing that day&apos;s trades, each with its own Replay button.</li>
            </ul>
            <Callout icon="Tip">The small &quot;Jump to:&quot; date field does double duty — pick a date and it both flips the calendar to that month <i>and</i> opens that day&apos;s trade drawer in one step. Empty days aren&apos;t clickable.</Callout>
          </Chapter>

          <Chapter id="analytics" num="04" route="/stats" title="Analytics" purpose="Every dimension your history can be sliced by — instrument, session, direction, mood, grade, and time.">
            <div className="manual-sub">Breakdowns available</div>
            <Pills items={['P&L by session', 'Buy vs. sell', 'Setup grade', 'Emotional state', 'Strategy tags', 'P&L by pair', 'Win rate by pair', 'Day of week', 'Monthly P&L']} />
            <ul className="manual-feature-list">
              <li><b>Playbook Discipline</b> <span className="muted">— the % of required playbook fields actually completed across your journaled trades.</span></li>
              <li><b>Avg R / Avg Win (R) / Avg Loss (R)</b> <span className="muted">— calculated only from trades where a stop-loss/risk value was recorded.</span></li>
              <li><b>Psychology &amp; Emotional Mindset Impact</b> <span className="muted">— win rate and P&amp;L broken out by the emotion you logged (Calm, Disciplined, Anxious, Greedy, Fearful, FOMO).</span></li>
              <li><b>View</b>: Tickets vs. Setups · <b>Date range</b>: All-Time, Today, 7/30 Days, 3/6 Months · <b>Account filter</b>: all or one specific account.</li>
            </ul>
            <Callout icon="Note">Grade, emotion, and tag breakdowns only populate once you&apos;ve filled that field in on trades — each empty section tells you exactly what to log to unlock it.</Callout>
          </Chapter>

          <Chapter id="performance" num="05" route="/performance" title="Performance" purpose="The risk and equity side of the story — where Analytics is categorical, Performance is financial.">
            <KvGrid items={[
              { label: 'Net P&L', value: '+ % account growth' },
              { label: 'Profit factor', value: 'Strong / Break-even / Losing' },
              { label: 'Expectancy', value: 'Avg $ per trade' },
              { label: 'Max drawdown', value: 'Excellent / Acceptable / High risk' },
            ]} />
            <ul className="manual-feature-list">
              <li><b>Equity Curve</b> <span className="muted">— account balance over time, with a reference line at your starting balance.</span></li>
              <li><b>Drawdown Chart</b> <span className="muted">— % decline from peak balance, for visualizing losing streaks.</span></li>
              <li><b>Recent Trade P&amp;L</b> <span className="muted">— bar chart of your last ~40 individual results.</span></li>
              <li><b>Risk Metrics</b> <span className="muted">— win rate, avg win vs. avg loss, avg R:R, gross profit/loss, largest win/loss, max consecutive wins/losses.</span></li>
              <li><b>Edge Summary</b> <span className="muted">— an auto-written paragraph summarizing your edge, ending in a verdict: positive edge, marginal edge, or unprofitable system.</span></li>
            </ul>
            <Callout icon="Tip">Long histories are automatically thinned to 300 chart points for readability — the underlying stats still use every trade.</Callout>
          </Chapter>

          <Chapter id="edge-coach" num="06" route="/coach" title="Edge Coach" purpose="Diagnoses the psychology and discipline patterns behind your results — what's actually stopping you from executing your own plan.">
            <ul className="manual-feature-list">
              <li><b>Early Exits</b> <span className="muted">— how many trades you closed before target, and the R/$ that likely cost you.</span></li>
              <li><b>Plan Adherence</b> <span className="muted">— % of your own execution checklist you actually followed, shown as a progress ring.</span></li>
              <li><b>Analysis vs. Execution Grade Gap</b> <span className="muted">— flags when your analysis quality outpaces your execution.</span></li>
              <li><b>Manual Intervention</b> <span className="muted">— compares outcomes on trades where you touched SL/TP mid-trade vs. left them alone.</span></li>
              <li><b>Demo vs. Live Comparison</b>, <b>Strategy Versions</b>, and <b>Lifecycle Stage Compliance</b>.</li>
              <li><b>What Works — Rule Evidence</b> <span className="muted">— win rate per specific playbook answer, with its sample size and a likely range, so two answers whose ranges overlap aren&apos;t mistaken for a real difference.</span></li>
              <li><b>Confidence vs. Actual Win Rate</b> <span className="muted">— tests whether your gut-feel confidence rating actually predicts outcomes.</span></li>
            </ul>
            <Callout icon="Note">Almost every panel here only appears once you&apos;ve logged the field it depends on. This page rewards thorough journaling more than any other.</Callout>
          </Chapter>

          <Chapter id="playbooks" num="07" route="/rules" title="Playbooks" purpose="Build the rulebook your trades get measured against — a versioned checklist spanning a trade's full lifecycle.">
            <div className="manual-sub">The nine lifecycle stages</div>
            <Pills items={['1 Concept', '2 Market context', '3 Setup & location', '4 Entry confirmation', '5 Risk plan', '6 Execution', '7 Trade management', '8 Exit', '9 Post-trade review']} />
            <div className="manual-sub">Building a strategy</div>
            <ul className="manual-feature-list">
              <li><b>New strategy</b> starts a blank draft — nothing saves until you publish.</li>
              <li>Add a stage via <b>Add recommended stage</b> (pre-filled with starter rules) or <b>Add empty stage</b>. Stages can be renamed, reordered, recategorized, or removed.</li>
              <li><b>Add rule</b> inside any stage: label, answer type (Yes/No, Number, Text, Single/Multiple choice), and whether it&apos;s required.</li>
              <li>Each rule&apos;s <b>More options</b> panel holds: tool role, what happens when it&apos;s not satisfied (record only / warn / skip trade / stop session), applicable timeframes, help text, and a <b>trade-screenshot requirement</b>.</li>
            </ul>
            <div className="manual-sub">Publishing</div>
            <ul className="manual-feature-list">
              <li>Every block/rule needs a name, and you must write a <b>change note of at least 20 characters</b> describing what changed and why.</li>
              <li>Publishing creates a new <b>immutable version</b>; older versions are never overwritten, so past trades keep pointing at the exact checklist they were judged against.</li>
              <li><b>Archive</b> retires a strategy without deleting its history. <b>Read playbook</b> opens a clean, read-only view of the published version.</li>
            </ul>
            <Callout icon="Tip">The strategy panel lists any <b>open Pre-Trade Analyses</b> already started against it, so you can jump back into one mid-setup instead of starting over.</Callout>
          </Chapter>

          <Chapter id="pretrade" num="08" route="/pretrade" title="Pre-Trade Analysis" purpose="Run your playbook's checklist before you enter — on a live chart you can draw on — then carry the answers into the real trade once it's taken.">
            <div className="manual-sub">Starting one</div>
            <ul className="manual-feature-list">
              <li>From Playbooks, click <b>Start Pre-Trade Analysis</b> on any strategy. It locks in that strategy&apos;s current published version and shows only its <b>Plan-phase</b> stages — Concept, Market context, Setup, Entry confirmation, and Risk plan.</li>
              <li>Answer the same rule checklist you&apos;d fill in on a real trade. Screenshot-required rules simply note that confirmation will be requested later, once inherited into an actual trade.</li>
            </ul>
            <div className="manual-sub">The chart</div>
            <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 9 }}>A candlestick chart loads for whatever symbol you type — with the same drawing tools as Backtest and Trade Replay, so you can mark up key levels yourself instead of the app guessing them for you.</p>
            <Pills items={['Trend line', 'Ray', 'Horizontal line', 'Rectangle / zone', 'Parallel channel', 'Fib retracement', 'Fib extension', 'Arrow', 'Text note', 'Magnet', 'Undo', 'Delete', 'Clear']} />
            <ul className="manual-feature-list">
              <li>Type a symbol and a <b>datalist</b> suggests real names from your connected broker account, so you&apos;re not guessing a spelling like &quot;USTEC&quot; vs. &quot;NAS100&quot; vs. &quot;US100&quot; yourself.</li>
              <li>Choose a <b>timeframe</b> (1m–1D) and <b>lookback window</b> (2–30 days) to bring the right amount of history into view.</li>
              <li>Use the drawing tools to mark <b>Previous Day High/Low</b>, <b>Previous Week High/Low</b>, and the <b>Asian / London session</b> highs and lows — then look for price to either <b>sweep</b> through one or <b>continue</b> through it.</li>
              <li>Everything — chart symbol, timeframe, and every annotation — <b>autosaves</b> a moment after you stop drawing.</li>
            </ul>
            <div className="manual-sub">Bringing it into a real trade</div>
            <ul className="manual-feature-list">
              <li>When the trade actually happens and syncs in, open its Journal Drawer and use <b>Inherit From Pre-Trade Analysis</b> to pull the playbook answers and notes across in one click.</li>
            </ul>
            <Callout icon="By design">TradeJournal never calculates PDH/PDL or session levels for you — marking them is a manual, deliberate act, the same way you&apos;d draw on a chart in your trading platform.</Callout>
          </Chapter>

          <Chapter id="knowledge" num="09" route="/knowledge" title="Knowledge Base" purpose="A free-form, searchable notebook for anything that isn't tied to one specific trade — broker quirks, market-structure ideas, session notes.">
            <ul className="manual-feature-list">
              <li><b>New Entry</b> opens a drawer with a Title, free-text Notes body, and comma-separated Tags.</li>
              <li>A live search box filters entries by title/content as you type.</li>
              <li>Entries display as cards: title, a short preview, tags, screenshot count, and date.</li>
              <li>Attach screenshots by uploading a file — or by <b>pasting an image straight from your clipboard</b> (Ctrl+V) while the entry drawer is open.</li>
            </ul>
            <Callout icon="Order matters" warn>A brand-new entry has to be saved once before you can attach screenshots to it — the drawer will prompt you to save first.</Callout>
          </Chapter>

          <Chapter id="backtest" num="10" route="/backtest" title="Backtest" purpose="Replay historical candles, practice entries against a strategy without risking real money, and see whether the setup actually has an edge.">
            <div className="manual-sub">Workspace</div>
            <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 9 }}>One unified view — chart, indicators, and trade execution live together; there&apos;s no separate &quot;Chart&quot; tab to switch to.</p>
            <ul className="manual-feature-list">
              <li>Pick a <b>symbol</b>, a past <b>date range</b>, and a <b>timeframe</b>, then Load Chart. The Historical Bar Replay bar steps candle-by-candle (or auto-plays at 0.5x–10x) up to that point in history.</li>
              <li><b>+ Long</b> / <b>+ Short</b> places a hypothetical position at a clicked price with a risk amount you set; <b>Log Setup</b> saves the outcome once it&apos;s closed.</li>
              <li><b>Indicators</b> — EMA 20/50/200, RSI (14), and Volume, toggled independently — plus a candlestick/line chart-type switch and price alerts.</li>
              <li><b>News</b> — high-impact (red) and medium-impact (orange) economic releases, shown as currency badges along the bottom of the chart under the candle they landed in, for the currencies that move the symbol (both sides of a pair; USD for US indices, gold and oil). Hover a badge to read the events with their actual, forecast and previous numbers. Releases still to come show ahead in the empty space to the right with a dashed ring, without their actual number; the legend also names the next high-impact one. Nothing leaks ahead of the replay: a release appears only once replay passes its time. Turn it off under Indicators.</li>
              <li><b>Where the news comes from</b> — the server fetches Forex Factory&apos;s public weekly calendar every hour, so new releases arrive by themselves (with forecast and previous; that feed has no actual numbers, which the MT5 history does). History before that comes from MT5, once: in MT5 open the Navigator, run the <code>NewsExport</code> script (copy <code>NewsExport.mq5</code> into <code>MQL5\Scripts</code> and compile it first), then upload the file it saves (<code>MQL5\Files\tradejournal_news.csv</code>) with <b>Indicators → Import MT5 news history</b>. One file covers every pair: news belongs to currencies, and each chart shows its own. The import works out your broker&apos;s clock from the US releases in the file, so times come out right whatever server you use. Only the journal&apos;s owner can import, since every account shares the calendar.</li>
              <li>Full drawing toolset: trend line, ray, horizontal line, rectangle/zone, parallel channel, Fibonacci retracement/extension, arrow, measure, and text notes, with undo/clear and a color picker.</li>
              <li>A session — chart position, drawings, and any open hypothetical trade — <b>autosaves</b> locally; leaving mid-backtest offers to resume it next time.</li>
              <li><b>Balance</b> — set the <b>starting balance</b> on the New Backtest page. It&apos;s locked for that backtest: the bar shows the current balance (starting balance plus every outcome you&apos;ve logged in the session, with the % change), and the risk % is worked out from it.</li>
              <li><b>Timeframes</b> can be switched at any point in the replay, with a trade open or just closed: the replay clock stays put, and the trade box moves to the candles that contain its entry and exit.</li>
            </ul>
            <div className="manual-sub">Strategies</div>
            <ul className="manual-feature-list">
              <li>A card grid of every strategy you&apos;ve named, each showing its trade count, win rate, and avg R.</li>
              <li>Clicking a strategy sets it as the <b>active strategy</b> (shown as a badge in the header) and drops you into Workspace with it pre-applied — every trade you log from there tags itself with that strategy automatically, until you pick a different one.</li>
              <li><b>New Strategy</b> names a setup once, with optional rules/notes, so it exists before you&apos;ve logged a single trade against it.</li>
            </ul>
            <div className="manual-sub">Log &amp; Metrics</div>
            <ul className="manual-feature-list">
              <li><b>Log</b> lists every saved backtest, filterable by strategy, symbol, and outcome, with search and sort; each row opens an inspector with its snapshot and a &quot;Load in Workspace&quot; button.</li>
              <li>Trades logged by an AI agent carry an <b>AGENT</b> badge and are hidden from your stats until you pick <b>Agent</b> or <b>All</b> in the header switch. See <a href="#ai-agents">AI agent backtesting</a>.</li>
              <li><b>Metrics</b> — Profit Factor, Expectancy, SQN Rating, Avg Win/Loss, plus Sharpe, Sortino, Calmar, Half Kelly, Annualized R, and Volatility, all computed from your backtest log.</li>
            </ul>
            <Callout icon="Note">Backtest trades never touch your real account balance or history — they&apos;re entirely separate from the synced trades everywhere else in the app.</Callout>
          </Chapter>

          <Chapter id="ai-agents" num="11" route="/api/mcp" title="AI agent backtesting (experimental)" purpose="Connect Claude (on the web, phone, desktop or Claude Code) or your own AI agent so it can backtest a strategy for you: replaying cTrader history bar by bar with the future hidden, placing simulated trades, and logging them to your Backtest Log.">
            <Callout icon="Experimental" warn>This is an <b>experimental feature</b>. It works, but it&apos;s new and may change: tool names, limits and behaviour can shift between updates, and you may hit rough edges. Treat agent results as a second opinion to check, not a verdict. They&apos;re kept out of your own stats for exactly that reason.</Callout>
            <div className="manual-sub">Before you start</div>
            <ul className="manual-feature-list">
              <li><b>cTrader connected</b> on the Accounts page. It supplies the historical candles; without it every session fails with &quot;cTrader is not connected&quot;.</li>
              <li><b>At least one strategy with a description</b> (Backtest → Strategies). The agent reads the description as the rules it must follow, so write it the way you&apos;d explain the setup to another trader: entry trigger, stop placement, target, and when not to trade.</li>
              <li><b>This journal&apos;s MCP address</b> is <code>{mcpUrl}</code>. It&apos;s already filled into every example below, so you only need to swap in your key. (Claude needs to be told where your journal lives, which is why the address appears in every setup.)</li>
            </ul>

            <div className="manual-sub">Easiest · claude.ai on web or phone (no key)</div>
            <ol className="manual-steps">
              <li><b>In claude.ai, open Settings → Connectors → Add custom connector</b><span className="d">Paste <code>{mcpUrl}</code> as the address and click <b>Connect</b>.</span></li>
              <li><b>Sign in and click Allow</b><span className="d">You&apos;re sent to this journal. Tick <b>Read my trade journal</b> if you want Claude to review your real trades too.</span></li>
              <li><b>Use it in any chat</b><span className="d">Turn the connector on in a chat and ask away. It appears under Accounts → AI agent access, where you can switch journal access off or <b>Disconnect</b> it.</span></li>
            </ol>
            <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 9 }}>Prefer Claude Code or Claude Desktop? They can use the same sign-in, or an access key as below.</p>

            <div className="manual-sub">Step 1 · Create an access key</div>
            <ol className="manual-steps">
              <li><b>Open Accounts</b><span className="d">Scroll to the bottom, to the <b>AI agent access</b> card.</span></li>
              <li><b>Name the key</b><span className="d">Use the device or agent it&apos;s for, e.g. &quot;Claude Desktop laptop&quot;. One key per device makes it easy to revoke just one later.</span></li>
              <li><b>Journal access (optional)</b><span className="d">Tick <b>Also let this key read my real trade journal</b> if you want the agent to review your real trades too (see <b>Reviewing your real trades</b> below). You can switch it on or off later with the <b>Journal access</b> box next to the key.</span></li>
              <li><b>Click Create access key</b><span className="d">The key (it starts with <code>tjk_</code>) appears <b>once</b>, together with a ready-to-copy Claude Code command and Claude Desktop config with the key already filled in. Copy what you need before clicking <b>I&apos;ve saved it</b>.</span></li>
            </ol>
            <Callout icon="Security" warn>Treat the key like a password. Without journal access it can only reach the backtest tools (it can&apos;t see your real trades, accounts or anything else); with journal access it can also read, but never change, your real trades. Anyone holding it can do the same. Only a fingerprint is stored, so a lost key can&apos;t be shown again: revoke it and create a new one.</Callout>

            <div className="manual-sub">Step 2a · Connect Claude Code</div>
            <ol className="manual-steps">
              <li><b>Open a terminal</b><span className="d">Any folder works; the connection is saved to your Claude Code settings.</span></li>
              <li><b>Run the command from the Accounts card</b><span className="d">The Accounts card shows it with your key filled in. It looks like this (<code>tjk_YOUR_KEY</code> is where your key goes):</span></li>
            </ol>
            <Code>{claudeCodeCmd(mcpUrl)}</Code>
            <ol className="manual-steps" start={3} style={{ counterReset: 'mstep 2' }}>
              <li><b>Check the connection</b><span className="d">Start <code>claude</code> and type <code>/mcp</code>. <code>tradejournal</code> should be listed as connected; the exact tool count can change as the journal adds capabilities.</span></li>
            </ol>

            <div className="manual-sub">Step 2b · Connect Claude Desktop</div>
            <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 9 }}>Claude Desktop can&apos;t attach an access key to a remote server by itself, so it connects through <b>mcp-remote</b>, a small free bridge that runs on your computer and adds the key to every request. Claude Desktop starts and stops it for you.</p>
            <ol className="manual-steps">
              <li><b>Install Node.js</b><span className="d">Download the LTS version from nodejs.org and install it (the bridge runs on it). Skip this if you already have it: running <code>node -v</code> in a terminal prints a version number.</span></li>
              <li><b>Open Claude Desktop&apos;s config file</b><span className="d">In Claude Desktop go to <b>Settings → Developer → Edit Config</b>. This opens <code>claude_desktop_config.json</code>. On a Mac it lives in <code>~/Library/Application Support/Claude/</code>; on Windows in <code>%APPDATA%\Claude\</code>.</span></li>
              <li><b>Paste the config from the Accounts card</b><span className="d">Use the <b>Copy config</b> button: your address and key are already filled in. It looks like this. If the file already has an <code>mcpServers</code> section, add the <code>&quot;tradejournal&quot;: {'{ … }'}</code> part inside it rather than pasting a second one.</span></li>
            </ol>
            <Code>{desktopConfig(mcpUrl)}</Code>
            <ol className="manual-steps" start={4} style={{ counterReset: 'mstep 3' }}>
              <li><b>Save the file and restart Claude Desktop</b><span className="d">Fully quit it (on Mac, Claude → Quit; on Windows, right-click the tray icon → Quit), then open it again. Closing the window isn&apos;t enough.</span></li>
              <li><b>Check the connection</b><span className="d">In a new chat, open the tools menu (the sliders icon under the message box). <b>tradejournal</b> should be listed with its tools. The first time the agent uses a tool, Claude asks for permission: choose <b>Allow always</b> to avoid being asked on every step.</span></li>
            </ol>
            <Callout icon="Tip">Keep <code>Authorization:${'{'}TJ_AUTH{'}'}</code> exactly as written, with no space after the colon. Claude Desktop on Windows breaks arguments that contain spaces, which is why the <code>Bearer …</code> part lives in <code>env</code>. Running the journal locally on <code>http://localhost:3000</code>? Add <code>&quot;--allow-http&quot;</code> to <code>args</code> (the Accounts card does this for you when you&apos;re on http).</Callout>

            <div className="manual-sub">Step 2c · Connect your own agent</div>
            <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 9 }}>Any MCP client that supports the Streamable HTTP transport can connect. Send JSON-RPC requests with these headers, starting with <code>initialize</code>, then <code>tools/list</code> and <code>tools/call</code>:</p>
            <Code>{agentHeaders(mcpUrl)}</Code>
            <ul className="manual-feature-list">
              <li>The key is only accepted in the <code>Authorization</code> header, never in the address (addresses end up in server logs).</li>
            </ul>

            <div className="manual-sub">Step 3 · Run your first backtest</div>
            <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 9 }}>Ask in plain language. Name the strategy, the symbol and the timeframe, and ask it to explain each trade:</p>
            <Code>{FIRST_PROMPT}</Code>
            <ul className="manual-feature-list">
              <li>The agent starts a session, reads candles, steps forward until its setup forms, opens a trade with a stop (and usually a target), steps until the trade exits, and logs it with notes.</li>
              <li><b>Blind sessions</b> (ask for &quot;blind&quot;): the server picks a random date range, shifts the dates into 1990 and rescales prices, so the agent can&apos;t recognise the period from memory. Weekdays and times of day stay real. Your log still records the real dates and prices.</li>
              <li><b>No hindsight:</b> the agent is never sent a candle that closes after the replay clock, on any timeframe. A candle touching both stop and target is settled on smaller candles, down to 1 minute, exactly like the Workspace chart.</li>
            </ul>

            <div className="manual-sub">Where the results show up</div>
            <ul className="manual-feature-list">
              <li>Agent trades appear in <b>Backtest → Log</b> with an <b>AGENT</b> badge (<b>AGENT · BLIND</b> for blind sessions), filed under the session&apos;s strategy.</li>
              <li>They are <b>kept out of your own numbers</b> by default. Once an agent has logged something, a <b>Mine / Agent / All</b> switch appears in the Backtest header (top of the Log on phones). Every Backtest page (Overview, Log, Metrics, Strategies) follows it.</li>
              <li>Open any agent trade to read its notes, lesson and quality scores, the same way as your own backtests.</li>
            </ul>

            <div className="manual-sub">What the agent can do</div>
            <div className="manual-table-wrap">
              <table className="manual-ref">
                <thead><tr><th>Tool</th><th>What it does</th></tr></thead>
                <tbody>
                  <tr><td className="term">list_symbols</td><td>Symbol names on your cTrader account.</td></tr>
                  <tr><td className="term">list_strategies</td><td>Your strategies, their descriptions (the rules), and agent results so far. <code>create_strategy</code> adds one.</td></tr>
                  <tr><td className="term">start_session</td><td>Start a replay on a symbol, timeframe and date range, or a blind one.</td></tr>
                  <tr><td className="term">get_candles</td><td>Closed candles on any timeframe before the clock, plus the still-forming higher-timeframe candle.</td></tr>
                  <tr><td className="term">step</td><td>Reveal the next candles: one at a time, a number of bars, until a price or time, or until the open trade exits.</td></tr>
                  <tr><td className="term">get_indicators</td><td>EMA, SMA, RSI, ATR and Bollinger Bands, calculated on closed candles only.</td></tr>
                  <tr><td className="term">open_trade</td><td>Enter at the last close with a required stop, optional target and USD risk. <code>close_trade</code> exits manually.</td></tr>
                  <tr><td className="term">place_order</td><td>A limit (pullback) or stop (breakout) entry, optionally expiring. Fills are checked minute by minute. <code>cancel_order</code> removes it.</td></tr>
                  <tr><td className="term">modify_trade</td><td>Move the stop or target (e.g. stop to breakeven), or a pending order&apos;s price. R is always measured from the original stop.</td></tr>
                  <tr><td className="term">log_trade</td><td>Save the closed trade to the Backtest Log with notes. <code>discard_trade</code> drops it instead.</td></tr>
                  <tr><td className="term">list_backtests</td><td>Browse your whole Backtest Log (your backtests and agent runs). <code>get_backtest</code> reads one in full, including its chart snapshot.</td></tr>
                  <tr><td className="term">update_backtest</td><td>Edit journal fields on any backtest: notes (or add a paragraph), lesson, tags, quality scores, mistakes. Prices and results can&apos;t be changed.</td></tr>
                  <tr><td className="term">delete_backtests</td><td>Delete backtests <b>an agent logged</b>, one or many at once (by strategy, run, symbol or dates). It shows what would go first and deletes only when confirmed. Your own backtests can&apos;t be deleted by an agent.</td></tr>
                  <tr><td className="term">delete_strategies</td><td>Delete whole strategies at once, with their agent backtests, runs and replay sessions. A strategy that holds any backtest you logged yourself is skipped. Also shows what would go first.</td></tr>
                  <tr><td className="term">get_metrics</td><td>The Metrics page&apos;s stats, filtered by source, strategy, symbol, direction and date, and broken down by strategy, symbol, weekday, hour, month and more. Ask it to compare your results with the agent&apos;s.</td></tr>
                  <tr><td className="term">get_strategy</td><td>A strategy&apos;s full history: every version of its rules, what changed and why, and results per version. <code>update_strategy_rules</code> saves a new version.</td></tr>
                  <tr><td className="term">set_holdout</td><td>Hide a strategy&apos;s later data so rules are tuned only on earlier data. <code>evaluate_holdout</code> then tests a version on it, counting every look.</td></tr>
                  <tr><td className="term">sessions</td><td><code>list_sessions</code>, <code>get_state</code>, <code>set_timeframe</code> and <code>end_session</code> manage a replay. Sessions expire a week after last use.</td></tr>
                </tbody>
              </table>
            </div>

            <Callout icon="Access">An agent can <b>read</b> your whole Backtest Log and <b>add to or edit</b> journal fields on your backtests (it&apos;s told to add notes rather than overwrite yours), but it <b>can&apos;t delete</b> your backtests or change their prices and results. Without journal access it can&apos;t reach anything outside Backtest: no real trades, accounts or settings.</Callout>
            <div className="manual-sub">Letting the agent improve a strategy</div>
            <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 9 }}>The agent can learn from its own results, as long as it doesn&apos;t judge a change on the same data it tuned it on. Ask it to follow this loop:</p>
            <ol className="manual-steps">
              <li><b>Hold out the later data</b><span className="d">e.g. &quot;hold out ORB NY Open from 2026-03-01&quot;. Results after that date are hidden from it until the final test.</span></li>
              <li><b>Find what separates winners from losers</b><span className="d">Every trade records its entry conditions (ATR, stop distance in ATRs, and whatever the agent adds, like range width). The agent splits results by them on the earlier data.</span></li>
              <li><b>Save one change as a new version</b><span className="d">With what changed and why. Every version stays in the strategy&apos;s history, including the ones that failed.</span></li>
              <li><b>Test it once on the held-out data</b><span className="d">Keep the change only if it holds up there. Every look at held-out results is counted, and versions made after peeking are flagged.</span></li>
            </ol>
            <Callout icon="Note">This doesn&apos;t retrain the AI model itself. It gives the agent a disciplined, recorded way to learn from your data, and keeps you from trusting an improvement that only exists in the data it was fitted to.</Callout>
            <div className="manual-sub">Mechanical strategies as code</div>
            <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 9 }}>For rule-based strategies the agent doesn&apos;t have to step through candles one call at a time. It writes the rules as a short piece of code, and the journal runs it over months or years of your cTrader history, usually in seconds to minutes. Any new strategy works this way without changes to the journal itself.</p>
            <ul className="manual-feature-list">
              <li><b>Still no hindsight</b>: the code is fed one closed candle at a time, on every timeframe it uses, so it can&apos;t peek ahead.</li>
              <li><b>The journal settles every trade</b>, the same way as replays: stops, targets and pending orders are checked on 1-minute candles. The agent can add spread and commission.</li>
              <li><b>Trend following too</b>: trailing stops, scaling into a winner (several positions at once), partial profits, trend indicators (ADX, MACD, Donchian, Supertrend and more), up to 25 years of history and up to 20 markets in one run.</li>
              <li><b>Sandboxed</b>: the code can&apos;t reach the internet, your data or the server, and runs with strict time and memory limits.</li>
              <li><b>Results</b> come back with likely ranges and breakdowns (by setup tag, weekday, hour, exit reason or any entry condition), and can be logged to your Backtest Log as agent trades.</li>
            </ul>
            <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 9 }}>Try asking: <i>&quot;Code up my ORB liquidity sweep on gold, 5-minute candles, and run it on the last year with a 0.3 spread. Break the results down by weekday.&quot;</i> or <i>&quot;Test a 55-day breakout trend-following system with a 3 ATR trailing stop on gold, US30 and EURUSD since 2012, adding up to 3 units.&quot;</i> Strategies that need judgement (reading structure, discretionary setups) still use the bar-by-bar replay.</p>
            <Callout icon="No setup">On the <b>Trades</b> page, <b>Export for AI</b> copies your filtered trades, statistics and playbooks as one document, with instructions for the AI already at the top. Paste it into ChatGPT, Claude, Gemini or any chat, on any device. Use this when you want a quick review without connecting an agent.</Callout>
            <div className="manual-sub">Reviewing your real trades</div>
            <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 9 }}>With <b>journal access</b> on, the agent can read your real trades the way a coach would, with your actual data in front of it. It is read-only: it can&apos;t edit, tag or delete anything.</p>
            <ul className="manual-feature-list">
              <li><b>Trades</b>: list and filter them (account, symbol, date, win/loss, setup, tag, emotion, exit reason), and open one in full with your notes, checklists, playbook answers, replay review and screenshots.</li>
              <li><b>Statistics</b>: the same numbers as your Stats pages, net of commission and swap, with likely ranges, split by setup, session, emotion, grades, rules followed, hold time and more.</li>
              <li><b>Price action</b>: candles from cTrader around any trade, with its entry, exit, stop and target, so it can see what the market did.</li>
              <li><b>Your playbooks</b>: the rules you wrote, to hold each trade against.</li>
              <li><b>Everything else</b>: your knowledge base, pre-trade analyses, and deposits and withdrawals.</li>
            </ul>
            <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 9 }}>Try asking: <i>&quot;Review my live trades from the last 3 months. Where am I losing money, is it the setup or my execution? Show me the trades that prove it.&quot;</i></p>
            <div className="manual-sub">Limits</div>
            <KvGrid items={[
              { label: 'Active sessions', value: '10 per user' },
              { label: 'Agent requests', value: '600 / min per key' },
              { label: 'Candle downloads', value: '120 / min per user' },
              { label: 'Session expiry', value: '7 days idle' },
            ]} />

            <div className="manual-sub">Troubleshooting</div>
            <ul className="manual-feature-list">
              <li><b>claude.ai sign-in fails or shows an error</b>: remove the connector in Settings → Connectors, add it again with the exact address above, and sign in again. If it still fails, contact support.</li>
              <li><b>Connector added but Claude doesn&apos;t use it</b>: connectors are turned on per chat. Open the tools menu in that chat and switch <b>tradejournal</b> on.</li>
              <li><b>Claude can&apos;t see my real trades</b>: journal access is off. Turn it on under Accounts → AI agent access, or disconnect and reconnect, ticking <b>Read my trade journal</b> when you sign in.</li>
              <li><b>401 / &quot;invalid or has been revoked&quot;</b>: the key is wrong or revoked, or <code>Bearer </code> is missing in front of it. Create a new key and update your config.</li>
              <li><b>&quot;cTrader is not connected&quot;</b>: connect cTrader on the Accounts page. The agent can&apos;t fix this for you.</li>
              <li><b>Rate limit messages</b>: wait a minute. Tell the agent to step several bars at a time (or until a price) instead of one call per candle.</li>
              <li><b>Claude Desktop shows no tradejournal tools</b>: check the file is valid JSON (a missing comma is the usual culprit), that Node.js is installed, and that you fully restarted Claude. Its log is at <code>~/Library/Logs/Claude/mcp-server-tradejournal.log</code> on Mac, or in <code>%APPDATA%\Claude\logs\</code> on Windows. If it says <code>npx</code> isn&apos;t found, replace <code>&quot;npx&quot;</code> with its full path (run <code>which npx</code> on Mac or <code>where npx</code> on Windows).</li>
              <li><b>Revoking a key</b>: Accounts → AI agent access → Revoke. Any agent using it is cut off on its very next request.</li>
            </ul>
          </Chapter>

          <Chapter id="accounts" num="12" route="/accounts" title="Accounts & syncing" purpose="Where every broker connection, the Desktop Sync App, and investor access are all managed.">
            <div className="manual-sub">Connecting MT5</div>
            <ol className="manual-steps">
              <li><b>Add account</b><span className="d">Give it a label, your MT5 login number, broker server, and your MT5 <i>investor</i> (read-only) password — never your trading password.</span></li>
              <li><b>Generate your sync key</b><span className="d">Under &quot;Your personal sync key,&quot; click Generate / rotate. It&apos;s shown once — copy it immediately.</span></li>
              <li><b>Install the Desktop Sync App</b><span className="d">Download it, paste in your sync key, and click Start Sync. The account record alone doesn&apos;t sync anything by itself.</span></li>
            </ol>
            <div className="manual-sub">MT5 on Linux (beta)</div>
            <ul className="manual-feature-list">
              <li>MetaTrader 5 runs on Linux through Wine (MetaQuotes&apos; Linux installer sets it up). On the Accounts page, <b>Download for Linux (beta)</b> gives you a setup script, <code>tradejournal-linux.sh</code>.</li>
              <li>Run <code>bash tradejournal-linux.sh</code> in a terminal and paste your sync key when asked. It installs Windows Python into MT5&apos;s Wine setup and runs the same sync as the Windows app as a background service, so trades keep syncing whenever you&apos;re logged in and MT5 is open.</li>
              <li>Other commands: <code>status</code> (is it running?), <code>logs</code> (watch it sync), <code>update</code> (get the newest sync), <code>stop</code> / <code>start</code>, and <code>uninstall</code>. Without systemd, <code>run</code> syncs in that terminal for as long as it&apos;s open.</li>
            </ul>
            <div className="manual-sub">MT5 without Windows (statement import)</div>
            <ul className="manual-feature-list">
              <li>On a Mac, the Desktop Sync App can&apos;t run. Use <b>Import MT5 statement</b> on the Trades page instead: the first import creates an account card marked <b>MT5 · statement import</b>, and later imports of the same account number add only new trades.</li>
              <li>Importing a report for an account the Windows app already syncs? The import finds that account by its number and adds only what the app hasn&apos;t, and the app then skips what you imported, so nothing is added twice.</li>
            </ul>
            <div className="manual-sub">Connecting cTrader</div>
            <ul className="manual-feature-list">
              <li><b>Connect cTrader</b> redirects to cTrader&apos;s own OAuth approval page. On return, pick which of your cTrader accounts under that login to actually connect.</li>
              <li>Each connected account gets <b>Sync Now</b> and <b>Disconnect</b> (stops syncing; already-synced trades stay in your history).</li>
              <li>cTrader is also what powers <b>Trade Replay&apos;s</b> candlestick charts, AI agent backtests, and the Pre-Trade Analysis chart — it matters even if your trade history itself comes from MT5.</li>
              <li>cTrader OAuth tokens are stored encrypted, the same way MT5 broker credentials are. TradeJournal never asks for a trading/master password and cannot place real trades.</li>
            </ul>
            <div className="manual-sub">Sharing investor access</div>
            <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 9 }}>Per account, not global — expand the <b>Investor</b> panel on any account card.</p>
            <ul className="manual-feature-list">
              <li><b>Enable investor access</b> generates a numeric account code and a one-time password (shown once).</li>
              <li><b>Copy investor link</b> gives you a shareable <code>/investor/login</code> URL; copy the password separately.</li>
              <li><b>Rotate password</b> issues a new one; <b>Revoke access</b> disables the link entirely.</li>
            </ul>
            <div className="manual-sub">AI agent access</div>
            <ul className="manual-feature-list">
              <li>See and manage everything connected to your journal: claude.ai connections and access keys. Switch journal access (read-only access to your real trades) on or off per connection, and disconnect or revoke any of them instantly. Full setup steps are in <a href="#ai-agents">AI agent backtesting</a>.</li>
            </ul>
            <div className="manual-sub" id="no-admin">There is no admin panel, not even for us</div>
            <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 9 }}>TradeJournal was built without an admin panel, on purpose. Not even the people who made it can open your account, read your trades, notes or screenshots, or see your balance from inside the app. Your journal is only visible to you, and to people you choose to share it with (Investor access, or an AI connection you set up).</p>
            <ul className="manual-feature-list">
              <li><b>Your account is in your hands.</b> You change your password under <b>Accounts → Password</b>, and you connect or disconnect brokers and AI tools yourself. Nobody can do it for you from a control panel.</li>
              <li><b>Forgot your password?</b> Use <b>Forgot password</b> on the sign-in page when it&apos;s shown. Because there&apos;s no admin panel, there&apos;s no one who can look your account up and unlock it from inside the app.</li>
              <li><b>Keep your own copy.</b> No one can bring back trades, notes or drawings you delete. Download a backup regularly from <a href="#backup">Backup &amp; export</a>.</li>
            </ul>
          </Chapter>

          <Chapter id="backup" num="13" route="/archive" title="Backup & export" purpose="Confirm your data is safe and pull a full export — this page reads and downloads, it doesn't restore.">
            <ul className="manual-feature-list">
              <li>A single status strip confirms your trade count is backed up, with a Refresh button and the last-updated time — the account-level and database-internal detail behind that lives on the server, not in front of you.</li>
              <li>If any screenshots are still uploading from an earlier offline moment, a banner shows how many are pending; they finish syncing automatically once you&apos;re back online.</li>
              <li><b>Download JSON</b> — a full backup suitable for restoring into a fresh database. <b>Download CSV</b> — trade fields for Excel or Sheets.</li>
            </ul>
            <Callout icon="One-way only" warn>There&apos;s no restore/import button on this page, even though the JSON export is restore-capable. Treat this page as export-only.</Callout>
          </Chapter>

          <Chapter id="investor" num="14" route="/investor" title="Investor mode" purpose="A no-signup, read-only window into one specific account's performance — for a partner, fund investor, or anyone you report to.">
            <div className="manual-sub">What the investor sees</div>
            <KvGrid items={[
              { label: 'Balance', value: 'Live' },
              { label: 'Win rate', value: '+ profit factor' },
              { label: 'Max drawdown', value: 'Color-coded' },
              { label: 'Avg win / loss', value: '+ expectancy' },
            ]} />
            <ul className="manual-feature-list">
              <li>An equity curve chart, and a table of up to 50 recent closed trades.</li>
              <li>A <b>Replay</b> button per trade opens a candlestick chart with a full playback bar: play/pause, step, jump-to-entry/exit, a speed selector, and a scrubbable progress bar.</li>
            </ul>
            <div className="manual-kbd-row">
              <div className="manual-kbd-pair"><span className="manual-kbd">Space</span> play / pause</div>
              <div className="manual-kbd-pair"><span className="manual-kbd">← / →</span> step candle</div>
              <div className="manual-kbd-pair"><span className="manual-kbd">E</span> jump to entry</div>
              <div className="manual-kbd-pair"><span className="manual-kbd">X</span> jump to exit</div>
            </div>
            <Callout icon="Boundaries">An investor session can&apos;t reach any other page and can&apos;t edit or upload anything. It&apos;s a separate login token from your own.</Callout>
          </Chapter>

          <section className="manual-chapter" id="glossary">
            <div className="manual-chapter-kicker"><span className="manual-chapter-num">—</span></div>
            <h2>Glossary &amp; quick reference</h2>
            <p className="manual-chapter-purpose">Terms that show up across the app without much explanation in the moment.</p>
            <div className="manual-table-wrap">
              <table className="manual-ref">
                <thead><tr><th>Term</th><th>What it means here</th></tr></thead>
                <tbody>
                  <tr><td className="term">MCP</td><td>Model Context Protocol: the standard way AI apps like Claude connect to outside tools. The journal&apos;s MCP server lives at <code>/api/mcp</code>.</td></tr>
                  <tr><td className="term">Access key</td><td>A <code>tjk_…</code> key for the MCP tools. It starts with backtesting access; if you turn on journal access, it can also read your real trades, notes, screenshots, playbooks, knowledge base, pre-trade plans and cash-flow events. Journal access is read-only and can be switched off any time.</td></tr>
                  <tr><td className="term">Blind session</td><td>An agent backtest where dates are shifted and prices rescaled, so the agent can&apos;t recognise the period.</td></tr>
                  <tr><td className="term">R / Avg R</td><td>Result measured as a multiple of what you risked. A trade risking $100 that made $250 is &quot;2.5R.&quot;</td></tr>
                  <tr><td className="term">Setup vs. Ticket</td><td>A &quot;ticket&quot; is one broker execution; a &quot;setup&quot; groups a ticket with any of its re-entries.</td></tr>
                  <tr><td className="term">Plan Adherence</td><td>% of your own execution checklist you actually followed on a trade.</td></tr>
                  <tr><td className="term">Analysis vs. Execution Grade</td><td>Two separate A–F scores — how good your read was, versus how well you carried it out.</td></tr>
                  <tr><td className="term">Sample tag</td><td>How many trades a number rests on, everywhere in the app: <b>too few to judge</b> (under 10), <b>early</b> (10–29), <b>developing</b> (30–99), <b>reliable</b> (100+). Rows with too few trades are dimmed.</td></tr>
                  <tr><td className="term">Likely range</td><td>The 95% range for a win rate or average result: given this many trades, where the true value most likely lies. 3 wins in 4 trades is &quot;likely 30% to 95%&quot;; 174 in 300 is &quot;likely 52% to 63%&quot;. A &quot;positive edge&quot; on Performance needs the whole expectancy range above zero.</td></tr>
                  <tr><td className="term">Investor password</td><td>A password that only ever grants read access — shown once, never retrievable again.</td></tr>
                  <tr><td className="term">Playbook version</td><td>An immutable snapshot of a strategy&apos;s rules, created every time you publish.</td></tr>
                </tbody>
              </table>
            </div>
            <p className="manual-end-note">TradeJournal · trading journal for MT5 &amp; cTrader</p>
          </section>
        </div>
      </div>
    </main>
  );
}

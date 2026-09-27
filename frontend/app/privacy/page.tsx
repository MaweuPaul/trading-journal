'use client';
import Link from 'next/link';
import { ShieldCheck } from 'lucide-react';

function Sub({ children }: { children: React.ReactNode }) {
  return <div className="manual-sub">{children}</div>;
}

export default function PrivacyPage() {
  return (
    <main className="page-content privacy-page">
      <header className="page-header">
        <div className="page-header-inner">
          <div>
            <h2><ShieldCheck size={22} style={{ verticalAlign: 'middle', marginRight: 8 }} />Privacy &amp; Data</h2>
            <p>What TradeJournal stores, why it needs it, and who can ever see it.</p>
          </div>
        </div>
      </header>

      <div style={{ maxWidth: 720 }}>
        <p style={{ color: 'var(--text-muted)', fontSize: 13.5, lineHeight: 1.6, marginBottom: 8 }}>
          TradeJournal isn&apos;t a commercial product — it&apos;s run privately for a small group of trusted
          people, not sold or offered publicly. Nothing here is collected to be sold, profiled, or shared with
          advertisers. Every piece of data below exists because a specific feature of the app needs it to work.
          This page explains that trade-by-trade.
        </p>

        <Sub>What we store, and why</Sub>
        <ul className="manual-feature-list">
          <li><b>Name, email, password</b> <span className="muted">— your password is scrambled before it&apos;s saved, so nobody (not even whoever runs this journal) can read it back; it can only be checked when you log in.</span></li>
          <li><b>MT5 login details and investor password</b> <span className="muted">— stored encrypted, and used only so the Desktop Sync App can read your closed trades. That&apos;s your broker&apos;s read-only investor password, not your real trading password: TradeJournal never asks for that, and couldn&apos;t place a trade with what it stores even if it wanted to.</span></li>
          <li><b>cTrader connection</b> <span className="muted">— you approve access on cTrader&apos;s own website; what we get back is stored encrypted and used only to read your trade history and price charts.</span></li>
          <li><b>Your trade history</b> <span className="muted">— symbol, direction, entry/exit, P&amp;L, timestamps, synced read-only from your broker. This is the data every chart, stat, and calendar cell in the app is built from.</span></li>
          <li><b>Everything you type or upload</b> <span className="muted">— notes, grades, emotion tags, playbook answers, strategy names, and screenshots. This is the actual &quot;journal&quot; layered on top of the read-only trade data, and it only exists because you added it.</span></li>
          <li><b>Screenshots</b> <span className="muted">— stored with Cloudinary, an image-hosting service, so they load quickly. If the journal is briefly offline when you upload one, it&apos;s held and uploaded as soon as it&apos;s back.</span></li>
          <li><b>Investor access code &amp; password</b> <span className="muted">— created only if you turn it on for a specific account; the password is scrambled and shown to you once, just like your own login password.</span></li>
          <li><b>Backtests</b> <span className="muted">— your replay sessions, drawings, simulated trades, chart snapshots and strategy notes. The price charts come from your own cTrader connection; they&apos;re market prices, not personal data.</span></li>
          <li><b>AI access keys and connected apps</b> <span className="muted">— only if you create one. Keys are scrambled the same way as your password, so they can&apos;t be read back; connected apps have to renew their access every hour.</span></li>
          <li><b>AI strategy runs</b> <span className="muted">— when an AI tests a strategy, the code it wrote, its settings and the resulting simulated trades are kept so you (and it) can review or rerun them. Trades it logs are marked AGENT and kept apart from your own backtest stats.</span></li>
        </ul>

        <Sub>AI agents (optional, experimental)</Sub>
        <ul className="manual-feature-list">
          <li><b>Off by default.</b> An AI can only reach your journal if you create an access key or approve a connection on <Link href="/accounts" style={{ color: 'var(--accent)' }}>Accounts → AI agent access</Link>.</li>
          <li><b>Backtesting only, unless you say otherwise.</b> A key or connection starts with backtesting access. Reading your real trades, notes, screenshots, playbooks, knowledge base, pre-trade plans and deposits/withdrawals needs <b>journal access</b>, which you tick per key or on the approval page and can switch off any time.</li>
          <li><b>Read-only on your real journal.</b> An AI can never change or delete your real trades or notes, and like everything else here it can never place a real trade.</li>
          <li><b>Where the data goes:</b> whatever the AI reads is sent to the company that runs that AI (for example Anthropic for Claude) and handled under <i>their</i> privacy terms, not this page&apos;s. Only connect AI services you trust with your trading data.</li>
          <li><b>Strategy code</b> an AI writes runs sealed off: it can&apos;t reach the internet, your data or your broker logins, and it&apos;s stopped if it runs too long.</li>
          <li><b>Export for AI</b> (Trades page) builds a document from your journal and hands it only to your own browser. Nothing is sent to any AI until you paste or upload it into a chat yourself, and then it&apos;s subject to that AI service&apos;s terms. You can leave your notes and screenshot links out of it.</li>
        </ul>

        <Sub>What we don&apos;t do</Sub>
        <ul className="manual-feature-list">
          <li>Every broker connection is <b>read-only</b> — TradeJournal cannot place, modify, or close a real trade for you, on MT5 or cTrader.</li>
          <li>No advertising trackers, analytics pixels, or third-party scripts run in the app. The only outside services involved are your broker (to read your trades and price charts), Cloudinary (only the screenshots you choose to upload), an email service (only to send password-reset links, if it&apos;s set up), and any AI service <i>you</i> choose to connect.</li>
          <li>Your data isn&apos;t sold, rented, or shared with anyone outside your own account.</li>
          <li>If this instance has more than one person signed up, accounts are fully isolated — nobody can see another user&apos;s trades, notes, or broker connections. There&apos;s no admin view into another user&apos;s journal.</li>
        </ul>

        <Sub>Who can see your data</Sub>
        <ul className="manual-feature-list">
          <li>By default: only you, signed in with your own password.</li>
          <li>If you explicitly enable <Link href="/accounts" style={{ color: 'var(--accent)' }}>Investor Access</Link> on a broker account, whoever holds that link and one-time password gets a read-only performance view of <i>that account only</i> — no notes, no other accounts, no ability to edit anything.</li>
          <li>Turning investor access back off (or rotating its password) invalidates the old link immediately.</li>
          <li>AI agents and apps you connect see what their access allows (backtesting, and your journal only with journal access) until you revoke them.</li>
        </ul>

        <Sub>Your control over it</Sub>
        <ul className="manual-feature-list">
          <li><b>Disconnect</b> any broker account from <Link href="/accounts" style={{ color: 'var(--accent)' }}>Accounts</Link> at any time — syncing stops immediately; trades already synced stay in your history until you remove them yourself.</li>
          <li><b>Revoke AI access</b> on <Link href="/accounts" style={{ color: 'var(--accent)' }}>Accounts → AI agent access</Link>: <i>Revoke</i> a key or <i>Disconnect</i> an app and it&apos;s cut off on its very next request; untick <i>Journal access</i> to keep backtesting but hide your real trades.</li>
          <li><b>Export everything</b> — a full JSON or CSV backup is one click away on the <Link href="/archive" style={{ color: 'var(--accent)' }}>Backup &amp; Export</Link> page.</li>
          <li>There&apos;s currently no self-service &quot;delete my account&quot; button — if you want your account and its data fully removed, just ask whoever gave you access; it&apos;s a small, known group here, not a support queue.</li>
        </ul>

        <div className="manual-callout" style={{ marginTop: 22 }}>
          <span className="icon">Good to know</span>
          <p>This isn&apos;t a public product — it&apos;s run for a small group of people who know each other, by the person who set it up. This page describes how the app itself is built to handle data; the person running it is who&apos;s actually accountable for it day to day.</p>
        </div>
      </div>
    </main>
  );
}

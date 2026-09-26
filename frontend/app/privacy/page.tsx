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
          <li><b>Name, email, password</b> <span className="muted">— your password is hashed with bcrypt before it&apos;s ever saved; we can&apos;t read it back, only verify a match at login.</span></li>
          <li><b>MT5 login, server, and investor password</b> <span className="muted">— encrypted at rest (AES-256-GCM), used only so the Desktop Sync App can read your closed-trade history. That&apos;s your broker&apos;s read-only investor password, not your real trading password — TradeJournal never asks for that, and couldn&apos;t place a trade with what it stores even if it wanted to.</span></li>
          <li><b>cTrader connection</b> <span className="muted">— you approve access on cTrader&apos;s own site (OAuth); the access/refresh tokens we get back are encrypted at rest the same way, and are used only to pull your trade history and candle data from cTrader&apos;s API.</span></li>
          <li><b>Your trade history</b> <span className="muted">— symbol, direction, entry/exit, P&amp;L, timestamps, synced read-only from your broker. This is the data every chart, stat, and calendar cell in the app is built from.</span></li>
          <li><b>Everything you type or upload</b> <span className="muted">— notes, grades, emotion tags, playbook answers, strategy names, and screenshots. This is the actual &quot;journal&quot; layered on top of the read-only trade data, and it only exists because you added it.</span></li>
          <li><b>Screenshots</b> <span className="muted">— stored via Cloudinary, the one external service this app uses, so images load quickly without bloating the database. If the database is briefly unreachable when you upload one, it&apos;s held on the server&apos;s own disk and auto-uploaded once it reconnects.</span></li>
          <li><b>Investor access code &amp; password</b> <span className="muted">— generated only if you turn it on for a specific account; the password is bcrypt-hashed and shown to you once, the same way your own login password is handled.</span></li>
        </ul>

        <Sub>What we don&apos;t do</Sub>
        <ul className="manual-feature-list">
          <li>Every broker connection is <b>read-only</b> — TradeJournal cannot place, modify, or close a real trade for you, on MT5 or cTrader.</li>
          <li>No advertising trackers, analytics pixels, or third-party scripts run in the app. Cloudinary is the only external service involved, and it only ever sees the screenshots you choose to upload.</li>
          <li>Your data isn&apos;t sold, rented, or shared with anyone outside your own account.</li>
          <li>If this instance has more than one person signed up, accounts are fully isolated — nobody can see another user&apos;s trades, notes, or broker connections. There&apos;s no admin view into another user&apos;s journal.</li>
        </ul>

        <Sub>Who can see your data</Sub>
        <ul className="manual-feature-list">
          <li>By default: only you, signed in with your own password.</li>
          <li>If you explicitly enable <Link href="/accounts" style={{ color: 'var(--accent)' }}>Investor Access</Link> on a broker account, whoever holds that link and one-time password gets a read-only performance view of <i>that account only</i> — no notes, no other accounts, no ability to edit anything.</li>
          <li>Turning investor access back off (or rotating its password) invalidates the old link immediately.</li>
        </ul>

        <Sub>Your control over it</Sub>
        <ul className="manual-feature-list">
          <li><b>Disconnect</b> any broker account from <Link href="/accounts" style={{ color: 'var(--accent)' }}>Accounts</Link> at any time — syncing stops immediately; trades already synced stay in your history until you remove them yourself.</li>
          <li><b>Export everything</b> — a full JSON or CSV backup is one click away on the <Link href="/archive" style={{ color: 'var(--accent)' }}>Backup &amp; Export</Link> page.</li>
          <li>There&apos;s currently no self-service &quot;delete my account&quot; button — if you want your account and its data fully removed, just ask whoever gave you access; it&apos;s a small, known group here, not a support queue.</li>
        </ul>

        <div className="manual-callout" style={{ marginTop: 22 }}>
          <span className="icon">Good to know</span>
          <p>This isn&apos;t a public product — it&apos;s run for a small group of people who know each other, on servers controlled by the person who set it up. This page describes how the app itself is built to handle data; the person running it is who&apos;s actually accountable for it day to day.</p>
        </div>
      </div>
    </main>
  );
}

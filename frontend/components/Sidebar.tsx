'use client';
import Link from 'next/link';
import { PAGE_PURPOSE } from './pagePurpose';
import { usePathname, useRouter } from 'next/navigation';
import { useState, useEffect, useSyncExternalStore } from 'react';
import { LayoutDashboard, List, BarChart2, X, Menu, Calendar, LogOut, LineChart, HardDrive, Brain, SlidersHorizontal, Landmark, BookOpen, BookMarked, FlaskConical } from 'lucide-react';
import ThemeToggle from './ThemeToggle';
import LogoMark from './LogoMark';

const navGroups = [
  {
    label: 'Overview',
    items: [
      { href: '/', label: 'Dashboard', icon: LayoutDashboard },
    ],
  },
  {
    label: 'Trading',
    items: [
      { href: '/trades', label: 'Trades', icon: List },
      { href: '/calendar', label: 'Calendar', icon: Calendar },
      { href: '/stats', label: 'Analytics', icon: BarChart2 },
      { href: '/performance', label: 'Performance', icon: LineChart },
    ],
  },
  {
    label: 'Improve',
    items: [
      { href: '/coach', label: 'Edge Coach', icon: Brain },
      { href: '/backtest', label: 'Backtest', icon: FlaskConical },
      { href: '/knowledge', label: 'Knowledge Base', icon: BookOpen },
      { href: '/rules', label: 'Playbooks', icon: SlidersHorizontal },
    ],
  },
  {
    label: 'Setup',
    items: [
      { href: '/accounts', label: 'Accounts', icon: Landmark },
      { href: '/archive', label: 'Backup', icon: HardDrive },
      { href: '/manual', label: 'Manual', icon: BookMarked },
    ],
  },
];

function fmtPnl(n: number) {
  const abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 1 });
  return `${n > 0 ? '+' : n < 0 ? '-' : ''}$${abs}`;
}

function NavContent({ path, onClose }: { path: string; onClose?: () => void }) {
  const router = useRouter();
  const [userName, setUserName] = useState('');
  const [userEmail, setUserEmail] = useState('');
  const [accountSummary, setAccountSummary] = useState({ connected: 0, enabled: 0, total: 0 });
  const [pnlSnapshot, setPnlSnapshot] = useState<{ week: number; month: number } | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const uStr = localStorage.getItem('user');
      if (uStr) {
        try {
          const u = JSON.parse(uStr);
          setUserName(u.name || '');
          setUserEmail(u.email || '');
        } catch {}
      }
      const token = localStorage.getItem('token');
      if (token) {
        fetch('/api/trading-accounts', { headers: { Authorization: `Bearer ${token}` } })
          .then(response => response.ok ? response.json() : Promise.reject())
          .then(body => {
            const accounts = body.accounts || [];
            setAccountSummary({
              connected: accounts.filter((account: { enabled: boolean; lastStatus: string }) => account.enabled && account.lastStatus === 'connected').length,
              enabled: accounts.filter((account: { enabled: boolean }) => account.enabled).length,
              total: accounts.length,
            });
          })
          .catch(() => {});

        fetch('/api/calendar', { headers: { Authorization: `Bearer ${token}` } })
          .then(response => response.ok ? response.json() : Promise.reject())
          .then(body => {
            const days: Record<string, { pnl: number }> = body?.days || {};
            const now = new Date();
            const weekStart = new Date(now); weekStart.setDate(now.getDate() - now.getDay()); weekStart.setHours(0, 0, 0, 0);
            const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
            let week = 0, month = 0;
            for (const [dateStr, day] of Object.entries(days)) {
              const d = new Date(`${dateStr}T00:00:00`);
              if (d >= monthStart) month += day.pnl;
              if (d >= weekStart) week += day.pnl;
            }
            setPnlSnapshot({ week, month });
          })
          .catch(() => {});
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const handleLogout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    router.push('/login');
    router.refresh();
    if (onClose) onClose();
  };

  return (
    <>
      <div className="sidebar-logo">
        <div className="sidebar-logo-inner">
          <LogoMark size={36} />
          <div className="logo-text">
            <h1>TradeJournal</h1>
            <span>Trading journal</span>
          </div>
        </div>
      </div>

      <nav className="sidebar-nav">
        {navGroups.map(group => (
          <div key={group.label} className="nav-group">
            <span className="nav-section-label">{group.label}</span>
            {group.items.map(({ href, label, icon: Icon }) => (
              <Link
                key={href}
                href={href}
                className={`nav-item ${path === href ? 'active' : ''}`}
                title={PAGE_PURPOSE[href] ? `${PAGE_PURPOSE[href].question} ${PAGE_PURPOSE[href].detail}` : undefined}
                onClick={onClose}
              >
                <Icon size={16} />
                {label}
              </Link>
            ))}
          </div>
        ))}
      </nav>

      <div className="sidebar-footer">
        {pnlSnapshot && (
          <div className="sidebar-pnl">
            <div className="sidebar-pnl-cell">
              <span className="sidebar-pnl-label">This Week</span>
              <span className={`sidebar-pnl-value ${pnlSnapshot.week > 0 ? 'positive' : pnlSnapshot.week < 0 ? 'negative' : ''}`}>{fmtPnl(pnlSnapshot.week)}</span>
            </div>
            <div className="sidebar-pnl-cell">
              <span className="sidebar-pnl-label">This Month</span>
              <span className={`sidebar-pnl-value ${pnlSnapshot.month > 0 ? 'positive' : pnlSnapshot.month < 0 ? 'negative' : ''}`}>{fmtPnl(pnlSnapshot.month)}</span>
            </div>
          </div>
        )}
        <div className="sidebar-theme">
          <span>Appearance</span>
          <ThemeToggle />
        </div>
        {userEmail && (
          <div className="user-profile-widget">
            <div className="user-info">
              <span className="user-name">{userName || 'Trader'}</span>
              <span className="user-email">{userEmail}</span>
            </div>
            <button className="logout-btn" onClick={handleLogout} aria-label="Sign out">
              <LogOut size={14} />
            </button>
          </div>
        )}
        <div className={`sync-pill ${accountSummary.enabled > accountSummary.connected ? 'attention' : ''}`}>
          <span className="sync-dot" />
          <span>{accountSummary.total === 0 ? 'No trading accounts' : `${accountSummary.connected}/${accountSummary.enabled} accounts connected`}</span>
        </div>
        <Link href="/privacy" className="sidebar-privacy-link" onClick={onClose}>Privacy &amp; data use</Link>
      </div>
    </>
  );
}

const noSubscribe = () => () => {};

export default function Sidebar() {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const signedIn = useSyncExternalStore(noSubscribe, () => Boolean(localStorage.getItem('token')), () => true);

  // The manual is readable before signing in (linked from the login page).
  if (path === '/manual' && !signedIn) return null;

  if (path === '/login' || path === '/signup' || path === '/privacy' || path.startsWith('/investor') || path.startsWith('/oauth') || path === '/forgot-password' || path === '/reset-password') return null;

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="sidebar">
        <NavContent path={path} />
      </aside>

      {/* Mobile topbar */}
      <header className="topbar">
        <div className="topbar-logo">
          <LogoMark size={28} />
          TradeJournal
        </div>
        <button className="hamburger" onClick={() => setOpen(true)} aria-label="Open menu">
          <Menu size={20} />
        </button>
      </header>

      {/* Mobile drawer overlay */}
      <div className={`nav-drawer-overlay ${open ? 'open' : ''}`} onClick={() => setOpen(false)} />

      {/* Mobile drawer */}
      <aside className={`mobile-drawer ${open ? 'open' : ''}`}>
        <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '14px 14px 0' }}>
          <button className="hamburger" onClick={() => setOpen(false)} aria-label="Close menu">
            <X size={18} />
          </button>
        </div>
        <NavContent path={path} onClose={() => setOpen(false)} />
      </aside>
    </>
  );
}

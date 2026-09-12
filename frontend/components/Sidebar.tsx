'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState, useEffect } from 'react';
import { LayoutDashboard, List, BarChart2, TrendingUp, X, Menu, Calendar, LogOut, LineChart, HardDrive, Brain, SlidersHorizontal, Landmark, BookOpen, BookMarked, FlaskConical } from 'lucide-react';
import ThemeToggle from './ThemeToggle';

const navItems = [
  { href: '/',            label: 'Dashboard',    icon: LayoutDashboard },
  { href: '/trades',      label: 'Trades',       icon: List },
  { href: '/calendar',    label: 'Calendar',     icon: Calendar },
  { href: '/stats',       label: 'Analytics',    icon: BarChart2 },
  { href: '/performance', label: 'Performance',  icon: LineChart },
  { href: '/coach',       label: 'Edge Coach',   icon: Brain },
  // Backtest is still being tested locally -- hidden from the nav until it's
  // ready, but the /backtest route itself stays reachable directly by URL.
  // { href: '/backtest', label: 'Backtest', icon: FlaskConical },
  { href: '/knowledge',   label: 'Knowledge Base', icon: BookOpen },
  { href: '/archive',     label: 'Backup',       icon: HardDrive },
  { href: '/rules',       label: 'Playbooks',     icon: SlidersHorizontal },
  { href: '/accounts',    label: 'Accounts',      icon: Landmark },
  { href: '/manual',      label: 'Manual',        icon: BookMarked },
];

function NavContent({ path, onClose }: { path: string; onClose?: () => void }) {
  const router = useRouter();
  const [userName, setUserName] = useState('');
  const [userEmail, setUserEmail] = useState('');
  const [accountSummary, setAccountSummary] = useState({ connected: 0, enabled: 0, total: 0 });

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
          <div className="logo-icon">
            <TrendingUp size={18} />
          </div>
          <div className="logo-text">
            <h1>TradeJournal</h1>
            <span>MT5 Analytics</span>
          </div>
        </div>
      </div>

      <nav className="sidebar-nav">
        <span className="nav-section-label">Menu</span>
        {navItems.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className={`nav-item ${path === href ? 'active' : ''}`}
            onClick={onClose}
          >
            <Icon size={16} />
            {label}
          </Link>
        ))}
      </nav>

      <div className="sidebar-footer">
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
      </div>
    </>
  );
}

export default function Sidebar() {
  const path = usePathname();
  const [open, setOpen] = useState(false);

  if (path === '/login' || path === '/signup' || path.startsWith('/investor')) return null;

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="sidebar">
        <NavContent path={path} />
      </aside>

      {/* Mobile topbar */}
      <header className="topbar">
        <div className="topbar-logo">
          <div className="logo-icon">
            <TrendingUp size={14} />
          </div>
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

'use client';

import { Monitor, Moon, Sun } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { ThemePreference, useTheme } from './ThemeProvider';

const OPTIONS: Array<{ value: ThemePreference; label: string; icon: typeof Sun }> = [
  { value: 'system', label: 'Auto', icon: Monitor },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
];

export default function ThemeToggle({ className = '' }: { className?: string }) {
  const { theme, resolvedTheme, setTheme } = useTheme();
  return (
    <div className={`theme-control ${className}`.trim()} role="group" aria-label={`Appearance, currently ${theme === 'system' ? `automatic (${resolvedTheme})` : theme}`}>
      {OPTIONS.map(({ value, label, icon: Icon }) => (
        <button
          key={value}
          type="button"
          className={theme === value ? 'active' : ''}
          aria-pressed={theme === value}
          aria-label={`Use ${label.toLowerCase()} appearance`}
          title={value === 'system' ? `Follow device (${resolvedTheme})` : `Use ${label.toLowerCase()} mode`}
          onClick={() => setTheme(value)}
        >
          <Icon size={14} aria-hidden="true" />
          <span>{label}</span>
        </button>
      ))}
    </div>
  );
}

export function AuthThemeToggle() {
  const path = usePathname();
  if (path !== '/login' && path !== '/signup') return null;
  return <ThemeToggle className="theme-control-auth" />;
}

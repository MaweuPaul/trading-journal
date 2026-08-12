'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useSyncExternalStore } from 'react';

export type ThemePreference = 'system' | 'light' | 'dark';
type ResolvedTheme = Exclude<ThemePreference, 'system'>;

interface ThemeContextValue {
  theme: ThemePreference;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: ThemePreference) => void;
}

const STORAGE_KEY = 'trade-journal-theme';
const CHANGE_EVENT = 'trade-journal-theme-change';
const SERVER_SNAPSHOT = 'system:light';
const ThemeContext = createContext<ThemeContextValue | null>(null);

const systemTheme = (): ResolvedTheme =>
  window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';

const readPreference = (): ThemePreference => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
  } catch {
    return 'system';
  }
};

const getThemeSnapshot = () => {
  const preference = readPreference();
  const resolved = preference === 'system' ? systemTheme() : preference;
  return `${preference}:${resolved}`;
};

const subscribe = (onChange: () => void) => {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  window.addEventListener('storage', onChange);
  window.addEventListener(CHANGE_EVENT, onChange);
  media.addEventListener('change', onChange);
  return () => {
    window.removeEventListener('storage', onChange);
    window.removeEventListener(CHANGE_EVENT, onChange);
    media.removeEventListener('change', onChange);
  };
};

const applyResolvedTheme = (resolved: ResolvedTheme) => {
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
};

export default function ThemeProvider({ children }: { children: React.ReactNode }) {
  const snapshot = useSyncExternalStore(subscribe, getThemeSnapshot, () => SERVER_SNAPSHOT);
  const [theme, resolvedTheme] = snapshot.split(':') as [ThemePreference, ResolvedTheme];

  useEffect(() => {
    applyResolvedTheme(resolvedTheme);
  }, [resolvedTheme]);

  const setTheme = useCallback((nextTheme: ThemePreference) => {
    try {
      localStorage.setItem(STORAGE_KEY, nextTheme);
    } catch {}
    applyResolvedTheme(nextTheme === 'system' ? systemTheme() : nextTheme);
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);

  const value = useMemo(() => ({ theme, resolvedTheme, setTheme }), [theme, resolvedTheme, setTheme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used inside ThemeProvider');
  return context;
}

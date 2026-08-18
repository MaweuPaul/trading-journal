'use client';
import { useEffect, useState } from 'react';

// One account filter, shared across Dashboard/Trades/Stats/Performance via
// localStorage, so picking an account on one page carries over when you
// navigate to another instead of each page defaulting back to "All accounts".
const STORAGE_KEY = 'tj:accountKeyFilter';

export function useAccountKeyFilter(urlValue?: string) {
  const [accountKeyFilter, setAccountKeyFilterState] = useState(urlValue || '');

  useEffect(() => {
    // A URL-supplied value (shared/bookmarked link) is explicit intent and
    // wins over whatever was last persisted from another page.
    if (urlValue) { setAccountKeyFilterState(urlValue); return; }
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved) setAccountKeyFilterState(saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlValue]);

  const setAccountKeyFilter = (value: string) => {
    setAccountKeyFilterState(value);
    if (value) window.localStorage.setItem(STORAGE_KEY, value);
    else window.localStorage.removeItem(STORAGE_KEY);
  };

  return [accountKeyFilter, setAccountKeyFilter] as const;
}

'use client';
import { useEffect, useState } from 'react';

// One account filter, shared across Dashboard/Trades/Stats/Performance via
// localStorage, so picking an account on one page carries over when you
// navigate to another instead of each page defaulting back to "All accounts".
const STORAGE_KEY = 'tj:accountKeyFilter';

export function useAccountKeyFilter(urlValue?: string) {
  const [accountKeyFilter, setAccountKeyFilterState] = useState(urlValue || '');
  // localStorage can only be read client-side, inside an effect that runs
  // after the first paint — so the persisted account isn't known yet during
  // that first render. A page that fires its data fetch on every render of
  // accountKeyFilter would fetch once unscoped (mixedAccounts:true) and then
  // again correctly scoped, and those two responses can resolve out of
  // order, letting the stale unscoped one win. `ready` lets pages hold off
  // fetching until the persisted value (if any) has actually been read.
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // A URL-supplied value (shared/bookmarked link) is explicit intent and
    // wins over whatever was last persisted from another page.
    if (!urlValue) {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved) setAccountKeyFilterState(saved);
    }
    setReady(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlValue]);

  const setAccountKeyFilter = (value: string) => {
    setAccountKeyFilterState(value);
    if (value) window.localStorage.setItem(STORAGE_KEY, value);
    else window.localStorage.removeItem(STORAGE_KEY);
  };

  return [accountKeyFilter, setAccountKeyFilter, ready] as const;
}

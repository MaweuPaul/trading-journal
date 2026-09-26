import { useSyncExternalStore } from 'react';

// Desktop gets the terminal layouts; below the app sidebar's 900px breakpoint
// the compact mobile layouts are used.
const WIDE_QUERY = '(min-width: 900px)';

function subscribeWide(onChange: () => void) {
  const mq = window.matchMedia(WIDE_QUERY);
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}

export function useIsDesktop() {
  return useSyncExternalStore(subscribeWide, () => window.matchMedia(WIDE_QUERY).matches, () => false);
}

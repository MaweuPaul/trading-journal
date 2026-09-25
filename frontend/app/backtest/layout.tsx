import './backtest.css';
import { Suspense } from 'react';
import BacktestShell from '@/components/backtest/BacktestShell';
import { BacktestProvider } from '@/components/backtest/data';

// The provider lives inside the Suspense boundary (needed for useSearchParams)
// so its fetch can't update context before the shell inside the boundary has
// hydrated -- that caused "server rendered text didn't match" on Sim Balance.
export default function BacktestLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={null}>
      <BacktestProvider>
        <BacktestShell>{children}</BacktestShell>
      </BacktestProvider>
    </Suspense>
  );
}

import { Suspense } from 'react';
import NewBacktestSetup from '@/components/backtest/NewBacktestSetup';

// NewBacktestSetup reads ?strategy= (from a strategy's "Start backtest").
export default function NewBacktestPage() { return <Suspense><NewBacktestSetup /></Suspense>; }

import { Suspense } from 'react';
import LogView from '@/components/backtest/LogView';

// LogView reads its filters from the URL (useSearchParams), which needs a
// Suspense boundary.
export default function BacktestLogPage() { return <Suspense><LogView /></Suspense>; }

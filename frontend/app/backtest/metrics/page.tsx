import { Suspense } from 'react';
import MetricsView from '@/components/backtest/MetricsView';

export default function BacktestMetricsPage() {
  // MetricsView reads ?strategy= (linked from a case study).
  return <Suspense><MetricsView /></Suspense>;
}

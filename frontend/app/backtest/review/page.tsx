import { redirect } from 'next/navigation';

// Trades are now reviewed and saved from the workspace's closeout panel.
export default function BacktestReviewPage() {
  redirect('/backtest/workspace');
}

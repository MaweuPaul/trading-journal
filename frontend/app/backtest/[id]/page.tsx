import BacktestDetail from '@/components/backtest/BacktestDetail';
export default async function BacktestDetailPage({ params }: { params: Promise<{ id: string }> }) { const { id } = await params; return <BacktestDetail id={id} />; }

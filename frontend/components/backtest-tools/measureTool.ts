// The TradingView-style measure tool: drag between two points to read off
// the price move, percent move, and bar count. Ephemeral -- never saved as
// a chart annotation.
import type { IChartApi, ISeriesApi, UTCTimestamp } from 'lightweight-charts';
import { Candle, MeasureRange, fmtPrice, nearestCandleIndex } from './types';

export function drawMeasureOverlay(params: {
  ctx: CanvasRenderingContext2D; chart: IChartApi; series: ISeriesApi<'Candlestick'>;
  range: MeasureRange; candles: Candle[] | null; resolvedTheme: 'light' | 'dark';
}) {
  const { ctx, chart, series, range, candles, resolvedTheme } = params;
  const x1 = chart.timeScale().timeToCoordinate(range.time1 as UTCTimestamp);
  const x2 = chart.timeScale().timeToCoordinate(range.time2 as UTCTimestamp);
  const y1 = series.priceToCoordinate(range.price1);
  const y2 = series.priceToCoordinate(range.price2);
  if (x1 == null || x2 == null || y1 == null || y2 == null) return;

  const up = range.price2 >= range.price1;
  const color = up ? '#10b981' : '#ef4444';
  ctx.save();
  ctx.fillStyle = color + '26'; ctx.strokeStyle = color; ctx.lineWidth = 1.25; ctx.setLineDash([5, 3]);
  ctx.beginPath(); ctx.rect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
  ctx.fill(); ctx.stroke(); ctx.setLineDash([]);

  const priceDiff = range.price2 - range.price1;
  const pctDiff = range.price1 !== 0 ? (priceDiff / range.price1) * 100 : 0;
  const bars = candles ? Math.abs(nearestCandleIndex(candles, range.time2) - nearestCandleIndex(candles, range.time1)) : 0;
  const label1 = `${priceDiff >= 0 ? '+' : ''}${fmtPrice(priceDiff)}  (${pctDiff >= 0 ? '+' : ''}${pctDiff.toFixed(2)}%)`;
  const label2 = `${bars} bar${bars === 1 ? '' : 's'}`;
  ctx.font = '700 11px sans-serif';
  const boxW = Math.max(ctx.measureText(label1).width, ctx.measureText(label2).width) + 16;
  const boxX = Math.min(x1, x2) + Math.abs(x2 - x1) / 2 - boxW / 2;
  const boxY = Math.min(y1, y2) - 42;
  ctx.fillStyle = resolvedTheme === 'dark' ? '#0a0d14ee' : '#ffffffee';
  ctx.fillRect(boxX, boxY, boxW, 34);
  ctx.strokeStyle = color; ctx.strokeRect(boxX, boxY, boxW, 34);
  ctx.fillStyle = color; ctx.fillText(label1, boxX + 8, boxY + 14);
  ctx.fillStyle = resolvedTheme === 'dark' ? '#c9d2e8' : '#334155'; ctx.fillText(label2, boxX + 8, boxY + 28);
  ctx.restore();
}

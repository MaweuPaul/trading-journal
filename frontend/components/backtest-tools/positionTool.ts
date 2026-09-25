// The TradingView-style Long/Short position tool: rendering the shaded
// risk/reward box with draggable SL/TP/Entry lines, hit-testing those
// handles, and the pure price math for placing/dragging a hypothetical trade.
import type { IChartApi, ISeriesApi, UTCTimestamp } from 'lightweight-charts';
import { ClosedTrade, OpenTrade, TradeHandle, fmtPrice } from './types';

export function placeTradeAt(direction: 'long' | 'short', time: number, price: number, riskAmount: number): OpenTrade {
  const riskDistance = Math.max(price * 0.005, 1e-6);
  const stopLoss = direction === 'long' ? price - riskDistance : price + riskDistance;
  const takeProfit = direction === 'long' ? price + riskDistance * 2 : price - riskDistance * 2;
  return { direction, entryTime: time, entryPrice: price, stopLoss, takeProfit, riskAmount };
}

export function updateHandlePrice(trade: OpenTrade, handle: TradeHandle, price: number): OpenTrade {
  if (handle === 'entry') {
    // Dragging the entry line moves the whole position -- SL and TP shift
    // with it so the risk distance and R:R stay exactly what they were.
    const delta = price - trade.entryPrice;
    return {
      ...trade, entryPrice: price,
      stopLoss: trade.stopLoss + delta,
      takeProfit: trade.takeProfit != null ? trade.takeProfit + delta : null,
    };
  }
  if (handle === 'sl') {
    const clamped = trade.direction === 'long' ? Math.min(price, trade.entryPrice - 1e-6) : Math.max(price, trade.entryPrice + 1e-6);
    return { ...trade, stopLoss: clamped };
  }
  const clamped = trade.direction === 'long' ? Math.max(price, trade.entryPrice + 1e-6) : Math.min(price, trade.entryPrice - 1e-6);
  return { ...trade, takeProfit: clamped };
}

export function findTradeHandleAt(y: number, openTrade: OpenTrade | null, closedTrade: unknown, series: ISeriesApi<'Candlestick'> | null): TradeHandle | null {
  if (!openTrade || closedTrade || !series) return null;
  const slY = series.priceToCoordinate(openTrade.stopLoss);
  if (slY != null && Math.abs(y - slY) <= 6) return 'sl';
  if (openTrade.takeProfit != null) {
    const tpY = series.priceToCoordinate(openTrade.takeProfit);
    if (tpY != null && Math.abs(y - tpY) <= 6) return 'tp';
  }
  const entryY = series.priceToCoordinate(openTrade.entryPrice);
  if (entryY != null && Math.abs(y - entryY) <= 6) return 'entry';
  return null;
}

export function drawTradeOverlay(params: {
  ctx: CanvasRenderingContext2D; chart: IChartApi; series: ISeriesApi<'Candlestick'>; canvas: HTMLCanvasElement;
  trade: OpenTrade | ClosedTrade; closedTrade: ClosedTrade | null;
  hoveredHandle: TradeHandle | null; draggingHandle: TradeHandle | null;
}) {
  const { ctx, chart, series, canvas, trade, closedTrade, hoveredHandle, draggingHandle } = params;
  const entryY = series.priceToCoordinate(trade.entryPrice);
  const slY = series.priceToCoordinate(trade.stopLoss);
  const tpY = trade.takeProfit != null ? series.priceToCoordinate(trade.takeProfit) : null;
  const entryX = chart.timeScale().timeToCoordinate(trade.entryTime as UTCTimestamp);
  const boxLeft = entryX ?? 0;
  const riskDistance = Math.abs(trade.entryPrice - trade.stopLoss);
  const rewardDistance = trade.takeProfit != null ? Math.abs(trade.takeProfit - trade.entryPrice) : 0;
  const rewardR = riskDistance > 0 ? rewardDistance / riskDistance : 0;
  const riskUSD = trade.riskAmount;
  const rewardUSD = trade.riskAmount * rewardR;

  if (entryY != null && slY != null) {
    ctx.save(); ctx.fillStyle = '#ef444422';
    ctx.fillRect(boxLeft, Math.min(entryY, slY), canvas.width - boxLeft, Math.abs(slY - entryY));
    ctx.restore();
  }
  if (entryY != null && tpY != null) {
    ctx.save(); ctx.fillStyle = '#10b98122';
    ctx.fillRect(boxLeft, Math.min(entryY, tpY), canvas.width - boxLeft, Math.abs(tpY - entryY));
    ctx.restore();
  }
  const drawLevel = (price: number, color: string, label: string, dashed: boolean, handle: boolean) => {
    const y = series.priceToCoordinate(price); if (y == null) return;
    const handleKey: TradeHandle = label === 'SL' ? 'sl' : label === 'TP' ? 'tp' : 'entry';
    ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = handle && (hoveredHandle === handleKey || draggingHandle === handleKey) ? 2.5 : 1.5;
    ctx.setLineDash(dashed ? [6, 4] : []);
    ctx.beginPath(); ctx.moveTo(boxLeft, y); ctx.lineTo(canvas.width, y); ctx.stroke();
    if (handle) {
      ctx.setLineDash([]); ctx.fillStyle = color;
      ctx.fillRect(canvas.width - 14, y - 5, 10, 10);
    }
    ctx.setLineDash([]); ctx.fillStyle = color; ctx.font = '700 10px sans-serif';
    ctx.fillText(`${label} ${fmtPrice(price)}`, boxLeft + 6, y - 6); ctx.restore();
  };
  drawLevel(trade.entryPrice, '#d4af37', 'Entry', false, !closedTrade);
  drawLevel(trade.stopLoss, '#ef4444', 'SL', true, !closedTrade);
  if (trade.takeProfit != null) drawLevel(trade.takeProfit, '#10b981', 'TP', true, !closedTrade);
  if (entryX != null) {
    ctx.save(); ctx.strokeStyle = '#d4af3799'; ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(entryX, 0); ctx.lineTo(entryX, canvas.height); ctx.stroke(); ctx.restore();
  }
  if (!closedTrade && slY != null) {
    ctx.save(); ctx.fillStyle = '#fca5a5'; ctx.font = '600 10px sans-serif'; ctx.textAlign = 'right';
    ctx.fillText(`Risk ${riskUSD > 0 ? `$${riskUSD.toFixed(0)}` : ''} (1R)`, canvas.width - 18, slY + (slY > (entryY ?? slY) ? 14 : -8));
    ctx.restore();
  }
  if (!closedTrade && tpY != null) {
    ctx.save(); ctx.fillStyle = '#86efac'; ctx.font = '600 10px sans-serif'; ctx.textAlign = 'right';
    ctx.fillText(`Reward ${rewardUSD > 0 ? `$${rewardUSD.toFixed(0)}` : ''} (${rewardR.toFixed(2)}R)`, canvas.width - 18, tpY + (tpY > (entryY ?? tpY) ? 14 : -8));
    ctx.restore();
  }
  if (closedTrade) {
    const exitX = chart.timeScale().timeToCoordinate(closedTrade.exitTime as UTCTimestamp);
    const exitY = series.priceToCoordinate(closedTrade.exitPrice);
    if (exitX != null && exitY != null) {
      ctx.save();
      ctx.fillStyle = closedTrade.outcome === 'win' ? '#10b981' : closedTrade.outcome === 'loss' ? '#ef4444' : '#94a3b8';
      ctx.beginPath(); ctx.arc(exitX, exitY, 5, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    }
  }
}

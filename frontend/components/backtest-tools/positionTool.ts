// The TradingView-style Long/Short position tool: rendering the shaded
// risk/reward box with draggable SL/TP/Entry lines, hit-testing those
// handles, and the pure price math for placing/dragging a hypothetical trade.
import type { IChartApi, ISeriesApi, Logical, UTCTimestamp } from 'lightweight-charts';
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

/** Design tokens the overlay paints with (read from the page's CSS variables). */
export interface OverlayPalette { win: string; loss: string; accent: string; label: string; labelBg: string; }

function withAlpha(hex: string, alpha: number) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function drawTag(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string, bg: string, maxRight: number) {
  ctx.save();
  ctx.font = '600 10px "JetBrains Mono", monospace';
  const w = ctx.measureText(text).width + 12;
  const left = Math.max(2, Math.min(x, maxRight - w - 2));
  ctx.fillStyle = bg;
  ctx.beginPath(); ctx.roundRect(left, y - 8, w, 16, 2); ctx.fill();
  ctx.fillStyle = color; ctx.textBaseline = 'middle';
  ctx.fillText(text, left + 6, y + 0.5);
  ctx.restore();
}

export function drawTradeOverlay(params: {
  ctx: CanvasRenderingContext2D; chart: IChartApi; series: ISeriesApi<'Candlestick'>; canvas: HTMLCanvasElement;
  trade: OpenTrade | ClosedTrade; closedTrade: ClosedTrade | null;
  hoveredHandle: TradeHandle | null; draggingHandle: TradeHandle | null;
  palette: OverlayPalette;
}) {
  const { ctx, chart, series, canvas, trade, closedTrade, hoveredHandle, draggingHandle, palette } = params;
  const entryY = series.priceToCoordinate(trade.entryPrice);
  const slY = series.priceToCoordinate(trade.stopLoss);
  const tpY = trade.takeProfit != null ? series.priceToCoordinate(trade.takeProfit) : null;
  if (entryY == null || slY == null) return;

  // Stop at the right edge of the plot pane so the box never covers the price scale.
  const timeScale = chart.timeScale();
  const paneRight = timeScale.width() || canvas.width;
  const entryX = timeScale.timeToCoordinate(trade.entryTime as UTCTimestamp);
  const left = Math.max(0, entryX ?? 0);
  // Like TradingView's position tool the box has its own width: to the exit
  // candle once closed, otherwise ~24 bars (at least 140px) past entry.
  let right: number;
  const exitX = closedTrade ? timeScale.timeToCoordinate(closedTrade.exitTime as UTCTimestamp) : null;
  if (closedTrade && exitX != null) right = Math.max(exitX, left + 60);
  else {
    const entryLogical = entryX != null ? timeScale.coordinateToLogical(entryX) : null;
    const endX = entryLogical != null ? timeScale.logicalToCoordinate((entryLogical + 24) as Logical) : null;
    right = Math.max(left + 140, endX ?? left + 140);
  }
  right = Math.min(right, paneRight - 2);
  if (right <= left) return;

  const riskDistance = Math.abs(trade.entryPrice - trade.stopLoss);
  const rewardDistance = trade.takeProfit != null ? Math.abs(trade.takeProfit - trade.entryPrice) : 0;
  const rewardR = riskDistance > 0 ? rewardDistance / riskDistance : 0;
  const riskUSD = trade.riskAmount;

  // Zones: reward fades toward entry, risk deepens toward the stop (as in the design).
  if (tpY != null) {
    const g = ctx.createLinearGradient(0, tpY, 0, entryY);
    g.addColorStop(0, withAlpha(palette.win, 0.34)); g.addColorStop(1, withAlpha(palette.win, 0.06));
    ctx.fillStyle = g; ctx.fillRect(left, Math.min(entryY, tpY), right - left, Math.abs(tpY - entryY));
  }
  {
    const g = ctx.createLinearGradient(0, entryY, 0, slY);
    g.addColorStop(0, withAlpha(palette.loss, 0.08)); g.addColorStop(1, withAlpha(palette.loss, 0.3));
    ctx.fillStyle = g; ctx.fillRect(left, Math.min(entryY, slY), right - left, Math.abs(slY - entryY));
  }

  const level = (y: number, color: string, dashed: boolean, handle: TradeHandle) => {
    const active = !closedTrade && (hoveredHandle === handle || draggingHandle === handle);
    ctx.save();
    ctx.strokeStyle = color; ctx.lineWidth = active ? 2.5 : 1.5; ctx.setLineDash(dashed ? [6, 4] : []);
    ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke();
    if (!closedTrade) {
      ctx.setLineDash([]); ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(right, y, active ? 5.5 : 4, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  };
  if (tpY != null) level(tpY, palette.win, false, 'tp');
  level(entryY, palette.accent, true, 'entry');
  level(slY, palette.loss, false, 'sl');

  const signUSD = (n: number) => `${n >= 0 ? '+' : '-'}$${Math.abs(n).toFixed(0)}`;
  const labelX = left + 8;
  if (tpY != null && trade.takeProfit != null) {
    const tag = `TP: ${fmtPrice(trade.takeProfit)} (+${rewardR.toFixed(2)}R${riskUSD > 0 ? ` / ${signUSD(riskUSD * rewardR)}` : ''})`;
    drawTag(ctx, tag, labelX, tpY + (tpY < entryY ? 12 : -12), palette.win, palette.labelBg, right);
  }
  drawTag(ctx, `Entry: ${fmtPrice(trade.entryPrice)} (${trade.direction === 'long' ? 'Long' : 'Short'})`, labelX, entryY, palette.accent, palette.labelBg, right);
  drawTag(ctx, `SL: ${fmtPrice(trade.stopLoss)} (-1.00R${riskUSD > 0 ? ` / -$${riskUSD.toFixed(0)}` : ''})`, labelX, slY + (slY > entryY ? -12 : 12), palette.loss, palette.labelBg, right);

  if (closedTrade && exitX != null) {
    const exitY = series.priceToCoordinate(closedTrade.exitPrice);
    if (exitY != null) {
      ctx.save();
      ctx.fillStyle = closedTrade.outcome === 'win' ? palette.win : closedTrade.outcome === 'loss' ? palette.loss : palette.label;
      ctx.strokeStyle = palette.labelBg; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(exitX, exitY, 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); ctx.restore();
    }
  }
}

/** Dashed vertical marker + "REPLAY FROM" tag at the start of the analysis window. */
export function drawReplayStartMarker(ctx: CanvasRenderingContext2D, chart: IChartApi, canvas: HTMLCanvasElement, time: number, palette: OverlayPalette) {
  const x = chart.timeScale().timeToCoordinate(time as UTCTimestamp);
  const paneRight = chart.timeScale().width() || canvas.width;
  if (x == null || x < 0 || x > paneRight) return;
  ctx.save();
  ctx.strokeStyle = palette.accent; ctx.lineWidth = 1.5; ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke();
  ctx.setLineDash([]);
  ctx.font = '700 9.5px "JetBrains Mono", monospace';
  const text = 'REPLAY FROM';
  const w = ctx.measureText(text).width + 14;
  const tagLeft = Math.min(x + 2, paneRight - w - 2);
  ctx.fillStyle = palette.accent;
  ctx.fillRect(tagLeft, 8, w, 15);
  ctx.fillStyle = '#2a1700'; ctx.textBaseline = 'middle';
  ctx.fillText(text, tagLeft + 7, 16);
  ctx.restore();
}

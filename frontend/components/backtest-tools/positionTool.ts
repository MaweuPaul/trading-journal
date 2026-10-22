// The TradingView-style Long/Short position tool: rendering the shaded
// risk/reward box with draggable SL/TP/Entry lines, hit-testing those
// handles, and the pure price math for placing/dragging a hypothetical trade.
import type { IChartApi, ISeriesApi, Logical, UTCTimestamp } from 'lightweight-charts';
import { Candle, ClosedTrade, OpenTrade, OrderType, SizingMode, SymbolSpec, TradeHandle, fmtPrice } from './types';

// R is always measured against the stop the trade went live with, so moving
// the stop to break-even doesn't turn a winner into 0R.
export const riskPerUnit = (t: OpenTrade) => Math.abs(t.entryPrice - (t.initialStop ?? t.stopLoss));
/** R of the position at `price`. */
export function rAt(t: OpenTrade, price: number) {
  const risk = riskPerUnit(t);
  const gain = t.direction === 'long' ? price - t.entryPrice : t.entryPrice - price;
  return risk ? gain / risk : 0;
}
/** Share of the original position still open. */
export const openFraction = (t: OpenTrade) => Math.max(0, 1 - (t.partials ?? []).reduce((sum, p) => sum + p.fraction, 0));
/** R already banked by partial closes. */
export const bankedR = (t: OpenTrade) => (t.partials ?? []).reduce((sum, p) => sum + p.fraction * rAt(t, p.price), 0);
/** The whole trade's R if what's left closes at `exitPrice`. */
export const totalR = (t: OpenTrade, exitPrice: number) => bankedR(t) + openFraction(t) * rAt(t, exitPrice);
export const outcomeForR = (r: number): 'win' | 'loss' | 'breakeven' => (Math.abs(r) < 0.005 ? 'breakeven' : r > 0 ? 'win' : 'loss');

/**
 * The order an entry at `entry` needs while price is at `market`, as on a
 * broker's ticket: buying below the market is a limit, above it a stop
 * (selling the other way round).
 */
export function orderTypeFor(direction: 'long' | 'short', entry: number, market: number): Exclude<OrderType, 'market'> {
  const below = entry < market;
  return direction === 'long' ? (below ? 'limit' : 'stop') : (below ? 'stop' : 'limit');
}
export const orderLabel = (t: Pick<OpenTrade, 'direction' | 'orderType'>) =>
  `${t.direction === 'long' ? 'Buy' : 'Sell'} ${t.orderType === 'stop' ? 'Stop' : t.orderType === 'limit' ? 'Limit' : 'Market'}`;

/**
 * A new position at the current replay candle. A price within `snap` of
 * `market` (the candle's close) buys/sells at market there; anything further
 * away is a pending limit or stop order that fills once a later candle reaches it.
 */
export function placeTradeAt(direction: 'long' | 'short', time: number, price: number, riskAmount: number, market?: number, snap = 0): OpenTrade {
  const atMarket = market == null || Math.abs(price - market) <= snap;
  const entry = atMarket && market != null ? market : price;
  const riskDistance = Math.max(entry * 0.005, 1e-6);
  const stopLoss = direction === 'long' ? entry - riskDistance : entry + riskDistance;
  const takeProfit = direction === 'long' ? entry + riskDistance * 2 : entry - riskDistance * 2;
  const order: Pick<OpenTrade, 'orderType' | 'pending'> = atMarket
    ? { orderType: 'market' }
    : { orderType: orderTypeFor(direction, entry, market!), pending: true };
  return { direction, entryTime: time, entryPrice: entry, stopLoss, takeProfit, riskAmount, ...order };
}

/**
 * Where a pending order fills on `c`, or null if price didn't reach it. A
 * candle that opens past the order (a gap) fills at its open, like a broker:
 * a limit gets the better price, a stop the worse one.
 */
export function pendingFillPrice(t: OpenTrade, c: Pick<Candle, 'open' | 'high' | 'low'>): number | null {
  if (!t.pending) return null;
  const e = t.entryPrice;
  // Buy orders trigger on the ask (bid candle + spread), sell orders on the bid.
  const sp = t.direction === 'long' ? t.spread ?? 0 : 0;
  const open = c.open + sp, high = c.high + sp, low = c.low + sp;
  const fillsBelow = (t.direction === 'long') === (t.orderType === 'limit'); // buy limit / sell stop: price falls to it
  if (fillsBelow) return low <= e ? Math.min(e, open) : null;
  return high >= e ? Math.max(e, open) : null;
}

/** The price the position would close at on a candle closing at `bidClose`: a short buys back at the ask. */
export const exitPriceAt = (t: OpenTrade, bidClose: number) => (t.direction === 'short' ? bidClose + (t.spread ?? 0) : bidClose);

/**
 * TP1 reached on a trade with a TP2: bank tp1Fraction there, optionally move
 * the stop to entry, and let the rest run to TP2.
 */
export function scaleOutAtTp1(t: OpenTrade, time: number): OpenTrade {
  const tp1 = t.takeProfit!;
  const fraction = Math.min(t.tp1Fraction ?? 0.5, openFraction(t));
  return {
    ...t,
    initialStop: t.initialStop ?? t.stopLoss,
    partials: [...(t.partials ?? []), { time, price: tp1, fraction }],
    stopLoss: t.beAtTp1 ? t.entryPrice : t.stopLoss,
    takeProfit: t.takeProfit2 ?? null,
    takeProfit2: null,
  };
}

/** Round down to the broker's lot step (with a little tolerance for float noise). */
function toStep(lots: number, step: number) {
  if (!(step > 0)) return lots;
  return Math.floor(lots / step + 1e-9) * step;
}
const clean = (v: number) => Number(v.toFixed(8));

/**
 * Size a position the way a broker would.
 * - 'risk': lots = risk $ / (stop distance x USD per point per lot), rounded down to the
 *   lot step (never below the minimum lot); the dollar risk is what those lots really risk.
 * - 'lots': the lots stay fixed, so moving the stop changes the dollar risk.
 * Without a spec (or a USD conversion) the risk stays the typed amount and lots are unknown.
 */
export function sizeTrade(trade: OpenTrade, spec: SymbolSpec | null, mode: SizingMode, riskInput: number, lotsInput: number): OpenTrade {
  const perLot = spec?.usdPerPointPerLot ? Math.abs(trade.entryPrice - trade.stopLoss) * spec.usdPerPointPerLot : 0;
  if (!spec || !(perLot > 0)) return { ...trade, riskAmount: riskInput, lots: null };
  let lots = mode === 'lots' ? toStep(lotsInput, spec.lotStep) : toStep(riskInput / perLot, spec.lotStep);
  lots = Math.max(spec.minLots, lots);
  if (spec.maxLots) lots = Math.min(spec.maxLots, lots);
  lots = clean(lots);
  return { ...trade, lots, riskAmount: clean(lots * perLot) };
}

export function updateHandlePrice(trade: OpenTrade, handle: TradeHandle, price: number, livePrice?: number): OpenTrade {
  if (livePrice != null) {
    if (handle === 'entry') return trade;
    if (handle === 'sl') {
      const clamped = trade.direction === 'long' ? Math.min(price, livePrice - 1e-6) : Math.max(price, livePrice + 1e-6);
      return { ...trade, stopLoss: clamped };
    }
  }
  if (handle === 'entry') {
    // Dragging the entry line moves the whole position -- SL and TP shift
    // with it so the risk distance and R:R stay exactly what they were.
    const delta = price - trade.entryPrice;
    return {
      ...trade, entryPrice: price,
      stopLoss: trade.stopLoss + delta,
      takeProfit: trade.takeProfit != null ? trade.takeProfit + delta : null,
      takeProfit2: trade.takeProfit2 != null ? trade.takeProfit2 + delta : trade.takeProfit2,
    };
  }
  if (handle === 'sl') {
    const clamped = trade.direction === 'long' ? Math.min(price, trade.entryPrice - 1e-6) : Math.max(price, trade.entryPrice + 1e-6);
    return { ...trade, stopLoss: clamped };
  }
  const clamped = trade.direction === 'long' ? Math.max(price, trade.entryPrice + 1e-6) : Math.min(price, trade.entryPrice - 1e-6);
  return handle === 'tp2' ? { ...trade, takeProfit2: clamped } : { ...trade, takeProfit: clamped };
}

export function findTradeHandleAt(y: number, openTrade: OpenTrade | null, closedTrade: unknown, series: ISeriesApi<'Candlestick'> | null): TradeHandle | null {
  if (!openTrade || closedTrade || !series) return null;
  const slY = series.priceToCoordinate(openTrade.stopLoss);
  if (slY != null && Math.abs(y - slY) <= 6) return 'sl';
  if (openTrade.takeProfit != null) {
    const tpY = series.priceToCoordinate(openTrade.takeProfit);
    if (tpY != null && Math.abs(y - tpY) <= 6) return 'tp';
  }
  if (openTrade.takeProfit2 != null) {
    const tp2Y = series.priceToCoordinate(openTrade.takeProfit2);
    if (tp2Y != null && Math.abs(y - tp2Y) <= 6) return 'tp2';
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
  // After a timeframe switch the entry/exit time can fall inside a candle
  // (a 5m exit on the 4H): use the candle it's in.
  const data = series.data();
  const xAt = (time: number) => {
    const exact = timeScale.timeToCoordinate(time as UTCTimestamp);
    if (exact != null) return exact;
    let lo = 0, hi = data.length - 1, found = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (Number(data[mid].time) <= time) { found = mid; lo = mid + 1; } else hi = mid - 1; }
    return found >= 0 ? timeScale.timeToCoordinate(data[found].time) : null;
  };
  const entryX = xAt(trade.entryTime);
  const left = Math.max(0, entryX ?? 0);
  // Like TradingView's position tool the box has its own width: to the exit
  // candle once closed, otherwise ~24 bars (at least 140px) past entry.
  let right: number;
  const exitX = closedTrade ? xAt(closedTrade.exitTime) : null;
  if (closedTrade && exitX != null) right = Math.max(exitX, left + 60);
  else {
    const entryLogical = entryX != null ? timeScale.coordinateToLogical(entryX) : null;
    const endX = entryLogical != null ? timeScale.logicalToCoordinate((entryLogical + 24) as Logical) : null;
    right = Math.max(left + 140, endX ?? left + 140);
  }
  right = Math.min(right, paneRight - 2);
  if (right <= left) return;

  const rewardR = trade.takeProfit != null ? rAt(trade, trade.takeProfit) : 0;
  const stopR = rAt(trade, trade.stopLoss);
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
  const tp2Y = trade.takeProfit2 != null ? series.priceToCoordinate(trade.takeProfit2) : null;
  if (tp2Y != null) {
    // The runner's zone beyond TP1, fainter than the main reward zone.
    if (tpY != null) { ctx.fillStyle = withAlpha(palette.win, 0.12); ctx.fillRect(left, Math.min(tpY, tp2Y), right - left, Math.abs(tp2Y - tpY)); }
    level(tp2Y, palette.win, true, 'tp2');
  }
  if (tpY != null) level(tpY, palette.win, false, 'tp');
  level(entryY, palette.accent, true, 'entry');
  level(slY, palette.loss, false, 'sl');

  const signUSD = (n: number) => `${n >= 0 ? '+' : '-'}$${Math.abs(n).toFixed(0)}`;
  const labelX = left + 8;
  if (tpY != null && trade.takeProfit != null) {
    const share = trade.takeProfit2 != null ? ` · ${Math.round((trade.tp1Fraction ?? 0.5) * 100)}%` : '';
    const tag = `${trade.takeProfit2 != null ? 'TP1' : 'TP'}: ${fmtPrice(trade.takeProfit)} (+${rewardR.toFixed(2)}R${riskUSD > 0 ? ` / ${signUSD(riskUSD * rewardR)}` : ''}${share})`;
    drawTag(ctx, tag, labelX, tpY + (tpY < entryY ? 12 : -12), palette.win, palette.labelBg, right);
  }
  if (tp2Y != null && trade.takeProfit2 != null) {
    const r2 = rAt(trade, trade.takeProfit2);
    drawTag(ctx, `TP2: ${fmtPrice(trade.takeProfit2)} (+${r2.toFixed(2)}R)`, labelX, tp2Y + (tp2Y < entryY ? 12 : -12), palette.win, palette.labelBg, right);
  }
  const entryName = trade.pending ? `${orderLabel(trade)} ${fmtPrice(trade.entryPrice)} · pending` : `Entry: ${fmtPrice(trade.entryPrice)}`;
  drawTag(ctx, `${entryName} (${trade.direction === 'long' ? 'Long' : 'Short'}${trade.lots != null ? ` · ${trade.lots} lots` : ''})`, labelX, entryY, palette.accent, palette.labelBg, right);
  const stopUSD = riskUSD * stopR;
  drawTag(ctx, `SL: ${fmtPrice(trade.stopLoss)} (${stopR >= 0 ? '+' : ''}${stopR.toFixed(2)}R${riskUSD > 0 ? ` / ${stopUSD >= 0 ? '+' : '-'}$${Math.abs(stopUSD).toFixed(Math.abs(stopUSD) < 1000 ? 2 : 0)}` : ''})`, labelX, slY + (slY > entryY ? -12 : 12), palette.loss, palette.labelBg, right);

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

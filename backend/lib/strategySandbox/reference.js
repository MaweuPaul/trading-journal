// The strategy_api tool's text: how to write code for run_strategy.
const REFERENCE = `
# Writing a strategy for run_strategy

Your code is plain JavaScript (ES2023, no imports, no network, no Date.now).
Define onBar(ctx); it is called once per CLOSED candle of the base timeframe,
oldest first. You only ever see candles that have closed, so there is no way
to look ahead. Optional: init(ctx) before the first candle, onEnd(ctx) after
the last. Globals and ctx.state keep values between calls.

## Reading the market
ctx.bar                     latest closed candle { time (unix s), iso, open, high, low, close, volume }
ctx.candle(back, tf)        a closed candle, back = 0 is the latest; tf defaults to the base
ctx.bars(n, tf)             last n closed candles, oldest first
ctx.series(tf)              whole closed arrays { time[], open[], high[], low[], close[], volume[] }
ctx.forming(tf)             the still-forming candle of a higher timeframe (from closed base candles only)
ctx.sma(p, o) ctx.ema(p, o) ctx.rsi(p, o) ctx.atr(p, o)
                            current value; o = { tf, source: 'close'|'open'|'high'|'low'|'hl2'|'hlc3', back }
ctx.ta.*                    sma, ema, rma, rsi, atr, trueRange (arrays in, arrays out), highest, lowest, stdev (last n)
ctx.time                    candle close time: { unix, iso, utc, ny, london }, each zone
                            { hour, minute, minutes (since midnight), weekday (0 = Sun), weekdayName, date 'YYYY-MM-DD' }
ctx.at(zone, date, h, m)    unix seconds of a wall-clock time: zone 'ny' | 'london' | 'utc' (DST handled)
ctx.params                  the params you passed to run_strategy (tune without editing code)
Higher timeframes must be listed in run_strategy's timeframes (e.g. ["1h", "1day"]).

## Your position
ctx.position   null or { direction, entryPrice, entryTime, stopLoss, initialStopLoss, takeProfit, riskAmount, barsHeld, unrealizedR, tag }
ctx.order      null or the pending order { type, direction, price, stopLoss, takeProfit, expiresAt, tag }
ctx.events     what happened since the last call: filled, closed { reason, rMultiple, outcome }, expired, rejected { reason }
ctx.stats      { trades, wins, losses, totalR, lastTrade }
One position or pending order at a time.

## Acting (executed at this candle's close)
ctx.buy({ stop, target, risk, tag, notes, features })        market entry at the close
ctx.sell({ ... })
ctx.buyLimit(price, { stop, target, expiresInBars | expiresAt, ... })   also sellLimit, buyStop, sellStop
ctx.modify({ stop, target })       move the position's stop/target (or { price, stop, target } of a pending order)
ctx.cancel()                        cancel the pending order
ctx.close({ notes })                exit the position at the close
ctx.log(...)                        debug output (first 300 lines kept); console.log works too
stop is required; target is optional. risk (USD) defaults to riskAmount. tag labels the setup
(results can be broken down by it). features records entry conditions ({ name: number | boolean | short text }),
so get_strategy_run / get_metrics can split results by them (groupBy "feature:<name>").

## How orders are settled (by the server, not your code)
Market entries fill at the candle close (plus spread if costs.spread is set). Limit/stop orders fill on
1-minute candles: a gap through the price fills at the minute's open; in the fill minute only the stop counts.
Stops and targets are checked on every candle; when one candle reaches both, 1-minute candles decide, and
if even they can't, the stop is assumed. R is always measured from the original stop. Commission (USD per
trade) is taken off each trade's result. A position still open at the end is closed at the last close.

## Example: 20/50 EMA cross, 1.5 ATR stop, 2R target, New York hours only
function onBar(ctx) {
  const fast = ctx.ema(20), slow = ctx.ema(50), fastPrev = ctx.ema(20, { back: 1 }), slowPrev = ctx.ema(50, { back: 1 });
  const atr = ctx.atr(14);
  if (slowPrev == null || atr == null || ctx.position || ctx.order) return;
  const h = ctx.time.ny.hour;
  if (h < 9 || h >= 16) return;
  const c = ctx.bar.close, k = ctx.params.atrStop ?? 1.5;
  if (fastPrev <= slowPrev && fast > slow) ctx.buy({ stop: c - k * atr, target: c + 2 * k * atr, tag: 'cross up', features: { atr } });
  if (fastPrev >= slowPrev && fast < slow) ctx.sell({ stop: c + k * atr, target: c - 2 * k * atr, tag: 'cross down', features: { atr } });
}

## Example: opening range sweep (New York, 5-minute base)
let day = null, hi = null, lo = null, done = false;
function onBar(ctx) {
  const ny = ctx.time.ny;
  if (ny.date !== day) { day = ny.date; hi = lo = null; done = false; }
  if (ny.minutes === 9 * 60 + 30) { const b = ctx.bar; hi = b.high; lo = b.low; return; } // the 9:25-9:30 candle
  if (hi == null || done || ctx.position || ny.minutes > 15 * 60) return;
  const b = ctx.bar, w = hi - lo;
  if (b.high > hi && b.close < hi && b.close > lo) { done = true; ctx.sell({ stop: b.high + 0.1 * w, target: lo, tag: 'swept high' }); }
  else if (b.low < lo && b.close > lo && b.close < hi) { done = true; ctx.buy({ stop: b.low - 0.1 * w, target: hi, tag: 'swept low' }); }
}
`.trim();

module.exports = { REFERENCE };

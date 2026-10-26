import type { IChartApi, ISeriesApi, UTCTimestamp } from 'lightweight-charts';
import type { Candle } from '../backtest-tools/types';

export interface Session {
  name: string;
  timeZone: string;
  startHour: number;
  startMinute: number;
  endHour: number;
  endMinute: number;
  color: string;
}

export const SESSIONS: Session[] = [
  {
    name: 'Tokyo',
    timeZone: 'Asia/Tokyo',
    startHour: 9,
    startMinute: 0,
    endHour: 15,
    endMinute: 0,
    color: '#ef4444',
  },
  {
    name: 'Sydney',
    timeZone: 'Australia/Sydney',
    startHour: 7,
    startMinute: 0,
    endHour: 16,
    endMinute: 0,
    color: '#22c55e',
  },
  {
    name: 'London',
    timeZone: 'Europe/London',
    startHour: 8,
    startMinute: 0,
    endHour: 16,
    endMinute: 30,
    color: '#38bdf8',
  },
  {
    name: 'New York',
    timeZone: 'America/New_York',
    startHour: 8,
    startMinute: 0,
    endHour: 17,
    endMinute: 0,
    color: '#f59e0b',
  },
];

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Minutes since local midnight in `timeZone` for a unix-seconds time. */

export function localminutes(unixSec: number, timeZone: string): number {
  let fmt = formatters.get(timeZone);

  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, fmt);
  }
  const parts = fmt.formatToParts(new Date(unixSec * 1000));
  const hour = Number(parts.find((p) => p.type === 'hour')?.value);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value);
  return hour * 60 + minute;
}

export function isSessionOpen(unixSec: number, session: Session): boolean {
  const minutes = localminutes(unixSec, session.timeZone);
  const startMinutes = session.startHour * 60 + session.startMinute;
  const endMinutes = session.endHour * 60 + session.endMinute;

  // crosses midnight
  if (endMinutes < startMinutes) {
    return minutes >= startMinutes || minutes < endMinutes;
  }

  return minutes >= startMinutes && minutes < endMinutes;
}

export interface SessionBox {
  session: Session;
  open: boolean;
  high: number;
  low: number;
  startTime: number;
  endTime: number;
}

/** One box per occurrence of `session`, oldest first. The last box may still be open. */
export function sessionBoxes(
  candles: Candle[],
  session: Session,
): SessionBox[] {
  const boxes: SessionBox[] = [];
  let current: SessionBox | null = null;
  let wasOpen = false;

  for (const candle of candles) {
    const isOpen = isSessionOpen(candle.time, session);

    if (isOpen && !wasOpen) {
      // no -> yes: session just opened, start a new box
      current = {
        session,
        open: true,
        high: candle.high,
        low: candle.low,
        startTime: candle.time,
        endTime: candle.time,
      };
      boxes.push(current);
    } else if (isOpen && current) {
      // yes -> yes: still open, grow the box
      current.high = Math.max(current.high, candle.high);
      current.low = Math.min(current.low, candle.low);
      current.endTime = candle.time;
    } else if (!isOpen && wasOpen && current) {
      // yes -> no: session just closed
      current.open = false;
      current = null;
    }
    // no -> no: nothing to do

    wasOpen = isOpen;
  }

  return boxes;
}

/**
 * The boxes as they looked at replay candle `idx`: later boxes dropped, and the
 * one in progress cut back to candles 0..idx. `current` is candle `idx` as the
 * replay shows it (it may still be forming), so its high/low never leak ahead.
 * `boxes` come from sessionBoxes over all loaded candles, computed once.
 */
export function sessionBoxesAt(
  boxes: SessionBox[],
  candles: Candle[],
  idx: number,
  current: Candle,
): SessionBox[] {
  const now = current.time;
  const out: SessionBox[] = [];

  for (const box of boxes) {
    if (box.startTime > now) continue; // hasn't started yet
    if (box.endTime < now) {
      out.push(box); // finished before now
      continue;
    }
    // In progress: rebuild high/low from its start up to now.
    let high = current.high;
    let low = current.low;
    for (let i = idx - 1; i >= 0 && candles[i].time >= box.startTime; i--) {
      high = Math.max(high, candles[i].high);
      low = Math.min(low, candles[i].low);
    }
    out.push({ ...box, open: true, high, low, endTime: now });
  }

  return out;
}

/** Draw session boxes on the overlay canvas, behind everything else. */
export function drawSessionOverlay(params: {
  ctx: CanvasRenderingContext2D;
  chart: IChartApi;
  series: ISeriesApi<'Candlestick'>;
  boxes: SessionBox[];
}) {
  const { ctx, chart, series, boxes } = params;
  const ts = chart.timeScale();
  // Times map to candle centres; widen by half a bar so the box covers whole candles.
  const halfBar = ts.options().barSpacing / 2;

  ctx.save();
  ctx.font = '600 10px sans-serif';
  ctx.lineWidth = 1;
  for (const box of boxes) {
    const x1 = ts.timeToCoordinate(box.startTime as UTCTimestamp);
    const x2 = ts.timeToCoordinate(box.endTime as UTCTimestamp);
    const y1 = series.priceToCoordinate(box.high);
    const y2 = series.priceToCoordinate(box.low);
    if (x1 == null || x2 == null || y1 == null || y2 == null) continue;

    const left = x1 - halfBar;
    const width = x2 - x1 + halfBar * 2;
    const color = box.session.color;
    ctx.fillStyle = color + '14'; // ~8% opacity so candles show through
    ctx.fillRect(left, y1, width, y2 - y1);
    ctx.strokeStyle = color + '80';
    ctx.setLineDash(box.open ? [4, 3] : []); // dashed while still forming
    ctx.strokeRect(left, y1, width, y2 - y1);
    if (width > 40) {
      ctx.fillStyle = color;
      ctx.fillText(box.session.name, left + 4, y1 - 4);
    }
  }
  ctx.restore();
}

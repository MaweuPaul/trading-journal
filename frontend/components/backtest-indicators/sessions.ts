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
    startHour: 8,
    startMinute: 0,
    endHour: 16,
    endMinute: 30,
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
    endHour: 16,
    endMinute: 30,
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

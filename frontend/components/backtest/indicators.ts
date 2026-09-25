// Indicator math for the Backtest chart. Every value at index i only uses
// candles 0..i, so slicing to the replay position never leaks future data.

/** Exponential moving average; null until `period` values exist (seeded with an SMA). */
export function ema(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((s, v) => s + v, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder's RSI; null until `period` changes exist. */
export function rsi(closes: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let avgGain = gain / period, avgLoss = loss / period;
  const value = () => (avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  out[period] = value();
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = value();
  }
  return out;
}

export const EMA_CONFIG = [
  { period: 20, color: '#22d3ee', label: 'EMA 20' },
  { period: 50, color: '#ffc174', label: 'EMA 50' },
  { period: 200, color: '#c084fc', label: 'EMA 200' },
] as const;

const SYMBOL_NAMES: Record<string, [string, string]> = {
  XAUUSD: ['Gold / US Dollar', 'Spot Gold'], XAGUSD: ['Silver / US Dollar', 'Spot Silver'],
  BTCUSD: ['Bitcoin / US Dollar', 'Bitcoin'], ETHUSD: ['Ethereum / US Dollar', 'Ethereum'],
  US30: ['Dow Jones 30', 'Dow 30'], NAS100: ['Nasdaq 100', 'Nasdaq 100'], US100: ['Nasdaq 100', 'Nasdaq 100'],
  SPX500: ['S&P 500', 'S&P 500'], US500: ['S&P 500', 'S&P 500'], SPY: ['SPDR S&P 500 ETF', 'S&P 500 ETF'],
  GER40: ['DAX 40', 'DAX 40'], UK100: ['FTSE 100', 'FTSE 100'], USOIL: ['WTI Crude Oil', 'WTI Crude'], UKOIL: ['Brent Crude Oil', 'Brent'],
};
const CURRENCIES: Record<string, string> = {
  USD: 'US Dollar', EUR: 'Euro', GBP: 'British Pound', JPY: 'Japanese Yen', AUD: 'Australian Dollar',
  NZD: 'New Zealand Dollar', CAD: 'Canadian Dollar', CHF: 'Swiss Franc',
};
/** [long name, short name] for the ticker header, e.g. ['Gold / US Dollar', 'Spot Gold']. */
export function symbolDescription(symbol: string): [string, string] | null {
  const s = symbol.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (SYMBOL_NAMES[s]) return SYMBOL_NAMES[s];
  const base = CURRENCIES[s.slice(0, 3)], quote = CURRENCIES[s.slice(3, 6)];
  if (s.length === 6 && base && quote) return [`${base} / ${quote}`, `${s.slice(0, 3)}/${s.slice(3)}`];
  return null;
}

/** Trading session for a UTC time -- shown next to the replay tick. */
export function sessionLabel(unixSeconds: number) {
  const h = new Date(unixSeconds * 1000).getUTCHours();
  if (h >= 22 || h < 7) return 'Asia';
  if (h < 12) return 'London';
  if (h < 16) return 'London/NY';
  if (h < 21) return 'New York';
  return 'NY Close';
}

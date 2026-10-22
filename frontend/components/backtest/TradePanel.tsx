'use client';
// The backtest workspace's right-hand panel, laid out like cTrader's replay:
// a new-order ticket (market / limit / stop), the open position with its
// management buttons, the session timeline, and the account.
import { useState } from 'react';
import { Icon } from './BacktestShell';
import { fmtR, fmtUSD } from './data';
import type { TimelineEvent } from './session';
import { ClosedTrade, OpenTrade, OrderType, SizingMode, SymbolSpec, fmtPrice } from '../backtest-tools/types';
import { bankedR, openFraction, orderLabel, orderTypeFor, rAt } from '../backtest-tools/positionTool';

export interface TicketOrder {
  direction: 'long' | 'short';
  type: OrderType;
  /** Entry for limit/stop orders (market orders fill at the current close). */
  price: number | null;
  /** Stop distance from entry, in price. */
  stopDistance: number;
  /** Target as a multiple of the stop distance; null for none. */
  tpR: number | null;
  tp2R: number | null;
  tp1Fraction: number;
  beAtTp1: boolean;
}

export interface TradePanelProps {
  marketPrice: number | null;
  replayTime: number | null;
  openTrade: OpenTrade | null;
  closedTrade: ClosedTrade | null;
  tradeLive: boolean;
  /** No new trade allowed (one already open, or no chart). */
  locked: boolean;
  unrealizedR: number;
  sizing: {
    mode: SizingMode; setMode: (m: SizingMode) => void;
    risk: string; setRisk: (v: string) => void;
    lots: string; setLots: (v: string) => void;
    spec: SymbolSpec | null; specNote: string;
  };
  account: {
    start: number | null; current: number | null; realized: number;
    riskPct: number | null; balanceInput: string; setBalance: (v: string) => void;
  };
  placingDirection: 'long' | 'short' | null;
  onPlace: (order: TicketOrder) => string | null;
  onPlaceOnChart: (direction: 'long' | 'short') => void;
  actions: {
    takePartial: (fraction: number) => void;
    stopToBreakeven: () => void;
    closeNow: () => void;
    cancel: () => void;
    toggleTp2: () => void;
    setTp1Fraction: (f: number) => void;
    setBeAtTp1: (v: boolean) => void;
    logOutcome: () => void;
  };
  timeline: TimelineEvent[];
  fmtTime: (unixSeconds: number) => string;
}

const TYPES: { id: OrderType; label: string }[] = [
  { id: 'market', label: 'Market' }, { id: 'limit', label: 'Limit' }, { id: 'stop', label: 'Stop' },
];
const FRACTIONS = [0.25, 0.33, 0.5, 0.67, 0.75];

const card = 'tw:border-b tw:border-outline-variant tw:px-3 tw:py-2.5';
const heading = 'tw:flex tw:items-center tw:justify-between tw:text-[10px] tw:font-semibold tw:uppercase tw:tracking-wider tw:text-on-surface-variant tw:mb-2';
const field = 'tw:w-full tw:bg-surface-container-lowest tw:border tw:border-outline-variant tw:rounded tw:px-2 tw:py-1 tw:font-mono-metric-md tw:text-[12px] tw:text-on-surface tw:focus:outline-none tw:focus:border-primary-container tw:disabled:opacity-50';
const smallBtn = 'tw:px-2 tw:py-1 tw:rounded tw:border tw:border-outline-variant tw:text-[11px] tw:font-semibold tw:text-on-surface tw:hover:bg-surface-container-high tw:disabled:opacity-40';

function OrderTicket(p: TradePanelProps) {
  const [type, setType] = useState<OrderType>('market');
  const [priceInput, setPriceInput] = useState('');
  const [stopInput, setStopInput] = useState('');
  const [tpOn, setTpOn] = useState(true);
  const [tpR, setTpR] = useState('2');
  const [tp2On, setTp2On] = useState(false);
  const [tp2R, setTp2R] = useState('3');
  const [fraction, setFraction] = useState(0.5);
  const [be, setBe] = useState(true);
  const [error, setError] = useState('');

  const market = p.marketPrice;
  const autoStop = market != null ? Number((market * 0.005).toPrecision(3)) : null;
  const stopDistance = Number(stopInput) > 0 ? Number(stopInput) : autoStop;
  const entry = type === 'market' ? market : Number(priceInput) || market;
  const disabled = p.locked || market == null;

  const place = (direction: 'long' | 'short') => {
    if (market == null || !stopDistance) return;
    const price = type === 'market' ? null : Number(priceInput) || null;
    if (type !== 'market' && price == null) { setError('Enter the order price'); return; }
    if (price != null && orderTypeFor(direction, price, market) !== type) {
      const side = direction === 'long' ? 'Buy' : 'Sell';
      const where = (direction === 'long') === (type === 'limit') ? 'below' : 'above';
      setError(`A ${side} ${type === 'limit' ? 'Limit' : 'Stop'} goes ${where} the current price (${fmtPrice(market)})`);
      return;
    }
    setError('');
    const err = p.onPlace({
      direction, type, price, stopDistance,
      tpR: tpOn ? Number(tpR) || null : null,
      tp2R: tpOn && tp2On ? Number(tp2R) || null : null,
      tp1Fraction: fraction, beAtTp1: be,
    });
    if (err) setError(err);
  };

  const sideBtn = (direction: 'long' | 'short') => {
    const long = direction === 'long';
    const label = type === 'market' ? (long ? 'Buy' : 'Sell') : `${long ? 'Buy' : 'Sell'} ${type === 'limit' ? 'Limit' : 'Stop'}`;
    return (
      <button type="button" disabled={disabled} onClick={() => place(direction)}
        title={type === 'market' ? `${long ? 'Buy' : 'Sell'} at the current close` : `Place a pending ${label.toLowerCase()} order`}
        className={`tw:flex-1 tw:flex tw:flex-col tw:items-center tw:py-1.5 tw:rounded tw:border tw:transition tw:active:scale-[0.98] tw:disabled:opacity-40 ${long
          ? 'tw:border-secondary/60 tw:bg-secondary/10 tw:hover:bg-secondary/20 tw:text-secondary'
          : 'tw:border-tertiary/60 tw:bg-tertiary/10 tw:hover:bg-tertiary/20 tw:text-tertiary'}`}>
        <span className="tw:text-[10px] tw:font-semibold tw:uppercase">{label}</span>
        <span className="tw:font-mono-metric-md tw:text-[15px] tw:font-bold">{entry != null ? fmtPrice(entry) : '—'}</span>
      </button>
    );
  };

  return (
    <section className={card} aria-label="New order">
      <div className={heading}><span>New order</span>
        {p.locked && p.openTrade && <span className="tw:normal-case tw:tracking-normal tw:text-[10px]">one position at a time</span>}
      </div>
      <div className="tw:grid tw:grid-cols-3 tw:gap-0.5 tw:bg-surface-container-lowest tw:p-0.5 tw:rounded tw:border tw:border-outline-variant tw:mb-2" role="tablist" aria-label="Order type">
        {TYPES.map(t => (
          <button key={t.id} type="button" role="tab" aria-selected={type === t.id} onClick={() => { setType(t.id); setError(''); if (t.id !== 'market' && !priceInput && market != null) setPriceInput(fmtPrice(market)); }}
            className={`tw:py-1 tw:rounded tw:text-[11px] tw:font-semibold ${type === t.id ? 'tw:bg-primary-container tw:text-on-primary' : 'tw:text-on-surface-variant tw:hover:text-on-surface'}`}>{t.label}</button>
        ))}
      </div>
      <div className="tw:flex tw:gap-1.5 tw:mb-2">{sideBtn('short')}{sideBtn('long')}</div>

      {type !== 'market' && (
        <label className="tw:block tw:mb-2 tw:text-[11px] tw:text-on-surface-variant">Order price
          <input type="number" step="any" value={priceInput} onChange={e => setPriceInput(e.target.value)} disabled={disabled} className={`${field} tw:mt-0.5`} />
        </label>
      )}

      <div className="tw:grid tw:grid-cols-2 tw:gap-2 tw:mb-2">
        <label className="tw:text-[11px] tw:text-on-surface-variant"
          title={p.sizing.spec ? `${p.sizing.spec.symbol}: 1 lot = ${p.sizing.spec.contractSize.toLocaleString()} units · min ${p.sizing.spec.minLots} · step ${p.sizing.spec.lotStep}` : p.sizing.specNote || 'Loading contract specs…'}>
          <select aria-label="Size by" value={p.sizing.mode} onChange={e => p.sizing.setMode(e.target.value as SizingMode)} className="tw:bg-transparent tw:text-on-surface-variant tw:text-[11px] tw:focus:outline-none">
            <option value="risk">Risk $</option>
            <option value="lots" disabled={!p.sizing.spec?.usdPerPointPerLot}>Lots</option>
          </select>
          {p.sizing.mode === 'risk'
            ? <input aria-label="Risk amount in dollars" type="number" min="0" step="any" value={p.sizing.risk} onChange={e => p.sizing.setRisk(e.target.value)} className={`${field} tw:mt-0.5`} />
            : <input aria-label="Position size in lots" type="number" min="0" step={p.sizing.spec?.lotStep ?? 0.01} value={p.sizing.lots} onChange={e => p.sizing.setLots(e.target.value)} className={`${field} tw:mt-0.5`} />}
        </label>
        <label className="tw:text-[11px] tw:text-on-surface-variant">Stop distance
          <input type="number" min="0" step="any" value={stopInput} placeholder={autoStop != null ? String(autoStop) : ''} onChange={e => setStopInput(e.target.value)} disabled={disabled}
            title="How far the stop sits from the entry, in price. Empty = 0.5% of the price." className={`${field} tw:mt-0.5`} />
        </label>
      </div>
      {p.account.riskPct != null && (
        <div className="tw:text-[10px] tw:text-on-surface-variant tw:-mt-1 tw:mb-2">
          Risk {p.account.riskPct < 1 ? p.account.riskPct.toFixed(2) : p.account.riskPct.toFixed(1)}% of balance
          {!p.sizing.spec && p.sizing.specNote && <span className="tw:text-error" title={p.sizing.specNote}> · lots unavailable</span>}
        </div>
      )}

      <div className="tw:flex tw:flex-col tw:gap-1.5 tw:text-[11px] tw:text-on-surface-variant">
        <label className="tw:flex tw:items-center tw:gap-1.5">
          <input type="checkbox" checked={tpOn} onChange={e => setTpOn(e.target.checked)} />
          <span className="tw:w-12">{tp2On ? 'TP1' : 'Target'}</span>
          <input type="number" min="0" step="0.1" value={tpR} onChange={e => setTpR(e.target.value)} disabled={!tpOn} aria-label="Target in R" className={`${field} tw:w-16`} />
          <span>R</span>
        </label>
        <label className="tw:flex tw:items-center tw:gap-1.5">
          <input type="checkbox" checked={tp2On} onChange={e => setTp2On(e.target.checked)} disabled={!tpOn} />
          <span className="tw:w-12">TP2</span>
          <input type="number" min="0" step="0.1" value={tp2R} onChange={e => setTp2R(e.target.value)} disabled={!tpOn || !tp2On} aria-label="Second target in R" className={`${field} tw:w-16`} />
          <span>R</span>
        </label>
        {tpOn && tp2On && (
          <div className="tw:flex tw:items-center tw:gap-2 tw:pl-5">
            <label className="tw:flex tw:items-center tw:gap-1">Close
              <select value={fraction} onChange={e => setFraction(Number(e.target.value))} className="tw:bg-surface-container-lowest tw:border tw:border-outline-variant tw:rounded tw:px-1 tw:text-on-surface">
                {FRACTIONS.map(f => <option key={f} value={f}>{Math.round(f * 100)}%</option>)}
              </select>at TP1
            </label>
            <label className="tw:flex tw:items-center tw:gap-1"><input type="checkbox" checked={be} onChange={e => setBe(e.target.checked)} />SL→BE</label>
          </div>
        )}
      </div>
      {error && <p className="tw:text-error tw:text-[11px] tw:mt-2" role="alert">{error}</p>}

      <div className="tw:flex tw:items-center tw:gap-1.5 tw:mt-2.5 tw:text-[10px] tw:text-on-surface-variant">
        <span>Or on the chart:</span>
        {(['long', 'short'] as const).map(d => (
          <button key={d} type="button" disabled={disabled} onClick={() => p.onPlaceOnChart(d)} aria-pressed={p.placingDirection === d}
            className={`${smallBtn} tw:py-0.5 ${p.placingDirection === d ? (d === 'long' ? 'tw:bg-secondary/20 tw:text-secondary' : 'tw:bg-tertiary/20 tw:text-tertiary') : ''}`}>
            {d === 'long' ? 'Long [L]' : 'Short [S]'}
          </button>
        ))}
      </div>
    </section>
  );
}

function PositionCard(p: TradePanelProps) {
  const t = p.openTrade!;
  const closed = p.closedTrade;
  const r = closed?.rMultiple ?? p.unrealizedR;
  const status = closed ? 'Closed' : t.pending ? `${orderLabel(t)} · pending` : p.tradeLive ? 'Open' : `${orderLabel(t)} · filling`;
  const row = (label: string, value: string, cls = 'tw:text-on-surface') => (
    <div className="tw:flex tw:justify-between tw:gap-2"><span className="tw:text-on-surface-variant">{label}</span><span className={`tw:font-mono-metric-md ${cls}`}>{value}</span></div>
  );
  return (
    <section className={card} aria-label="Position">
      <div className={heading}>
        <span>Position</span>
        <span className={`tw:normal-case tw:tracking-normal tw:px-1.5 tw:rounded tw:font-bold ${t.direction === 'long' ? 'tw:bg-secondary/20 tw:text-secondary' : 'tw:bg-tertiary/20 tw:text-tertiary'}`}>
          {t.direction === 'long' ? 'Long' : 'Short'} · {status}
        </span>
      </div>
      <div className="tw:flex tw:flex-col tw:gap-0.5 tw:text-[11px]">
        {row('Entry', fmtPrice(t.entryPrice))}
        {row('Stop', `${fmtPrice(t.stopLoss)} (${fmtR(rAt(t, t.stopLoss), 1)})`, 'tw:text-tertiary')}
        {t.takeProfit != null && row(t.takeProfit2 != null ? 'TP1' : 'Target', `${fmtPrice(t.takeProfit)} (${fmtR(rAt(t, t.takeProfit), 1)})`, 'tw:text-secondary')}
        {t.takeProfit2 != null && row('TP2', `${fmtPrice(t.takeProfit2)} (${fmtR(rAt(t, t.takeProfit2), 1)})`, 'tw:text-secondary')}
        {row('Size', `${t.lots != null ? `${t.lots} lot${t.lots === 1 ? '' : 's'} · ` : ''}$${t.riskAmount.toFixed(2)} risk`)}
        {(t.partials?.length ?? 0) > 0 && row('Banked', `${fmtR(bankedR(t))} · ${Math.round(openFraction(t) * 100)}% open`)}
        {!t.pending && row(closed ? 'Result' : 'Open P/L', `${fmtR(r)} (${fmtUSD(r * t.riskAmount)})`, `tw:font-bold ${r >= 0 ? 'tw:text-secondary' : 'tw:text-tertiary'}`)}
      </div>

      {closed ? (
        <button type="button" onClick={p.actions.logOutcome} className="tw:mt-2.5 tw:w-full tw:flex tw:items-center tw:justify-center tw:gap-1.5 tw:py-1.5 tw:rounded tw:bg-primary-container tw:text-on-primary tw:font-semibold tw:text-[12px] tw:hover:brightness-110">
          <Icon name="bookmark_added" className="tw:text-[15px]" />Log outcome
        </button>
      ) : (
        <div className="tw:flex tw:flex-col tw:gap-1.5 tw:mt-2.5">
          {!p.tradeLive && t.takeProfit != null && (
            <div className="tw:flex tw:flex-wrap tw:items-center tw:gap-1.5 tw:text-[11px] tw:text-on-surface-variant">
              <button type="button" onClick={p.actions.toggleTp2} aria-pressed={t.takeProfit2 != null} className={`${smallBtn} ${t.takeProfit2 != null ? 'tw:bg-secondary/20 tw:text-secondary' : ''}`}>
                {t.takeProfit2 != null ? 'TP2 ✓' : '+ TP2'}
              </button>
              {t.takeProfit2 != null && <>
                <select aria-label="Share closed at TP1" value={t.tp1Fraction ?? 0.5} onChange={e => p.actions.setTp1Fraction(Number(e.target.value))} className="tw:bg-surface-container-lowest tw:border tw:border-outline-variant tw:rounded tw:px-1 tw:text-on-surface">
                  {FRACTIONS.map(f => <option key={f} value={f}>{Math.round(f * 100)}% at TP1</option>)}
                </select>
                <label className="tw:flex tw:items-center tw:gap-1"><input type="checkbox" checked={t.beAtTp1 ?? true} onChange={e => p.actions.setBeAtTp1(e.target.checked)} />SL→BE</label>
              </>}
            </div>
          )}
          {p.tradeLive && (
            <div className="tw:grid tw:grid-cols-3 tw:gap-1">
              {[0.25, 0.5].map(f => (
                <button key={f} type="button" onClick={() => p.actions.takePartial(f)} disabled={openFraction(t) <= f + 1e-9} className={smallBtn}
                  title={`Take ${f * 100}% of the original position off at the current close`}>Close {f * 100}%</button>
              ))}
              <button type="button" onClick={p.actions.stopToBreakeven} disabled={t.stopLoss === t.entryPrice} className={smallBtn} title="Move the stop to the entry price">SL → BE</button>
            </div>
          )}
          <div className="tw:flex tw:gap-1">
            {!t.pending && (
              <button type="button" onClick={p.actions.closeNow} className="tw:flex-1 tw:py-1 tw:rounded tw:bg-primary-container/20 tw:border tw:border-primary-container/50 tw:text-primary-container tw:text-[11px] tw:font-semibold tw:hover:bg-primary-container/30">
                Close at {p.marketPrice != null ? fmtPrice(p.marketPrice) : 'market'}
              </button>
            )}
            <button type="button" onClick={p.actions.cancel} className="tw:flex-1 tw:py-1 tw:rounded tw:bg-tertiary/10 tw:border tw:border-tertiary/30 tw:text-tertiary tw:text-[11px] tw:font-semibold tw:hover:bg-tertiary/20">
              {t.pending ? 'Cancel order' : 'Remove'}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function Timeline({ events, fmtTime }: { events: TimelineEvent[]; fmtTime: (s: number) => string }) {
  const tone = (e: TimelineEvent) => (e.tone === 'win' ? 'tw:text-secondary' : e.tone === 'loss' ? 'tw:text-tertiary' : 'tw:text-on-surface');
  return (
    <section className={`${card} tw:flex-1 tw:min-h-0 tw:flex tw:flex-col`} aria-label="Timeline">
      <div className={heading}><span>Timeline</span><span className="tw:normal-case tw:tracking-normal">{events.length || ''}</span></div>
      {events.length === 0
        ? <p className="tw:text-[11px] tw:text-on-surface-variant">Orders, fills and exits in this session show up here.</p>
        : (
          <ol className="tw:flex tw:flex-col tw:gap-1.5 tw:overflow-y-auto tw:min-h-0 tw:pr-1">
            {[...events].reverse().map((e, i) => (
              <li key={`${e.time}-${i}`} className="tw:text-[11px] tw:leading-snug">
                <div className="tw:font-mono-metric-md tw:text-[10px] tw:text-on-surface-variant">{fmtTime(e.time)}</div>
                <div className={tone(e)}>{e.text}</div>
              </li>
            ))}
          </ol>
        )}
    </section>
  );
}

function Account({ a }: { a: TradePanelProps['account'] }) {
  return (
    <section className="tw:px-3 tw:py-2.5" aria-label="Account">
      <div className={heading}><span>Account</span></div>
      {a.start != null && a.current != null ? (
        <div className="tw:flex tw:flex-col tw:gap-0.5 tw:text-[11px]">
          <div className="tw:flex tw:justify-between"><span className="tw:text-on-surface-variant tw:flex tw:items-center tw:gap-1"><Icon name="lock" className="tw:text-[11px]" />Starting balance</span><span className="tw:font-mono-metric-md">${a.start.toLocaleString()}</span></div>
          <div className="tw:flex tw:justify-between"><span className="tw:text-on-surface-variant">Balance</span>
            <span className="tw:font-mono-metric-md tw:font-bold">${a.current.toLocaleString(undefined, { maximumFractionDigits: 2 })}
              {a.realized !== 0 && <span className={`tw:ml-1 tw:text-[10px] ${a.realized > 0 ? 'tw:text-secondary' : 'tw:text-tertiary'}`}>{a.realized > 0 ? '+' : ''}{((a.realized / a.start) * 100).toFixed(2)}%</span>}
            </span>
          </div>
        </div>
      ) : (
        <label className="tw:text-[11px] tw:text-on-surface-variant">Starting balance $
          <input type="number" min="0" step="any" value={a.balanceInput} onChange={e => a.setBalance(e.target.value)} className={`${field} tw:mt-0.5`} />
        </label>
      )}
    </section>
  );
}

export default function TradePanel(p: TradePanelProps) {
  return (
    <aside className="tw:w-[300px] tw:shrink-0 tw:bg-surface-container-low tw:border-l tw:border-outline-variant tw:flex tw:flex-col tw:min-h-0 tw:overflow-y-auto tw:select-text tw:z-20" aria-label="Trading panel">
      {p.openTrade ? <PositionCard {...p} /> : <OrderTicket {...p} />}
      <Timeline events={p.timeline} fmtTime={p.fmtTime} />
      <Account a={p.account} />
    </aside>
  );
}

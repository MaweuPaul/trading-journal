'use client';
import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Icon } from './BacktestShell';
import { authHeaders, useBacktest } from './data';
import { symbolDescription } from './indicators';
import { CHART_INTERVALS, INTERVAL_DAYS, LOOKBACK_BARS, suggestInterval } from '../backtest-tools/types';

const QUICK = ['XAUUSD', 'NAS100', 'EURUSD', 'BTCUSD', 'SPX500'];
const PRESETS = [{ label: 'Last week', days: 7 }, { label: 'Last month', days: 30 }, { label: 'Last 3 months', days: 90 }] as const;
const DAY = 86_400_000;
const NEW_STRATEGY = '__new__';

function iso(offset: number) { const d = new Date(); d.setUTCDate(d.getUTCDate() + offset); return d.toISOString().slice(0, 10); }
function tfLabel(v: string) { return CHART_INTERVALS.find(i => i.value === v)?.label ?? v; }
function defaultName(symbol: string, interval: string, from: string) {
  const month = new Date(from).toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });
  return `${symbol || 'Backtest'} ${tfLabel(interval)} ${month}`;
}

const label = 'tw:text-body-sm tw:font-semibold tw:text-on-surface';
const hint = 'tw:text-[11px] tw:text-outline';
const input = 'tw:w-full tw:bg-surface-container-lowest tw:border tw:border-outline-variant tw:rounded tw:text-body-md tw:text-on-surface tw:focus:outline-none tw:focus:border-primary tw:transition-colors';
const chip = (on: boolean) => on
  ? 'tw:bg-primary-fixed tw:border tw:border-primary tw:text-primary tw:font-semibold'
  : 'tw:bg-surface-container-lowest tw:hover:bg-surface-container-high tw:border tw:border-outline-variant tw:text-on-surface-variant tw:hover:text-on-surface tw:transition-colors';

// cTrader symbol lists mix FX, metals, indices and hundreds of single stocks;
// group them so the picker opens on the markets people actually backtest.
const CATEGORIES = ['Popular', 'Forex', 'Metals', 'Indices', 'Commodities', 'Crypto', 'Stocks'] as const;
type Category = typeof CATEGORIES[number];
const POPULAR = ['XAUUSD', 'XAGUSD', 'EURUSD', 'GBPUSD', 'USDJPY', 'GBPJPY', 'AUDUSD', 'USDCAD', 'NAS100', 'US 100', 'US 30', 'US 500', 'SPX500', 'GER40', 'GERMANY 40', 'UK 100', 'BTCUSD', 'ETHUSD', 'XTIUSD', 'USOIL'];
// Anchored on instrument codes so company names ("Goldman Sachs", "LinkedIn",
// "Tokyo Gas") stay under Stocks.
const METAL = /^(X(AU|AG|PT|PD)[A-Z]{3}|GOLD|SILVER|PLATINUM|PALLADIUM)$/;
const CRYPTO = /^(BTC|ETH|LTC|XRP|BCH|ADA|DOGE|DOT|SOL|BNB|LNK|XLM|EOS|TRX|AVAX|MATIC|SHIB)(USD|EUR|GBP|JPY|USDT)$/;
const INDEX = /^(US|UK|JAPAN|GERMANY|FRANCE|EUROPE|SPAIN|ITALY|AUSTRALIA|HONG KONG|CHINA|SWISS|NETHERLANDS|CANADA|NAS|SPX|GER|DJ|JP|HK|AUS|FRA|EU|ESP|STOXX|DE|F)\s?\d{2,4}$|^(VIX|DXY|USDX|NIKKEI|DAX)$/;
const COMMODITY = /^(X(TI|BR|NG)[A-Z]{3}|NAT\.?\s?GAS|GAS NATURAL|BRENT|WTI|US\s?OIL|UK\s?OIL|COPPER|COCOA|COFFEE|SUGAR|CORN|WHEAT|SOYBEANS?|COTTON)$/;
function categoryOf(s: string): Exclude<Category, 'Popular'> {
  const u = s.toUpperCase();
  if (METAL.test(u)) return 'Metals';
  if (CRYPTO.test(u)) return 'Crypto';
  if (COMMODITY.test(u)) return 'Commodities';
  if (INDEX.test(u)) return 'Indices';
  if (/^[A-Z]{6}$/.test(u) && symbolDescription(u)) return 'Forex';
  return 'Stocks';
}

/** Searchable, grouped list of the symbols the connected cTrader account can serve. */
function SymbolPicker({ value, onChange, symbols }: { value: string; onChange: (s: string) => void; symbols: string[] | null }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [cat, setCat] = useState<Category>('Popular');
  const boxRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const q = query.trim().toUpperCase();
  const all = useMemo(() => (symbols?.length ? symbols : QUICK), [symbols]);
  const byCat = useMemo(() => {
    const groups = Object.fromEntries(CATEGORIES.map(c => [c, [] as string[]])) as Record<Category, string[]>;
    for (const s of all) groups[categoryOf(s)].push(s);
    const have = new Set(all);
    groups.Popular = POPULAR.filter(s => have.has(s));
    if (!groups.Popular.length) groups.Popular = all.filter(s => categoryOf(s) !== 'Stocks').slice(0, 20);
    return groups;
  }, [all]);
  const matches = q
    ? all.filter(s => s.includes(q) || (symbolDescription(s)?.[0] ?? '').toUpperCase().includes(q))
      .sort((a, b) => Number(!a.startsWith(q)) - Number(!b.startsWith(q)) || a.localeCompare(b)).slice(0, 200)
    : byCat[cat];
  const desc = symbolDescription(value);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!boxRef.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  useEffect(() => { listRef.current?.children[active]?.scrollIntoView({ block: 'nearest' }); }, [active]);

  const pick = (s: string) => { onChange(s); setQuery(''); setOpen(false); };
  const show = () => {
    const c: Category = byCat.Popular.includes(value) || !all.includes(value) ? 'Popular' : categoryOf(value);
    setCat(c); setQuery(''); setActive(Math.max(0, byCat[c].indexOf(value))); setOpen(true);
  };

  return (
    <div ref={boxRef} className="tw:relative">
      <div className="tw:absolute tw:inset-y-0 tw:left-0 tw:pl-3 tw:flex tw:items-center tw:pointer-events-none tw:text-outline"><Icon name="search" className="tw:text-[18px]" /></div>
      <input id="bt-symbol" role="combobox" aria-expanded={open} aria-controls="bt-symbol-list" aria-autocomplete="list" autoComplete="off" spellCheck={false}
        value={open ? query : value} placeholder={open ? value || 'Search symbols…' : 'Search symbols…'}
        onFocus={show} onClick={() => !open && show()}
        onChange={e => { setQuery(e.target.value); setActive(0); setOpen(true); }}
        onKeyDown={e => {
          if (e.key === 'ArrowDown') { e.preventDefault(); if (!open) show(); else setActive(i => Math.min(matches.length - 1, i + 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => Math.max(0, i - 1)); }
          else if (e.key === 'Enter' && open) { e.preventDefault(); if (matches[active]) pick(matches[active]); else if (q) pick(q); }
          else if (e.key === 'Escape') { setOpen(false); setQuery(''); }
          else if (e.key === 'Tab') setOpen(false);
        }}
        className={`${input} tw:pl-9 tw:pr-40 tw:py-2 tw:uppercase`} />
      <button type="button" tabIndex={-1} aria-label="Show all symbols" onClick={() => (open ? setOpen(false) : show())}
        className="tw:absolute tw:inset-y-0 tw:right-0 tw:pr-2.5 tw:pl-2 tw:flex tw:items-center tw:gap-2 tw:text-on-surface-variant">
        {!open && desc && <span className="tw:text-[11px] tw:truncate tw:max-w-[140px]">{desc[0]}</span>}
        <Icon name={open ? 'expand_less' : 'expand_more'} className="tw:text-[18px]" />
      </button>
      {open && (
        <div className="tw:absolute tw:z-30 tw:left-0 tw:right-0 tw:top-full tw:mt-1 tw:bg-surface-container tw:border tw:border-outline-variant tw:rounded tw:shadow-lg tw:overflow-hidden">
        {q ? (
          <p className="tw:px-3 tw:py-1.5 tw:text-[10px] tw:uppercase tw:tracking-wider tw:text-outline tw:border-b tw:border-surface-container-highest">
            {matches.length === 200 ? '200+' : matches.length} matches in {all.length} cTrader symbols
          </p>
        ) : (
          <div className="tw:flex tw:flex-wrap tw:gap-1 tw:px-2 tw:py-1.5 tw:border-b tw:border-surface-container-highest" role="tablist" aria-label="Market type">
            {CATEGORIES.filter(c => byCat[c].length).map(c => (
              <button key={c} type="button" role="tab" aria-selected={cat === c}
                onMouseDown={e => { e.preventDefault(); setCat(c); setActive(0); listRef.current?.scrollTo({ top: 0 }); }}
                className={`tw:px-2 tw:py-0.5 tw:rounded tw:text-[11px] ${cat === c ? 'tw:bg-primary/15 tw:text-primary tw:font-semibold' : 'tw:text-on-surface-variant tw:hover:text-on-surface'}`}>
                {c} <span className="tw:text-outline">{byCat[c].length}</span>
              </button>
            ))}
          </div>
        )}
        <ul id="bt-symbol-list" ref={listRef} role="listbox" aria-label="Symbols" className="tw:max-h-72 tw:overflow-y-auto tw:py-1">
          {symbols === null && <li className="tw:px-3 tw:py-1 tw:text-[11px] tw:text-outline">Loading your cTrader symbols…</li>}
          {symbols?.length === 0 && <li className="tw:px-3 tw:py-1 tw:text-[11px] tw:text-outline">cTrader list unavailable — showing common symbols</li>}
          {matches.map((s, i) => {
            const d = symbolDescription(s);
            return (
              <li key={s} role="option" aria-selected={s === value}
                onMouseDown={e => { e.preventDefault(); pick(s); }} onMouseEnter={() => setActive(i)}
                className={`tw:px-3 tw:py-1.5 tw:flex tw:items-center tw:justify-between tw:gap-3 tw:cursor-pointer tw:text-body-sm ${i === active ? 'tw:bg-surface-container-high' : ''}`}>
                <span className={`tw:font-mono-metric-md tw:font-semibold ${s === value ? 'tw:text-primary' : 'tw:text-on-surface'}`}>{s}</span>
                {d && <span className="tw:text-[11px] tw:text-on-surface-variant tw:truncate">{d[0]}</span>}
              </li>
            );
          })}
          {!matches.length && (
            <li className="tw:px-3 tw:py-2 tw:text-body-sm tw:text-on-surface-variant">
              No match. {q && <button type="button" onMouseDown={e => { e.preventDefault(); pick(q); }} className="tw:text-primary tw:underline">Use “{q}” anyway</button>}
            </li>
          )}
        </ul>
        </div>
      )}
    </div>
  );
}

export default function NewBacktestSetup() {
  const router = useRouter();
  const { activeSymbol, strategyInfo, strategies, currentStrategy, setActiveSymbol, setCurrentStrategy, createStrategy } = useBacktest();
  const [symbols, setSymbols] = useState<string[] | null>(null);
  const [symbol, setSymbol] = useState(activeSymbol || 'XAUUSD');
  const [from, setFrom] = useState(iso(-30));
  const [to, setTo] = useState(iso(0));
  const [custom, setCustom] = useState(false);
  const [pickedInterval, setPickedInterval] = useState<string | null>(null);
  const presetStrategy = useSearchParams().get('strategy');
  const [strategy, setStrategy] = useState(presetStrategy ?? currentStrategy);
  // Non-null while the trader is naming a brand-new strategy inline.
  const [newStrategy, setNewStrategy] = useState<string | null>(null);
  const [newStrategyIdea, setNewStrategyIdea] = useState('');
  const [strategyError, setStrategyError] = useState('');
  const [name, setName] = useState<string | null>(null);
  const fromRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch('/api/pre-trade-analyses/symbols', { headers: authHeaders() })
      .then(r => (r.ok ? r.json() : { symbols: [] }))
      .then(d => setSymbols(Array.isArray(d.symbols) ? d.symbols : []))
      .catch(() => setSymbols([]));
  }, []);

  // The timeframe follows the window (cTrader caps a request at 1500 bars) until the trader picks one.
  const interval = pickedInterval ?? suggestInterval(from, to);
  const sessionName = name ?? defaultName(symbol, interval, from);

  const fromMs = new Date(from).getTime();
  const toMs = new Date(to).getTime() + DAY;
  const valid = Number.isFinite(fromMs) && Number.isFinite(toMs) && toMs > fromMs;
  // Candles stream in as the replay advances, so any range length works.
  const replayMs = toMs - fromMs;
  // Markets trade roughly 5 of 7 days.
  const estBars = valid ? Math.round((replayMs / DAY / INTERVAL_DAYS[interval]) * (5 / 7)) : 0;
  const preset = custom ? undefined : PRESETS.find(p => to === iso(0) && from === iso(-p.days));
  const missing = symbols && symbols.length > 0 && !symbols.includes(symbol);

  const pickPreset = (days: number) => { setCustom(false); setFrom(iso(-days)); setTo(iso(0)); };
  const pickCustom = () => {
    setCustom(true);
    const el = fromRef.current;
    if (el) { el.focus(); try { el.showPicker(); } catch { /* not supported */ } }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    let chosen = strategy;
    const typed = newStrategy?.trim();
    if (newStrategy != null) {
      if (!typed) { setStrategyError('Name the new strategy, or pick an existing one.'); return; }
      const existing = strategies.find(s => s.toLowerCase() === typed.toLowerCase());
      if (existing) chosen = existing;
      else {
        setStrategyError('');
        const res = await createStrategy(typed, newStrategyIdea.trim());
        if (!res.ok) { setStrategyError(res.error || 'Could not save the strategy'); return; }
        chosen = typed;
      }
    }
    setActiveSymbol(symbol); setCurrentStrategy(chosen);
    const q = new URLSearchParams({ symbol, interval, from, to, name: sessionName, strategy: chosen, autostart: '1' });
    router.push(`/backtest/workspace?${q}`);
  };

  return (
    <div className="tw:flex-1 tw:bg-background tw:p-4 tw:sm:p-6">
      <form onSubmit={e => void submit(e)} className="tw:w-full tw:bg-surface-container tw:border tw:border-surface-container-highest tw:rounded-lg tw:p-5 tw:sm:p-6 tw:flex tw:flex-col tw:gap-5 tw:shadow-sm">
        <div>
          <h1 className="tw:text-headline-md tw:font-semibold tw:text-on-surface">New backtest</h1>
          <p className="tw:text-body-sm tw:text-on-surface-variant tw:mt-1">Pick a market and a date range. Candles are revealed one at a time, so you trade without seeing the future.</p>
        </div>

        {/* Two columns on wide screens: market & window | replay settings */}
        <div className="tw:grid tw:grid-cols-1 tw:lg:grid-cols-2 tw:gap-x-10 tw:gap-y-5">
        <div className="tw:flex tw:flex-col tw:gap-5">
        {/* Symbol */}
        <div className="tw:flex tw:flex-col tw:gap-2">
          <label htmlFor="bt-symbol" className={label}>Symbol</label>
          <SymbolPicker value={symbol} onChange={setSymbol} symbols={symbols} />
          <div className="tw:flex tw:flex-wrap tw:gap-1.5">
            {QUICK.map(s => <button key={s} type="button" onClick={() => setSymbol(s)} aria-pressed={symbol === s} className={`tw:px-2.5 tw:py-1 tw:rounded tw:text-[11px] ${chip(symbol === s)}`}>{s}</button>)}
          </div>
          {missing && <p className="tw:text-[11px] tw:text-error">{symbol} isn&apos;t in your cTrader symbol list — the chart may not load.</p>}
        </div>

        {/* Date range */}
        <div className="tw:flex tw:flex-col tw:gap-2">
          <span className={label}>Date range</span>
          <div className="tw:grid tw:grid-cols-2 tw:sm:grid-cols-4 tw:gap-1.5">
            {PRESETS.map(p => (
              <button key={p.label} type="button" aria-pressed={preset === p} onClick={() => pickPreset(p.days)} className={`tw:px-2 tw:py-1.5 tw:rounded tw:text-label-action ${chip(preset === p)}`}>{p.label}</button>
            ))}
            <button type="button" aria-pressed={!preset} onClick={pickCustom} className={`tw:px-2 tw:py-1.5 tw:rounded tw:text-label-action ${chip(!preset)}`}>Custom</button>
          </div>
          <div className="tw:grid tw:grid-cols-2 tw:gap-3">
            <label className="tw:flex tw:flex-col tw:gap-1">
              <span className={hint}>From</span>
              <input ref={fromRef} type="date" required value={from} max={to} onChange={e => { setCustom(true); setFrom(e.target.value); }} className={`${input} tw:px-2.5 tw:py-1.5`} />
            </label>
            <label className="tw:flex tw:flex-col tw:gap-1">
              <span className={hint}>To</span>
              <input type="date" required value={to} min={from} max={iso(0)} onChange={e => { setCustom(true); setTo(e.target.value); }} className={`${input} tw:px-2.5 tw:py-1.5`} />
            </label>
          </div>
        </div>

        </div>

        <div className="tw:flex tw:flex-col tw:gap-5">
        {/* Timeframe */}
        <div className="tw:flex tw:flex-col tw:gap-2">
          <div className="tw:flex tw:justify-between tw:items-center">
            <span className={label}>Timeframe</span>
            {pickedInterval
              ? <button type="button" onClick={() => setPickedInterval(null)} className="tw:text-[11px] tw:text-primary tw:hover:underline">Use suggested ({tfLabel(suggestInterval(from, to))})</button>
              : <span className={hint}>Picked to fit the range</span>}
          </div>
          <div className="tw:grid tw:grid-cols-6 tw:gap-1.5" role="radiogroup" aria-label="Timeframe">
            {CHART_INTERVALS.map(i => (
              <button key={i.value} type="button" role="radio" aria-checked={interval === i.value} onClick={() => setPickedInterval(i.value)}
                className={`tw:py-1.5 tw:rounded tw:text-label-action ${chip(interval === i.value)}`}>{i.label}</button>
            ))}
          </div>
        </div>

        {/* Plain summary */}
        <p className="tw:text-body-sm tw:rounded tw:px-3 tw:py-2 tw:border tw:border-surface-container-highest tw:bg-surface-container-low tw:text-on-surface-variant">
          {!valid ? 'Pick a start date before the end date.'
            : `About ${estBars.toLocaleString()} ${tfLabel(interval)} candles to step through, plus the ${LOOKBACK_BARS} candles before the start shown for context.`}
        </p>

        {/* Strategy & name */}
        <div className="tw:grid tw:grid-cols-1 tw:sm:grid-cols-2 tw:gap-4">
          <div className="tw:flex tw:flex-col tw:gap-2">
            <div className="tw:flex tw:justify-between tw:items-center">
              <label htmlFor="bt-strategy" className={label}>Strategy <span className="tw:font-normal tw:text-outline">(optional)</span></label>
              <Link href="/backtest/strategies" className="tw:text-[11px] tw:text-primary tw:hover:underline">Manage</Link>
            </div>
            <div className="tw:relative">
              <select id="bt-strategy" value={newStrategy != null ? NEW_STRATEGY : strategy}
                onChange={e => { if (e.target.value === NEW_STRATEGY) setNewStrategy(''); else { setNewStrategy(null); setStrategy(e.target.value); } }}
                className={`${input} tw:px-3 tw:py-2 tw:appearance-none`}>
                <option value="">No strategy</option>
                {strategies.map(s => {
                  const info = strategyInfo.find(i => i.name === s);
                  return <option key={s} value={s}>{s}{info?.description ? ` — ${info.description.slice(0, 50)}` : ''}</option>;
                })}
                <option value={NEW_STRATEGY}>+ New strategy…</option>
              </select>
              <div className="tw:absolute tw:inset-y-0 tw:right-0 tw:pr-3 tw:flex tw:items-center tw:pointer-events-none tw:text-outline"><Icon name="expand_more" className="tw:text-[18px]" /></div>
            </div>
            {newStrategy != null && (
              <div className="tw:flex tw:flex-col tw:gap-1.5 tw:p-2.5 tw:rounded tw:border tw:border-primary/40 tw:bg-primary/5">
                <input autoFocus aria-label="New strategy name" maxLength={60} value={newStrategy} onChange={e => setNewStrategy(e.target.value)}
                  placeholder="Strategy name, e.g. London Breakout" className={`${input} tw:px-3 tw:py-2`} />
                <input aria-label="Strategy idea (optional)" maxLength={200} value={newStrategyIdea} onChange={e => setNewStrategyIdea(e.target.value)}
                  placeholder="The idea in one line (optional)" className={`${input} tw:px-3 tw:py-1.5 tw:text-body-sm`} />
                <p className={hint}>Saved when you start the backtest.</p>
              </div>
            )}
            {strategyError && <p className="tw:text-[11px] tw:text-error">{strategyError}</p>}
          </div>
          <div className="tw:flex tw:flex-col tw:gap-2">
            <label htmlFor="bt-name" className={label}>Session name</label>
            <input id="bt-name" maxLength={100} value={sessionName} onChange={e => setName(e.target.value)} className={`${input} tw:px-3 tw:py-2`} />
          </div>
        </div>
        </div>
        </div>

        <div className="tw:pt-4 tw:border-t tw:border-surface-container-highest tw:flex tw:flex-col-reverse tw:sm:flex-row tw:items-center tw:justify-end tw:gap-2">
          <Link href="/backtest" className="tw:w-full tw:sm:w-auto tw:px-4 tw:py-2 tw:rounded tw:border tw:border-outline-variant tw:text-on-surface-variant tw:hover:text-on-surface tw:hover:bg-surface-container-high tw:text-label-action tw:transition-colors tw:text-center">Cancel</Link>
          <button type="submit" disabled={!valid || !symbol.trim()} className="tw:w-full tw:sm:w-auto tw:px-5 tw:py-2 tw:rounded tw:bg-primary tw:text-on-primary tw:font-semibold tw:text-body-md tw:hover:opacity-90 tw:transition-opacity tw:flex tw:items-center tw:justify-center tw:gap-1.5 tw:disabled:opacity-50">
            <Icon name="play_arrow" className="tw:text-[18px]" /><span>Start backtest</span>
          </button>
        </div>
      </form>
    </div>
  );
}

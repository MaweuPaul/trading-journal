// Reads the report MT5 saves from History → right-click → Report (HTML):
// the account line, the Positions table (one row per closed position) and
// the Deals table (running balance, close comments, deposits/withdrawals).
// Columns are found by their header names, so a report with extra or
// missing columns (Fee, Comment…) still lines up. Times are the broker's
// server time, read as UTC -- the same way the desktop sync app stores them,
// so imported and synced trades line up.

const SECTIONS = ['positions', 'orders', 'deals', 'open positions', 'working orders', 'summary', 'results'];

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}
const cellText = html => decodeEntities(html.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, ''))
  .replace(/[\s ]+/g, ' ').trim();

/** Every table row as a list of cell texts (colspan expanded, hidden cells dropped). */
function tableRows(html) {
  const clean = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
  const rows = [];
  for (const rowHtml of clean.split(/<tr\b[^>]*>/i).slice(1)) {
    const body = rowHtml.split(/<\/tr>|<\/table>/i)[0];
    const cells = [];
    const re = /<t([dh])\b([^>]*)>([\s\S]*?)(?=<t[dh]\b|$)/gi;
    let m;
    while ((m = re.exec(body))) {
      const attrs = m[2];
      if (/class\s*=\s*["'][^"']*\bhidden\b/i.test(attrs)) continue;
      const span = Math.max(1, Math.min(40, Number((/colspan\s*=\s*["']?(\d+)/i.exec(attrs) || [])[1]) || 1));
      const text = cellText(m[3].replace(/<\/t[dh]>[\s\S]*$/i, ''));
      cells.push(text);
      for (let i = 1; i < span; i++) cells.push('');
    }
    rows.push(cells);
  }
  return rows;
}

/** "1 234.56", "-1.5", "- 3.84", "0,25" -> number (NaN when blank). */
function num(text) {
  let t = String(text ?? '').replace(/[\s ]/g, '');
  if (!t) return NaN;
  if (/^-?\d+,\d+$/.test(t)) t = t.replace(',', '.');
  t = t.replace(/,/g, '');
  return Number.parseFloat(t);
}

/** "2024.01.15 10:23:45" (server time) -> Date, read as UTC. */
function mt5Time(text) {
  const m = /^(\d{4})[.\-/](\d{2})[.\-/](\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(String(text || '').trim());
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)));
}

const headerKey = text => String(text).toLowerCase().replace(/[\s/.]+/g, '');

/** Column index by header name; repeated names ("Time", "Price") get a count suffix: time, time2. */
function headerIndex(cells) {
  const seen = {};
  const index = {};
  cells.forEach((cell, i) => {
    const key = headerKey(cell);
    if (!key) return;
    seen[key] = (seen[key] || 0) + 1;
    index[seen[key] === 1 ? key : `${key}${seen[key]}`] = i;
  });
  return index;
}

function parseAccount(text) {
  // "12345678 (USD, Broker-Server, real, Hedge)" -- login, then currency, server, type, mode.
  const m = /^\s*(\d{3,20})\s*(?:\(([^)]*)\))?/.exec(String(text || ''));
  if (!m) return null;
  const parts = (m[2] || '').split(',').map(part => part.trim()).filter(Boolean);
  const kind = parts.find(part => /^(real|demo|contest)$/i.test(part)) || '';
  const server = parts.length >= 2 ? parts[1] : '';
  return {
    login: m[1],
    currency: /^[A-Z]{3}$/.test(parts[0] || '') ? parts[0] : 'USD',
    server,
    accountType: /^real$/i.test(kind) ? 'live' : /^(demo|contest)$/i.test(kind) ? 'demo' : '',
    mode: parts.find(part => /^(hedge|hedging|netting|exchange)$/i.test(part)) || '',
  };
}

/**
 * Parse a report. Returns { account, name, company, positions, deals, balanceOps }
 * or throws an Error with a message meant for the user.
 */
function parseMt5Statement(html) {
  if (typeof html !== 'string' || html.length < 50) throw new Error('That file looks empty. Save the report from MT5 again and pick the .html file.');
  if (!/<table/i.test(html)) throw new Error('That isn\'t an MT5 report. In MT5 open History, right-click, choose Report → HTML, and upload that file.');
  const rows = tableRows(html);

  const meta = {};
  for (const cells of rows.slice(0, 40)) {
    const filled = cells.filter(Boolean);
    for (let i = 0; i < filled.length - 1; i++) {
      const label = /^(name|account|company|date)\s*:$/i.exec(filled[i]);
      if (label && !meta[label[1].toLowerCase()]) meta[label[1].toLowerCase()] = filled[i + 1];
    }
  }
  const account = parseAccount(meta.account);

  // Split into sections: a row with one filled cell naming a section starts one.
  const sections = {};
  let current = null;
  for (const cells of rows) {
    const filled = cells.filter(Boolean);
    if (filled.length === 1 && SECTIONS.includes(filled[0].toLowerCase())) {
      current = { name: filled[0].toLowerCase(), header: null, rows: [] };
      if (!sections[current.name]) sections[current.name] = current;
      else current = { ...current, ignore: true };
      continue;
    }
    if (!current || current.ignore) continue;
    if (!current.header) {
      if (filled.length >= 5) current.header = headerIndex(cells);
      continue;
    }
    if (filled.length === 0) { current = null; continue; }
    current.rows.push(cells);
  }

  const pos = sections.positions;
  if (!pos || !pos.header || pos.header.position == null || pos.header.symbol == null) {
    throw new Error('No Positions table found in this report. Save it from a recent MT5 version (History → right-click → Report → HTML), with the terminal language set to English.');
  }
  const col = (cells, header, key) => (header[key] == null ? '' : cells[header[key]] ?? '');

  const positions = [];
  for (const cells of pos.rows) {
    const h = pos.header;
    const type = col(cells, h, 'type').toLowerCase();
    if (type !== 'buy' && type !== 'sell') continue;
    const openTime = mt5Time(col(cells, h, 'time'));
    const closeTime = mt5Time(col(cells, h, 'time2'));
    const positionId = col(cells, h, 'position').replace(/\D/g, '');
    const entryPrice = num(col(cells, h, 'price'));
    const exitPrice = num(col(cells, h, 'price2'));
    const volume = num(col(cells, h, 'volume'));
    const profit = num(col(cells, h, 'profit'));
    if (!positionId || !openTime || !closeTime || ![entryPrice, exitPrice, volume, profit].every(Number.isFinite)) continue;
    const sl = num(col(cells, h, 'sl')), tp = num(col(cells, h, 'tp'));
    positions.push({
      positionId,
      symbol: col(cells, h, 'symbol'),
      direction: type === 'buy' ? 'BUY' : 'SELL',
      volume, entryPrice, exitPrice, openTime, closeTime,
      stopLoss: Number.isFinite(sl) && sl > 0 ? sl : null,
      takeProfit: Number.isFinite(tp) && tp > 0 ? tp : null,
      commission: Number.isFinite(num(col(cells, h, 'commission'))) ? num(col(cells, h, 'commission')) : 0,
      fee: Number.isFinite(num(col(cells, h, 'fee'))) ? num(col(cells, h, 'fee')) : 0,
      swap: Number.isFinite(num(col(cells, h, 'swap'))) ? num(col(cells, h, 'swap')) : 0,
      profit,
    });
  }

  const deals = [];
  const dealSection = sections.deals;
  if (dealSection?.header && dealSection.header.deal != null) {
    const h = dealSection.header;
    for (const cells of dealSection.rows) {
      const time = mt5Time(col(cells, h, 'time'));
      const ticket = col(cells, h, 'deal').replace(/\D/g, '');
      if (!time || !ticket) continue;
      deals.push({
        ticket, time,
        symbol: col(cells, h, 'symbol'),
        type: col(cells, h, 'type').toLowerCase(),
        direction: col(cells, h, 'direction').toLowerCase(),
        volume: num(col(cells, h, 'volume')),
        price: num(col(cells, h, 'price')),
        order: col(cells, h, 'order').replace(/\D/g, ''),
        commission: num(col(cells, h, 'commission')) || 0,
        fee: num(col(cells, h, 'fee')) || 0,
        swap: num(col(cells, h, 'swap')) || 0,
        profit: num(col(cells, h, 'profit')) || 0,
        balance: num(col(cells, h, 'balance')),
        comment: col(cells, h, 'comment'),
      });
    }
    deals.sort((a, b) => a.time - b.time || (BigInt(a.ticket) < BigInt(b.ticket) ? -1 : 1));
  }

  const BALANCE_TYPES = new Set(['balance', 'credit', 'correction', 'bonus', 'charge']);
  const balanceOps = deals.filter(d => BALANCE_TYPES.has(d.type) && d.profit !== 0).map(d => ({
    externalId: d.ticket,
    type: d.type === 'balance' ? (d.profit > 0 ? 'deposit' : 'withdrawal') : 'adjustment',
    amount: d.type === 'balance' ? Math.abs(d.profit) : d.profit,
    occurredAt: d.time,
    balanceAfter: Number.isFinite(d.balance) ? d.balance : null,
    note: d.comment || (d.type === 'balance' ? '' : d.type),
  }));

  return { account, name: meta.name || '', company: meta.company || '', positions, deals, balanceOps };
}

const exitTriggerFromComment = comment => {
  const c = String(comment || '').toLowerCase();
  if (/^\[?\s*sl\b/.test(c)) return 'SL';
  if (/^\[?\s*tp\b/.test(c)) return 'TP';
  if (/^\[?\s*so\b/.test(c) || c.includes('stop out')) return 'StopOut';
  return '';
};

/**
 * Turn a parsed report into journal trades (one per closed position, like a
 * synced MT5 trade) using the Deals table for the running balance, the
 * closing deal's ticket and how it closed. Account identity is added by the caller.
 */
function statementTrades(parsed) {
  const out = parsed.deals.filter(d => (d.direction === 'out' || d.direction === 'in/out') && (d.type === 'buy' || d.type === 'sell'));
  const used = new Set();
  const withBalance = parsed.deals.filter(d => Number.isFinite(d.balance));
  const balanceAt = time => {
    let found = null;
    for (const d of withBalance) { if (d.time <= time) found = d.balance; else break; }
    return found;
  };
  const same = (a, b) => Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 1e-9);

  return parsed.positions.map(p => {
    const closing = p.direction === 'BUY' ? 'sell' : 'buy';
    // A single closing deal at the position's close time, price and size.
    const exact = out.find(d => !used.has(d.ticket) && d.symbol === p.symbol && d.type === closing
      && d.time.getTime() === p.closeTime.getTime() && same(d.price, p.exitPrice) && same(d.volume, p.volume));
    if (exact) used.add(exact.ticket);
    const lastClose = exact || out.filter(d => d.symbol === p.symbol && d.type === closing && d.time.getTime() === p.closeTime.getTime()).pop();
    const runningBalance = exact && Number.isFinite(exact.balance) ? exact.balance : balanceAt(p.closeTime);
    const net = p.profit + p.commission + p.fee + p.swap;
    const before = runningBalance == null ? null : runningBalance - net;
    return {
      dealId: exact ? exact.ticket : `stmt-${p.positionId}`,
      positionId: p.positionId,
      symbol: p.symbol,
      direction: p.direction,
      entryPrice: p.entryPrice,
      exitPrice: p.exitPrice,
      lotSize: p.volume,
      pnlUSD: p.profit,
      pnlPct: before && before > 0 ? Math.round((p.profit / before) * 100 * 10000) / 10000 : 0,
      commission: p.commission + p.fee,
      swap: p.swap,
      openTime: p.openTime,
      closeTime: p.closeTime,
      durationMinutes: Math.max(0, Math.round((p.closeTime - p.openTime) / 60000)),
      runningBalance: runningBalance == null ? 0 : Math.round(runningBalance * 100) / 100,
      stopLoss: p.stopLoss,
      takeProfit: p.takeProfit,
      exitTrigger: exitTriggerFromComment(lastClose?.comment),
    };
  });
}

module.exports = { parseMt5Statement, statementTrades, tableRows, parseAccount, mt5Time, num };

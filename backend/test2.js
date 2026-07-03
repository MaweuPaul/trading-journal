const fs = require('fs');

try {
  const trades = JSON.parse(fs.readFileSync('./local_trades.json', 'utf8'));
  const wins = trades.filter(t => t.pnlUSD > 0);
  const losses = trades.filter(t => t.pnlUSD < 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnlUSD, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnlUSD, 0));
  const netPnL = trades.reduce((s, t) => s + t.pnlUSD, 0);

  // Equty curve
  const equityCurve = trades.map(t => ({
    date: t.closeTime,
    balance: t.runningBalance,
    pnl: t.pnlUSD,
  }));

  let peak = -Infinity;
  let maxDrawdownPct = 0;
  for (const t of trades) {
    if (t.runningBalance > peak) peak = t.runningBalance;
    const dd = peak > 0 ? ((peak - t.runningBalance) / peak) * 100 : 0;
    if (dd > maxDrawdownPct) maxDrawdownPct = dd;
  }
  const lastBalance = trades[trades.length - 1]?.runningBalance || 0;
  const currentDrawdown = peak > 0 ? ((peak - lastBalance) / peak) * 100 : 0;

  const avgWinUSD = wins.length > 0 ? grossProfit / wins.length : 0;
  const avgLossUSD = losses.length > 0 ? grossLoss / losses.length : 0;
  const winLossRatio = avgLossUSD > 0 ? avgWinUSD / avgLossUSD : avgWinUSD > 0 ? Infinity : 0;
  
  const winRate = (wins.length / trades.length) * 100;
  const lossRate = 100 - winRate;
  const expectancyUSD = (winRate / 100 * avgWinUSD) - (lossRate / 100 * avgLossUSD);

  let currentWnStreak = 0;
  let currentLossStreak = 0;
  let maxWinStreak = 0;
  let maxLossStreak = 0;
  for (const t of trades) {
    if (t.pnlUSD > 0) {
      currentWnStreak++;
      currentLossStreak = 0;
      if (currentWnStreak > maxWinStreak) maxWinStreak = currentWnStreak;
    } else if (t.pnlUSD < 0) {
      currentLossStreak++;
      currentWnStreak = 0;
      if (currentLossStreak > maxLossStreak) maxLossStreak = currentLossStreak;
    }
  }

  const meanPnL = netPnL / trades.length;
  const variance = trades.reduce((s, t) => s + Math.pow(t.pnlUSD - meanPnL, 2), 0) / trades.length;
  const stdDev = Math.sqrt(variance);
  const sharpeRatio = stdDev > 0 ? meanPnL / stdDev : 0;

  const symbolMap = {};
  for (const t of trades) {
    if (!symbolMap[t.symbol]) symbolMap[t.symbol] = { symbol: t.symbol, pnl: 0, trades: 0, wins: 0 };
    symbolMap[t.symbol].pnl += t.pnlUSD;
    symbolMap[t.symbol].trades++;
    if (t.pnlUSD > 0) symbolMap[t.symbol].wins++;
  }
  const bySymbol = Object.values(symbolMap).map(s => ({
    ...s,
    winRate: s.trades > 0 ? (s.wins / s.trades) * 100 : 0,
  })).sort((a, b) => b.pnl - a.pnl);

  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const dayMap = {};
  for (const t of trades) {
    const day = days[new Date(t.closeTime).getDay()];
    if (!dayMap[day]) dayMap[day] = { day, pnl: 0, trades: 0 };
    dayMap[day].pnl += t.pnlUSD;
    dayMap[day].trades++;
  }
  const byDayOfWeek = days.map(d => dayMap[d] || { day: d, pnl: 0, trades: 0 });

  const monthMap = {};
  for (const t of trades) {
    const d = new Date(t.closeTime);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (!monthMap[key]) monthMap[key] = { month: key, pnl: 0, trades: 0, wins: 0 };
    monthMap[key].pnl += t.pnlUSD;
    monthMap[key].trades++;
    if (t.pnlUSD > 0) monthMap[key].wins++;
  }
  const byMonth = Object.values(monthMap).sort((a, b) => a.month.localeCompare(b.month));

  const avgDurationMin = trades.reduce((s, t) => s + (t.durationMinutes || 0), 0) / trades.length;

  const bySessonMap = {
    Tokyo: { session: 'Tokyo (Asan)', pnl: 0, trades: 0, wins: 0 },
    London: { session: 'London (Eur)', pnl: 0, trades: 0, wins: 0 },
    Overlap: { session: 'London/NY Overlap', pnl: 0, trades: 0, wins: 0 },
    NewYork: { session: 'New York (US)', pnl: 0, trades: 0, wins: 0 },
    Pacfc: { session: 'Pacfc/Late NY', pnl: 0, trades: 0, wins: 0 },
  };
  for (const t of trades) {
    const utcHour = new Date(t.closeTime).getUTCHours();
    let sess = 'Pacfc';
    if (utcHour >= 0 && utcHour < 8) sess = 'Tokyo';
    else if (utcHour >= 8 && utcHour < 13) sess = 'London';
    else if (utcHour >= 13 && utcHour < 16) sess = 'Overlap';
    else if (utcHour >= 16 && utcHour < 21) sess = 'NewYork';

    bySessonMap[sess].pnl += t.pnlUSD;
    bySessonMap[sess].trades++;
    if (t.pnlUSD > 0) bySessonMap[sess].wins++;
  }
  const bySesson = Object.values(bySessonMap).map(s => ({
    ...s,
    winRate: s.trades > 0 ? (s.wins / s.trades) * 100 : 0
  }));

  const tagMap = {};
  for (const t of trades) {
    if (t.tags && t.tags.length > 0) {
      for (const tag of t.tags) {
        const trimmed = tag.trim();
        if (!trimmed) continue;
        if (!tagMap[trimmed]) tagMap[trimmed] = { tag: trimmed, pnl: 0, trades: 0, wins: 0 };
        tagMap[trimmed].pnl += t.pnlUSD;
        tagMap[trimmed].trades++;
        if (t.pnlUSD > 0) tagMap[trimmed].wins++;
      }
    }
  }
  const byTag = Object.values(tagMap).map(tg => ({
    ...tg,
    winRate: tg.trades > 0 ? (tg.wins / tg.trades) * 100 : 0
  })).sort((a, b) => b.pnl - a.pnl);

  const emotonMap = {};
  for (const t of trades) {
    if (t.emotion) {
      const emo = t.emotion;
      if (!emotonMap[emo]) emotonMap[emo] = { emotion: emo, pnl: 0, trades: 0, wins: 0 };
      emotonMap[emo].pnl += t.pnlUSD;
      emotonMap[emo].trades++;
      if (t.pnlUSD > 0) emotonMap[emo].wins++;
    }
  }
  const byEmoton = Object.values(emotonMap).map(em => ({
    ...em,
    winRate: em.trades > 0 ? (em.wins / em.trades) * 100 : 0
  })).sort((a, b) => b.pnl - a.pnl);

  let totalRules = 0;
  let compledRules = 0;
  for (const t of trades) {
    if (t.checklist && t.checklist.length > 0) {
      for (const rule of t.checklist) {
        totalRules++;
        if (rule.complied) compledRules++;
      }
    }
  }
  const globalComplanceRate = totalRules > 0 ? (compledRules / totalRules) * 100 : 0;

  const gradeMap = {};
  for (const t of trades) {
    if (t.grade) {
      const grd = t.grade;
      if (!gradeMap[grd]) gradeMap[grd] = { grade: grd, pnl: 0, trades: 0, wins: 0 };
      gradeMap[grd].pnl += t.pnlUSD;
      gradeMap[grd].trades++;
      if (t.pnlUSD > 0) gradeMap[grd].wins++;
    }
  }
  const byGrade = Object.values(gradeMap).map(g => ({
    ...g,
    winRate: g.trades > 0 ? (g.wins / g.trades) * 100 : 0
  })).sort((a, b) => a.grade.localeCompare(b.grade));

  console.log("SUCCESS");
} catch(e) {
  console.error("FAILED:", e.stack);
}

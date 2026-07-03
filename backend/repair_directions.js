const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, 'routes/trades.js');
let content = fs.readFileSync(file, 'utf8');

const replacements = [
  // Fix arrow function parameters that were messed up
  [/\bit =>\b/g, 't =>'],
  [/\bis =>\b/g, 's =>'],
  [/\bin =>\b/g, 'n =>'],
  [/\bid =>\b/g, 'd =>'],

  // Fix missing i's in specific variables
  [/\bbggestWn\b/g, 'biggestWin'],
  [/\bbggestLoss\b/g, 'biggestLoss'],
  [/\bequtyCurve\b/g, 'equityCurve'],
  [/\bavgDuratonMn\b/g, 'avgDurationMin'],
  [/\bsharpeRato\b/g, 'sharpeRatio'],
  [/\bnfnty\b/g, 'Infinity'],
  [/\bFrday\b/g, 'Friday'],
  [/\bvarance\b/g, 'variance'],
  [/\bmetrcs\b/g, 'metrics'],
  [/\bsesson\b/g, 'session'],
  [/\bcomplance\b/g, 'compliance'],
  [/\bproftFactor\b/g, 'profitFactor'],
  [/\bwnLossRato\b/g, 'winLossRatio'],
  [/\bavgWnUSD\b/g, 'avgWinUSD'],
  [/\bmaxWnStreak\b/g, 'maxWinStreak'],
  [/\bavgWn\b/g, 'avgWin'],
  [/\bavgLoss\b/g, 'avgLoss'],
  [/\brrRato\b/g, 'rrRatio'],
  [/\bmaxConsecWns\b/g, 'maxConsecWins'],
  [/\blargestWn\b/g, 'largestWin'],
  [/\bsplt\b/g, 'split'],
  [/\bgetTme\b/g, 'getTime'],
  [/\bthrtyDaysAgo\b/g, 'thirtyDaysAgo'],
  [/\bsxMonthsAgo\b/g, 'sixMonthsAgo'],
  [/\bstartWth\b/g, 'startsWith'],
  [/\bstartsWth\b/g, 'startsWith'],
  [/\bMath\.mn\b/g, 'Math.min'],
  [/\blotSze\b/g, 'lotSize'],
  [/\bcommsson\b/g, 'commission']
];

for (const [pattern, replacement] of replacements) {
  content = content.replace(pattern, replacement);
}

// Special case: is + Number -> s + Number (since reduce(s, t) => s + ...)
content = content.replace(/\bis \+/g, 's +');

fs.writeFileSync(file, content, 'utf8');
console.log('Fixed trades.js with Node script');

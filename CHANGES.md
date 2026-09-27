# What's new (September 2026)

A summary of everything added in this round, in plain terms. Technical details are in the README ("AI Agent Backtesting (MCP)") and the in-app Manual, chapter 11.

## 1. AI can review your real journal (read-only)
- On **Accounts → AI agent access**, tick **Journal access** on a key (or when creating one). It's off by default and **read-only**: the AI can never change anything.
- The AI can then read:
  - **Trades:** results after commission and swap, R from your real stop, setup, confirmations, tags, emotion, grades, exit reasons.
  - **Your journaling:** notes, checklists (which rules you broke), playbook answers, replay reviews, screenshots.
  - **Stats:** breakdowns by setup, session, emotion, rules followed, hold time and more, each with a sample-size label and likely range.
  - **Price action:** candles around any trade.
  - **Everything else:** playbooks, knowledge base, pre-trade analyses, deposits and withdrawals.
- Example request: *"Review my live trades from the last 3 months. Where am I losing money: the setup or my execution?"*

## 2. Export for AI (any chat, any device, no setup)
- **Trades page → Export for AI** copies or downloads one document from the page's filters. It contains:
  - instructions for the AI to review your trading like a coach;
  - your stats with likely ranges, and breakdowns;
  - your playbooks;
  - your trades with their journal (your notes are optional).
- Paste or upload it into ChatGPT, Claude, Gemini or any other chat.

## 3. Connect claude.ai on web and phone (sign-in, no key)
- In claude.ai: **Settings → Connectors → Add custom connector**, paste your journal's MCP address (shown on Accounts), click **Connect**, sign in and click **Allow**.
- Tick **Read my trade journal** on that page if you want Claude to see your trades.
- Connected apps are listed on Accounts, where you can turn journal access off or **Disconnect** them.
- Sign-ins expire hourly and renew automatically.

## 4. AI strategy testing without new code on the server
- **Strategies as code:** the AI writes a mechanical strategy as a short script, and the server tests it over months or years of your cTrader history, usually in seconds to minutes.
  - The script only ever sees closed candles, so no hindsight.
  - The server itself settles every entry, stop and target on 1-minute data.
  - Optional spread and commission.
- **Trend following:**
  - trailing stops;
  - scaling into winners (several positions at once);
  - partial profits;
  - ADX, MACD, Donchian, Bollinger, Keltner and Supertrend indicators;
  - up to 25 years and 20 markets in one run.
- **Bar-by-bar replay** is still there for judgement-based setups.
  - A new "wick beyond a level" stop makes liquidity-sweep replays fast.
- **Research tools:** rule versions, held-out testing, entry-condition breakdowns and likely ranges on every result.
- Everything the AI logs is marked **AGENT** and kept out of your own backtest stats unless you switch the view to Agent or All.

## 5. Backtest fixes (from testers)
- **Drawings no longer disappear when you switch timeframe** (or after a refresh). Drawings are moved onto the new timeframe's candles instead of being lost.
- **Rectangles / zones now extend**: the right edge follows the latest candle as the replay moves forward.
- **Initial balance**: a **Balance $** box next to **Risk $** shows your risk as a % of the account. It's remembered in your browser.

## 6. Real position sizing (contract sizes per symbol)
- The Backtest position tool now uses each symbol's **contract size, minimum lot and lot step from your cTrader broker**, plus a USD conversion for non-USD quotes (e.g. JPY, EUR indices).
- **Size by Risk $:** type the dollars you want to risk. Moving the stop re-sizes the position in lots, rounded down to the broker's lot step, and the $ shown is what those lots really risk (e.g. $100 on gold gives 0.10 lots and $95.51).
- **Size by Lots:** type the lots. Moving the stop changes the dollar risk, as it would in a real account.
- The entry label shows the lots, and the lot size is saved with each backtest in the Backtest Log.

## 7. Labels and requirements
- **AI agent access** is marked **Experimental**.
- **Bar replay and backtesting need cTrader**: connect at least a free cTrader **demo** account on the Accounts page. Journal review and Export for AI work without it.

## Backtest results so far (gold, 2025-09-22 → 2026-09-22)
| Strategy | Trades | Win rate | Avg R (likely range) | Verdict |
|---|---|---|---|---|
| ORB NY Open (breakout close) | 233 | 57.9% | +0.04 | about break-even |
| ORB + 5-min confirmation + retest | 189 | 50.3% | +0.01 (−0.14 to +0.15) | no edge |
| ORB + 1-min confirmation + retest | 217 | 49.3% | −0.01 (−0.15 to +0.12) | no edge |
| ORB liquidity sweep | 33 | 45.5% | +0.27 (−0.30 to +0.84) | promising, too few trades |
| Daily FVG (XAUUSD) | 45 | n/a | +0.87 | strongest so far; test more |

Next step worth doing: rerun the liquidity sweep over 5 years with the new strategy-as-code runner to get hundreds of trades.

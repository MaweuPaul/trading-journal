# Trade Journal — Security & Journal Quality Audit

**Scope:** full repo review (backend Express API, Next.js frontend, `sync.py` MT5 agent).
**Date:** 2026-08-15
**Reviewer stance:** senior engineer + trader. No code was changed.

---

## 0. Executive summary

The architecture is genuinely good for a personal journal: single-owner lock, AES-256-GCM credential encryption with context binding, a scoped sync-agent token, immutable playbook version snapshots, and an offline fallback. The playbook/Edge Coach model is more thoughtful than most commercial journals.

Three things undermine it:

1. **Real trading data is committed to git.** `backend/local_account_events.json` is tracked and contains real deposits, withdrawals, broker transaction IDs and your user ID — despite being listed in `.gitignore`.
2. **Every analytic silently merges all broker accounts.** You added multi-account support, but `/stats`, `/performance`, `/calendar`, `/balance`, `/coach` and both exports have no `accountKey` filter. Demo trades, live trades and two different prop accounts are averaged into one equity curve. Every number on those pages is currently untrustworthy.
3. **The flagship Edge Coach metric is mathematically dead.** The "missed profit / early exit" calculation algebraically cancels to zero. `estimatedMissedUSD` is *always* exactly `0.00`. Nobody has noticed because it renders as a plausible number.

Beneath #3 sits the single biggest journal gap: **you never record the stop loss.** Without initial risk there is no R-multiple, and without R-multiple a trading journal cannot answer its most important question — *am I being paid for the risk I take?* MT5 has this data and `sync.py` throws it away.

Findings are ranked below. Severity is calibrated for a **personal, single-owner journal handling real money**, not a multi-tenant SaaS.

---

## 1. Security findings

### SEC-1 — Real financial data committed to git — **HIGH**

`backend/local_account_events.json` is tracked by git (`git ls-files` confirms it) and currently shows as modified. `.gitignore` lists it, but **gitignore does not apply to already-tracked files** — it was committed before the ignore rule landed, in `df50ac4` and `71fa44a`, and has been silently versioned ever since.

Contents include real withdrawals/deposits, amounts, broker transaction IDs (`externalId: "535145458"`), account object IDs and your user ID:

```json
{ "type": "withdrawal", "amount": 10, "occurredAt": "2026-08-13T...",
  "note": "OTXX-WD(93680504)-D", "externalId": "291198872",
  "accountKey": "mt5:6a7cae9193507d63d9e6ef83", "user": "6a1eee5706ed670d978060f1" }
```

If this repo is ever pushed to a public remote, forked, or shared with a collaborator, your cash-flow history goes with it — including in history, so deleting the file now is not enough.

**Fix:** `git rm --cached backend/local_account_events.json`, commit, then purge from history (`git filter-repo --path backend/local_account_events.json --invert-paths`, or BFG) before any push. Rotate nothing — no secrets leaked — but treat the transaction IDs as disclosed.

**Good news:** no `.env` file has ever been committed. I checked the full history (`git log --all --diff-filter=A`) — only `.env.example` files are tracked. That part was done right.

### SEC-2 — Plaintext owner password in `backend/.env` powers an offline login bypass — **HIGH**

`backend/.env` contains `ADMIN_EMAIL` and `ADMIN_PASSWORD` in plaintext. `routes/auth.js:95-102`:

```js
if (mongoose.connection.readyState !== 1) {
  const env = ownerEnv();
  if (env.email && env.password && email === env.email.toLowerCase() && password === env.password) {
    const user = { id: 'mocked_admin_user_id', ... };
    return res.json({ token: signToken(user), user });
  }
```

Three problems compounding:

- The password lives on disk in plaintext, next to `MONGODB_URI`, `JWT_SECRET` and `ACCOUNT_ENCRYPTION_KEY`. Anything that reads that one file owns everything.
- The comparison is `===`, not `safeSecretEqual` — you already wrote a timing-safe comparator and used it for `SYNC_SECRET` (`auth.js:121`) but not here.
- The resulting token carries `userId: 'mocked_admin_user_id'`, and `isOfflineTradeVisibleToUser` (`trades.js:600-604`) returns `true` **unconditionally** for that ID. An offline token sees every trade and every account event in the local cache, regardless of owner.

This path activates precisely when MongoDB is unreachable — i.e. when you are least able to notice.

**Fix:** store a bcrypt hash (`OWNER_PASSWORD_HASH`) instead of the plaintext, compare with `bcrypt.compare`, and scope the offline token to a real owner ID captured at first login rather than a wildcard sentinel. `SEED_OWNER_ENABLED` is already `false` in `.env.example` — the legacy `ADMIN_*` names in your live `.env` should be removed once you migrate.

### SEC-3 — No rate limiting anywhere, with a wide-open CORS policy — **MEDIUM**

`server.js:22`: `app.use(cors({ origin: true, credentials: true }))` reflects *any* origin. There is no `express-rate-limit` or equivalent in the dependency tree — I checked.

`POST /api/auth/login` is unauthenticated, unthrottled, and reachable from any web page you happen to have open, because the API listens on `localhost:4000` and CORS reflects the caller's origin. Bearer tokens live in `localStorage` rather than cookies, so this is not classic CSRF — but it does mean any site can run an unlimited credential-guessing loop against your local API, and read the result.

**Fix:** pin `origin` to your actual frontend origin(s) rather than `true`; add `express-rate-limit` to `/api/auth/login`, `/api/auth/register` and `/api/auth/sync-agent` (e.g. 10 attempts / 15 min). Cheap, high value.

### SEC-4 — Destructive endpoints have no second factor and no owner-role check — **MEDIUM**

`DELETE /api/maintenance/trades` (`trades.js:1047`) wipes the entire trade history with a single authenticated call. No confirmation token, no dry-run, no soft-delete, no automatic backup first. Same shape for `POST /maintenance/dedupe-trades` (`trades.js:1066`) and `recalculate-balances` (`trades.js:1125`), which rewrite data in place.

Compounding this: `routes/tradingAccounts.js` defines an `ownerOnly` guard (line 10) and applies it consistently — but **`routes/trades.js` never uses it.** Every owner-facing route there is protected only by `auth`. A sync-agent token is kept out solely by the URL allowlist in `middleware/auth.js:26-42`, which pattern-matches on the raw `req.originalUrl` string. That is a single fragile string check standing between a worker token and `DELETE /api/maintenance/trades`.

**Fix:** add the same `ownerOnly` middleware to every non-agent route in `trades.js` — defence in depth so the allowlist is not the only control. For the destructive routes, require an explicit confirmation field in the body (`{ confirm: "DELETE ALL TRADES" }`) and write a JSON backup before executing.

### SEC-5 — JWTs cannot be revoked — **LOW/MEDIUM**

Owner tokens last 7 days (`auth.js:21`), agent tokens 24h. There is no `jti`, no denylist, and no logout endpoint — the frontend just does `localStorage.removeItem('token')`. A copied token stays valid for its full lifetime with no way to kill it short of rotating `JWT_SECRET` (which also invalidates nothing else, but logs you out everywhere).

For a single-user local journal this is acceptable. It becomes a real problem the moment you deploy to Render/Vercel as the README describes.

**Fix (only if you deploy publicly):** add a `tokenVersion` integer on the `User` document, embed it in the JWT, and compare on each request. Bumping it revokes everything instantly.

### SEC-6 — Encryption key sits next to the data it protects — **LOW (design note)**

`lib/credentialEncryption.js` is well built: AES-256-GCM, random 12-byte IV, auth tag verified, and AAD bound to `userId:accountId:field` so a ciphertext cannot be moved between accounts or fields. That is better than most production code I review.

Be clear-eyed about what it buys you, though: `ACCOUNT_ENCRYPTION_KEY` lives in `backend/.env` on the same host that reads the database. This protects against **MongoDB Atlas compromise, a leaked DB backup, or a stolen connection string** — genuinely valuable. It does **not** protect against host compromise, since the attacker gets key and ciphertext together.

Also note `GET /api/sync-agent/trading-accounts` (`tradingAccounts.js:146-168`) decrypts and returns **plaintext MT5 passwords over HTTP** to the local agent. Over `http://localhost` that is fine. If you ever set `API_BASE` to a remote host without TLS, you are shipping broker credentials in the clear. Consider refusing to serve that endpoint when `req.secure` is false and the host is not loopback.

### SEC-7 — Minor hardening notes — **LOW**

| Item | Location | Note |
|---|---|---|
| 25 MB JSON body limit | `server.js:23` | Unthrottled base64 screenshot uploads; an accidental loop fills disk/Cloudinary quota. |
| Raw error messages returned to client | throughout `trades.js` (`res.status(500).json({ error: err.message })`) | Leaks Mongoose/internal detail. Log server-side, return a generic message. |
| Proxy strips `Origin`/`Referer` | `frontend/app/api/[...path]/route.ts:33` | Deliberate, but it removes the backend's ability to ever do origin checks. |
| `NEXT_PUBLIC_API_URL` | `frontend/.env.local` | `NEXT_PUBLIC_*` is inlined into the browser bundle. Harmless if it is a localhost URL; do not put an internal hostname there. |
| Offline screenshots served statically | `server.js:28` | `/public/screenshots/...` is served with **no auth**. Anyone who can reach port 4000 can enumerate and read your chart screenshots if they guess a trade ID. |
| `repair_directions.js` | `backend/` | A committed script that regex-rewrites `routes/trades.js` in place. Running it by accident mangles your router. Delete it. |

---

## 2. Data-integrity bugs — the ones that cost you money

These are not security issues. They are worse, for a trader: they make the journal *confidently wrong*.

### BUG-1 — Every analytic merges all broker accounts — **CRITICAL**

You built multi-account support (`TradingAccount` model, `accountKey` on every trade, an accounts page, per-account sync). Then only **two** endpoints actually filter by it:

| Endpoint | `accountKey` filter? |
|---|---|
| `GET /api/trades` (`trades.js:1761`) | ✅ yes |
| `GET /api/trades/latest-close` (`trades.js:1741`) | ✅ yes |
| `GET /api/stats` (`trades.js:2838`) | ❌ **no** |
| `GET /api/performance` (`trades.js:1538`) | ❌ **no** |
| `GET /api/calendar` (`trades.js:3168`) | ❌ **no** |
| `GET /api/balance` (`trades.js:3224`) | ❌ **no** |
| `GET /api/coach` (`trades.js:3464`) | ❌ **no** |
| `GET /api/export/json`, `/export/csv` | ❌ **no** |

All of them query `{ user: req.user.userId }` and nothing else.

Why this is severe, concretely: `runningBalance` is **per-account**. `/performance` sorts every trade from every account by `closeTime` and walks `runningBalance` to build one equity curve (`trades.js:1618-1633`). If account A sits at $5,000 and account B at $300, the curve sawtooths between them and `maxDrawdownPct` reports catastrophic drawdowns that never happened. `startBalance` (`trades.js:1671`) is taken from whichever account happened to close first.

`GET /api/balance` (`trades.js:3249`) is worse — it takes `Trade.findOne().sort({closeTime:-1})` across *all* accounts and reports that single account's `runningBalance` as **your balance**. Your dashboard headline number is whichever account traded most recently.

And demo trades pollute live statistics. `/coach` has a `demoVsLive` split (`trades.js:3633-3634`) but every *other* metric in that response — grade gap, exit reasons, confidence curve, setup analytics, playbook effectiveness — is computed over the merged set.

**Fix:** thread `accountKey` through all six endpoints exactly as `/api/trades` does, add an account selector to the app shell (not per-page), and persist it. For equity/drawdown specifically, compute **per-account curves and never concatenate them** — if you want a portfolio view, sum the per-account balances at each timestamp, don't interleave rows.

### BUG-2 — Edge Coach "missed profit" always returns zero — **HIGH**

`trades.js:3533-3539`:

```js
const actualRR = t.pnlUSD > 0 && t.plannedRR > 0
  ? parseFloat((t.pnlPct > 0 ? (t.pnlPct / (Math.abs(t.pnlPct) / t.plannedRR || 1)) : 0).toFixed(2))
  : null;
const missedRR = t.plannedRR - (actualRR || 0);
const estimatedTargetUSD = t.pnlUSD > 0 ? (t.pnlUSD / (actualRR || t.plannedRR)) * t.plannedRR : 0;
const missedUSD = Math.max(0, estimatedTargetUSD - t.pnlUSD);
```

Work the algebra. For a winner with `pnlPct > 0`:

```
actualRR = pnlPct / (|pnlPct| / plannedRR) = pnlPct · plannedRR / pnlPct = plannedRR
```

`actualRR` is **identically `plannedRR`**, for every winning trade, always. Therefore:

- `missedRR = plannedRR − plannedRR = 0`
- `estimatedTargetUSD = (pnlUSD / plannedRR) · plannedRR = pnlUSD`
- `missedUSD = max(0, pnlUSD − pnlUSD) = 0`

For a loser, `actualRR` is `null`, so `missedRR = plannedRR` (the full planned RR is booked as "missed" — meaningless) and `estimatedTargetUSD = 0`, so `missedUSD = 0` again.

**Net result: `estimatedMissedUSD` is mathematically guaranteed to be `0.00` on every possible input, and `totalMissedRR` is just the sum of `plannedRR` over your losing non-TP/SL exits.** The headline "money left on the table" number on the Coach page is a constant.

The same cancellation appears in `avgRROf` at `trades.js:3604-3609`, which also always returns mean `plannedRR`. (That one is dead code — `interventionAvgRR`/`cleanAvgRR` appear in the empty-state object at line 3491 but are never included in the real response at 3789-3797.)

**Root cause:** you cannot compute a realised R-multiple from `pnlPct` alone. R requires initial risk. See MISS-1 below — this bug cannot be *fixed*, only *enabled*, by recording the stop loss.

### BUG-3 — `runningBalance` ignores deposits and withdrawals — **HIGH**

`sync.py:421-434` derives history backwards from the current balance:

```python
total_profit_in_window = sum(d.profit + d.commission + d.swap for d in closed_sorted)
balance_before_window = current_balance - total_profit_in_window
```

This assumes the only thing that ever moved your balance was trading P&L. It is not — you have withdrawals in your own data (`local_account_events.json` shows several). Every deposit or withdrawal inside the window shifts the entire reconstructed history by that amount, so historical `runningBalance` values, `pnlPct` (`sync.py:465`, which divides by `balance_before_trade`), the equity curve and every drawdown figure are all skewed.

`POST /api/maintenance/recalculate-balances` (`trades.js:1146-1147`) repeats the identical mistake — it re-walks P&L from an anchor balance and never consults `AccountEvent`. The tool built to fix bad balances reproduces the bug.

**Fix:** merge `AccountEvent` rows into the chronological walk in both places, applying `accountEventNetAmount` at its `occurredAt`. You already have the events synced and the helper written (`trades.js:624-629`) — it just isn't wired into the balance reconstruction. Also scope the walk **per `accountKey`** (see BUG-1).

### BUG-4 — Partial closes and scale-ins are recorded incorrectly — **MEDIUM/HIGH**

`sync.py:411`: `closed = [d for d in deals if d.entry == mt5.DEAL_ENTRY_OUT]`

Then for each closing deal, entry price comes from the **first** `DEAL_ENTRY_IN` found on that position (`sync.py:447-450`).

Consequences:

- **Partial closes** each become a separate "trade" sharing one `positionId`. Take 50% at 1R and run the rest to 3R and your journal shows two trades, inflating trade count and distorting win rate, average duration and expectancy.
- **Scale-ins** (multiple `DEAL_ENTRY_IN` on one position) use only the first fill's price, not the volume-weighted average entry. Your recorded entry price is wrong, so any R or MFE/MAE math built on it is wrong.
- **`DEAL_ENTRY_OUT_BY`** (close-by, hedging accounts) is filtered out entirely — those trades never reach the journal at all.

You do have `tradeGroup`/`parentTradeId` and a `groupBySetup` aggregation, but that is a manual, after-the-fact UI grouping for re-entries. It does not reconstruct a position from its deals, and `groupBySetup` isn't applied on `/coach` or `/calendar` anyway.

**Fix:** aggregate by `position_id` at the source in `sync.py`. Build one journal record per position with volume-weighted average entry, volume-weighted average exit, summed P&L/commission/swap, `openTime` = first IN, `closeTime` = last OUT, and keep the individual fills as a `legs[]` array for partial-exit analysis (which is itself a feature worth having).

### BUG-5 — Zero-trade ranges emit `NaN` — **LOW**

In `/api/stats`, `winRate` (line 2981), `expectancyUSD` (2983), `meanPnL` (3003) and `avgDurationMin` (3044) all divide by `trades.length` with no guard. Select a range with no trades and these become `NaN`, which `JSON.stringify` serialises as `null`. The final `winRate` at line 3137 *is* guarded — the intermediate ones are not. `profitFactor: Infinity` (line 3138) also serialises to `null`, so a flawless run shows the same value as no data.

### BUG-6 — Typo'd strings leak into the API response — **LOW (cosmetic, user-facing)**

`trades.js:3047-3052` ships these labels to the UI:

```js
Tokyo:  { session: 'Tokyo (Asan)',      ... }   // Asian
London: { session: 'London (Eur)',      ... }   // Euro
Pacfc:  { session: 'Pacfc/Late NY',     ... }   // Pacific
```

These are visible on your Stats page. They are the residue of `repair_directions.js` — a regex script that stripped `i` characters across `routes/trades.js` and was then partially repaired by hand. The file is still full of the fallout in comments (`Equty curve`, `Rsk stats`, `Sharpe Rato`, `Sesson Analytcs`, `Wn/Loss Streaks`). Cosmetic, but it is the kind of thing that makes you distrust the numbers next to it.

---

## 3. Missing journal elements

Your `MISSING_FEATURES.md` is a strong feature backlog and I won't repeat it. These are the gaps that are *different in kind* — data you are permanently losing, every day, that you cannot backfill later.

### MISS-1 — No stop loss, no take profit, no risk. This is the big one. — **CRITICAL**

The `Trade` schema (`models/Trade.js`) has no `stopLoss`, no `takeProfit`, no `riskUSD`, no `riskPercent`, no `initialRiskDistance`. `sync.py:467-484` builds its payload without them.

Everything downstream is crippled by this single omission:

- **No R-multiple.** You cannot say "that was a +2.4R trade." R is the only unit that lets you compare a 0.01-lot scalp to a 0.5-lot swing. Without it, `pnlUSD` comparisons across different position sizes are noise.
- **BUG-2 is unfixable** without it. "Missed profit" needs realised R vs planned R.
- **`plannedRR` is unverifiable.** You ask the user to type a planned R:R by hand, then have no way to check it against the actual stop that was on the order.
- **No risk-consistency analysis.** The single most valuable report a journal can produce — "your losers average 1.4R but your winners average 0.9R" — is impossible. That one chart has fixed more trading accounts than any indicator.
- **No MAE/MFE.** How far did it go against you before working? How much did you leave on the table? Both need the stop and the candle data — and you already fetch candles for Replay.

**The data is free and you are discarding it.** MT5's `history_orders_get(position=deal.position_id)` returns the opening order with `sl` and `tp` populated. Add three fields to the payload and the entire risk layer becomes computable — retroactively too, since MT5 keeps full order history.

### MISS-2 — `exitReason` is manual, but MT5 tells you for free — **HIGH**

`exitReason` is a hand-entered enum (`TP`, `SL`, `Fear`, `Revenge`, `ManualClose`…). It powers the Coach's exit-reason breakdown and the early-exit detection. It is also the field most likely to go unfilled or be filled dishonestly after a bad day.

MT5 deals carry `deal.reason`: `DEAL_REASON_SL` (4), `DEAL_REASON_TP` (5), `DEAL_REASON_CLIENT` (0), `DEAL_REASON_EXPERT` (3), `DEAL_REASON_SO` (6, stop-out). `sync.py` reads `deal.comment` and `deal.external_id` for cash-flow events (`sync.py:522-523`) but never reads `reason` for trades.

**Fix:** auto-populate an objective `exitTrigger` from `deal.reason`, and keep the subjective `exitReason` separate for the *why*. Then the Coach can report the gap: "you tagged 12 exits as 'ManualClose' — 9 of them were stop-outs." That is the kind of honesty a journal exists to enforce. Also capture `deal.magic` to separate EA trades from discretionary ones — right now they are indistinguishable.

### MISS-3 — CSV export drops most of the journal — **MEDIUM**

`trades.js:3332-3340` exports 25 columns. Missing: `accountKey`, `tradingAccount`, `plannedRR`, `exitReason`, `confidenceRating`, `analysisGrade`, `executionGrade`, `manuallyIntervened`, `primarySetup`, `setupConfirmations`, `isReEntry`, `tradeGroup`, `playbookId`/`playbookVersionId`, and any checklist compliance summary.

So the CSV contains the broker data (which you can re-download from MT5 anytime) and almost none of the journal data (which exists nowhere else). It exports the replaceable half. Note it also carries the legacy `grade` field but not the two `analysisGrade`/`executionGrade` fields that superseded it.

The JSON export (`trades.js:3269`) is complete — that's your real backup. The CSV is what you'd use in Excel or a notebook, and it's the one that's gutted.

### MISS-4 — No automated backup, despite a route that reports on it — **MEDIUM**

`GET /api/export/status` reports `localBackupInfo` and a `lastModified` timestamp, implying a backup regime. There isn't one — `local_trades.json` is only rewritten as a side effect of writes (`saveLocalDatabase`), there is no scheduled export, no retention, and no restore path. There is no import endpoint at all, so a full JSON export currently cannot be restored into a clean database without writing a script by hand.

A journal you can't restore is a journal you don't have. This matters more than any feature on the backlog.

### MISS-5 — No trade-level currency or instrument metadata — **MEDIUM**

Everything is hardcoded USD (`pnlUSD`, `currency: 'USD'` at `trades.js:1372`/`1391`). No `contractSize`, `tickValue`, or `pointValue` is stored per trade. That blocks:

- Correct risk math for XAUUSD vs USTEC vs EURJPY (each has a different value per point).
- Any non-USD-denominated account.
- Converting a stop distance in price into a monetary risk — which MISS-1 needs.

`sync.py` has symbol-alias handling already (`configured_symbol_aliases`, `resolve_broker_symbol`); `mt5.symbol_info()` returns `trade_contract_size` and `trade_tick_value` in the same call. Capture them per trade at sync time — they can change, so snapshot them rather than looking them up later.

### MISS-6 — No analytics tests — **MEDIUM**

15 tests pass. They cover credential encryption, replay annotation normalisation, sync-agent auth scoping and account-key helpers — all good, all correct. **Zero tests cover `/stats`, `/performance`, `/coach`, `/balance` or `/calendar`.** The math that decides whether you think you're profitable is the only part with no test coverage, which is exactly why BUG-2 survived.

A dozen table-driven tests with hand-computed expected values (three trades in, known profit factor / expectancy / drawdown out) would have caught BUG-2, BUG-3 and BUG-5 immediately.

Also: `backend/test-stats.js` is picked up by `node --test` and tries to bind port 4001 and hit a live server — it printed `"error": "JWT_SECRET is not configured"` during the run and still passed. Along with `test2.js` and `fetch-error.js`, these are scratch files that should not be in the repo.

### MISS-7 — Smaller gaps worth noting

- **No `tradingAccount` scoping on `AccountEvent` queries.** `/api/account-events` and `/api/balance` aggregate cash flow across accounts — same class of bug as BUG-1. The model *has* `accountKey` and `tradingAccount`; the queries ignore them.
- **No timezone model.** Session analytics bucket on `closeTime` UTC hour (`trades.js:3055`), day-of-week uses server-local `getDay()` (line 3025) while `/stats` range filters use UTC (line 2874). Mixed timezone bases in one endpoint. Store a broker/trader timezone preference and use it consistently.
- **No slippage or execution-quality tracking.** You have planned vs actual nowhere, because there is no plan record (your MISSING_FEATURES #1) and no requested-vs-filled price.
- **No commission/swap in the headline P&L.** `pnlUSD` is `deal.profit` only (`sync.py:475`); commission and swap are stored separately but `/stats` sums `pnlUSD` alone (`trades.js:2954-2956`) while `recalculate-balances` correctly includes all three (`trades.js:1146`). So your net P&L and your balance disagree by total costs. For a high-frequency or micro-lot account that gap is material.

---

## 4. Prioritised action plan

**This week — stop the bleeding**

1. Untrack `local_account_events.json` and purge it from history before any push. *(SEC-1)*
2. Fix the `pnlUSD` vs `pnlUSD + commission + swap` inconsistency, or at minimum surface both as `grossPnL`/`netPnL`. *(MISS-7)*
3. Delete `repair_directions.js`, `test2.js`, `fetch-error.js`, `test-stats.js`. *(SEC-7, MISS-6)*
4. Replace the plaintext `ADMIN_PASSWORD` with a bcrypt hash and use `safeSecretEqual`. *(SEC-2)*

**Next — make the numbers true**

5. Capture `sl`, `tp`, `deal.reason`, `deal.magic`, `contract_size`, `tick_value` in `sync.py`. Re-run a full history sync; MT5 still has it all. *(MISS-1, MISS-2, MISS-5)*
6. Add `accountKey` filtering to all six unfiltered endpoints, plus a global account selector. *(BUG-1)*
7. Fold `AccountEvent` into balance reconstruction in both `sync.py` and `recalculate-balances`. *(BUG-3)*
8. Rewrite the R-multiple math on top of the real stop, and delete the dead `avgRROf`. *(BUG-2)*
9. Write the analytics test suite — hand-computed fixtures, one per metric. *(MISS-6)*

**Then — harden and complete**

10. Rate-limit auth; pin CORS origin. *(SEC-3)*
11. `ownerOnly` on every `trades.js` route; confirmation payload + auto-backup on destructive routes. *(SEC-4)*
12. Aggregate deals by `position_id` for correct partial-close and scale-in handling. *(BUG-4)*
13. Full CSV export; add a JSON **import**/restore path; schedule automated backups. *(MISS-3, MISS-4)*
14. Fix the `NaN`/`Infinity` serialisation and the typo'd session labels. *(BUG-5, BUG-6)*

Only after all of that does the feature backlog in `MISSING_FEATURES.md` — pre-trade plans, daily journal, weekly review — become worth building. Those features generate *more* data flowing through the same broken analytics; fix the pipe before increasing the flow.

---

## 5. What's genuinely well built

Worth stating plainly, because the list above is long:

- **`lib/credentialEncryption.js`** — AES-256-GCM with per-field AAD context binding is textbook-correct. The context string (`userId:accountId:field`) means a ciphertext cannot be replayed into a different account or field. Most codebases I review get this wrong.
- **Immutable playbook snapshots.** Attaching a frozen copy of the playbook version to each trade, and refusing to swap it later (`trades.js:2316-2321`), means your historical analysis stays honest when you evolve your strategy. This is the single best design decision in the repo.
- **Sync-agent token scoping.** A separate short-lived role with an endpoint allowlist, rather than reusing the owner token, is the right instinct — it just needs the belt-and-braces `ownerOnly` on the other side.
- **The account-identity uniqueness migration** in `server.js:107-136` — recognising that MT5 deal tickets are unique per account, not globally, and migrating the index live, is careful work.
- **The offline fallback** genuinely works end-to-end, including screenshot sidecar metadata for later Cloudinary reconciliation.
- **`normalizeBlocks` / `validatePlaybookResponses`** — thorough server-side validation of a complex nested user-defined schema, with real bounds checking. It would have been easy to trust the client here.

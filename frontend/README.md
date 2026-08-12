# TradeJournal Frontend

The frontend is a Next.js 15 application for building versioned visual strategy playbooks and completing trade journals generated from those published rules.

## Appearance

Use the **Auto / Light / Dark** selector on the sign-in and sign-up screens or at the bottom of the authenticated sidebar. Auto follows the operating-system color preference. An explicit Light or Dark selection is saved in the browser and restored before the page paints, which avoids a flash of the wrong theme. Replay charts and their drawing tools use the same app-wide appearance setting.

The **Accounts** route manages multiple MT5 accounts. It shows safe labels, connection health, balance, trade count, and agent activity without returning broker credentials to browser JavaScript. Advanced symbol aliases and the real-account restriction are configured independently per account.

## Rule-driven journal model

The journal form is not hard-coded. A published playbook defines:

- Lifecycle stages: Concept, Context, Setup, Entry, Risk, Execution, Management, Exit, and Review.
- Rule labels, guidance, answer types, choices, units, defaults, and validation.
- Stage-level visual references.
- Rule-level reference, valid, and invalid example images.
- Which answers and instructional images are required.

When a playbook is attached to a trade, the frontend renders its fields in Plan, Manage, and Review tabs. The first save stores the complete published snapshot on that trade. Later playbook versions do not rewrite the journal, and an attached trade cannot switch to another version.

The Playbook editor uses progressive disclosure: rules initially show only their name, primitive answer type, format or choices, required state, and actions. Open **More options** for rule purpose, timeframe scope, failure behavior, guidance, validation, optional visual references, and trade-evidence settings. Reference images never block publishing. Enable **Require a trade screenshot** only when the generated journal must collect visual evidence from the actual trade, linked to the exact rule and immutable playbook version.

Rule purpose can be Observation, Confirmation, Entry trigger, Decision gate, Invalidation, Risk limit, Management action, Exit signal, or Review prompt. Timeframe scope is optional; no selection means all timeframes. Failure behavior records whether an unmet condition should only be recorded, warn the trader, skip the setup, or stop the session. Published values are displayed consistently in Read Playbook, Trade Journal Details, and Deep Playbook Replay without preventing an old journal from remaining editable.

The Answer type selector contains only the primitive values Yes/No, Number, Text, Single choice, and Multiple choice. Semantic controls are configured separately as formats: Number supports Percentage, Currency, Price, Duration, R:R, and Rating; Text supports Short text, Long explanation, Date, and Time.

The Trades page provides separate **Account type** and **Trading account** filters. Account type selects Live or Demo; Trading account selects the exact MT5 login and broker server captured by sync. Account filters, other table filters, pagination, the open trade, and Replay state remain URL-backed across refreshes. Older records without account identity remain available under **Older trades — account unknown** until a full MT5 resync backfills them.

The Trades drawer includes a full-screen **Replay** workspace. It requests only the needed broker window from the local MT5 sync agent and polls until the backend's short-lived cache receives it; candle history is not stored on the trade. The screen reveals candles one by one, marks entry and exit, and saves notes, emotion, grade, and tags. An explicitly labelled Twelve Data fallback is available when MT5 history is unavailable.

Replay timeline events default to **This timeframe** so chart-specific observations do not clutter every chart. Choose **All timeframes** for a trade-level decision or lesson that should follow the same timestamp and price across each Replay chart. Legacy events remain scoped to their original timeframe.

Replay separates trade identity from chart interaction controls. The second toolbar groups timeframe selection, Select, Zone, Line, Level, Arrow, Text, Image, and Event tools with contextual colors, autosave status, Undo, Delete, and saved-object management. Controls have visible active states and remain horizontally reachable on narrow screens. Select makes an object clickable; Delete/Backspace or the Delete button removes only that selected object. Image uploads become trade screenshots and are then pinned to an exact chart time and price. Annotation visibility follows candle playback so later documentation is not exposed early.

The bottom review transport shows entry, exit, and journal-event positions on the scrubber. It includes direct Entry/Exit and previous/next-note jumps plus an enabled-by-default option to pause automatically at entry and exit. A visible Shortcuts guide documents keyboard playback and Quick Review commands; editable fields suppress all global shortcuts. Process grading stays disabled until the preceding qualitative review questions are complete, and surprising plan/grade combinations receive an honesty prompt rather than an automatic score.

## Routes

| Route | Purpose |
|---|---|
| `/rules` | Build and publish immutable visual playbooks |
| `/rules/read` | Read a published playbook as a visual manual |
| `/trades` | Filter trades and complete the rule-generated journal |
| `/coach` | Compare versions, answers, stage compliance, and numeric evidence |
| `/signup` | Create the single owner on an empty installation |

## Local setup

Create `frontend/.env.local`:

```env
NEXT_PUBLIC_API_URL=http://localhost:4000/api
```

Then run:

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Verification

```bash
node node_modules/typescript/bin/tsc --noEmit
node node_modules/eslint/bin/eslint.js app/rules/page.tsx app/rules/read/page.tsx
npm run build
```

The full credential-backed test procedure is in [`../TESTING.md`](../TESTING.md), and installation instructions are in [`../SETUP.md`](../SETUP.md).

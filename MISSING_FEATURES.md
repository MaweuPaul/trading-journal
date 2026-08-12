# Missing Features — ETW Trade Journal

Current implementation gap register for the personal, single-owner trading journal.

Status legend: **Missing** = no implementation, **Partial** = useful foundation exists but the workflow is incomplete, **Complete** = verified in the current codebase and retained here only to correct the previous audit.

---

## Current Product Baseline

The journal already includes:

- One-time owner signup with no second user allowed after an owner exists
- MT5 trade synchronization with Live/Demo classification and filtering
- Versioned strategy playbooks with immutable snapshots on attached trades
- Structured playbook fields, required answers, reference images, and optional required trade-image confirmation
- Trade journal editing driven by the exact playbook version attached to that trade
- Edge Coach analysis for strategy versions, lifecycle-stage compliance, structured rule evidence, numeric fields, setup performance, exit reasons, and execution behavior
- Stats for symbols, sessions, weekdays, tags, emotions, grades, and global checklist compliance
- Full-screen Replay with MT5 requests, Twelve Data fallback, multiple timeframes, playback controls, drawing tools, and an integrated playbook journal
- Candle-linked Replay events for observations, decisions, emotions, mistakes, violations, lessons, and custom trade moments
- A default five-question Quick Review with conditional mistake/strength prompts and optional Deep Playbook mode
- URL-persisted Trades filters, pagination, selected trade, Replay trade, timeframe, and journal phase
- JSON backups and CSV export

---

## Critical

### 1. Pre-Trade Planning Workflow — Partial

**Existing:** Playbooks can model the full lifecycle using structured primitive fields, optional evidence, nine semantic rule tools, applicable timeframes, and the intended decision when a condition is not satisfied. Trades retain the attached playbook snapshot and answers. Replay timeline events can remain chart-specific or appear across all timeframes.

**Still missing:** A plan must be creatable and timestamped **before** an MT5 trade closes or syncs. Add a planned-trade record that can later be matched to the broker trade.

Recommended core fields:

- `setupDescription`
- `plannedEntry`, `plannedSL`, and `plannedTP`
- `sessionBias`
- `preTradeNotes`
- `plannedAt` and `executedAt`
- optional playbook version and responses captured at planning time
- matching state: planned, matched, cancelled, missed

### 2. Daily Session Journal — Missing

Add a `DayJournal` model and `/journal/daily` page containing:

- Pre-session mood, market bias, important news, daily loss limit, and maximum trade count
- Post-session review, wins, mistakes, rule violations, and next-session focus
- Automatic linking of trades by owner and trading date/timezone
- Daily planned risk versus realized P&L and drawdown

### 3. Risk Management Tracker — Partial

**Existing:** Playbooks support numeric, percentage, currency, price, duration, and risk-to-reward fields. Performance reporting includes drawdown.

**Still missing:** A canonical risk model and limits shared across trades and sessions:

- Planned monetary risk and `riskPercent` per trade
- Calculation from entry, stop, contract/tick value, volume, and account balance
- Daily and weekly risk budgets
- Warnings before limits are exceeded
- Planned R versus realized R reporting

---

## Important

### 4. Missed Trade Log — Missing

Create planned setups that can end as “missed” without becoming broker trades. Capture symbol, timeframe, direction, setup/playbook, evidence, reason not taken, and hypothetical result. Compare missed opportunities with executed trades without mixing hypothetical P&L into account results.

### 5. Weekly Review — Missing

Add a `WeeklyReview` model and `/journal/weekly` page. Pre-fill the review with weekly metrics and capture best/worst trade, recurring mistake, rule violations, key learning, and next-week goal.

### 6. Behavioral Mistake Taxonomy — Partial

**Existing:** Trades support free-form tags, structured emotions, exit reasons, intervention state, and playbook review questions. Stats and Coach analyze several of these fields.

**Still missing:** A separately stored, user-configurable mistake taxonomy such as revenge trade, moved stop, cut early, oversize, FOMO entry, no setup, over-trading, and ignored bias. Add frequency, cost, and trend reports without turning these into hard-coded strategy rules.

### 7. Per-Rule Checklist Compliance — Partial

**Existing:** Stats calculate global checklist compliance. Edge Coach compares playbook-version performance, required lifecycle-stage completeness, and structured rule answers.

**Still missing:** A dedicated report for each legacy checklist rule showing compliance rate, compliant versus non-compliant P&L/win rate, time trend, and sample size. Prefer playbook rule IDs so renamed rules remain historically comparable.

### 8. Save Replay Annotations — Partial

**Existing:** Replay stores rectangle/zone, line, and text annotations by trade and timeframe. Annotations autosave, survive refresh, appear in JSON backups, and support undo plus individual or clear-all deletion.

**Still missing:** Complete the advanced editing and image-export portion:

- Selecting, dragging, resizing, and editing existing annotations directly on the chart
- Optional chart-image capture uploaded to the existing screenshot system
- Association with the trade's immutable playbook version when appropriate

### 9. Replay Session Resume — Partial

**Existing:** The URL preserves the Replay trade, timeframe, and journal phase across refresh. MT5 replay sessions and candle data are cached server-side. Private notes, tags, playbook answers, grades, outcome fields, speed, and candle position now autosave in an ownership-scoped server draft with visible status.

**Still missing:** Revision browsing and explicit recovery of an older draft. Current autosave preserves the latest draft only; it does not yet expose a draft history UI.

---

## Nice to Have

### 10. Mobile Coverage — Partial

Responsive rules exist for the shell, tables, playbooks, journal, and Replay. A device-level QA pass is still required for small phones, touch drawing, landscape Replay, virtual-keyboard behavior, and accessible focus trapping.

### 11. Trade Import — Missing

CSV export exists, but CSV/Excel **import** does not. Add broker templates, field mapping, preview, validation, duplicate detection, timezone handling, and an import report.

### 12. Hypothesis / Strategy Lab — Partial

Edge Coach already provides strategy-version, rule-answer, setup, numeric-field, and compliance evidence. A user-authored hypothesis builder is still missing—for example: “XAUUSD + London + liquidity sweep + version 9.” It should expose filters, cohort comparison, minimum-sample warnings, and saved hypotheses.

### 13. Prop Firm Challenge Tracker — Missing

Add challenge accounts, starting balance, profit target, daily/max drawdown rules, minimum days, expiry, and breach warnings. Keep broker accounts and challenge rule sets separate.

### 14. Application-Wide Theme Toggle — Missing

Replay has its own dark workspace, but there is no persistent application-wide light/dark/system theme selector.

### 15. Notifications and Sync Health — Partial

Replay displays MT5 connection diagnostics, but there is no global notification center. Add alerts for new imports, stale/disconnected sync, risk-limit proximity, failed backups, and optional browser/email delivery.

### 16. Sharing — Missing

No public or expiring share view exists for a trade, weekly review, or redacted playbook. Sharing must be opt-in and remove account identity, broker IDs, and private notes by default.

### 17. AI-Assisted Insights — Missing

There is no natural-language query or evidence-grounded narrative layer. Any future AI feature should use the existing structured analytics, show its filters/sample size, cite the contributing trades, and never modify journal records without confirmation.

---

## Completed Since the Previous Audit

### Trade Replay UI — Complete

Replay is imported and rendered from the Trades journal drawer. It supports MT5-on-demand candle requests, Twelve Data fallback, multiple timeframes, diagnostics, playback, chart drawing, playbook responses, and saving review fields.

### Stats and Edge Coach — Complete Foundation

`/stats` and `/coach` are no longer placeholders. Both consume real analytics endpoints. More reports can be added, but the core pages and analysis logic are operational.

### Playbook-Based Journaling — Complete Foundation

Users can create flexible strategies, publish immutable versions, attach a version to a trade, and answer its structured rules in Trade Journal Details and Replay. Existing trades keep their historical snapshot when a new version is published.

### Replay and Trades Refresh Persistence — Complete

The Trades URL records table page/filters and active trade context. Replay additionally records timeframe and phase, so refreshing or sharing the URL restores that context.

### Twelve Data Configuration Documentation — Complete

The example and setup documentation use `TWELVE_DATA_API_KEY` placeholders. Secret values in personal `.env` files must never be documented or committed.

---

## Recommended Build Order

1. Pre-trade planned setup records and MT5 matching
2. Daily Session Journal
3. Canonical per-trade and daily risk tracking
4. Persisted Replay annotations and chart captures
5. Missed Trade workflow built on planned setups
6. Weekly Review generated from daily/trade data
7. User-configurable behavioral mistake taxonomy
8. Per-rule compliance report
9. Hypothesis Lab on top of existing Edge Coach cohorts
10. Mobile and touch Replay QA

---

*Audited: 2026-08-11*  
*Stack: Next.js · Node/Express · MongoDB · Cloudinary · MT5 Python sync · Twelve Data · Render/Vercel*

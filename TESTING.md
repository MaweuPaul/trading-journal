# TradeJournal Feature Testing Guide

This guide explains how each major feature works, how to test it, and what result confirms it is operating correctly.

## Verification status

The following checks were run against the repository on August 10, 2026:

| Check | Result | What it confirms |
|---|---|---|
| Backend JavaScript syntax | Passed | Express routes, models, middleware, and startup files parse correctly |
| TypeScript `tsc --noEmit` | Passed | Frontend pages and components are type-valid |
| Targeted ESLint | Passed | New Signup, Playbook, and contextual-help components pass their targeted lint checks |
| Next.js production build | Passed | All 15 application routes, including `/rules/read`, compile and prerender successfully |
| Playbook answer-type trace | Passed | Standard and specialized field types are configured in the builder, rendered in Trade Review, validated by the backend, and stored in snapshots |

Tests requiring real external credentials cannot be fully executed in a source-only environment. MongoDB persistence, Cloudinary upload/recovery, and MT5 synchronization must be verified against your own services using the procedures below.

## Seed the dummy visual playbook

The repository includes a complete test strategy, three local chart illustrations, and three sample response sets:

- `backend/fixtures/visual-playbook-test.json`
- `backend/fixtures/visual-playbook-responses.json`
- `frontend/public/playbook-test-assets/`

Start the backend, then seed the playbook through the authenticated API:

```powershell
cd backend
$env:TEST_USER_EMAIL='owner@example.com'
$env:TEST_USER_PASSWORD='your-test-password'
npm run seed:test-playbook
```

For a non-default deployment, also set `API_BASE` and `APP_BASE`. The script checks for the fixture name first and does not create a duplicate when it already exists. It never embeds or prints the password.

The response fixture is intentionally not written automatically to trades because each installation has different trade IDs. Open three existing test trades, attach `London Liquidity Sweep — Test Playbook`, and copy the matching values from `visual-playbook-responses.json` into the Plan, Manage, and Review stages. This produces winning, normal-loss, and poor-execution samples for Edge Coach.

## Test environment

Complete [SETUP.md](SETUP.md) first. For a complete integration test, prepare:

- A test MongoDB database
- A test Cloudinary account or folder
- An MT5 demo account with at least two closed trades
- A real account only if you want to test the Live classification
- Backend and frontend terminals
- Browser developer tools

Use a separate test database when testing destructive backup or recovery operations.

## 1. Backend health

### How it works

The Express backend exposes a public health endpoint independently of authentication.

### Test

1. Start the backend with `node backend/server.js`.
2. Open `http://localhost:4000/health`.

### Expected result

The response contains:

```json
{
  "status": "ok"
}
```

The timestamp may differ.

## 2. First-run Signup and registration lock

### How it works

`GET /api/auth/setup-status` checks whether any user exists. Signup is available only when the user collection is empty. `POST /api/auth/register` repeats that check on the backend and uses a unique owner key to prevent simultaneous requests from creating multiple owners.

### Test

1. Use a new empty MongoDB database.
2. Set `SEED_OWNER_ENABLED=false`.
3. Start the backend and frontend.
4. Open `/signup`.
5. Create the owner with an eight-character-or-longer password.
6. Sign out and sign in again.
7. Revisit `/signup`.
8. Attempt a direct second `POST /api/auth/register` request.

### Expected result

- First registration succeeds and signs the owner in.
- Login works with the new credentials.
- `/signup` reports that the journal is already configured.
- A second API registration returns HTTP `403`.
- The database contains exactly one user.

## 3. Environment owner seed

### How it works

When `SEED_OWNER_ENABLED=true`, startup creates the owner only if no user exists. Existing credentials are never overwritten.

### Test

1. Use an empty test database.
2. Configure `OWNER_NAME`, `OWNER_EMAIL`, and `OWNER_PASSWORD`.
3. Start the backend and sign in.
4. Stop the backend.
5. Change `OWNER_NAME` and `OWNER_PASSWORD` in `.env`.
6. Restart and try both the original and changed passwords.

### Expected result

- The first startup creates the owner.
- The second startup logs that the existing owner was retained.
- The original password still works.
- The changed environment password does not overwrite the database password.

## 4. Authentication and protected routes

### How it works

Login returns a seven-day JWT. Protected routes verify the token with the configured `JWT_SECRET`.

### Test

1. Open `/api/trades` without an `Authorization` header.
2. Sign in and repeat with `Authorization: Bearer TOKEN`.
3. Sign out from the sidebar.
4. Remove `JWT_SECRET` in a test environment and restart.

### Expected result

- Unauthenticated request returns `401`.
- Authenticated request succeeds.
- Logout clears the browser session and returns to Login.
- Missing `JWT_SECRET` produces a configuration error instead of using a hard-coded secret.

## 5. MT5 synchronization

### How it works

`sync.py` authenticates as the journal owner, reads closed MT5 deals, calculates trade duration and running balance, then posts new trades to `/api/sync`.

### Test

1. Close at least two trades in an MT5 demo account.
2. Run `python sync.py --once`.
3. Run it a second time.
4. Open the Trades page.

### Expected result

- First run reports inserted trades.
- Second run reports the same deals as skipped rather than duplicated.
- Entry, exit, direction, size, P&L, commission, swap, timestamps, and balance appear.
- The database has one record per owner and `dealId`.

## 6. Live and Demo classification

### How it works

The sync script maps MT5 real mode to `live`; demo and contest modes map to `demo`. Matching existing trades are backfilled during resync.

### Test

1. Sync from a demo account with `MT5_REQUIRE_REAL_ACCOUNT=false`.
2. Verify the Demo badge beside each symbol.
3. Use the Account filter: Demo only, Live only, and Live & Demo.
4. If available, repeat with a real account.
5. Set `MT5_REQUIRE_REAL_ACCOUNT=true` and attempt a demo sync.

### Expected result

- Demo sync produces `demo` records and badges.
- Filters return only the selected account type.
- Real sync produces `live` records.
- Real-only mode refuses the demo account before sending trades.

## 7. Trade list filters and pagination

### How it works

The frontend sends symbol, direction, account type, date range, page, and limit query parameters to `/api/trades`. The backend applies the same filtering in MongoDB and offline modes.

### Test

1. Filter by symbol.
2. Filter by BUY and SELL.
3. Filter by Live or Demo.
4. Apply From and To dates.
5. Combine filters.
6. Use Reset.
7. Test pagination with more than 50 trades.

### Expected result

- Every filter reduces the list correctly.
- Combined filters use all selected conditions.
- Reset restores the complete list and page 1.
- Pagination totals match the filtered result.

## 8. Journal fields

### How it works

Trade Review stores notes, emotion, grades, tags, planned R:R, confidence, exit reason, intervention, re-entry details, screenshots, and playbook responses on the selected trade.

### Test

1. Open a trade.
2. Complete every visible review field.
3. Save and close the drawer.
4. Refresh the browser and reopen the trade.

### Expected result

All saved fields return exactly as entered. A failed save shows an error and does not silently close with lost data.

## 9. Playbook creation

### How it works

A playbook is a custom strategy made of blocks and structured rules. Publishing creates an immutable version.

### Test

1. Open Playbooks.
2. Create `Answer Type Test`.
3. Add a block named `Evidence`.
4. Add one rule for each answer type listed below.
5. Mark at least one rule Required.
6. Publish version 1.

### Expected result

- The strategy appears in the playbook list as version 1.
- It can be selected from Trade Review.
- Choice fields require at least two comma-separated choices before publishing.
- Empty block names or rule labels prevent publishing.

## 10. Playbook answer types

The screenshot in the request shows the six supported answer types. They are not merely display options; each selects a different trade-review control and backend validation rule.

| Answer type | How it works in Trade Review | Backend validation | Edge Coach comparison |
|---|---|---|---|
| Yes / No | Two buttons store the boolean `true` or `false` | Rejects non-boolean values | Yes and No outcomes are compared separately |
| Single choice | Dropdown stores one configured option | Rejects values not present in the published options | Each answer becomes a comparison group |
| Multiple choice | Toggle pills store an array of selected options | Rejects non-arrays and unknown options | Each selected option contributes to its own group |
| Number | Number input stores a numeric value | Requires a finite number | Preserved for later numerical analysis; not grouped currently |
| Rating 1–10 | Slider stores an integer-like number from 1 through 10 | Rejects values below 1 or above 10 | Each rating is grouped for comparison |
| Text | Text area stores free-form notes | Converts to text and limits storage to 2,000 characters | Preserved for qualitative review; not grouped currently |

### Test data

Create these rules:

| Rule | Type | Example answer |
|---|---|---|
| Order Block tapped? | Yes / No | Yes |
| Session | Single choice | London from `London, New York, Asia` |
| Confirmations | Multiple choice | FVG and MSS from `FVG, MSS, Sweep` |
| Distance to stop | Number | `18.5` |
| Setup quality | Rating 1–10 | `8` |
| Review note | Text | `Waited for displacement` |

### End-to-end test

1. Publish the six rules.
2. Select the playbook on a trade.
3. Confirm that each rule renders the control described in the table.
4. Enter the example answers and save.
5. Refresh and reopen the trade.
6. Inspect the JSON export and locate `playbookResponses`.
7. For a required rule, attempt to save without an answer.
8. If testing the API directly, submit an invalid rating of `11` or an unknown choice.

### Expected result

- Every control renders and accepts its expected value.
- All six responses survive refresh and appear in JSON export.
- Required unanswered rules block saving in the frontend and backend.
- Invalid choices, malformed arrays, non-boolean Yes/No values, non-numeric numbers, and out-of-range ratings are rejected.
- Yes/No, choices, multiple choices, and ratings appear in Edge Coach after reviewed trades exist.
- Number and text remain stored but do not yet appear in effectiveness grouping.

### Confirmed implementation path

The source verification confirmed:

1. The Playbook editor exposes all six types.
2. Choice types expose a choices editor and require at least two values.
3. Trade Review renders a distinct control for every type.
4. Required fields are checked before the frontend saves.
5. The backend reloads the canonical published version rather than trusting client-supplied rule text.
6. The backend validates and sanitizes responses.
7. MongoDB and offline trade records store `playbookSnapshot` and `playbookResponses`.
8. Edge Coach processes the four structured comparison types.

## 11. Required playbook rules

### Test

1. Mark a Yes/No rule Required.
2. Publish a new version.
3. Attach it to a trade.
4. Leave the rule unanswered and save.
5. Answer it and save again.

### Expected result

- First save is blocked and identifies the missing rule.
- Second save succeeds.
- Direct API requests cannot bypass the backend requirement.

## 12. Immutable versions and audit snapshots

### How it works

Publishing edits appends a new version. When a playbook is saved on a trade, the backend copies the canonical version into `playbookSnapshot`.

### Test

1. Attach version 1 to Trade A and save answers.
2. Change a rule label, add a rule, enter a change note, and publish version 2.
3. Attach version 2 to Trade B.
4. Reopen Trade A and Trade B.
5. Archive the playbook.

### Expected result

- Trade A retains version 1 wording and answers.
- Trade B uses version 2.
- Edge Coach displays both versions separately.
- Archived playbook disappears from new selections but remains on existing trades.
- No historical rule is deleted.

## 13. Edge Coach

### How it works

Edge Coach aggregates behavior, playbook versions, and structured rule answers. Evidence labels are based on answer-group sample size.

### Test

1. Review multiple winning and losing trades with the same playbook.
2. Use different answers for at least one Yes/No rule.
3. Open Edge Coach and change the date range.

### Expected result

- Strategy Versions displays trade count, win rate, and average P&L per version.
- Rule Evidence displays outcomes per answer.
- Samples under 5 are Insufficient, 5–19 Developing, and 20+ Strong.
- Date range changes recalculate the evidence from matching trades only.

## 14. Dashboard, Performance, Calendar, and Analytics

### Test

1. Compare Dashboard trade count and P&L with the Trades page.
2. Verify the Performance equity curve follows chronological running balances.
3. Verify deposits and withdrawals do not appear as trading P&L.
4. Select profitable and losing dates in Calendar.
5. Compare Analytics symbol and direction totals with filtered trades.

### Expected result

- Headline totals reconcile with underlying trades.
- Equity and drawdown use chronological account data.
- Calendar daily P&L equals trades closed that day.
- Analytics categories sum to their applicable trade population.

## 15. Screenshot upload and metadata

### How it works

Online uploads store the image in Cloudinary with core context metadata and a raw JSON sidecar containing richer journal and playbook data. Offline uploads are staged on disk.

### Test

1. Paste an image into the screenshot area.
2. Upload an image file.
3. Add and edit captions.
4. Inspect the Cloudinary resource context.
5. Locate its `_metadata` raw sidecar.
6. Delete a disposable test screenshot.

### Expected result

- Image appears after upload and after refresh.
- Context includes `dealId`, symbol, direction, prices, P&L, timestamps, and account type.
- Sidecar includes journal fields and playbook snapshot/responses.
- Caption edits persist.
- Delete removes the database reference and Cloudinary image.

## 16. Screenshot reconstruction

### How it works

Recovery scans only the authenticated owner's Cloudinary prefix. It reattaches by `dealId`. When a trade is missing, it can reconstruct the core MT5 record from embedded context before attaching the screenshot.

### Test

Use a disposable database and screenshot:

1. Export a JSON backup.
2. Upload a screenshot to a test trade.
3. Delete only that trade from the test database.
4. Call `POST /api/maintenance/recover-screenshots`.
5. Reload Trades.

### Expected result

- Response reports one reconstructed trade and recovered screenshot.
- Core prices, timestamps, direction, P&L, and account type match the metadata.
- The screenshot is attached.

Reconstruction does not use OCR and cannot recover values that were never stored in the asset metadata. The JSON sidecar remains the richer recovery record.

## 17. Backup and export

### Test

1. Open Backup.
2. Verify database mode and counts.
3. Download JSON.
4. Download CSV.
5. Open both files.

### Expected result

- JSON counts match the owner database.
- JSON includes full trades, playbook snapshots, and responses.
- CSV opens with one trade per row.
- No password, JWT secret, MongoDB URI, or Cloudinary secret is exported.

## 18. Offline fallback

### How it works

The backend loads local trade and account-event mirrors when MongoDB is unavailable. Environment owner credentials can provide offline login if configured.

### Test

1. Confirm a recent local backup exists.
2. Stop or block MongoDB in a test environment.
3. Restart the backend.
4. Sign in using configured owner environment credentials.
5. Browse trades and export status.
6. Upload a test screenshot.
7. Restore MongoDB and restart.

### Expected result

- Backend announces offline mode.
- Cached trades remain accessible.
- Screenshot is staged under `backend/public/screenshots/` with metadata.
- After reconnection, the image uploads and local staging is cleaned.

## 19. Responsive and accessibility checks

### Test

Test widths near 375, 768, 1024, and a wide desktop:

1. Navigate every screen with keyboard only.
2. Focus contextual information icons.
3. Open the mobile navigation drawer.
4. Edit a playbook on a narrow screen.
5. Increase browser text scaling.

### Expected result

- Application screens use the available width without horizontal page overflow.
- Tables provide local horizontal scrolling where necessary.
- Info explanations appear on hover, focus, and touch.
- Touch targets remain usable.
- Signup and Login do not show the authenticated sidebar.

## 20. Pre-release command checklist

Run from the repository:

```powershell
cd backend
node --check server.js
node --check routes\auth.js
node --check routes\trades.js
node --check middleware\auth.js

cd ..\frontend
node node_modules\typescript\bin\tsc --noEmit
node node_modules\eslint\bin\eslint.js app\signup\page.tsx app\rules\page.tsx components\InfoHint.tsx
npm run build
```

All commands should exit with code 0. The build may warn about multiple lockfiles; that warning does not indicate a compilation failure.

## Test report template

Copy this table into an issue or release note:

| Area | Result | Evidence / notes |
|---|---|---|
| Owner signup and lock | Pass / Fail | |
| Login and logout | Pass / Fail | |
| MT5 sync | Pass / Fail | |
| Live/Demo classification | Pass / Fail | |
| Trade filters | Pass / Fail | |
| Journal persistence | Pass / Fail | |
| Six playbook answer types | Pass / Fail | |
| Required rules | Pass / Fail | |
| Version snapshots | Pass / Fail | |
| Edge Coach evidence | Pass / Fail | |
| Screenshot upload | Pass / Fail | |
| Screenshot reconstruction | Pass / Fail | |
| JSON/CSV export | Pass / Fail | |
| Offline fallback | Pass / Fail | |
| Responsive/accessibility | Pass / Fail | |

## Structured visual playbook acceptance test

Run this workflow after completing setup with valid MongoDB and Cloudinary credentials.

1. Open Playbooks and create a new strategy.
2. Add recommended Context, Setup, Risk, Execution, Exit, and Review stages.
3. Reorder two stages, collapse and expand them, and confirm the stage numbers follow the new order.
4. Rename template fields, remove one, and add one empty custom field.
5. Configure these field types: Yes/No, choices, percentage, currency, price, duration, risk-to-reward, rating, date, time, short text, and long explanation.
6. Set units and numeric minimum/maximum values, then mark several fields required.
7. Upload at least three chart images: Reference, Valid example, and Invalid example.
8. Link one image to a specific field, write a caption of at least ten characters, and reorder the images.
9. Enter a change note describing what changed, why, and the expected result. Publish version 1.
10. Open Read Playbook and verify the cover, contents, chapters, large images, captions, options, and next/previous navigation.
11. Attach the playbook to a trade and complete its Plan, Manage, and Review tabs.
12. Attempt to save with a required field missing. Confirm the journal opens the phase containing that field and blocks the save.
13. Complete every required field, save, refresh, and reopen the trade.
14. Edit the playbook, publish version 2, and reopen the earlier trade.
15. Complete several trades with different answers and outcomes, then open Edge Coach.

Expected results:

- Templates are editable starting points, not locked rules.
- Screenshot captions and field configuration are part of the published snapshot.
- Version 1 remains available in reading mode after version 2 is published.
- The earlier trade still contains schema version 1's exact stages, screenshots, fields, and responses.
- Edge Coach separates versions and reports stage compliance, answer effectiveness, and numeric winning/losing averages.

## Legacy migration test

Use a backup containing playbooks created before the structured timeline update.

1. Start the updated backend against the backup.
2. Open an old playbook and an old attached trade.
3. Confirm legacy `pre_trade`, `post_trade`, and `trade_management` categories appear as Setup, Review, and Management while editing.
4. Confirm the stored historical version has not been rewritten.
5. Publish a new version with a detailed change note.
6. Export JSON and compare the old and new versions.

Expected results:

- Versions without `schemaVersion` are treated as schema version 1.
- Newly published versions contain `schemaVersion: 2`.
- Publishing appends a version and never mutates the old version or trades already attached to it.
- Unknown legacy categories remain readable as Custom stages.

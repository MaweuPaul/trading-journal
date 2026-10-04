# Before building bulk delete for MCP strategies

A checklist to finish before adding an MCP tool that deletes many strategies
(and what's filed under them) at once. A bulk delete can wipe a lot in one
call, so the safety net comes first.

## 1. Backups working (you)

- [ ] Create the backup cluster in MongoDB Atlas (a second free cluster,
      ideally another project and region). Add a database user, and allow
      network access from anywhere (`0.0.0.0/0`).
- [ ] Check the live cluster also allows `0.0.0.0/0` (GitHub's machines have
      no fixed address).
- [ ] In GitHub → Settings → Secrets and variables → Actions, add the secrets
      `MONGODB_URI` (same as on Render) and `BACKUP_MONGODB_URI` (the backup
      cluster).
- [ ] If the live `MONGODB_URI` has no database name after `.mongodb.net/`,
      add the variable `MONGODB_DB_NAME` (the name shown in Atlas → Browse
      Collections).
- [ ] Push the backup work to main (scheduled GitHub jobs only run from main).
- [ ] Actions → Database backup → Run workflow. The run is green and its log
      ends with `Done: backup_YYYY-MM-DD, … documents`.
- [ ] The next morning, check the nightly run went green on its own.
- [ ] Practise a restore once into a throwaway database (not the live one), so
      the steps are known before they're needed. See "Database Backups" in the
      README.

## 2. Know which strategies an agent created (code)

Today a strategy doesn't record who created it, so a bulk delete couldn't tell
your strategies from an agent's.

- [ ] Add a `source` field to `BacktestStrategy` (`owner` | `agent`) and the
      access key that created it (`apiKey`), set by `create_strategy` over MCP
      and by the Strategies page.
- [ ] Backfill existing strategies: a strategy whose logged backtests are all
      agent trades is `agent`, anything with your own backtests is `owner`.
      Review the result before relying on it.

## 3. Decide what a bulk delete removes (decision)

- [ ] Only strategies marked `agent`, never yours.
- [ ] With each one: its rules history, its agent-logged backtests, its
      `run_strategy` runs and its agent replay sessions (the same set the
      Strategies page delete removes).
- [ ] Skip any strategy that has backtests you logged yourself, and say so in
      the result.
- [ ] Filters it accepts: by name, by name prefix, created before a date,
      created by a given access key.

## 4. Build it safely (code)

- [ ] Two steps, like `delete_backtests`: the first call only lists what would
      go (strategies and counts of backtests, runs and sessions); a second call
      with `confirm: true` deletes.
- [ ] A cap per call (e.g. 50 strategies), so one mistaken filter can't empty
      everything.
- [ ] Tests: owner strategies untouched, mixed strategies skipped, preview
      deletes nothing, other users untouched, cap respected.
- [ ] Update the AI agents chapter of the manual and the README tool list.

# SPY 0DTE Call Agent

Third sibling of `../webull-agent` (stock day-trader) and
`../webull-options-agent` (NVDA wheel), trading against the same Webull
OpenAPI sandbox. `webullClient.ts`, `optionsClient.ts` and `marketHours.ts`
are copied from the wheel project, whose CLAUDE.md documents every
live-verified API quirk they encode (leg `symbol` = underlying ticker, not
OCC; `category: US_OPTION` header; position strike/expiry live under
`legs[0]`; LIMIT-only option orders; etc.). Read that "API surface" section
before changing any order code.

## Strategy

Every trading day, one entry, one exit:

- **10:30am ET** (one hour after the open): read SPY's last 1-min bar close,
  buy `SPY_CONTRACTS` (1) of the **CALL expiring today** whose strike is
  nearest to `price - SPY_STRIKE_OFFSET` ($1), i.e. ~$1 in the money. The
  order is a LIMIT at the ask, with one retry at a fresh ask.
- **Stop**: close if the option's mid falls to `(1 - SPY_STOP_LOSS_PCT)` x
  entry (50% loss), checked every `SPY_POLL_MS` (15s).
- **EOD**: close at 15 minutes before the close, 3:45pm ET (12:45pm on the
  `NYSE_EARLY_CLOSES` half-days in `marketHours.ts`).
- Exits are LIMIT sells at the bid, stepping down $0.05 per unfilled attempt,
  retried until 1 minute before the close. If still holding, the agent logs
  `exit_failed` and exits non-zero (red Actions run). **An ITM 0DTE call left
  at expiry is auto-exercised into 100 SPY shares per contract (~$77k), so
  close it by hand.**
- No entry after 11:00am ET. If the session starts late, the day is skipped
  rather than entering at a random time.

## Design notes

- **The stop is client-side** (the monitor loop), not a resting broker STOP
  order. Option STOP orders have never been verified live here, and a
  resting stop would need cancel-then-sell at EOD, the race that stranded
  positions in `../webull-agent` on 2026-08-19.
- **Every order is settled before the next one is placed**: `settleOrder()`
  polls for a terminal status, cancels if it hasn't filled within 10s, and
  waits for the cancel to be confirmed. What we hold always comes from
  broker positions (`findHeldCall()`), never from the order we asked for.
- **Startup resumes any open 0DTE call first**, whatever the clock says, so
  a re-dispatched job after a crash still manages and closes the position.
  `spy-state.json` is only used for "already entered today?", so a
  re-dispatch after a stop-out won't buy a second time.
- **Quotes are 15 minutes delayed in the sandbox.** The live snapshot
  carries `delay_minutes: 15`, so the stop and exit prices trail real prices
  and the stop can fire up to ~15 min late. This doesn't matter for
  paper-trading; moving to a real-time account would.

## Hosting (GitHub Actions)

`.github/workflows/spy-0dte.yml`: one long-running job per day, `workflow_dispatch`
only, `timeout-minutes: 355`. The public repo gets unmetered minutes (see the
wheel project's CLAUDE.md for why it isn't private). Needs:

- Repo secrets `WEBULL_APP_KEY`, `WEBULL_APP_SECRET`, `WEBULL_BASE_URL`,
  `WEBULL_SANDBOX_ACCOUNT_ID` (the paper **Individual Cash** account, same as
  the wheel).
- A **cron-job.org** job: `POST https://api.github.com/repos/Pedrazar/webull-spy-0dte-agent/actions/workflows/spy-0dte.yml/dispatches`,
  body `{"ref":"main"}`, headers `Authorization: Bearer <fine-grained PAT,
  this repo only, Actions: Read and write>`, `Accept: application/vnd.github+json`,
  `X-GitHub-Api-Version: 2022-11-28`. Schedule: `20 7 * * 1-5` in the
  `America/Los_Angeles` timezone (= 10:20am ET year-round). Same setup as
  `../webull-agent`. **Don't dispatch before 10:10am ET**: `main.ts` refuses
  on Actions, because the session wouldn't reach the 3:45 exit inside the
  360-minute runner cap.

## Files

- `main.ts`: the session (`runSession`): resume, then entry, then monitor/exit.
- `tradeLogger.ts`: `spy-trades.jsonl` (append-only events) + `spy-state.json`.
- `testSpyChain.ts [YYYY-MM-DD]`: live check of price, 0DTE chain, strike
  pick, snapshot and BUY_TO_OPEN **preview** (never places an order).

## Status as of 2026-09-26 (initial build, a Saturday)

Verified live against the sandbox (`testSpyChain.ts 2026-09-28`): SPY price
via bars, single-expiration CALL chain lookup, strike pick (771.35 - 2 ->
769 strike), snapshot, and BUY_TO_OPEN preview (accepted, est. $357).

**Not yet verified live** (needs market hours): a real fill, `settleOrder()`
cancelling a real working order (the endpoint itself was probed with a fake
id on 2026-09-26 and answered "Order not present", so the request shape is
accepted), SELL_TO_CLOSE, the positions shape for a long call (the wheel only
confirmed a short put), and the full Actions run. The first trading day is
the test, so watch that run.

## Status as of 2026-09-28 (first real trading day — a real incident)

cron-job.org fired correctly at 7:20am PT. Entry worked: bought 1
`SPY260928C00766000` (strike $766, ~$1.45 ITM) at $1.96 = $196, logged
correctly with `underlyingPrice`/`targetStrike`. The stop-loss correctly
triggered at 10:59am ET (mid fell to $0.98, exactly 50% of entry) and
`exitPosition()` began retrying SELL_TO_CLOSE, stepping the limit down
$0.05 each attempt — 4 attempts, all cancelled unfilled (0 filled). Then a
429 from an **unguarded API call crashed the entire process** at 11:00am
ET, 5 hours before the close, with the position still open and zero
further attempts to close it for the rest of the day — see the git log for
the full fix (`orderStatus()` now treats a transient fetch error as
"unknown" instead of throwing; more importantly, `exitPosition()`'s whole
retry-loop body is now wrapped in try/catch so ANY transient error just
costs one retry, bounded by the loop's own `giveUpAtMin` deadline, and can
never be misread as "no position, done").

**Verified after the fact** (checked live positions/orders/balance
directly, not just the log): no SPY position, no open orders, cash healthy
(~$1,001,033 vs. the $1,000,000 start), no unusual large debit — so the
call evidently expired rather than being exercised into 100 shares. Bounded
loss, roughly the $196 premium. **This was a fortunate outcome, not this
code working as designed** — nothing closed the position on purpose; nobody
was watching a live crash for 5 hours, and the auto-exercise warning this
project's own `exit_failed` event exists specifically to surface never got
logged, because the crash happened before reaching that fallback path.

**Residual gap, not yet addressed**: "Startup resumes any open 0DTE call
first" (see Design notes) only helps if something actually triggers a
fresh run after a crash — this project's `workflow_dispatch` fires exactly
once per day via cron-job.org, with no automatic retry-on-failure. A
*different* future crash (not this exact bug, now fixed) would still strand
a position with nothing to pick it up except a manual re-run. Worth
deciding later whether that's an acceptable risk for a paper account or
needs a second cron-job.org safety-net trigger later in the afternoon.

## Status update — 2026-09-29: entry never filled, a second straight day of the same pattern

10:30am ET entry tried twice (SPY 765.31 -> target 764.31 -> the 764 call),
first at ask $2.10, then a fresh ask $1.97 after the first attempt's 10s
window expired — **both orders sat SUBMITTED for the full window and were
cancelled unfilled**, never a FILLED or even a partial fill. No crash this
time (the 2026-09-28 fix held), and the code did exactly what it should
when a fill never comes: gave up cleanly, logged `skipped(order_not_filled)`,
no position, no open orders. **Net for the day: $0, but also zero trading**
— confirmed live via positions/open-orders, nothing to close.

This is the same shape as 2026-09-28's exit failure (4 SELL_TO_CLOSE
attempts, all cancelled unfilled) but on the entry/BUY side instead — two
different days, two different sides of the trade, same symptom: an order
placed right at the live quoted bid/ask doesn't get matched by the sandbox
within the old 10s window. Leading hypothesis, from this project's own
"quotes are 15 minutes delayed in the sandbox" note (see Design notes): the
snapshot's bid/ask may be stale relative to whatever price the sandbox's
matching engine actually requires to consider an order marketable, so a
limit order built from that snapshot may not really be at the true
current price.

**Diagnostic changes made 2026-09-30, not yet exercised live**:
`settleOrder()`'s wait is now 30s by default (was 10s) with every poll
logged (`[order] <id> poll @Xs: STATUS`), not just the final outcome, and
entry specifically gets a full 60s per attempt (there's ~30 min of budget
before `ENTRY_DEADLINE_MIN`, so this costs nothing). Both `enter()` and the
exit loop now log the full snapshot (`bid`/`ask`/`last`/`delay_minutes`) at
order time and again right after the order settles, so a real run's log can
show directly whether the quote moved between those two points (supporting
the staleness hypothesis) or stayed put while never filling (pointing at
something else — a sandbox matching quirk unrelated to quote staleness).
**Next trading day's run is the test** — read its full log for the
`[quote]`/`[order] ... poll` lines, not just the summary lines, to answer
this.

## Change log

- **2026-09-30: diagnostic instrumentation for the fill-failure pattern**
  — longer settle windows (60s entry / 30s default, up from 10s) with
  full poll-by-poll and before/after-quote logging. See the status update
  above. Not a behavior fix yet — the goal is to see what's actually
  happening before changing the retry/pricing logic.
- **2026-09-28: fixed a process crash mid-exit-retry** — see the status
  update above and the git log (`main.ts`'s `orderStatus()`/`exitPosition()`).
- **2026-09-26: strike offset $2 -> $1** (user's call, before the first live
  day). Set in `spy-0dte.yml`'s `SPY_STRIKE_OFFSET`, which is what Actions
  actually uses; `.env` and main.ts's default match it.

# SPY 0DTE Call Agent

Third sibling of `../webull-agent` (stock day-trader) and
`../webull-options-agent` (NVDA wheel), same Webull OpenAPI sandbox.
`webullClient.ts`, `optionsClient.ts`, `marketHours.ts` are copied from the
wheel project — read its CLAUDE.md "API surface" section (leg `symbol` =
underlying ticker not OCC; `category: US_OPTION` header; position
strike/expiry under `legs[0]`; LIMIT-only option orders) before changing any
order code.

## Strategy

- **Entry, one or two independent "slots" a day** (`SPY_SLOTS`, 2026-11-09):
  `morning` at 10:30am ET (deadline 11:00am) and, if enabled, `midday` at
  12:30pm ET (deadline 1:00pm). Paper runs both (`SPY_SLOTS=morning,midday`
  in `spy-0dte.yml`); live is pinned to `morning` only for now
  (`spy-0dte-live.yml`). Each slot buys `SPY_CONTRACTS` (1) of the **CALL
  expiring today** nearest `price - SPY_STRIKE_OFFSET` ($1 ITM). LIMIT,
  repriced up from the ask via `escalatingDiscount()` (3/6/12/24/48%, capped
  50%), up to 5 attempts, 10s settle wait each. No entry after its deadline
  — that slot is skipped rather than entering late.
- Slots run **concurrently**, not sequentially — `midday` doesn't wait for
  `morning` to close. Two guards keep that safe: a slot never enters a
  strike another still-open slot already holds (the broker can't tell two
  same-strike lots apart, see `findHeldCall()`), and a slot skips its entry
  if today's already-realized P&L (summed across closed slots) is at or
  below `-SPY_DAILY_RISK_LIMIT` (default $250, user's figure).
- **Stop-loss**: client-side, exit if mid <= 50% of entry
  (`SPY_STOP_LOSS_PCT`), polled every 15s.
- **Profit-lock trailing stop**: once the peak mid since entry reaches 50%
  above entry (`SPY_PROFIT_LOCK_ARM_PCT`), armed; a pullback of 15% off the
  peak (`SPY_PROFIT_LOCK_TRAIL_PCT`, not off entry) closes immediately.
  Before arming, behaves exactly as before (stop + EOD only).
- **EOD**: close at 3:30pm ET (12:30pm half-days, `SPY_EXIT_BEFORE_CLOSE_MIN
  = 30`) — an 18-min buffer before Webull's real 3:48pm forced-liquidation
  deadline for a single-leg ITM 0DTE position (see Change log, 2026-10-21).
- Exits are LIMIT sells repriced down the same way, retried until 1 min
  before close. If still holding, logs `exit_failed` and exits non-zero (red
  Actions run). **An ITM 0DTE call left at expiry auto-exercises into 100
  shares/contract (~$77k) — close it by hand if this ever happens.**

## Design notes

- **Stop/profit-lock are client-side** (the monitor loop), not a resting
  broker order — untested here, and a resting stop would need
  cancel-then-sell at EOD (the race that stranded positions in
  `../webull-agent` on 2026-08-19).
- **Every order settles before the next is placed**: `settleOrder()` polls
  for terminal status, cancels unfilled after 10s, waits for cancel
  confirmation. What's held always comes from broker positions
  (`findHeldCall()`), never the order itself.
- **`findHeldCall()` requires an exact strike match** (`expectedStrike`
  param) — not "any SPY call expiring today". Fixed 2026-10-20 after it sold
  a position the user had bought manually in the same shared account (see
  Change log).
- **Startup resumes an open position only via the remembered strike** in
  `spy-state.json`/`live-state.json` — never a blind scan of positions. If
  that state is missing/stale, resume is skipped (narrows but doesn't fully
  close a sub-second crash-before-state-write gap — accepted tradeoff).
- **Quotes are 15 min delayed in the sandbox** (`delay_minutes: 15`);
  production/live is real-time (`delay_minutes: 0`, confirmed 2026-10-16).
- Real live fills carry small regulatory/clearing/SEC fees sandbox never
  charges (~$0.11/round-trip observed); `realizedPnl` doesn't subtract them.
  Not urgent at this size.

## Hosting (GitHub Actions)

**Paper** — `.github/workflows/spy-0dte.yml`: `workflow_dispatch` only,
`timeout-minutes: 355`. Public repo (unmetered Actions minutes — see wheel
project's CLAUDE.md for why). Secrets: `WEBULL_APP_KEY/APP_SECRET/BASE_URL/
SANDBOX_ACCOUNT_ID` (paper **Individual Cash**, same as the wheel). cron-job.org
dispatches `20 7 * * 1-5` America/Los_Angeles (10:20am ET year-round) — don't
dispatch before 10:10am ET, `main.ts` refuses (the session must fit the
360-min runner cap).

**Live** — `.github/workflows/spy-0dte-live.yml`: same shape, own
cron-job.org entry (so either side can be paused independently). Secrets:
`WEBULL_PROD_APP_KEY/_APP_SECRET/_BASE_URL/_ACCOUNT_ID` (**Individual
Margin**, `A5H8R5F7IQGJ69DKPVC4RSNJLA` — hardcoded safety check in
`testProdAuth.ts`, refuses to run if that ID stops resolving to "Individual
Margin"), `WEBULL_PROD_TOKEN/_TOKEN_EXPIRES` (rotating bearer token,
auto-refreshed). A step after the trading run pushes any refreshed token
back to Secrets via `gh secret set` (PAT `WEBULL_SECRETS_PAT`, Secrets:
Read/write on this repo only — the default `GITHUB_TOKEN` can't manage
secrets), masked from the log before use.

**Both workflows** retry their commit-back step (pull-rebase-push) up to 5x
with backoff — they touch disjoint files (`spy-*` vs `live-*`) but can still
race on the same ref when both finish near EOD; `exit 1` if all 5 attempts
fail, so a red run always means "go check the log."

**This account is shared with the user's own manual trading** — not
dedicated/empty (confirmed 2026-10-16, collided for real on 2026-10-20, see
Change log). `enter()` checks `option_buying_power` against the worst-case
escalating-discount cost before the first order and skips
(`insufficient_buying_power`) rather than attempting a buy that would fail.

## Files

- `main.ts`: the session (`runSession`) — resume, then entry, then
  monitor/exit. Shared by paper (`main()`) and live (`liveMain.ts` ->
  `runSession()`).
- `liveMain.ts`: live entry point. Hard-refuses to run unless
  `SPY_LOG_PREFIX=live` is already set in the process env *before* start —
  setting it as a plain statement inside the file does NOT work (CommonJS
  import hoisting means `tradeLogger.ts` would already have read and
  defaulted the prefix by then).
- `tradeLogger.ts`: `SPY_LOG_PREFIX`-prefixed files — `spy-trades.jsonl`/
  `spy-state.json` (paper, default) or `live-trades.jsonl`/`live-state.json`
  (live). Real and paper records never share a file, even in this same
  public repo.
- `prodTokenManager.ts`: pluggable `TokenStore` — `fileTokenStore` (local
  `prod-token.json`) or `envTokenStore()` (CI: reads
  `WEBULL_PROD_TOKEN`/`_EXPIRES`, writes a refresh to local gitignored
  `prod-token-refreshed.json` for the workflow's push-to-Secrets step).
- `testSpyChain.ts [YYYY-MM-DD]` / `testProdAuth.ts`: live checks +
  BUY_TO_OPEN preview (never places an order); `testProdAuth.ts` also has
  the Individual-Margin safety check above.

## Change log

- **2026-09-26**: built. Strike offset set to $1 (was $2, user's call).
- **2026-09-28 (first paper trading day)**: a 429 on an unguarded
  positions-list call crashed the process right after logging a correct
  stop-loss fill. Position was never actually at risk (confirmed flat after
  the fact), but nothing watched it for the remaining 5 hours and
  `exit_filled` never got logged. Fixed: `orderStatus()` treats a transient
  fetch error as "unknown"; `exitPosition()`'s whole retry loop wrapped in
  try/catch.
- **2026-09-29/30**: entry never filled two days running — orders sat at the
  live bid/ask for the full window, cancelled unfilled. Diagnostic logging
  added to isolate the cause.
- **2026-10-02**: root cause found and fixed — sandbox quote staleness
  combined with repricing steps too small/slow to chase a moving market.
  `escalatingDiscount()` replaces flat $0.05/attempt steps with exponential
  percentage steps (3/6/12/24/48%, capped 50%), used by both entry and exit.
  Settle wait dropped back to 10s (the 30s/60s diagnostic windows proved
  unnecessary — every real fill settled in under 3s).
- **2026-10-16**: production/live investigated. Needed an options
  market-data subscription (OPRA Real-Time Non-display, $4.99/mo —
  resolved) and an account choice — user picked **Individual Margin**
  (shared with other activity, not dedicated). Built `liveMain.ts`,
  `prodTokenManager.ts`'s pluggable store, the buying-power guard, and
  `spy-0dte-live.yml` (token-refresh-to-Secrets step, since this repo is
  public and a live token can't be committed like the paper workflow's
  static sandbox secrets).
- **2026-10-19 (first live day)**: real entry/stop-loss fill both confirmed
  against the broker ($2.10 -> $1.04, -$106/-50.5%, right on target). A
  second instance of the 09-28 crash bug (a redundant post-fill
  confirmation check outside the try/catch) crashed the process right after
  the fill — position was never at risk, but `exit_filled` had to be
  reconstructed by hand. Fixed: that check is now skipped entirely once the
  loop already has a broker-confirmed fill; where still needed, a failure
  logs an honest `exit_failed(...)` instead of crashing.
- **2026-10-20 (most serious bug found)**: `findHeldCall()` had no identity
  check and sold a position the user had bought manually in the same shared
  account, blending both fills into one wrong P&L number. (User confirmed
  they'd bought it themselves and was fine with the outcome given a market
  move that day — luck, not correct behavior.) Same day, a workflow commit
  lost a race against an unrelated push and failed silently (data
  reconstructed by hand from the Actions log + broker records). Fixed:
  `findHeldCall()` now requires an exact `expectedStrike`; startup resume
  only via remembered state, never a blind scan.
- **2026-10-21**: the 10-20 commit-race hit again (paper this time). Fixed
  properly: both workflows retry pull-rebase-push up to 5x with backoff,
  `exit 1` if all attempts fail. Added the **profit-lock trailing stop**
  (arm at +50% peak, 15% trail) after a live trade peaked at +$402
  unrealized and gave back to +$269 by EOD — validated by replaying that
  exact day's 311 real mid-quotes before trusting it (would have realized
  $306 instead of $269). Moved EOD exit from 3:45pm to 3:30pm ET after a
  real Webull "Forced Liquidation Warning" revealed the broker's actual
  single-leg forced-liquidation deadline is 3:48pm ET.
- **2026-11-09: second daily entry slot (`midday`, 12:30pm ET), paper only**
  (user's call). `spy-state.json`/`live-state.json` changed shape —
  `{date, slots: {morning: {...}, midday?: {...}}}` instead of one flat
  object — so any script reading the state file directly needs updating.
  Slots run concurrently in one process; `tradeLogger.ts`'s state writes are
  now serialized through a promise queue so two slots closing at the exact
  same EOD minute can't race and drop one's update. Added a user-specified
  **$250 daily risk limit** (`SPY_DAILY_RISK_LIMIT`): a later slot skips its
  entry if already-closed slots are, combined, down more than that. A slot
  also skips if its target strike is already held by another open slot
  (same-strike lots are indistinguishable to the broker). Not yet exercised
  live — paper's next two-slot day is the first real test of the
  concurrency/collision/risk-limit logic together.

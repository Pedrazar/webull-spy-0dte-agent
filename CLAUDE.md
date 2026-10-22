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
  order is a LIMIT, repriced upward from the ask across up to 5 attempts
  via `escalatingDiscount()` if it doesn't fill (see Design notes).
- **Stop**: close if the option's mid falls to `(1 - SPY_STOP_LOSS_PCT)` x
  entry (50% loss), checked every `SPY_POLL_MS` (15s).
- **EOD**: close at 15 minutes before the close, 3:45pm ET (12:45pm on the
  `NYSE_EARLY_CLOSES` half-days in `marketHours.ts`).
- Exits are LIMIT sells, repriced down from the bid the same way, retried
  until 1 minute before the close. If still holding, the agent logs
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

## Status as of 2026-10-02 (expected behavior, but a real slippage observation)

Today's stop-loss triggered cleanly (no crash, no unfilled-forever order —
both earlier fixes holding), but illustrates a real characteristic of the
retry-chasing exit design worth knowing about: SPY fell fast (option mid
$0.98 -> $0.42 in ~4 minutes), the stop fired at mid $0.87 (vs. the $0.90
threshold), and then **6 of 7** SELL_TO_CLOSE attempts were cancelled
unfilled while chasing the falling bid down before attempt 7 finally filled
— at $0.42, well below the ~$0.90 the stop was meant to cut losses at.
Realized: -$134 (-74.9%), notably worse than the intended ~50%. Each retry
reads a *fresh* current bid (not the previous attempt's price minus $0.05),
so in a fast decline the steps between attempts can be much larger than
$0.05 and the whole sequence can meaningfully lag a crashing market. Not a
bug — this is the documented trade-off of a client-side stop with
limit-order retries (see Design notes) rather than a resting broker stop
order — but a real cost worth the user knowing about if this pattern
recurs often. No code change made for this; flagging for awareness only.

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

## Status update — 2026-10-02: the fill-failure pattern, finally caught in full detail, and it's expensive

Stop triggered at 15:18:49 ET (mid $0.87, threshold $0.90). What followed
is the clearest trace yet of the pattern first seen on 2026-09-28 (exit)
and 2026-09-29 (entry): **6 straight SELL_TO_CLOSE attempts, each priced at
that moment's live bid minus a growing nickel (attempt N: bid - 0.05*(N-1)),
each left sitting SUBMITTED for the full 30s diagnostic window, then
cancelled unfilled** — including attempts priced AT OR BELOW a bid the
market had already moved to (e.g. attempt 1 at $0.86 while the very next
quote read showed the bid had risen to $0.88 — a sell below the live bid
should be trivially marketable, and still didn't fill). Only attempt 7,
priced $0.42 — **30 cents, ~42%, below that moment's $0.72 bid** — finally
filled (at $0.45, broker-confirmed).

**This rules out "just wait longer" as the fix.** 2026-09-30's diagnostic
change (10s -> 30s/60s windows) didn't help here: the problem isn't time,
it's price — nothing filled until the limit was repriced far more
aggressively than a nickel at a time. **Cost of not knowing this sooner**:
the stop triggered at $0.87 (would have been a ~51% loss, right at target)
but didn't actually fill until $0.45 three and a half minutes later (a 75%
loss) — ~$42 worse than it should have been, almost entirely attributable
to chasing a falling price with too-small, too-slow repricing steps while
real theta/price decay kept eating the option's value underneath the retry
loop.

**Not yet fixed** — this needs an actual strategy change (much more
aggressive repricing, e.g. percentage-of-price steps instead of a flat
$0.05, and/or a far more aggressive starting discount given this is a stop
whose whole point is urgency over price), not just more logging. Flagged to
the user 2026-10-02; implementation pending their go-ahead.

## Change log

- **2026-10-02: fixed the repricing scheme** (the actual fix for the
  pattern documented in the status update above). `escalatingDiscount()`
  replaces the old flat-$0.05-per-attempt step with a percentage-based
  exponential one (3%, 6%, 12%, 24%, 48%, capped 50%), used by both
  `enter()` (escalating up from the ask, 5 attempts) and `exitPosition()`
  (escalating down from the bid, retried until `giveUpAtMin`).
  `settleOrder()`'s per-attempt wait dropped back to 10s (from the
  2026-09-30 diagnostic's 30s/60s) — confirmed unnecessary: every fill
  across 5 trading days settled in under 3 seconds, so the long wait only
  ever cost time without buying a real chance at a fill. Not yet
  exercised live.

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

## Status update — 2026-10-16: live-account verification, two hard blockers found

User asked to go live Monday (2026-10-19). Before writing any live order
code, ran `testProdAuth.ts` (preview-only, never places an order) against
the real production API. Findings:

**Token approval: works.** The sibling `webull-agent` project's cached
prod token had expired 2026-09-03; a fresh `create_token` came back
PENDING and was approved in-app within the 25-second poll window. Valid
until 2026-10-31. This project now has its own `prod-token.json` (own
cache, not shared with the sibling project) and `prodTokenManager.ts`
(copied verbatim, see its header).

**Blocker 1 — which real account, genuinely unresolved**: four accounts
exist under this login — Traditional IRA, Individual Margin, Individual
Cash, Roth IRA. Individual Cash shows **`option_buying_power: $1.00`** —
effectively unfunded. Individual Margin has real existing activity
(`total_unrealized_profit_loss: -$360`, `total_day_profit_loss: -$1135.22`
at the time of this check) — not a dedicated/empty account, so running an
unattended bot in it means sharing buying power and risk with whatever
else happens there. IRA accounts have their own options-approval-level and
day-trading restrictions that haven't been checked. **This is the user's
decision, not inferable from the API** — flagged, not resolved.

**Blocker 2 — no options market data subscription on the production API
key**: `getOptionSnapshot()` against production returned
`403 MARKET_DATA_NOT_SUBSCRIBED: "Insufficient permission, please
subscribe to US_OPTION."` The chain endpoint worked (237 real 0DTE SPY
contracts came back), but with no snapshot quotes, nothing downstream can
work — no entry price, no stop-loss check, no exit price. This needs to be
resolved on Webull's side (a subscription, likely with its own cost/signup
flow) — not something fixable in code.

**Also hit `429 TOO_MANY_REQUESTS` looping balance checks across 4
accounts with no delay** — minor, needs a backoff, but moot until the two
blockers above are resolved.

**Did not reach**: snapshot-dependent steps, the order preview, or any
live-agent code changes. Recommended NOT going live Monday until both
blockers are resolved and the preview step is confirmed.

## Status update — 2026-10-16 (continued): both blockers cleared, one new risk identified

User subscribed to OPRA Real-Time Non-display ($4.99/mo) and chose the
**Individual Margin** account (`account_id A5H8R5F7IQGJ69DKPVC4RSNJLA`,
now hardcoded as a safety check in `testProdAuth.ts` — the script refuses
to run if that ID stops resolving to "Individual Margin"). Re-ran
`testProdAuth.ts`: snapshot now returns real-time data (`delay_minutes:
0`, vs. sandbox's 15-min delay), balance confirms $916.31 option buying
power, and the BUY_TO_OPEN preview was accepted by production in the same
shape as sandbox. `.env` gained `WEBULL_PROD_ACCOUNT_ID`.

**New risk found, not yet resolved**: the production access token
(`prod-token.json`) is a rotating bearer credential — unlike the paper
agent's static sandbox app key/secret (safely stored as GitHub encrypted
secrets, never exposed), this token changes on every refresh and would
need to persist across GitHub Actions' ephemeral runners somehow. The
paper agent's existing pattern for that (git-commit the file back after
each run, see `spy-0dte.yml`) is **not safe to reuse here** — this repo is
public, so committing a live token means anyone can read it from git
history and use it to see the real account or place real trades until it
expires. Options not yet decided: (a) have the workflow rewrite a GitHub
Secret via a PAT instead of committing a file, (b) run the live agent
locally instead of on Actions (avoids ever sending the token to GitHub at
all), or (c) something else. **Blocks writing the live GitHub Actions
workflow until decided.**

**Also not yet done**: `main.ts`'s entry path has no buying-power check —
never needed against sandbox's effectively-unlimited paper buying power,
but the margin account's real $916.31 is a real constraint that should be
checked and logged before attempting a buy, not just discovered via an
order rejection.

**Also noted, not a blocker**: the margin account already shows other real
activity (-$310 unrealized P&L, -$1085 day P&L at the time of this check)
— it is not a dedicated/empty account, confirmed per the 2026-10-16
account-selection finding above.

## Status update — 2026-10-16 (continued further): live workflow built, NOT yet dispatched

Built on top of the two cleared blockers above:

- **`prodTokenManager.ts`**: storage is now pluggable (`TokenStore`
  interface). `fileTokenStore` (unchanged behavior, `prod-token.json`) for
  local dev; `envTokenStore()` (new) reads the cached token from
  `WEBULL_PROD_TOKEN`/`WEBULL_PROD_TOKEN_EXPIRES` env vars and, on a
  refresh, writes the new value to a local gitignored file
  (`prod-token-refreshed.json`) instead of anywhere git-tracked.
- **`liveMain.ts`** (new): the live entry point. Reuses `main.ts`'s
  `runSession()` completely unchanged — same entry/stop/EOD/
  escalating-repricing logic that's been proven over 13 paper trading
  days — only the client/credentials/account differ. Hard-refuses to run
  unless `SPY_LOG_PREFIX=live` is already set in the process environment
  *before* the process starts: confirmed live that setting it as a plain
  statement inside the file does NOT work (TypeScript's CommonJS output
  hoists `import`s above other top-level code, so `tradeLogger.ts`'s
  prefix would already have been read and defaulted to "spy" by the time
  that statement ran) — without this guard, real trades would have
  silently been appended to the paper log files.
- **`tradeLogger.ts`**: file paths now take a `SPY_LOG_PREFIX` prefix
  (defaults to `spy`, unchanged for paper). Live writes to
  `live-state.json`/`live-trades.jsonl` instead — real and paper records
  never share a file, even though both live in this same public repo.
- **`main.ts`**: added a buying-power guard to `enter()` — checks the
  account's `option_buying_power` against the worst case the
  escalating-discount retry could pay (up to 50% over the current ask)
  before placing the first order, logging `skipped(insufficient_buying_power)`
  and refusing to even attempt the buy if it's not covered. Never needed
  against sandbox's ~$1M paper buying power; the real margin account's
  $916.31 (as of this check, shared with other activity in that account)
  is a real constraint.
- **`.github/workflows/spy-0dte-live.yml`** (new): same shape as the paper
  workflow, needs its own cron-job.org dispatch entry (not shared with
  paper's). After the trading step, a new step pushes a refreshed token
  (if `prod-token-refreshed.json` exists) back to GitHub Secrets via
  `gh secret set`, using a separate fine-grained PAT
  (`WEBULL_SECRETS_PAT`, scoped to Secrets: Read and write on this repo
  only — the default `GITHUB_TOKEN` can never manage repo secrets). The
  token value is masked from the log (`::add-mask::`) before use.
- **Repo secrets set 2026-10-16**: `WEBULL_PROD_APP_KEY`/`_APP_SECRET`/
  `_BASE_URL`/`_ACCOUNT_ID` (Individual Margin,
  `A5H8R5F7IQGJ69DKPVC4RSNJLA`), and `WEBULL_PROD_TOKEN`/`_TOKEN_EXPIRES`
  bootstrapped from the locally-approved token (valid until 2026-10-31).
  **`WEBULL_SECRETS_PAT` is NOT yet set** — needs the user to create a
  fine-grained PAT (this repo only, Secrets: Read and write) in GitHub
  settings; not urgent for the first several live days since the
  bootstrapped token only needs refreshing within 5 days of its Oct 31
  expiry (`REFRESH_BUFFER_MS`), but every run after that point will fail
  without it.

**Not yet done, genuinely blocking a fully unattended go-live**:
1. `liveMain.ts` has never been run end-to-end — `testProdAuth.ts` only
   exercised the PREVIEW endpoint, never `placeOptionOrder` itself against
   production. The very first real dispatch is also the first real test of
   the live PLACE path, with no prior live confirmation the way the
   sandbox build had (`testOptionOrderPreview.ts` before `main.ts` was
   trusted there, then a manually-triggered day-1 paper run). Recommend
   the first live dispatch be done manually by the user, watching, during
   the entry window — not blind via an unattended cron trigger — treated
   explicitly as the verification step it actually is.
2. `WEBULL_SECRETS_PAT` doesn't exist yet (see above).
3. No cron-job.org dispatch entry exists for `spy-0dte-live.yml` yet —
   deliberately not set up until after a manually-watched first run is
   confirmed working.

## Status update — 2026-10-19: FIRST LIVE TRADING DAY — real money, real trade, a real crash, position was never actually at risk

User manually triggered `spy-0dte-live.yml` at 10:12am ET, watched it start.
**Entry: real fill, SPY 767 call @ $2.10** (10:30:54 ET; paper's own
independent run bought the identical contract that same minute at $2.25 —
a useful live/paper cross-check, both sides of the system agreeing).

Stop triggered at 1:09:04pm ET (mid hit exactly $1.05, the 50% level) and
the SELL_TO_CLOSE **filled for real** at **$1.04** — confirmed directly
against the broker's own order record, not inferred. **Immediately after
logging that fill, the process crashed** (`429 TOO_MANY_REQUESTS` on
`/trading/assets/positions/list`) and the Actions run shows red. **The
position was never actually at risk** — verified live moments after
discovering the crash: the real account shows no SPY position and no open
orders, and the crash happened on a redundant post-fill confirmation
check, not before the real exit. But `exit_filled` was never logged by the
running process, so this had to be reconstructed by hand from the
broker's order records during a routine "how did we do" check — not
caught proactively.

**Real P&L: -$106 (-50.5%), right on the intended 50% stop** — confirmed
entry $2.10 / exit $1.04. A reconciliation event was appended to
`live-trades.jsonl` and `live-state.json` was corrected to match (same
honest-reconciliation convention the paper agent used on 2026-09-28,
its own first-day incident).

**Root cause, fixed same day**: `exitPosition()`'s final confirmation
check (`if (await findHeldCall(...))`) sat OUTSIDE the loop's own
2026-09-28 try/catch fix — a second instance of that exact bug class in a
different spot. Fixed two ways: (1) that check is now skipped entirely
when the loop already has a broker-confirmed fill covering the whole
position (the fill itself already IS the confirmation — a second
positions/list call right after it was always redundant, which is also
why it was hitting rate limits); (2) when a check genuinely is still
needed, a failure now logs an honest `exit_failed(... "could not confirm,
verify manually" ...)` instead of crashing or silently assuming either
outcome. **Not yet re-exercised live** — the next real stop-loss or EOD
exit on the live account is the verification.

**Also newly observed, real but trivial**: live orders carry real
regulatory/clearing/SEC fees (~$0.11 total across both legs today) that
sandbox never charged. `realizedPnl` in the trade log does not currently
subtract these — worth doing if it ever matters at this position size, not
urgent at ~$0.11/round-trip.

**Paper vs. live comparison, same day, same contract**: paper -$112
(-49.78%, entry $2.25/exit $1.13), live -$106 (-50.48%, entry $2.10/exit
$1.04). Directionally and magnitude-wise consistent — reassuring, even
though the day's actual result was a loss.

**Still not done before this can run fully unattended**: a cron-job.org
dispatch entry for `spy-0dte-live.yml` was deliberately never set up
(per the 2026-10-16 plan — first live day was meant to be manual/watched,
which it was). Given today's crash, recommend at least one more
watched live day confirming the exitPosition fix holds before setting up
unattended daily dispatch.

## Status update — 2026-10-20: a real bug sold a position this agent never bought

Live's second trading day. User re-ran `spy-0dte-live.yml` (yesterday's run
had sat failed; re-running restarts the full session fresh, not a resume).
Entry: real, SPY 771 call @ $1.95. Stop triggered at 15:12 ET.

**The exit retry loop sold TWO different contracts**: the 771 strike this
agent actually entered (filled $0.84, a real -$111/-56.9% loss — its own
first attempt at 770 also got a CANCELLED fill along the way, adding to
the confusion in the run log), AND a completely separate **770-strike
call the user had bought themselves, manually, in this same shared
Individual Margin account** — sold for $1.21, confirmed directly against
the broker. `findHeldCall()` took the first long SPY call expiring today
it found, with no check that it was this agent's own position; the
exit loop's `proceeds`/`sold` accounting blended both fills into one
number (the process's own logged `exitPrice`/`realizedPnl` for this day
— 1.02 / -93 — were wrong for both positions and must not be trusted).
**User confirmed they bought the 770 themselves, and — by coincidence,
given a market move that day — were fine with it having been sold; this
was luck, not the code working as designed.** True cost basis for the
user's own 770 purchase wasn't found in `/openapi/trade/order/history`'s
recent entries, so the actual gain/loss to the user from that sale isn't
independently confirmed.

**Separately, the job's own commit of all of today's data (entry_filled,
the blended exit_filled) never reached origin** — `git pull --rebase`
inside the workflow hit an add/add conflict against an unrelated commit
pushed from this conversation around the same time, and the push failed
(exit code 1), silently, with no retry. Both `live-trades.jsonl`'s
today-dated lines and `live-state.json`'s "2026-10-20" date were
reconstructed by hand afterward, from the Actions build log plus
broker-verified order records (`client_order_id`s `6ee8dcc8...`/
`3585a6a7...` for the agent's own entry/exit, `9b3c29ef...` for the
770 sale) — NOT from anything the running process itself ever recorded.
**This commit-conflict failure mode is not yet fixed** — a future
same-minute collision between a manual commit and a workflow's own commit
would silently lose that day's data again.

**Root cause fixed same day**: `findHeldCall()` now takes a required
`expectedStrike` parameter and only ever matches that exact strike — never
"any SPY call". Every call site updated, including the startup resume
path in `runSession()`, which now only resumes by checking today's own
remembered strike from `spy-state.json`/`live-state.json` (never by
blind-scanning positions) — if that state is missing or stale, resume is
skipped entirely rather than guessing. This narrows (but doesn't fully
close) a separate, much smaller timing gap: a crash in the sub-second
window between a confirmed fill and the state-file write would still miss
a resume opportunity — accepted tradeoff, far safer than the old
behavior given this account demonstrably holds other positions.
**Not yet re-verified live.**

**This account can no longer be treated as a reasonable approximation of
dedicated** — it already had other activity as of the 2026-10-16
selection decision, and today proved that activity can directly collide
with this agent's own operation, not just share buying power with it.

## Status update — 2026-10-21: the recurring commit-race, now fixed properly

Both agents traded cleanly today — no logic bugs, no crashes. Live: entry
$2.37, EOD exit $5.06, **+$269 (+113.5%)**, broker-verified. Paper: entry
$2.30, EOD exit $5.05, **+$275 (+119.6%)**.

**But paper's own commit got rejected** — the exact failure mode flagged
as "not yet fixed" in the 2026-10-20 status update, now confirmed hitting
BOTH workflows (that day it was live's commit that got lost to a race
with a manual push; today it was paper's commit losing a race to live's
own commit, both finishing near EOD around the same time). The rejection
is a ref-update race (`cannot lock ref ... is at X but expected Y`), not
a real content conflict — paper and live touch entirely disjoint files
(`spy-*.json{,l}` vs `live-*.json{,l}`), so there was nothing to actually
merge, just a stale local ref at push time. The single pull-rebase-push
attempt in both workflows had no retry, so it failed outright and the
step reported red — even though the trading session itself had already
logged a completely correct `exit_filled`.

**Fixed in both `spy-0dte.yml` and `spy-0dte-live.yml`**: the commit step
now retries the pull-rebase-push sequence up to 5 times with increasing
backoff (5s/10s/15s/20s/25s), aborting any stuck rebase between attempts.
Since the two workflows never touch the same files, a retry has nothing
real to conflict with — it should resolve cleanly every time. If all 5
attempts still fail, the step now explicitly fails loudly (`exit 1`)
rather than silently swallowing it, so a red run always means "go check
the log," never "something was silently lost with no signal at all."

**Today's actual data, reconstructed by hand one more time** (same
approach as 2026-10-19/2026-10-20 — pulled directly from the Actions run's
own log, which had logged everything correctly before the push failed):
`spy-trades.jsonl`/`spy-state.json` now correctly show today's paper
result. **Not yet re-verified live** — tomorrow, if both workflows finish
close together again, is the test.

/**
 * SPY 0DTE call agent — one long-running session per trading day.
 *
 * Strategy:
 *   - At 10:30am ET (one hour after the open), read SPY's price and buy
 *     SPY_CONTRACTS of the same-day-expiring CALL whose strike is nearest to
 *     (price - SPY_STRIKE_OFFSET), i.e. ~$1 in the money.
 *   - Watch it every POLL_MS. Close it if its mid price falls to
 *     (1 - SPY_STOP_LOSS_PCT) x the entry price (50% loss), or at 15
 *     minutes before the close (3:45pm ET; 12:45pm on half-days), whichever
 *     comes first. At most one entry per day.
 *
 * The stop is client-side (this loop), not a resting broker STOP order:
 * option STOP orders have never been verified live against this sandbox,
 * and a resting stop would need a cancel-then-sell at EOD — the exact race
 * that stranded positions in ../webull-agent (see its CLAUDE.md).
 *
 * Hosting: GitHub Actions, dispatched once a day at ~10:20am ET (see
 * .github/workflows/spy-0dte.yml). The whole session must fit inside the
 * 6-hour hosted-runner cap, which is why startup refuses to run early.
 */

import "dotenv/config";
import { WebullClient } from "./webullClient";
import {
  getOptionChain,
  getOptionSnapshot,
  getPositions,
  placeOptionOrder,
  cancelOptionOrder,
  getOrderDetail,
  OptionContract,
  Position,
} from "./optionsClient";
import { isMarketHoliday, nyMinutesOf, marketCloseMinutes, todayNyDate } from "./marketHours";
import { logEvent, readState, writeState, DayState } from "./tradeLogger";

const SYMBOL = "SPY";
const CONTRACTS = parseInt(process.env.SPY_CONTRACTS ?? "1", 10);
const STRIKE_OFFSET = parseFloat(process.env.SPY_STRIKE_OFFSET ?? "1");
const STOP_LOSS_PCT = parseFloat(process.env.SPY_STOP_LOSS_PCT ?? "0.50");
const POLL_MS = parseInt(process.env.SPY_POLL_MS ?? "15000", 10);

const ENTRY_MIN = 10 * 60 + 30; // 10:30am ET
const ENTRY_DEADLINE_MIN = 11 * 60; // don't enter late if the session started late
const EXIT_BEFORE_CLOSE_MIN = 15; // 3:45pm ET on a normal day
/** On Actions, a session started before this can't reach the EOD exit
 * inside the 6-hour runner cap (10:10 -> 15:50 is 340 min + setup). */
const EARLIEST_ACTIONS_START_MIN = 10 * 60 + 10;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function hhmm(min: number): string {
  return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Market data
// ---------------------------------------------------------------------------

/** SPY's last 1-minute bar close — same live-verified endpoint the sibling
 * projects use for the underlying price. */
export async function fetchSpyPrice(client: WebullClient): Promise<number | null> {
  try {
    const bars = await client.get<Array<{ close: string }>>("/openapi/market-data/stock/bars", {
      symbol: SYMBOL,
      category: "US_STOCK",
      timespan: "M1",
      count: "1",
    });
    if (bars?.[0]?.close) return parseFloat(bars[0].close);
  } catch (err) {
    console.warn("[price] SPY bars lookup failed:", err);
  }
  return null;
}

/** Nearest listed strike to the target; on an exact tie, the lower strike
 * (deeper in the money). */
export function pickStrikeNearest(contracts: OptionContract[], target: number): OptionContract | null {
  if (contracts.length === 0) return null;
  return [...contracts].sort((a, b) => {
    const da = Math.abs(parseFloat(a.strike_price) - target);
    const db = Math.abs(parseFloat(b.strike_price) - target);
    return da - db || parseFloat(a.strike_price) - parseFloat(b.strike_price);
  })[0];
}

async function quote(client: WebullClient, optionSymbol: string): Promise<{ bid: number; ask: number; mid: number } | null> {
  try {
    const snap = (await getOptionSnapshot(client, [optionSymbol]))[0];
    const bid = parseFloat(snap?.bid ?? "");
    const ask = parseFloat(snap?.ask ?? "");
    if (!(bid > 0) || !(ask > 0)) return null;
    return { bid, ask, mid: round2((bid + ask) / 2) };
  } catch (err) {
    console.warn(`[quote] snapshot for ${optionSymbol} failed:`, err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Broker truth
// ---------------------------------------------------------------------------

interface HeldCall {
  optionSymbol: string;
  strike: number;
  expiration: string;
  contracts: number;
  costPrice: number; // per-contract, per-share premium paid
}

/** Today's long SPY 0DTE call, if the broker says we hold one. */
async function findHeldCall(client: WebullClient, accountId: string): Promise<HeldCall | null> {
  const today = todayNyDate();
  const positions: Position[] = await getPositions(client, accountId);
  for (const p of positions) {
    const leg = p.legs?.[0];
    if (p.instrument_type !== "OPTION" || p.symbol !== SYMBOL || !leg) continue;
    if (leg.option_type !== "CALL" || leg.option_expire_date !== today) continue;
    const qty = parseFloat(p.quantity);
    if (!(qty > 0)) continue;
    const strike = parseFloat(leg.option_exercise_price ?? "");
    return {
      optionSymbol: occ(today, strike),
      strike,
      expiration: today,
      contracts: qty,
      costPrice: parseFloat(p.cost_price ?? leg.cost ?? "0"),
    };
  }
  return null;
}

function occ(expiration: string, strike: number): string {
  const [y, m, d] = expiration.split("-");
  return `${SYMBOL}${y.slice(2)}${m}${d}C${String(Math.round(strike * 1000)).padStart(8, "0")}`;
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

const TERMINAL = new Set(["FILLED", "CANCELLED", "REJECTED", "FAILED", "EXPIRED"]);

interface Settled {
  status: string; // a TERMINAL status, or "UNKNOWN" if even the cancel never settled
  filledQuantity: number;
  filledPrice: number | null;
}

/** CONFIRMED LIVE 2026-09-28: a transient API error here (that day, a 429
 * rate-limit from settleOrder()'s poll loop calling this repeatedly during
 * exitPosition()'s stop-loss retries) used to throw uncaught all the way
 * through exitPosition() and main(), killing the whole process mid-retry.
 * The position was left open with no further attempt to close it for the
 * rest of the trading day — exitPosition()'s own giveUpAtMin deadline and
 * "still holding -> log exit_failed with an auto-exercise warning" fallback
 * never got a chance to run, because the crash happened first. Caught
 * fortunate that day (the position was gone by end of day with no
 * unusual balance change, so it evidently expired rather than being
 * exercised — but that was luck, not this code working as designed).
 * Treating a transient fetch error the same as "no order data yet" lets
 * every caller's existing retry/timeout logic keep working instead of the
 * whole process dying. */
async function orderStatus(client: WebullClient, accountId: string, clientOrderId: string) {
  let o;
  try {
    o = (await getOrderDetail(client, accountId, clientOrderId)).orders?.[0];
  } catch (err) {
    console.warn(`[order] status check for ${clientOrderId} failed transiently, treating as unknown:`, err);
    o = undefined;
  }
  return {
    status: o?.status ?? "UNKNOWN",
    filledQuantity: parseFloat(o?.filled_quantity ?? "0"),
    filledPrice: o?.filled_price ? parseFloat(o.filled_price) : null,
  };
}

/** Waits up to waitMs for the order to reach a terminal state; if it
 * hasn't, cancels it and waits for the cancel to be CONFIRMED before
 * returning. Callers never place a replacement order until this returns,
 * so two working orders can't exist for the same contract. */
async function settleOrder(client: WebullClient, accountId: string, clientOrderId: string, waitMs = 10_000): Promise<Settled> {
  const deadline = Date.now() + waitMs;
  let s = await orderStatus(client, accountId, clientOrderId);
  while (!TERMINAL.has(s.status) && Date.now() < deadline) {
    await sleep(1500);
    s = await orderStatus(client, accountId, clientOrderId);
  }
  if (TERMINAL.has(s.status)) return s;

  console.log(`[order] ${clientOrderId} still ${s.status} after ${waitMs / 1000}s — cancelling`);
  try {
    await cancelOptionOrder(client, accountId, clientOrderId);
  } catch (err) {
    // Can legitimately fail if it filled between the last poll and now —
    // the status re-check below is what decides.
    console.warn(`[order] cancel ${clientOrderId} failed:`, err);
  }
  for (let i = 0; i < 10; i++) {
    await sleep(1500);
    s = await orderStatus(client, accountId, clientOrderId);
    if (TERMINAL.has(s.status)) return s;
  }
  return { ...s, status: "UNKNOWN" };
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

async function enter(client: WebullClient, accountId: string): Promise<HeldCall | null> {
  const today = todayNyDate();
  const price = await fetchSpyPrice(client);
  if (price === null) {
    logEvent({ event: "skipped", reason: "no_price", detail: "SPY bars lookup returned nothing" });
    return null;
  }
  const target = round2(price - STRIKE_OFFSET);

  const chain = (
    await getOptionChain(client, {
      underlyingSymbol: SYMBOL,
      optionType: "CALL",
      startDate: today,
      endDate: today,
      strikePriceGte: Math.floor(target - 5),
      strikePriceLte: Math.ceil(price + 5),
    })
  ).filter((c) => c.expiration_date === today);
  const contract = pickStrikeNearest(chain, target);
  if (!contract) {
    logEvent({ event: "skipped", reason: "no_0dte_contract", detail: `no SPY CALL expiring ${today} near strike ${target}` });
    return null;
  }
  const strike = parseFloat(contract.strike_price);
  console.log(`[decision] SPY ${price} - ${STRIKE_OFFSET} = target ${target} -> ${contract.symbol} (strike ${strike})`);

  // Buy at the ask for a likely fill; one retry at a fresh ask if the first
  // attempt doesn't fill within the settle window.
  for (let attempt = 1; attempt <= 2; attempt++) {
    const q = await quote(client, contract.symbol);
    if (!q) {
      logEvent({ event: "skipped", reason: "no_quote", detail: `no usable bid/ask for ${contract.symbol}` });
      return null;
    }
    const res = await placeOptionOrder(client, accountId, {
      underlyingSymbol: SYMBOL,
      optionSymbol: contract.symbol,
      side: "BUY",
      quantity: CONTRACTS,
      optionType: "CALL",
      strikePrice: strike,
      expirationDate: today,
      limitPrice: q.ask,
      positionIntent: "BUY_TO_OPEN",
    });
    const clientOrderId = (res.client_order_id as string) ?? "";
    const s = await settleOrder(client, accountId, clientOrderId);
    console.log(`[order] BUY_TO_OPEN attempt ${attempt} @ ${q.ask}: ${s.status}, filled ${s.filledQuantity}`);

    // Broker positions decide what we actually hold (partial fills, or an
    // UNKNOWN settle, both land here correctly).
    const held = await findHeldCall(client, accountId);
    if (held) {
      const entryPrice = held.costPrice || s.filledPrice || q.ask;
      held.costPrice = entryPrice;
      logEvent({
        event: "entry_filled",
        optionSymbol: held.optionSymbol,
        strike: held.strike,
        expiration: today,
        contracts: held.contracts,
        entryPrice,
        totalCost: round2(entryPrice * held.contracts * 100),
        underlyingPrice: price,
        targetStrike: target,
        clientOrderId,
      });
      return held;
    }
    if (s.status === "UNKNOWN") break; // don't stack a second order on an unsettled one
  }
  logEvent({ event: "skipped", reason: "order_not_filled", detail: `BUY_TO_OPEN ${contract.symbol} never filled` });
  return null;
}

// ---------------------------------------------------------------------------
// Exit
// ---------------------------------------------------------------------------

/** Sells the held call with LIMIT orders at the bid, stepping the price
 * down $0.05 per unfilled attempt, until flat or `giveUpAtMin` (NY
 * minutes). Returns true once the broker shows no position. */
async function exitPosition(
  client: WebullClient,
  accountId: string,
  held: HeldCall,
  reason: "stop_loss" | "eod",
  giveUpAtMin: number
): Promise<boolean> {
  let proceeds = 0;
  let sold = 0;
  for (let attempt = 1; nyMinutesOf(new Date()) < giveUpAtMin; attempt++) {
    // CONFIRMED LIVE 2026-09-28: an uncaught transient error anywhere in
    // this loop body (that day: a 429 from settleOrder's poll) used to kill
    // the whole process mid-retry, skipping past giveUpAtMin entirely and
    // leaving the position open with zero further attempts to close it —
    // the exit_failed/auto-exercise-warning fallback below never got a
    // chance to run. Wrapping the whole body means any transient error just
    // costs one retry (bounded by the loop's own giveUpAtMin deadline
    // either way), never gets misread as "no position, done" (that
    // conclusion only ever comes from a successful findHeldCall call
    // actually returning null, never from a failure), and — if genuinely
    // still unable to close by the deadline — always reaches the graceful
    // "still holding, log exit_failed, warn about exercise risk" path
    // below instead of crashing past it.
    try {
      const current = await findHeldCall(client, accountId);
      if (!current) break;
      const q = await quote(client, current.optionSymbol);
      if (!q) {
        console.warn(`[exit] no quote for ${current.optionSymbol}, retrying`);
        await sleep(5000);
        continue;
      }
      const limit = Math.max(0.01, round2(q.bid - 0.05 * (attempt - 1)));
      const res = await placeOptionOrder(client, accountId, {
        underlyingSymbol: SYMBOL,
        optionSymbol: current.optionSymbol,
        side: "SELL",
        quantity: current.contracts,
        optionType: "CALL",
        strikePrice: current.strike,
        expirationDate: current.expiration,
        limitPrice: limit,
        positionIntent: "SELL_TO_CLOSE",
      });
      const s = await settleOrder(client, accountId, (res.client_order_id as string) ?? "");
      console.log(`[exit] SELL_TO_CLOSE attempt ${attempt} @ ${limit} (${reason}): ${s.status}, filled ${s.filledQuantity}`);
      if (s.filledQuantity > 0) {
        proceeds += (s.filledPrice ?? limit) * s.filledQuantity;
        sold += s.filledQuantity;
      }
      if (s.status === "UNKNOWN") await sleep(10_000); // let it settle before re-checking positions
    } catch (err) {
      console.warn(`[exit] attempt ${attempt} hit a transient error, will retry:`, err);
      await sleep(5000);
    }
  }

  if (await findHeldCall(client, accountId)) {
    logEvent({
      event: "exit_failed",
      optionSymbol: held.optionSymbol,
      reason,
      detail: `still holding after retrying until ${hhmm(giveUpAtMin)} ET — CLOSE MANUALLY; an ITM 0DTE call left at expiry is auto-exercised into 100 SPY shares per contract`,
    });
    return false;
  }

  const exitPrice = sold > 0 ? round2(proceeds / sold) : 0;
  const realizedPnl = round2((exitPrice - held.costPrice) * held.contracts * 100);
  logEvent({
    event: "exit_filled",
    optionSymbol: held.optionSymbol,
    reason,
    contracts: held.contracts,
    entryPrice: held.costPrice,
    exitPrice,
    realizedPnl,
    pctReturn: round2(((exitPrice - held.costPrice) / held.costPrice) * 100),
  });
  const state = readState();
  if (state) writeState({ ...state, exitPrice, exitReason: reason, realizedPnl });
  return true;
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

async function monitor(client: WebullClient, accountId: string, held: HeldCall): Promise<boolean> {
  const closeMin = marketCloseMinutes();
  const exitMin = closeMin - EXIT_BEFORE_CLOSE_MIN;
  const stopPrice = round2(held.costPrice * (1 - STOP_LOSS_PCT));
  console.log(`[monitor] ${held.optionSymbol} x${held.contracts} entry ${held.costPrice}, stop at mid <= ${stopPrice}, EOD exit ${hhmm(exitMin)} ET`);

  let lastLog = 0;
  let lastReconcile = Date.now();
  for (;;) {
    if (nyMinutesOf(new Date()) >= exitMin) {
      return exitPosition(client, accountId, held, "eod", closeMin - 1);
    }
    const q = await quote(client, held.optionSymbol);
    if (q && q.mid <= stopPrice) {
      console.log(`[monitor] STOP: mid ${q.mid} <= ${stopPrice}`);
      return exitPosition(client, accountId, held, "stop_loss", closeMin - 1);
    }
    if (Date.now() - lastLog >= 60_000) {
      const pnl = q ? round2((q.mid - held.costPrice) * held.contracts * 100) : null;
      console.log(`[monitor] bid ${q?.bid ?? "-"} ask ${q?.ask ?? "-"} mid ${q?.mid ?? "-"} | unrealized ${pnl ?? "?"}`);
      lastLog = Date.now();
    }
    // Every 5 minutes, confirm with the broker that we still hold it (it
    // could be closed by hand in the app).
    if (Date.now() - lastReconcile >= 300_000) {
      lastReconcile = Date.now();
      if (!(await findHeldCall(client, accountId))) {
        logEvent({ event: "position_gone", optionSymbol: held.optionSymbol, detail: "broker no longer shows the position (closed outside this agent?)" });
        return true;
      }
    }
    await sleep(POLL_MS);
  }
}

export async function runSession(client: WebullClient, accountId: string): Promise<boolean> {
  const now = new Date();
  const today = todayNyDate(now);
  if (isMarketHoliday(now)) {
    console.log(`[session] ${today} is a weekend/holiday — nothing to do`);
    return true;
  }
  if (process.env.GITHUB_ACTIONS === "true" && nyMinutesOf(now) < EARLIEST_ACTIONS_START_MIN) {
    throw new Error(
      `Started at ${hhmm(nyMinutesOf(now))} ET, before ${hhmm(EARLIEST_ACTIONS_START_MIN)} — the session wouldn't reach the EOD exit inside the 6h runner cap. Fix the dispatch time.`
    );
  }

  // Resume first: a position we already hold (e.g. after a crashed/re-run
  // job) is always managed, whatever the clock or state file say.
  const existing = await findHeldCall(client, accountId);
  if (existing) {
    const state = readState();
    if (state?.date === today && state.entryPrice) existing.costPrice = state.entryPrice;
    logEvent({ event: "resumed", optionSymbol: existing.optionSymbol, contracts: existing.contracts, entryPrice: existing.costPrice, detail: "found an open 0DTE call at startup" });
    writeState({ date: today, entered: true, optionSymbol: existing.optionSymbol, strike: existing.strike, contracts: existing.contracts, entryPrice: existing.costPrice });
    return monitor(client, accountId, existing);
  }

  const state = readState();
  if (state?.date === today && state.entered) {
    logEvent({ event: "skipped", reason: "already_entered_today", detail: `already traded ${state.optionSymbol} today` });
    return true;
  }

  for (;;) {
    const min = nyMinutesOf(new Date());
    if (min >= ENTRY_MIN) break;
    console.log(`[session] waiting for ${hhmm(ENTRY_MIN)} ET entry (now ${hhmm(min)})`);
    await sleep(Math.min(60_000, (ENTRY_MIN - min) * 60_000));
  }
  if (nyMinutesOf(new Date()) >= ENTRY_DEADLINE_MIN) {
    logEvent({ event: "skipped", reason: "past_entry_window", detail: `session reached entry at ${hhmm(nyMinutesOf(new Date()))} ET, after the ${hhmm(ENTRY_DEADLINE_MIN)} cutoff` });
    return true;
  }

  const held = await enter(client, accountId);
  if (!held) return true;
  const entered: DayState = { date: today, entered: true, optionSymbol: held.optionSymbol, strike: held.strike, contracts: held.contracts, entryPrice: held.costPrice };
  writeState(entered);
  return monitor(client, accountId, held);
}

async function main() {
  const baseUrl = process.env.WEBULL_BASE_URL ?? "https://api.sandbox.webull.com";
  const accountId = process.env.WEBULL_SANDBOX_ACCOUNT_ID;
  if (!accountId) throw new Error("WEBULL_SANDBOX_ACCOUNT_ID must be set — refusing to guess an account.");
  const client = new WebullClient({
    appKey: process.env.WEBULL_APP_KEY!,
    appSecret: process.env.WEBULL_APP_SECRET!,
    baseUrl,
    host: new URL(baseUrl).host,
  });
  const ok = await runSession(client, accountId);
  if (!ok) process.exit(1); // red run in the Actions UI = position may still be open
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[fatal]", err);
    process.exit(1);
  });
}

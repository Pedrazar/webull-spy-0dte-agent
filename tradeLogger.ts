/**
 * Append-only event log (spy-trades.jsonl) plus a small per-day state
 * snapshot (spy-state.json). Same convention as the sibling projects: the
 * log is never rewritten or truncated, only appended to.
 *
 * spy-state.json tracks one sub-object per trading "slot" (2026-11-09: added
 * a second slot, `midday`, so up to two independent same-day entries can be
 * tracked without colliding — see main.ts's `SPY_SLOTS`). Each slot's own
 * `entered` flag is what stops a same-day re-dispatch of the workflow from
 * buying a second time for that slot after it was already stopped out.
 * Whether a position is open right now always comes from the broker, never
 * from here.
 *
 * File prefix is configurable (2026-10-16, for live trading): `LOG_PREFIX`
 * defaults to `spy` (the existing paper files, unchanged), but the live
 * entrypoint sets `SPY_LOG_PREFIX=live` so real trades write to
 * `live-trades.jsonl`/`live-state.json` instead — real and paper records
 * never mix in the same file, even though they live in the same repo.
 */

import fs from "fs";
import path from "path";

const PREFIX = process.env.SPY_LOG_PREFIX ?? "spy";
const LOG_PATH = path.join(__dirname, `${PREFIX}-trades.jsonl`);
const STATE_PATH = path.join(__dirname, `${PREFIX}-state.json`);

export type SpyEvent =
  | {
      event: "entry_filled";
      slot: string;
      optionSymbol: string;
      strike: number;
      expiration: string;
      contracts: number;
      entryPrice: number; // per-contract premium paid (per share, x100 for dollars)
      totalCost: number;
      /** SPY's price at decision time and the exact strike target
       * (price - STRIKE_OFFSET) — `strike` is the nearest listed strike. */
      underlyingPrice: number;
      targetStrike: number;
      clientOrderId: string;
    }
  | {
      event: "exit_filled";
      slot: string;
      optionSymbol: string;
      reason: "stop_loss" | "profit_lock" | "eod" ;
      contracts: number;
      entryPrice: number;
      exitPrice: number; // weighted average across fills
      realizedPnl: number;
      pctReturn: number;
    }
  | {
      event: "resumed";
      slot: string;
      optionSymbol: string;
      contracts: number;
      entryPrice: number;
      detail: string;
    }
  | {
      event: "position_gone";
      slot: string;
      optionSymbol: string;
      detail: string;
    }
  | {
      event: "skipped";
      slot: string;
      reason:
        | "holiday"
        | "already_entered_today"
        | "past_entry_window"
        | "no_0dte_contract"
        | "no_quote"
        | "no_price"
        | "order_not_filled"
        | "insufficient_buying_power"
        | "strike_collision"
        | "daily_risk_limit";
      detail: string;
    }
  | {
      event: "exit_failed";
      slot: string;
      optionSymbol: string;
      reason: "stop_loss" | "profit_lock" | "eod";
      detail: string;
    };

export function logEvent(e: SpyEvent): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...e });
  fs.appendFileSync(LOG_PATH, line + "\n");
  console.log(`[event] ${line}`);
}

export interface SlotState {
  entered: boolean;
  optionSymbol?: string;
  strike?: number;
  contracts?: number;
  entryPrice?: number;
  exitPrice?: number;
  exitReason?: "stop_loss" | "profit_lock" | "eod";
  realizedPnl?: number;
}

export interface DayState {
  date: string; // NY date
  slots: Record<string, SlotState>;
}

/** Today's state, or a fresh empty one if there's no file yet, it's
 * unreadable, or it's a stale prior day's — callers never need to check the
 * date themselves. */
export function readDayState(today: string): DayState {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) as DayState;
    if (parsed.date === today && parsed.slots) return parsed;
  } catch {
    // no file yet, or unreadable — treated the same as "nothing yet today"
  }
  return { date: today, slots: {} };
}

function writeDayState(s: DayState): void {
  fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2) + "\n");
}

/** Slots run concurrently in the same process (see main.ts's
 * `Promise.all` over `runSlotSession`) and can genuinely finish at the same
 * wall-clock moment — both slots' EOD exit fires at the identical NY minute
 * every single day, for instance. Without serializing, two concurrent
 * read-modify-write calls here could race and silently drop one slot's
 * update. Node is single-threaded, so chaining onto one shared promise is
 * enough to make every read-modify-write atomic relative to the others —
 * no real lock needed. */
let writeQueue: Promise<unknown> = Promise.resolve();
export function updateSlotState(today: string, slotId: string, patch: Partial<SlotState>): Promise<void> {
  writeQueue = writeQueue.then(() => {
    const state = readDayState(today);
    state.slots[slotId] = { ...(state.slots[slotId] ?? { entered: false }), ...patch };
    writeDayState(state);
  });
  return writeQueue as Promise<void>;
}

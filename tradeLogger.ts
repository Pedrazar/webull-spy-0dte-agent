/**
 * Append-only event log (spy-trades.jsonl) plus a small per-day state
 * snapshot (spy-state.json). Same convention as the sibling projects: the
 * log is never rewritten or truncated, only appended to.
 *
 * spy-state.json is only used for one decision — "did we already enter
 * today?" — so a same-day re-dispatch of the workflow can't buy a second
 * time after the first position was already stopped out. Whether a
 * position is open right now always comes from the broker, never from here.
 */

import fs from "fs";
import path from "path";

const LOG_PATH = path.join(__dirname, "spy-trades.jsonl");
const STATE_PATH = path.join(__dirname, "spy-state.json");

export type SpyEvent =
  | {
      event: "entry_filled";
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
      optionSymbol: string;
      reason: "stop_loss" | "eod" ;
      contracts: number;
      entryPrice: number;
      exitPrice: number; // weighted average across fills
      realizedPnl: number;
      pctReturn: number;
    }
  | {
      event: "resumed";
      optionSymbol: string;
      contracts: number;
      entryPrice: number;
      detail: string;
    }
  | {
      event: "position_gone";
      optionSymbol: string;
      detail: string;
    }
  | {
      event: "skipped";
      reason: "holiday" | "already_entered_today" | "past_entry_window" | "no_0dte_contract" | "no_quote" | "no_price" | "order_not_filled";
      detail: string;
    }
  | {
      event: "exit_failed";
      optionSymbol: string;
      reason: "stop_loss" | "eod";
      detail: string;
    };

export function logEvent(e: SpyEvent): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...e });
  fs.appendFileSync(LOG_PATH, line + "\n");
  console.log(`[event] ${line}`);
}

export interface DayState {
  date: string; // NY date
  entered: boolean;
  optionSymbol?: string;
  strike?: number;
  contracts?: number;
  entryPrice?: number;
  exitPrice?: number;
  exitReason?: "stop_loss" | "eod";
  realizedPnl?: number;
}

export function readState(): DayState | null {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) as DayState;
  } catch {
    return null;
  }
}

export function writeState(s: DayState): void {
  fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2) + "\n");
}

/**
 * Options-specific Webull OpenAPI wrappers.
 *
 * UNVERIFIED AGAINST THE LIVE SANDBOX as of writing — every endpoint path and
 * payload shape below was pulled directly from Webull's own official SDK
 * source (not docs prose, which don't show full payloads):
 *   - webull-openapi-python-sdk: webull/trade/request/v2/{place,preview,cancel,replace}_option_request.py,
 *     webull/data/request/get_option_contracts_request_v2.py,
 *     webull/data/request/get_option_snapshot_request.py,
 *     webull/trade/request/v2/get_account_balance_request.py,
 *     webull/trade/request/v2/get_account_positions_request.py
 *   - webull-openapi-skills: webull_skill/trading/option_order.py (order body
 *     shape, including the `category: US_OPTION` header requirement),
 *     webull_skill/market_data/option.py
 *
 * Run testOptionAuth.ts / testOptionChain.ts / testOptionOrderPreview.ts
 * before trusting any of this — see CLAUDE.md's Build order.
 */

import crypto from "crypto";
import { WebullClient } from "./webullClient";

const V3 = { version: "v3" };

function newClientOrderId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

export interface AccountBalance {
  // CONFIRMED LIVE (2026-09-08): the real shape nests buying power under
  // account_currency_assets[0], not flat fields off the response root.
  // Every numeric field in Webull responses is a STRING — always parseFloat.
  total_cash_balance?: string;
  account_currency_assets?: Array<{
    currency: string;
    option_buying_power?: string;
    day_buying_power?: string;
    cash_balance?: string;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

/** The figure to check before selling a cash-secured put: option_buying_power
 * for the account's USD entry, falling back to total_cash_balance if that
 * shape ever changes. */
export function extractOptionBuyingPower(balance: AccountBalance): number {
  const usd = balance.account_currency_assets?.find((a) => a.currency === "USD");
  if (usd?.option_buying_power) return parseFloat(usd.option_buying_power);
  if (balance.total_cash_balance) return parseFloat(balance.total_cash_balance);
  return 0;
}

export async function getAccountList(client: WebullClient): Promise<unknown[]> {
  const res = await client.get<{ data?: unknown[] } | unknown[]>("/trading/accounts/list", {}, V3);
  return Array.isArray(res) ? res : (res as { data?: unknown[] }).data ?? [];
}

export async function getAccountBalance(client: WebullClient, accountId: string): Promise<AccountBalance> {
  return client.get<AccountBalance>("/trading/assets/balances/get", { account_id: accountId }, V3);
}

// ---------------------------------------------------------------------------
// Positions (stock + option) — v3 successor to the sibling project's
// /openapi/assets/positions
// ---------------------------------------------------------------------------

export interface PositionLeg {
  symbol: string; // CONFIRMED LIVE (2026-09-09, first real fill): this is the
  // UNDERLYING ticker ("NVDA"), same as the position's own top-level symbol
  // — NOT the OCC option contract symbol. The OCC symbol appears NOWHERE in
  // this response; reconstruct it with occSymbol() below when one is needed
  // (e.g. for a snapshot-quote lookup).
  cost?: string; // per-contract cost basis (credit received for a short leg) — CONFIRMED live, e.g. "1.11"
  option_type?: "PUT" | "CALL";
  option_expire_date?: string; // YYYY-MM-DD — CONFIRMED live field name (contrast with the chain-list endpoint's `expiration_date`, a different name for the same concept on a different payload)
  option_exercise_price?: string; // strike — CONFIRMED live field name (NOT `strike_price`, which is what the chain-list endpoint calls it)
  instrument_type?: string;
  leg_id?: string;
  [key: string]: unknown;
}

export interface Position {
  symbol: string; // underlying ticker for BOTH equity and option positions
  instrument_type: string; // "EQUITY" | "OPTION"
  quantity: string; // combo-level; CONFIRMED negative for a short option position (e.g. "-5")
  cost_price?: string; // avg cost per share/contract — used for the "never sell a call below cost basis" guard
  // CONFIRMED LIVE: an option position's strike/expiration/type live under
  // legs[0], not as top-level fields (top level only has combo-wide fields
  // like quantity/cost_price/instrument_type). Equity positions are
  // presumed to have no legs array — not yet confirmed live (no assignment
  // has happened yet); if reconcile() ever misreads an equity position,
  // check this assumption first.
  legs?: PositionLeg[];
  [key: string]: unknown;
}

export async function getPositions(client: WebullClient, accountId: string): Promise<Position[]> {
  const res = await client.get<{ data?: Position[] } | Position[]>(
    "/trading/assets/positions/list",
    { account_id: accountId },
    V3
  );
  return Array.isArray(res) ? res : (res as { data?: Position[] }).data ?? [];
}

/** Reconstructs the OCC option symbol (e.g. "NVDA261002P00200000") from its
 * parts — needed because the positions endpoint never returns it directly
 * (confirmed live 2026-09-09). Matches the exact format confirmed from the
 * chain-list endpoint's own `symbol` field for the same contract. */
export function occSymbol(underlying: string, expirationDate: string, optionType: "PUT" | "CALL", strike: number): string {
  const [y, m, d] = expirationDate.split("-");
  const yymmdd = y.slice(2) + m + d;
  const strikeCode = String(Math.round(strike * 1000)).padStart(8, "0");
  return `${underlying}${yymmdd}${optionType === "PUT" ? "P" : "C"}${strikeCode}`;
}

// ---------------------------------------------------------------------------
// Option chain / contracts
// ---------------------------------------------------------------------------

export interface OptionContract {
  symbol: string; // e.g. "NVDA260925P00260000"
  underlying_symbol?: string;
  option_type: "CALL" | "PUT";
  strike_price: string;
  // CONFIRMED LIVE (2026-09-08 against sandbox): the chain-list endpoint
  // calls this field `expiration_date`, NOT `option_expire_date` — that
  // latter name is only used inside an order-placement leg's request body
  // (see buildSingleLegOrder below), a genuinely different field of a
  // genuinely different payload. Easy to conflate; don't.
  expiration_date: string; // YYYY-MM-DD
  status?: string;
  [key: string]: unknown;
}

export interface GetOptionChainParams {
  underlyingSymbol: string;
  optionType?: "CALL" | "PUT";
  startDate?: string; // YYYY-MM-DD
  endDate?: string; // YYYY-MM-DD
  strikePriceGte?: number;
  strikePriceLte?: number;
}

export async function getOptionChain(
  client: WebullClient,
  params: GetOptionChainParams
): Promise<OptionContract[]> {
  const query: Record<string, string> = {
    category: "US_OPTION",
    underlying_symbols: params.underlyingSymbol,
  };
  if (params.optionType) query.option_type = params.optionType;
  if (params.startDate) query.start_date = params.startDate;
  if (params.endDate) query.end_date = params.endDate;
  if (params.strikePriceGte !== undefined) query.strike_price_gte = String(params.strikePriceGte);
  if (params.strikePriceLte !== undefined) query.strike_price_lte = String(params.strikePriceLte);

  const res = await client.get<{ data?: OptionContract[] } | OptionContract[]>(
    "/trading/instruments/options/contracts/list",
    query,
    V3
  );
  return Array.isArray(res) ? res : (res as { data?: OptionContract[] }).data ?? [];
}

// ---------------------------------------------------------------------------
// Option quotes
// ---------------------------------------------------------------------------

export interface OptionSnapshot {
  symbol: string;
  // CONFIRMED LIVE: the snapshot endpoint's real field names are `bid`/
  // `ask`/`price` (last trade), not the `*_price`-suffixed names the SDK's
  // docstring implied.
  bid?: string;
  ask?: string;
  price?: string;
  [key: string]: unknown;
}

/** Max 20 symbols per call, per the SDK's own docstring. */
export async function getOptionSnapshot(client: WebullClient, symbols: string[]): Promise<OptionSnapshot[]> {
  const res = await client.get<{ data?: OptionSnapshot[] } | OptionSnapshot[]>(
    "/market-data/options/snapshots/list",
    { symbols: symbols.join(","), category: "US_OPTION" },
    V3
  );
  return Array.isArray(res) ? res : (res as { data?: OptionSnapshot[] }).data ?? [];
}

// ---------------------------------------------------------------------------
// Option orders — single leg only (SINGLE strategy: this wheel never legs
// into multi-leg combos)
// ---------------------------------------------------------------------------

export type OptionSide = "BUY" | "SELL";
export type PositionIntent = "SELL_TO_OPEN" | "BUY_TO_CLOSE" | "BUY_TO_OPEN" | "SELL_TO_CLOSE";

export interface BuildOptionOrderParams {
  // CONFIRMED LIVE (2026-09-08): the leg's `symbol` field must be the
  // UNDERLYING ticker (e.g. "NVDA"), not the OCC option contract symbol —
  // sending the full contract symbol here (e.g. "NVDA261002P00215000")
  // fails preview with OPENAPI_PARAM_ERR "invalid market,symbol,option_type,
  // strike_price,option_expire_date" every time, regardless of whether the
  // other fields are correct, because the API treats symbol+strike+expire+
  // type as the independent identifying fields for the leg, not the OCC
  // string. The OCC contract symbol (from the chain endpoint / snapshot
  // lookups) is only needed for logging/state, so it's kept separate here
  // as optionSymbol and never sent in the order body.
  underlyingSymbol: string;
  optionSymbol: string; // for the caller's own logging/state only — NOT sent to the API
  side: OptionSide;
  quantity: number; // contracts
  optionType: "CALL" | "PUT";
  strikePrice: number;
  expirationDate: string; // YYYY-MM-DD
  limitPrice: number;
  positionIntent: PositionIntent;
  clientOrderId?: string;
}

function buildSingleLegOrder(p: BuildOptionOrderParams): Record<string, unknown> {
  return {
    client_order_id: p.clientOrderId ?? newClientOrderId(),
    combo_type: "NORMAL",
    order_type: "LIMIT", // options never support MARKET — confirmed in SDK docstrings
    quantity: String(p.quantity),
    option_strategy: "SINGLE",
    side: p.side,
    // Sell-side option orders only support DAY (GTC is buy-side only, per
    // the skills repo docstring) — this wheel always uses DAY, matching that
    // constraint for both legs (sells to open, buys to close).
    time_in_force: "DAY",
    entrust_type: "QTY",
    limit_price: String(p.limitPrice),
    position_intent: p.positionIntent,
    legs: [
      {
        side: p.side,
        quantity: String(p.quantity),
        symbol: p.underlyingSymbol,
        strike_price: String(p.strikePrice),
        option_expire_date: p.expirationDate,
        instrument_type: "OPTION",
        option_type: p.optionType,
        market: "US",
      },
    ],
  };
}

/** category header derivation confirmed from the SDK's PlaceOptionRequest.add_custom_headers_from_order:
 * market ("US") + "_" + instrument_type ("OPTION") = "US_OPTION". Easy to
 * silently omit since it's not in the request body — must be a header. */
const OPTION_ORDER_HEADERS = { headers: { category: "US_OPTION" }, ...V3 };

export interface PlaceOptionOrderResult {
  client_order_id?: string;
  order_id?: string;
  [key: string]: unknown;
}

export async function previewOptionOrder(
  client: WebullClient,
  accountId: string,
  params: BuildOptionOrderParams
): Promise<unknown> {
  const order = buildSingleLegOrder(params);
  return client.post(
    "/openapi/trade/option/order/preview",
    { account_id: accountId, new_orders: [order] },
    OPTION_ORDER_HEADERS
  );
}

export async function placeOptionOrder(
  client: WebullClient,
  accountId: string,
  params: BuildOptionOrderParams
): Promise<PlaceOptionOrderResult> {
  const order = buildSingleLegOrder(params);
  return client.post<PlaceOptionOrderResult>(
    "/openapi/trade/option/order/place",
    { account_id: accountId, new_orders: [order] },
    OPTION_ORDER_HEADERS
  );
}

export async function cancelOptionOrder(client: WebullClient, accountId: string, clientOrderId: string): Promise<unknown> {
  return client.post(
    "/openapi/trade/option/order/cancel",
    { account_id: accountId, client_order_id: clientOrderId },
    V3
  );
}

// ---------------------------------------------------------------------------
// Order status — reuses the already LIVE-VERIFIED (in the sibling stock-agent
// project) /openapi/trade/order/detail and /openapi/trade/order/open
// endpoints with the "v2" header, rather than the newer-but-unverified v3
// paths (/trading/orders/...) — these two are generic across instrument
// types, not stock-specific, so the proven combo is reused as-is.
// ---------------------------------------------------------------------------

export interface OrderDetail {
  status: string;
  filled_price?: string;
  filled_quantity?: string;
  [key: string]: unknown;
}

export async function getOrderDetail(
  client: WebullClient,
  accountId: string,
  clientOrderId: string
): Promise<{ orders?: OrderDetail[] }> {
  return client.get<{ orders?: OrderDetail[] }>("/openapi/trade/order/detail", {
    account_id: accountId,
    client_order_id: clientOrderId,
  });
}

export async function getOpenOrders(client: WebullClient, accountId: string): Promise<OrderDetail[]> {
  const res = await client.get<{ orders?: OrderDetail[] } | OrderDetail[]>("/openapi/trade/order/open", {
    account_id: accountId,
  });
  return Array.isArray(res) ? res : (res as { orders?: OrderDetail[] }).orders ?? [];
}

/** Polls order/detail until a terminal state or attempts run out — same
 * pattern as the sibling project's OrderManager.pollOrderFill(). Returns
 * null if the order hasn't settled within maxAttempts; callers must treat
 * that as "still unknown," not "not filled." */
export async function pollOptionOrderFill(
  client: WebullClient,
  accountId: string,
  clientOrderId: string,
  maxAttempts = 5,
  delayMs = 1500
): Promise<{ status: string; filledPrice: number | null; filledQuantity: number } | null> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const detail = await getOrderDetail(client, accountId, clientOrderId);
    const order = detail.orders?.[0];
    if (order && (order.status === "FILLED" || order.status === "CANCELLED" || order.status === "REJECTED")) {
      return {
        status: order.status,
        filledPrice: order.filled_price ? parseFloat(order.filled_price) : null,
        filledQuantity: parseFloat(order.filled_quantity ?? "0"),
      };
    }
    if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, delayMs));
  }
  return null;
}

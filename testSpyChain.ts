/**
 * Live sandbox check for everything main.ts depends on, WITHOUT placing an
 * order: SPY underlying price (stock bars), a single-expiration CALL chain
 * (the 0DTE lookup — pass a date to test a future expiry on a non-trading
 * day), a snapshot quote, and a BUY_TO_OPEN preview.
 *
 *   npx tsx testSpyChain.ts [YYYY-MM-DD]
 */

import "dotenv/config";
import { WebullClient } from "./webullClient";
import { getOptionChain, getOptionSnapshot, previewOptionOrder } from "./optionsClient";
import { todayNyDate } from "./marketHours";
import { fetchSpyPrice, pickStrikeNearest } from "./main";

async function run() {
  const baseUrl = process.env.WEBULL_BASE_URL!;
  const accountId = process.env.WEBULL_SANDBOX_ACCOUNT_ID!;
  const client = new WebullClient({
    appKey: process.env.WEBULL_APP_KEY!,
    appSecret: process.env.WEBULL_APP_SECRET!,
    baseUrl,
    host: new URL(baseUrl).host,
  });

  const expiry = process.argv[2] ?? todayNyDate();
  const price = await fetchSpyPrice(client);
  console.log("SPY price:", price);
  if (price === null) return;

  const chain = await getOptionChain(client, {
    underlyingSymbol: "SPY",
    optionType: "CALL",
    startDate: expiry,
    endDate: expiry,
    strikePriceGte: Math.floor(price - 10),
    strikePriceLte: Math.ceil(price + 10),
  });
  console.log(`chain for ${expiry}: ${chain.length} contracts, expirations:`, [...new Set(chain.map((c) => c.expiration_date))]);
  console.log("sample contract:", chain[0]);

  const target = price - parseFloat(process.env.SPY_STRIKE_OFFSET ?? "1");
  const contract = pickStrikeNearest(chain.filter((c) => c.expiration_date === expiry), target);
  console.log(`target strike ${target.toFixed(2)} -> picked`, contract?.symbol, contract?.strike_price);
  if (!contract) return;

  const snap = await getOptionSnapshot(client, [contract.symbol]);
  console.log("snapshot:", JSON.stringify(snap[0], null, 2));
  const ask = snap[0]?.ask ? parseFloat(snap[0].ask) : parseFloat(snap[0]?.price ?? "0");

  const preview = await previewOptionOrder(client, accountId, {
    underlyingSymbol: "SPY",
    optionSymbol: contract.symbol,
    side: "BUY",
    quantity: 1,
    optionType: "CALL",
    strikePrice: parseFloat(contract.strike_price),
    expirationDate: expiry,
    limitPrice: ask,
    positionIntent: "BUY_TO_OPEN",
  }).catch((e) => `PREVIEW ERROR: ${e}`);
  console.log("preview BUY_TO_OPEN:", JSON.stringify(preview, null, 2));
}

run();

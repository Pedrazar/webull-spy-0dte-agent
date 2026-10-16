/**
 * LIVE production verification — PREVIEW ONLY, never places a real order.
 *
 * Checks, in order: (1) can we get a valid production access token right
 * now (handles the create/check/refresh/PENDING-approval flow via
 * prodTokenManager.ts); (2) what real accounts exist under this login and
 * their balances/option approval; (3) SPY's 0DTE option chain against
 * production; (4) a snapshot quote; (5) a BUY_TO_OPEN preview (preview
 * endpoint only — confirmed in the sandbox build this never places an
 * order, see optionsClient.ts's previewOptionOrder()).
 *
 *   npx tsx testProdAuth.ts
 */

import "dotenv/config";
import { WebullClient } from "./webullClient";
import { getValidAccessToken } from "./prodTokenManager";
import { getOptionChain, getOptionSnapshot, previewOptionOrder, getAccountList, getAccountBalance, extractOptionBuyingPower } from "./optionsClient";
import { todayNyDate, isMarketHoliday } from "./marketHours";

async function run() {
  const baseUrl = process.env.WEBULL_PROD_BASE_URL;
  const appKey = process.env.WEBULL_PROD_APP_KEY;
  const appSecret = process.env.WEBULL_PROD_APP_SECRET;
  if (!baseUrl || !appKey || !appSecret) {
    throw new Error("WEBULL_PROD_APP_KEY/APP_SECRET/BASE_URL must be set in .env");
  }

  const prodClient = new WebullClient({ appKey, appSecret, baseUrl, host: new URL(baseUrl).host });

  console.log("=== Step 1: production access token ===");
  const token = await getValidAccessToken(prodClient);
  prodClient.setAccessToken(token);
  console.log("Got a token (not printing it). Proceeding.\n");

  console.log("=== Step 2: real accounts under this login ===");
  const accounts = await getAccountList(prodClient);
  console.log(JSON.stringify(accounts, null, 2));

  // Safety check (2026-10-16 decision: Individual Margin): refuse to
  // continue if WEBULL_PROD_ACCOUNT_ID doesn't actually resolve to that
  // account right now — accounts can be renumbered/relabeled, and this
  // script (and, later, the live agent) should never silently preview or
  // trade against an account nobody confirmed.
  const chosenId = process.env.WEBULL_PROD_ACCOUNT_ID;
  if (chosenId) {
    const match = (accounts as Array<{ account_id?: string; account_label?: string; account_type?: string }>).find(
      (a) => a.account_id === chosenId
    );
    if (!match) {
      throw new Error(`WEBULL_PROD_ACCOUNT_ID ${chosenId} was not found in this login's account list — refusing to continue.`);
    }
    console.log(`\nConfirmed WEBULL_PROD_ACCOUNT_ID ${chosenId} = "${match.account_label}" (${match.account_type}).`);
    if (match.account_label !== "Individual Margin") {
      throw new Error(
        `WEBULL_PROD_ACCOUNT_ID ${chosenId} resolves to "${match.account_label}", not "Individual Margin" — refusing to continue. Update this check if the intended account genuinely changed.`
      );
    }
  }
  for (const acct of accounts as Array<{ account_id?: string; brokerage_account_id?: string; [k: string]: unknown }>) {
    const id = (acct.account_id ?? acct.brokerage_account_id) as string | undefined;
    if (!id) continue;
    console.log(`\n--- balance for account ${id} ---`);
    try {
      const bal = await getAccountBalance(prodClient, id);
      console.log(JSON.stringify(bal, null, 2));
      console.log(`option_buying_power (extracted): ${extractOptionBuyingPower(bal)}`);
    } catch (err) {
      console.log(`balance lookup failed: ${err}`);
    }
  }

  console.log("\n=== Step 3: SPY 0DTE chain (production) ===");
  const today = todayNyDate();
  console.log(`today (NY): ${today}, market holiday: ${isMarketHoliday(new Date())}`);
  const chain = await getOptionChain(prodClient, {
    underlyingSymbol: "SPY",
    optionType: "CALL",
    startDate: today,
    endDate: today,
  });
  console.log(`chain: ${chain.length} contracts, sample:`, chain[0]);
  if (chain.length === 0) {
    console.log("No 0DTE chain returned — stopping here (nothing to preview against).");
    return;
  }

  console.log("\n=== Step 4: snapshot quote (production) ===");
  const contract = chain[Math.floor(chain.length / 2)];
  const snap = await getOptionSnapshot(prodClient, [contract.symbol]);
  console.log(JSON.stringify(snap[0], null, 2));
  const ask = snap[0]?.ask ? parseFloat(snap[0].ask) : parseFloat(snap[0]?.price ?? "0");
  if (!(ask > 0)) {
    console.log("No usable ask — stopping here.");
    return;
  }

  console.log("\n=== Step 5: BUY_TO_OPEN PREVIEW (production) — does NOT place an order ===");
  // 2026-10-16 decision: Individual Margin (account_id A5H8R5F7IQGJ69DKPVC4RSNJLA,
  // account_number CVV9HSH3) is the account for live trading — NOT accounts[0]
  // (that's the Traditional IRA). Hardcoded here deliberately so this script
  // can never silently preview against the wrong account.
  const liveAccountId = process.env.WEBULL_PROD_ACCOUNT_ID;
  if (!liveAccountId) throw new Error("WEBULL_PROD_ACCOUNT_ID must be set in .env to run the preview step");
  console.log(`Using account ${liveAccountId} for the preview.`);
  const preview = await previewOptionOrder(prodClient, liveAccountId, {
    underlyingSymbol: "SPY",
    optionSymbol: contract.symbol,
    side: "BUY",
    quantity: 1,
    optionType: "CALL",
    strikePrice: parseFloat(contract.strike_price),
    expirationDate: today,
    limitPrice: ask,
    positionIntent: "BUY_TO_OPEN",
  }).catch((e) => `PREVIEW ERROR: ${e}`);
  console.log(JSON.stringify(preview, null, 2));
}

run().catch((err) => {
  console.error("\n[FATAL]", err instanceof Error ? err.message : err);
  process.exit(1);
});

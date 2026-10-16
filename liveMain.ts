/**
 * LIVE entry point — real money, the Individual Margin account. Reuses
 * every bit of strategy/order logic from `main.ts`'s `runSession()`
 * (entry escalation, monitor loop, exit escalation, buying-power guard)
 * unchanged; the only differences are which credentials/account it points
 * at and where its token and trade records are stored. See CLAUDE.md's
 * 2026-10-16 status updates for the full verification history before this
 * was trusted to run.
 *
 * MUST be invoked with SPY_LOG_PREFIX=live already set in the process
 * environment (the workflow sets it; for a manual local run, prefix the
 * command: `SPY_LOG_PREFIX=live npx tsx liveMain.ts`). Setting it as a
 * plain statement inside this file would NOT work and was tried first —
 * confirmed live (2026-10-16) that TypeScript's CommonJS output hoists
 * `import`s above other top-level code, so `tradeLogger.ts`'s
 * `PREFIX = process.env.SPY_LOG_PREFIX ?? "spy"` (read at import time)
 * would already have run and silently defaulted to "spy" — meaning real
 * trades would have been appended to the PAPER log, `spy-trades.jsonl`.
 * The check below exists specifically so that mistake (or a future one
 * like it) fails loudly instead of silently corrupting the paper records.
 */

import "dotenv/config";
import { WebullClient } from "./webullClient";
import { getValidAccessToken, envTokenStore } from "./prodTokenManager";
import { runSession } from "./main";

async function liveMain() {
  if (process.env.SPY_LOG_PREFIX !== "live") {
    throw new Error(
      'SPY_LOG_PREFIX must be set to "live" in the environment BEFORE this process starts (not inside this file — see the header comment). Refusing to run: without it, real trades would be appended to the paper log files.'
    );
  }

  const baseUrl = process.env.WEBULL_PROD_BASE_URL;
  const appKey = process.env.WEBULL_PROD_APP_KEY;
  const appSecret = process.env.WEBULL_PROD_APP_SECRET;
  const accountId = process.env.WEBULL_PROD_ACCOUNT_ID;
  if (!baseUrl || !appKey || !appSecret) {
    throw new Error("WEBULL_PROD_APP_KEY/APP_SECRET/BASE_URL must be set — refusing to guess live credentials.");
  }
  if (!accountId) {
    throw new Error("WEBULL_PROD_ACCOUNT_ID must be set — refusing to guess which real account to trade.");
  }

  const client = new WebullClient({ appKey, appSecret, baseUrl, host: new URL(baseUrl).host });
  const token = await getValidAccessToken(client, envTokenStore());
  client.setAccessToken(token);

  console.log(`[live] trading account ${accountId} — this places REAL orders.`);
  const ok = await runSession(client, accountId);
  if (!ok) process.exit(1); // red run in the Actions UI = position may still be open, needs a human
}

if (require.main === module) {
  liveMain().catch((err) => {
    console.error("[fatal]", err);
    process.exit(1);
  });
}

/**
 * Manages the production Webull OAuth-style access token for LIVE order
 * placement on the real account — unlike the sibling `webull-agent`
 * project (where this same flow exists but is used only for a watchlist
 * push, never orders), this project's whole point of having it is to
 * trade real money. Copied from that project's `prodTokenManager.ts`
 * verbatim except this header; `TOKEN_PATH` resolves to THIS project's own
 * `prod-token.json`, not the sibling's — deliberately separate caches, so
 * a stale/expired token in one project can't be silently assumed valid
 * for the other (confirmed live 2026-10-16: the sibling's cached token had
 * expired 2026-09-03, over six weeks before this project checked).
 *
 * Confirmed live flow (mirrors webull/core/http/initializer/token/*.py in
 * the official Python SDK):
 *   POST /openapi/auth/token/create  {token?}  -> {token, expires, status}
 *   POST /openapi/auth/token/check   {token}   -> same shape
 *   POST /openapi/auth/token/refresh {token}   -> same shape
 * status is one of PENDING | NORMAL | INVALID | EXPIRED. A fresh
 * create_token call returns PENDING until the account holder approves the
 * request inside the real Webull app — CONFIRMED live, this is a genuine
 * one-time (or occasional) manual step, not something this code can
 * complete on its own. refresh_token extends an already-NORMAL token
 * without requiring re-approval — also confirmed live.
 *
 * STORAGE is pluggable (added 2026-10-16, for this project only — the
 * sibling `webull-agent` project still always uses the file store, since
 * its token only feeds a watchlist push, not real orders). Local dev
 * defaults to `prod-token.json` (gitignored). GitHub Actions uses a
 * different store instead: this repo is PUBLIC, and unlike the paper
 * agent's state (safe to git-commit back after each run), a live bearer
 * token must never land in git history where anyone could read and use
 * it. The CI store (`envTokenStore()`) reads the cached token from
 * `WEBULL_PROD_TOKEN`/`WEBULL_PROD_TOKEN_EXPIRES` env vars (populated from
 * GitHub Secrets) and, when a refresh produces a new token, writes it to a
 * local gitignored file (`prod-token-refreshed.json`) instead of git — a
 * workflow step after the trading script runs reads that file and pushes
 * the new value back to the Secrets via `gh secret set` (see
 * `.github/workflows/spy-0dte-live.yml`), masking it from the log first.
 * The token itself never appears in a commit, a log line, or this
 * process's stdout at any point.
 */

import fs from "fs";
import path from "path";
import { WebullClient } from "./webullClient";

const TOKEN_PATH = path.join(__dirname, "prod-token.json");
const REFRESHED_OUTPUT_PATH = path.join(__dirname, "prod-token-refreshed.json");
const REFRESH_BUFFER_MS = 5 * 24 * 60 * 60 * 1000; // refresh once <5 days from expiry, so a scheduled run never races expiry mid-flight

export interface StoredToken {
  token: string;
  expiresAt: number;
}

interface TokenResponse {
  token: string;
  expires: number;
  status: "PENDING" | "NORMAL" | "INVALID" | "EXPIRED";
}

/** Where a valid token is read from and a refreshed one is written to. */
export interface TokenStore {
  load(): StoredToken | null;
  save(token: string, expiresAt: number): void;
}

/** Local dev / the sibling project's usage: a gitignored JSON file. */
export const fileTokenStore: TokenStore = {
  load(): StoredToken | null {
    try {
      return JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"));
    } catch {
      return null;
    }
  },
  save(token: string, expiresAt: number): void {
    fs.writeFileSync(TOKEN_PATH, JSON.stringify({ token, expiresAt }, null, 2));
  },
};

/** CI: reads the cached token from env vars (GitHub Secrets, passed in by
 * the workflow), and on a refresh writes the new value to a local
 * gitignored file for a later workflow step to push back to Secrets —
 * never to git, never logged. */
export function envTokenStore(): TokenStore {
  return {
    load(): StoredToken | null {
      const token = process.env.WEBULL_PROD_TOKEN;
      const expiresAt = process.env.WEBULL_PROD_TOKEN_EXPIRES;
      if (!token || !expiresAt) return null;
      return { token, expiresAt: parseInt(expiresAt, 10) };
    },
    save(token: string, expiresAt: number): void {
      fs.writeFileSync(REFRESHED_OUTPUT_PATH, JSON.stringify({ token, expiresAt }, null, 2));
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Returns a valid access token, refreshing or creating one as needed.
 * Throws with a clear, actionable message if a fresh PENDING request never
 * gets approved within the poll window — callers (stockScreener.ts, or
 * this project's live order code) should catch this and refuse to trade
 * rather than proceed without a confirmed token.
 */
export async function getValidAccessToken(prodClient: WebullClient, store: TokenStore = fileTokenStore): Promise<string> {
  const stored = store.load();

  if (stored && stored.expiresAt - Date.now() > REFRESH_BUFFER_MS) {
    return stored.token; // still comfortably valid, no network call needed
  }

  if (stored) {
    // Try to refresh first — extends a NORMAL token without needing
    // re-approval. Falls through to create_token below if this fails (e.g.
    // the stored token actually went INVALID/EXPIRED already).
    try {
      const refreshed = await prodClient.post<TokenResponse>("/openapi/auth/token/refresh", {
        token: stored.token,
      });
      if (refreshed.status === "NORMAL") {
        store.save(refreshed.token, refreshed.expires);
        console.log(`[prod-token] refreshed, valid until ${new Date(refreshed.expires).toISOString()}`);
        return refreshed.token;
      }
    } catch (err) {
      console.warn("[prod-token] refresh failed, falling back to create_token:", err);
    }
  }

  const created = await prodClient.post<TokenResponse>("/openapi/auth/token/create", {});
  if (created.status === "NORMAL") {
    store.save(created.token, created.expires);
    return created.token;
  }

  // PENDING — needs a human to approve inside the real Webull app. Poll a
  // handful of times in case someone's mid-approval, but don't block a
  // scheduled run indefinitely.
  console.warn(
    `[prod-token] new token is PENDING approval — open the Webull app and approve the ` +
      `access request before ${new Date(created.expires).toISOString()}`
  );
  for (let attempt = 1; attempt <= 5; attempt++) {
    await sleep(5000);
    const checked = await prodClient.post<TokenResponse>("/openapi/auth/token/check", {
      token: created.token,
    });
    if (checked.status === "NORMAL") {
      store.save(checked.token, checked.expires);
      console.log(`[prod-token] approved, valid until ${new Date(checked.expires).toISOString()}`);
      return checked.token;
    }
    if (checked.status === "INVALID" || checked.status === "EXPIRED") {
      throw new Error(`[prod-token] token ${checked.status} before approval — rerun to request a new one`);
    }
  }

  throw new Error(
    "[prod-token] still PENDING after polling — approve the request in the Webull app, then rerun"
  );
}

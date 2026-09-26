/**
 * Market-hours gating — lifted from ../webull-agent/main.ts (DST-safe Intl
 * clock + hardcoded NYSE holiday set), which itself was hardened live after
 * a real incident (see that project's CLAUDE.md: a holiday-blind check once
 * burned a full session on Labor Day). Extended here with
 * isAtOrAfterMarketClose(), since this agent's own loop needs to know when
 * to stop polling, not just when to start.
 */

// Shared America/New_York clock — DST-safe (asks Intl directly rather than
// hardcoding a UTC offset, which would silently drift wrong across the
// EST/EDT transition).
const nyTimeFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export function nyTimeOf(date: Date): { hour: number; minute: number } {
  const parts = nyTimeFormatter.formatToParts(date);
  return {
    hour: parseInt(parts.find((p) => p.type === "hour")?.value ?? "-1", 10),
    minute: parseInt(parts.find((p) => p.type === "minute")?.value ?? "-1", 10),
  };
}

export function nyNow(): { hour: number; minute: number } {
  return nyTimeOf(new Date());
}

// NYSE/NASDAQ full-market-closure dates (America/New_York calendar date).
// Copied from the sibling project — needs a manual annual top-up; a
// stale/missing year just means holiday-awareness silently stops working
// for that year, not a crash. Does NOT cover early-close half-days.
const NYSE_HOLIDAYS = new Set([
  // 2026
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25",
  "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  // 2027
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31",
  "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
]);

const nyDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}); // en-CA locale formats as YYYY-MM-DD directly, matching NYSE_HOLIDAYS

export function todayNyDate(date: Date = new Date()): string {
  return nyDateFormatter.format(date);
}

export function isMarketHoliday(date: Date): boolean {
  const day = date.getDay(); // 0=Sun, 6=Sat, in whatever local TZ the process runs — fine for a coarse weekend check
  if (day === 0 || day === 6) return true;
  return NYSE_HOLIDAYS.has(nyDateFormatter.format(date));
}

/** True at or after today's 9:30am ET regular-hours open. */
export function isAtOrAfterMarketOpen(date: Date): boolean {
  const { hour, minute } = nyTimeOf(date);
  return hour > 9 || (hour === 9 && minute >= 30);
}

/** True at or after today's 4:00pm ET regular-hours close. */
export function isAtOrAfterMarketClose(date: Date): boolean {
  const { hour } = nyTimeOf(date);
  return hour >= 16;
}

/** True only during the regular 9:30am-4:00pm ET session on a trading day. */
export function isMarketOpenNow(date: Date = new Date()): boolean {
  if (isMarketHoliday(date)) return false;
  return isAtOrAfterMarketOpen(date) && !isAtOrAfterMarketClose(date);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls real NY time until the regular session has opened (9:30am ET) on a
 * non-holiday weekday. Returns immediately if already open. Returns false
 * (instead of opening) on a weekend/holiday or if already past today's
 * close — callers must exit without trading in that case, not proceed. */
export async function waitForMarketOpen(): Promise<boolean> {
  for (;;) {
    const now = new Date();
    if (isMarketHoliday(now)) {
      console.log(`[market-hours] ${todayNyDate(now)} is a weekend/holiday — nothing to do`);
      return false;
    }
    if (isAtOrAfterMarketOpen(now)) {
      const { hour, minute } = nyTimeOf(now);
      console.log(`[market-hours] market open (NY time ${hour}:${String(minute).padStart(2, "0")}), proceeding`);
      return true;
    }
    if (isAtOrAfterMarketClose(now)) {
      console.log(`[market-hours] already past today's close — nothing to do`);
      return false;
    }
    const { hour, minute } = nyTimeOf(now);
    console.log(`[market-hours] waiting for market open (NY time ${hour}:${String(minute).padStart(2, "0")})...`);
    await sleep(30_000);
  }
}

// ---------------------------------------------------------------------------
// Added for the SPY 0DTE agent: minute-level scheduling + early closes.
// ---------------------------------------------------------------------------

// NYSE 1:00pm ET early-close half-days. A 0DTE position must be out before
// THESE closes, not 4:00pm — the default 3:45pm exit would be hours late.
// Needs the same manual annual top-up as NYSE_HOLIDAYS above.
const NYSE_EARLY_CLOSES = new Set([
  "2026-11-27", "2026-12-24",
  "2027-11-26",
]);

/** Minutes since midnight, NY time — for comparing against "HH:MM" targets. */
export function nyMinutesOf(date: Date): number {
  const { hour, minute } = nyTimeOf(date);
  return hour * 60 + minute;
}

/** Today's regular-session close in NY minutes (960 = 4:00pm, 780 = 1:00pm). */
export function marketCloseMinutes(date: Date = new Date()): number {
  return NYSE_EARLY_CLOSES.has(todayNyDate(date)) ? 13 * 60 : 16 * 60;
}

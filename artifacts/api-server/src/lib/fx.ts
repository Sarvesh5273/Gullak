import { FX_SOURCE, SUPPORTED_CURRENCIES } from "@workspace/gullak-core";
import { logger } from "./logger";

/**
 * Daily USD exchange rates from ExchangeRate-API's open endpoint (no key,
 * published once a day, attribution required, caching allowed). Kept in
 * memory: refreshed after the source's next scheduled update, at most hourly,
 * with a 10-minute back-off after a failure. Callers get the last good rates
 * or null; there is no made-up fallback rate.
 */
const SOURCE_URL = "https://open.er-api.com/v6/latest/USD";
const REFRESH_FLOOR_MS = 60 * 60_000;
const FAILURE_BACKOFF_MS = 10 * 60_000;

export type FxSnapshot = {
  asOf: Date;
  rates: Map<string, number>;
};

let current: { snapshot: FxSnapshot; fetchedAt: number; nextUpdateAt: number } | null = null;
let lastFailureAt = 0;
let inFlight: Promise<void> | null = null;

async function refresh(): Promise<void> {
  try {
    const res = await fetch(SOURCE_URL, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as {
      result?: string;
      time_last_update_unix?: number;
      time_next_update_unix?: number;
      rates?: Record<string, unknown>;
    };
    if (body.result !== "success" || !body.rates || !body.time_last_update_unix) throw new Error("Unexpected response");
    const rates = new Map<string, number>();
    for (const currency of SUPPORTED_CURRENCIES) {
      const rate = body.rates[currency];
      if (typeof rate === "number" && Number.isFinite(rate) && rate > 0) rates.set(currency, rate);
    }
    if (!rates.has("INR")) throw new Error("Response has no INR rate");
    current = {
      snapshot: { asOf: new Date(body.time_last_update_unix * 1000), rates },
      fetchedAt: Date.now(),
      nextUpdateAt: (body.time_next_update_unix ?? 0) * 1000,
    };
    logger.info({ asOf: current.snapshot.asOf.toISOString(), inr: rates.get("INR") }, "Exchange rates refreshed");
  } catch (err) {
    lastFailureAt = Date.now();
    logger.warn({ err }, "Exchange-rate refresh failed");
  }
}

function due(now: number): boolean {
  if (!current) return now - lastFailureAt > FAILURE_BACKOFF_MS;
  if (now - lastFailureAt < FAILURE_BACKOFF_MS) return false;
  return now - current.fetchedAt > REFRESH_FLOOR_MS && now > current.nextUpdateAt;
}

/** Last good rates (refreshing first when due), or null if none are usable. */
export async function getFxRates(): Promise<FxSnapshot | null> {
  const now = Date.now();
  if (due(now)) {
    inFlight ??= refresh().finally(() => {
      inFlight = null;
    });
    // Only block when there is nothing to serve yet.
    if (!current) await inFlight;
  }
  // Served with its publish date, so an old snapshot (refreshes failing) stays visible as old.
  return current?.snapshot ?? null;
}

/**
 * Rate snapshot stored with a ledger row so receipts keep the value from the
 * day of the transfer. Empty for dollars or when rates are unavailable.
 */
export async function fxColumns(currency: string): Promise<{ fxCurrency?: string; fxRate?: string }> {
  if (currency === "USD") return {};
  const snapshot = await getFxRates();
  const rate = snapshot?.rates.get(currency);
  return rate ? { fxCurrency: currency, fxRate: String(rate) } : {};
}

export const FX_SOURCE_INFO = { sourceName: FX_SOURCE.name, sourceUrl: FX_SOURCE.url };

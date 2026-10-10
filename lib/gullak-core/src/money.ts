import { AUSD_DECIMALS } from "./chain";

const UNIT = 10n ** BigInt(AUSD_DECIMALS);
const CENT = UNIT / 100n;

/** Largest amount the UI accepts in one field ($1,000,000). Server limits are far lower. */
const MAX_INPUT_UNITS = 1_000_000n * UNIT;

/**
 * Parses a dollar amount typed by a person ("12", "12.5", "$1,200.50") into
 * AUSD base units (6 decimals). Accepts at most 2 decimal places.
 * Returns null for anything that is not a positive amount.
 */
export function parseUsd(input: string): bigint | null {
  const cleaned = input.trim().replace(/^\$/, "").replace(/,/g, "");
  const match = /^(\d{1,7})(?:\.(\d{0,2}))?$/.exec(cleaned);
  if (!match) return null;
  const whole = BigInt(match[1]);
  const cents = BigInt((match[2] ?? "").padEnd(2, "0") || "0");
  const units = whole * UNIT + cents * CENT;
  if (units <= 0n || units > MAX_INPUT_UNITS) return null;
  return units;
}

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Formats AUSD base units as dollars, e.g. 1234500000n -> "$1,234.50".
 * Sub-cent dust is truncated, never rounded up.
 */
export function formatUsd(units: bigint | string, options: { sign?: boolean } = {}): string {
  const value = typeof units === "string" ? BigInt(units) : units;
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / UNIT;
  const cents = (abs % UNIT) / CENT;
  const body = `$${groupThousands(whole.toString())}.${cents.toString().padStart(2, "0")}`;
  if (negative) return `−${body}`;
  return options.sign ? `+${body}` : body;
}

/** Converts AUSD base units to the equivalent CTK amount (18 decimals) at the pair's 1:1 price. */
export function ausdToCtkUnits(ausdUnits: bigint): bigint {
  return ausdUnits * 10n ** 12n;
}

export const AUSD_UNIT = UNIT;

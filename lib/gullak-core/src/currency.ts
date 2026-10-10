/**
 * Local currency display. Balances are always AUSD (US dollars); local amounts
 * are approximate conversions at a published daily rate, shown with "≈".
 * Countries are the main remittance corridors into India, plus India itself.
 */

export type Country = {
  /** ISO 3166-1 alpha-2. */
  code: string;
  name: string;
  /** ISO 4217. */
  currency: string;
};

export const COUNTRIES: readonly Country[] = [
  { code: "IN", name: "India", currency: "INR" },
  { code: "US", name: "United States", currency: "USD" },
  { code: "AE", name: "United Arab Emirates", currency: "AED" },
  { code: "GB", name: "United Kingdom", currency: "GBP" },
  { code: "SA", name: "Saudi Arabia", currency: "SAR" },
  { code: "SG", name: "Singapore", currency: "SGD" },
  { code: "CA", name: "Canada", currency: "CAD" },
  { code: "AU", name: "Australia", currency: "AUD" },
  { code: "QA", name: "Qatar", currency: "QAR" },
  { code: "KW", name: "Kuwait", currency: "KWD" },
  { code: "OM", name: "Oman", currency: "OMR" },
  { code: "DE", name: "Germany", currency: "EUR" },
];

export const DEFAULT_COUNTRY = "IN";

/** Every currency Gullak can show, without duplicates (USD included). */
export const SUPPORTED_CURRENCIES: readonly string[] = [...new Set(COUNTRIES.map((c) => c.currency))];

/** UPI payouts are always in rupees. */
export const PAYOUT_CURRENCY = "INR";

export function countryByCode(code: string | null | undefined): Country | null {
  if (!code) return null;
  return COUNTRIES.find((c) => c.code === code.toUpperCase()) ?? null;
}

export function currencyForCountry(code: string | null | undefined): string {
  return countryByCode(code)?.currency ?? "USD";
}

/** "IN" -> 🇮🇳 (regional indicator symbols). */
export function flagEmoji(code: string): string {
  return code
    .toUpperCase()
    .replace(/[A-Z]/g, (ch) => String.fromCodePoint(0x1f1e6 + ch.charCodeAt(0) - 65));
}

const TIME_ZONE_COUNTRY: Record<string, string> = {
  "Asia/Kolkata": "IN",
  "Asia/Calcutta": "IN",
  "Asia/Dubai": "AE",
  "Europe/London": "GB",
  "Asia/Riyadh": "SA",
  "Asia/Singapore": "SG",
  "Asia/Qatar": "QA",
  "Asia/Kuwait": "KW",
  "Asia/Muscat": "OM",
  "Europe/Berlin": "DE",
};

const CANADIAN_ZONES = new Set([
  "America/Toronto",
  "America/Vancouver",
  "America/Edmonton",
  "America/Winnipeg",
  "America/Halifax",
  "America/St_Johns",
  "America/Regina",
  "America/Montreal",
]);

/** Best guess from the device time zone; the member can change it later. */
export function countryFromTimeZone(timeZone: string | null | undefined): string {
  if (!timeZone) return DEFAULT_COUNTRY;
  const direct = TIME_ZONE_COUNTRY[timeZone];
  if (direct) return direct;
  if (CANADIAN_ZONES.has(timeZone)) return "CA";
  if (timeZone.startsWith("America/") || timeZone.startsWith("US/")) return "US";
  if (timeZone.startsWith("Australia/")) return "AU";
  return DEFAULT_COUNTRY;
}

const SYMBOLS: Record<string, string> = {
  INR: "₹",
  USD: "$",
  GBP: "£",
  EUR: "€",
  SGD: "S$",
  CAD: "C$",
  AUD: "A$",
};

function groupDigits(whole: string, indian: boolean): string {
  if (!indian || whole.length <= 3) return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const last3 = whole.slice(-3);
  return `${whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last3}`;
}

/** 123456.7, "INR" -> "₹1,23,456.70"; "AED" -> "AED 123,456.70". */
export function formatLocal(amount: number, currency: string): string {
  const symbol = SYMBOLS[currency] ?? `${currency} `;
  const [whole = "0", cents = "00"] = Math.abs(amount).toFixed(2).split(".");
  return `${amount < 0 ? "−" : ""}${symbol}${groupDigits(whole, currency === "INR")}.${cents}`;
}

/** AUSD base units (6 decimals) at `rate` local units per US dollar. */
export function usdUnitsToLocal(units: bigint | string, rate: number): number {
  return (Number(typeof units === "string" ? BigInt(units) : units) / 1e6) * rate;
}

/** "₹96.83 per $1" */
export function formatRate(rate: number, currency: string): string {
  return `${formatLocal(rate, currency)} per $1`;
}

/** Attribution the free rate source requires wherever its rates are shown. */
export const FX_SOURCE = { name: "Exchange Rate API", url: "https://www.exchangerate-api.com" } as const;

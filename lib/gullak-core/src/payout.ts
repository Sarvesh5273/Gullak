/**
 * Cash-out destinations. Testnet only simulates the bank-side payout; the
 * redeem leg (AUSD back through Agora Instant Settlement) is real on-chain.
 * We validate the UPI ID but only ever store and show a masked form.
 */

/** UPI virtual payment address: `name@bank` (NPCI format, loosely). */
const UPI_RE = /^[a-zA-Z0-9._-]{2,64}@[a-zA-Z][a-zA-Z0-9]{1,31}$/;

export function normalizeUpiId(input: string): string {
  return input.trim().toLowerCase();
}

/** A human sentence when the UPI ID is unusable, else null. */
export function upiIdProblem(input: string): string | null {
  const v = normalizeUpiId(input);
  if (!v) return "Enter a UPI ID, like name@okhdfc.";
  if (!v.includes("@")) return "A UPI ID has an @, like name@okhdfc.";
  if (!UPI_RE.test(v)) return "That doesn't look like a UPI ID.";
  return null;
}

/** `mother.sharma@okhdfc` -> `mo•••@okhdfc` */
export function maskUpiId(input: string): string {
  const [name = "", bank = ""] = normalizeUpiId(input).split("@");
  return `${name.slice(0, 2)}•••@${bank}`;
}

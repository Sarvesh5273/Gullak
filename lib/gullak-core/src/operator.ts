import { keccak256, stringToBytes, type Hex } from "viem";

export type OperatorKeySource = "OPERATOR_PRIVATE_KEY" | "SESSION_SECRET";

export type OperatorKeyResult =
  | { ok: true; privateKey: Hex; source: OperatorKeySource }
  | { ok: false; problem: string };

/**
 * Resolves the server-side operator key (gas sponsor + add-money desk).
 * Server and admin scripts only; never called by the app.
 *
 * 1. OPERATOR_PRIVATE_KEY secret, when set.
 * 2. Otherwise derived from the SESSION_SECRET secret with a fixed label, so a
 *    fresh project has a stable operator address without handling a raw key.
 *    Rotating SESSION_SECRET therefore changes the operator address.
 */
export function resolveOperatorKey(env: Record<string, string | undefined>): OperatorKeyResult {
  const explicit = env["OPERATOR_PRIVATE_KEY"]?.trim();
  if (explicit) {
    const hex = explicit.startsWith("0x") ? explicit : `0x${explicit}`;
    if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) {
      return { ok: false, problem: "OPERATOR_PRIVATE_KEY is not a 32-byte hex key." };
    }
    return { ok: true, privateKey: hex as Hex, source: "OPERATOR_PRIVATE_KEY" };
  }
  const sessionSecret = env["SESSION_SECRET"];
  if (sessionSecret && sessionSecret.length >= 32) {
    return {
      ok: true,
      privateKey: keccak256(stringToBytes(`gullak/operator-key/v1:${sessionSecret}`)),
      source: "SESSION_SECRET",
    };
  }
  return { ok: false, problem: "No operator key: set the OPERATOR_PRIVATE_KEY secret (or SESSION_SECRET)." };
}

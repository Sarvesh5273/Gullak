import { getAddress, hexToString, isAddress, isHex, stringToHex, type Address, type Hex } from "viem";

/**
 * Gullak API sign-in tokens.
 *
 * The client's in-memory signing session signs a short, human-readable
 * statement (EIP-191). The server recovers the signer and trusts the address
 * until the statement expires. Tokens only identify the caller; they cannot
 * move money. Every transfer carries its own EIP-3009 signature.
 */

export const AUTH_TOKEN_PREFIX = "gullak1";
export const AUTH_TOKEN_TTL_SECONDS = 15 * 60;
export const AUTH_MAX_TTL_SECONDS = 30 * 60;
export const AUTH_CLOCK_SKEW_SECONDS = 120;

export type AuthClaims = {
  address: Address;
  audience: string;
  issuedAt: Date;
  expiresAt: Date;
  nonce: string;
};

const HEADER = "Gullak sign-in";
const NOTICE = "This proves you control this Gullak account. It cannot move money.";

export function buildAuthMessage(claims: AuthClaims): string {
  return [
    HEADER,
    "",
    NOTICE,
    "",
    `Address: ${claims.address}`,
    `Audience: ${claims.audience}`,
    `Issued At: ${claims.issuedAt.toISOString()}`,
    `Expires At: ${claims.expiresAt.toISOString()}`,
    `Nonce: ${claims.nonce}`,
  ].join("\n");
}

/** Strict inverse of buildAuthMessage. Returns null on any deviation. */
export function parseAuthMessage(message: string): AuthClaims | null {
  const lines = message.split("\n");
  if (lines.length !== 9) return null;
  if (lines[0] !== HEADER || lines[1] !== "" || lines[2] !== NOTICE || lines[3] !== "") return null;

  const field = (line: string, name: string): string | null =>
    line.startsWith(`${name}: `) ? line.slice(name.length + 2) : null;

  const address = field(lines[4], "Address");
  const audience = field(lines[5], "Audience");
  const issuedAt = field(lines[6], "Issued At");
  const expiresAt = field(lines[7], "Expires At");
  const nonce = field(lines[8], "Nonce");
  if (!address || !audience || !issuedAt || !expiresAt || !nonce) return null;
  if (!isAddress(address, { strict: false })) return null;
  if (!/^[a-z0-9.-]{1,253}(:\d{1,5})?$/i.test(audience)) return null;
  if (!/^[0-9a-f]{32}$/.test(nonce)) return null;

  const issued = new Date(issuedAt);
  const expires = new Date(expiresAt);
  if (Number.isNaN(issued.getTime()) || Number.isNaN(expires.getTime())) return null;
  if (issued.toISOString() !== issuedAt || expires.toISOString() !== expiresAt) return null;

  return { address: getAddress(address), audience, issuedAt: issued, expiresAt: expires, nonce };
}

export function encodeAuthToken(message: string, signature: Hex): string {
  return `${AUTH_TOKEN_PREFIX}.${stringToHex(message).slice(2)}.${signature.slice(2)}`;
}

export function decodeAuthToken(token: string): { message: string; signature: Hex } | null {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== AUTH_TOKEN_PREFIX) return null;
  const messageHex = `0x${parts[1]}`;
  const signature = `0x${parts[2]}`;
  if (parts[1].length === 0 || parts[1].length > 2048 || !isHex(messageHex, { strict: true })) return null;
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) return null;
  return { message: hexToString(messageHex as Hex), signature: signature as Hex };
}

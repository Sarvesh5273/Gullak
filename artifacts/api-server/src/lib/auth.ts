import type { NextFunction, Request, Response } from "express";
import { recoverMessageAddress, type Address } from "viem";
import {
  AUTH_CLOCK_SKEW_SECONDS,
  AUTH_MAX_TTL_SECONDS,
  decodeAuthToken,
  parseAuthMessage,
} from "@workspace/gullak-core";
import { sendError } from "./http";

/** Hosts a sign-in statement may name as its audience: this deployment's domains. */
function allowedAudiences(): Set<string> {
  const hosts = [
    ...(process.env["REPLIT_DOMAINS"] ?? "").split(","),
    process.env["REPLIT_DEV_DOMAIN"] ?? "",
    ...(process.env["AUTH_EXTRA_AUDIENCES"] ?? "").split(","),
  ]
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return new Set(hosts);
}

const audiences = allowedAudiences();

type VerifyResult = { ok: true; address: Address } | { ok: false; reason: string };

/** Recently verified tokens, so polling does not re-run ecrecover every time. */
const verified = new Map<string, { address: Address; expiresAt: number }>();
const MAX_CACHED = 5_000;

export async function verifyAuthToken(token: string): Promise<VerifyResult> {
  const cached = verified.get(token);
  if (cached) {
    if (cached.expiresAt > Date.now()) return { ok: true, address: cached.address };
    verified.delete(token);
  }

  const decoded = decodeAuthToken(token);
  if (!decoded) return { ok: false, reason: "Malformed sign-in token." };
  const claims = parseAuthMessage(decoded.message);
  if (!claims) return { ok: false, reason: "Unrecognised sign-in statement." };

  if (!audiences.has(claims.audience.toLowerCase())) {
    return { ok: false, reason: "Sign-in statement is for a different site." };
  }
  const now = Date.now();
  const skew = AUTH_CLOCK_SKEW_SECONDS * 1000;
  if (claims.issuedAt.getTime() > now + skew) return { ok: false, reason: "Sign-in statement is from the future." };
  if (claims.expiresAt.getTime() <= now) return { ok: false, reason: "Sign-in expired." };
  if (claims.expiresAt.getTime() - claims.issuedAt.getTime() > AUTH_MAX_TTL_SECONDS * 1000) {
    return { ok: false, reason: "Sign-in statement lasts too long." };
  }

  let signer: Address;
  try {
    signer = await recoverMessageAddress({ message: decoded.message, signature: decoded.signature });
  } catch {
    return { ok: false, reason: "Bad signature." };
  }
  if (signer.toLowerCase() !== claims.address.toLowerCase()) return { ok: false, reason: "Bad signature." };

  if (verified.size >= MAX_CACHED) verified.clear();
  verified.set(token, { address: claims.address, expiresAt: claims.expiresAt.getTime() });
  return { ok: true, address: claims.address };
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) {
    sendError(res, 401, "unauthorized", "Sign in to continue.");
    return;
  }
  const result = await verifyAuthToken(token);
  if (!result.ok) {
    sendError(res, 401, "unauthorized", result.reason);
    return;
  }
  res.locals["address"] = result.address;
  next();
}

/** The signed-in account. Only valid on routes behind requireAuth. */
export function authAddress(res: Response): Address {
  const address = res.locals["address"] as Address | undefined;
  if (!address) throw new Error("authAddress used on a route without requireAuth");
  return address;
}

import type { Response } from "express";
import { and, eq, gt, sql } from "drizzle-orm";
import { getAddress, verifyTypedData, type Address, type Hex } from "viem";
import { db, transfersTable, type TransferRow } from "@workspace/db";
import type { ActivityItem } from "@workspace/api-zod";
import {
  AUSD_EIP712_DOMAIN,
  LIMITS,
  SPONSOR_POLICY,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  formatUsd,
} from "@workspace/gullak-core";
import {
  ChainSubmitError,
  getAusdBalance,
  isAuthorizationUsed,
  type TransferAuthorization,
} from "./chain";
import { toActivityItems } from "./activity";
import { sendError } from "./http";
import type { DriveResult } from "./settlement";

/** Shared by the money routes: daily-limit queries, ledger updates, and EIP-3009 checks. */

export const ONE_DAY_AGO = sql`now() - interval '24 hours'`;

type Where = ReturnType<typeof and>;

export async function sumSince(where: Where): Promise<bigint> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${transfersTable.amount}), 0)::text` })
    .from(transfersTable)
    .where(where);
  return BigInt(row?.total ?? "0");
}

export async function countSince(where: Where): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(transfersTable).where(where);
  return row?.n ?? 0;
}

/**
 * Sponsored on-chain transactions in the last 24h, any kind and status (a
 * reverted one still paid gas). A cash-out is two transactions (three with a refund). Checked before
 * every money action so the gas sponsor's daily burn stays bounded however
 * many accounts exist.
 */
export async function sponsorCapReached(): Promise<boolean> {
  const [row] = await db
    .select({
      n: sql<number>`coalesce(sum(case when ${transfersTable.kind} = 'cashout' then 2 else 1 end + case when ${transfersTable.refundTxHash} is not null then 1 else 0 end), 0)::int`,
    })
    .from(transfersTable)
    .where(gt(transfersTable.createdAt, ONE_DAY_AGO));
  return (row?.n ?? 0) >= SPONSOR_POLICY.dailyTxCap;
}

export const SPONSOR_CAP_MESSAGE = "Gullak's free transactions are used up for today. Try again tomorrow.";

export function failureMessage(err: unknown): { status: number; code: string; message: string } {
  if (err instanceof ChainSubmitError) {
    if (err.code === "sponsor_out_of_gas") {
      return { status: 503, code: "sponsor_unavailable", message: "Gullak's gas sponsor is out of test MON. No money moved." };
    }
    if (err.code === "simulation_failed" || err.code === "reverted") {
      return { status: 502, code: "rejected_by_chain", message: "The network rejected this transaction. No money moved." };
    }
  }
  return { status: 502, code: "chain_error", message: "The network did not take this transaction. No money moved." };
}

/** The row a signed authorization already created; retries reuse the same authorization. */
export async function findByAuthorization(from: Address, nonce: Hex): Promise<TransferRow | null> {
  const [row] = await db
    .select()
    .from(transfersTable)
    .where(and(eq(transfersTable.fromAddress, from), eq(transfersTable.authNonce, nonce)));
  return row ?? null;
}

/**
 * Answers a money request. Anything where money moved, or may still move, is
 * answered with the ledger item (201 settled, 202 still settling, 200 an
 * earlier result for a retried authorization) so the app can show the
 * receipt. Errors mean no money moved.
 */
export async function respondWithResult(
  res: Response,
  viewer: Address,
  { row, error }: DriveResult,
  opts: { created: boolean; parse: (item: ActivityItem) => unknown },
): Promise<void> {
  if (row.status === "failed" && (row.stage === "transfer" || row.stage === "deliver")) {
    const f = failureMessage(error);
    sendError(res, f.status, f.code, f.message);
    return;
  }
  const [item] = await toActivityItems([row], viewer);
  const status = row.status === "pending" ? 202 : opts.created ? 201 : 200;
  res.status(status).json(opts.parse(item));
}

export type AuthorizationInput = {
  from: string;
  to: string;
  value: string;
  validAfter: number;
  validBefore: number;
  nonce: string;
  signature: string;
};

export type AuthorizationCheck =
  | { ok: true; auth: TransferAuthorization }
  | { ok: false; status: number; code: string; message: string };

/**
 * Checks a member-signed EIP-3009 authorization before Gullak spends gas on it:
 * it must come from the signed-in member, have an acceptable time window, and
 * carry a valid signature. Destination rules are up to each route.
 */
export async function checkAuthorization(input: AuthorizationInput, me: Address): Promise<AuthorizationCheck> {
  const from = getAddress(input.from);
  const to = getAddress(input.to);
  const value = BigInt(input.value);
  const validAfter = BigInt(input.validAfter);
  const validBefore = BigInt(input.validBefore);
  const nonce = input.nonce.toLowerCase() as Hex;
  const signature = input.signature as Hex;
  const now = BigInt(Math.floor(Date.now() / 1000));

  if (from !== me) {
    return { ok: false, status: 400, code: "from_mismatch", message: "You can only send from your own account." };
  }
  if (validAfter > now || validBefore <= now + 30n || validBefore > now + BigInt(LIMITS.maxTransferValiditySeconds)) {
    return { ok: false, status: 400, code: "bad_validity", message: "This authorization's time window is not acceptable. Try again." };
  }
  const signatureOk = await verifyTypedData({
    address: from,
    domain: AUSD_EIP712_DOMAIN,
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: { from, to, value, validAfter, validBefore, nonce },
    signature,
  }).catch(() => false);
  if (!signatureOk) {
    return { ok: false, status: 400, code: "bad_signature", message: "The transfer signature does not match." };
  }
  return { ok: true, auth: { from, to, value, validAfter, validBefore, nonce, signature } };
}

/**
 * Chain pre-flight for an authorization: not already used, and the member can
 * cover it. Returns null when it's fine to relay.
 */
export async function preflightAuthorization(
  auth: TransferAuthorization,
): Promise<{ status: number; code: string; message: string; err?: unknown } | null> {
  try {
    const [balance, used] = await Promise.all([getAusdBalance(auth.from), isAuthorizationUsed(auth.from, auth.nonce)]);
    if (used) return { status: 409, code: "nonce_used", message: "This transfer was already submitted." };
    if (balance < auth.value) {
      return { status: 422, code: "insufficient_funds", message: `Your balance is ${formatUsd(balance)}.` };
    }
    return null;
  } catch (err) {
    return { status: 502, code: "rpc_error", message: "Could not reach Monad. Try again.", err };
  }
}

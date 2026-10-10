import { Router, type IRouter } from "express";
import { and, eq, gt, inArray } from "drizzle-orm";
import { getAddress } from "viem";
import { db, membersTable, transfersTable } from "@workspace/db";
import { CreateCashoutBody, CreateCashoutResponse } from "@workspace/api-zod";
import { LIMITS, PAYOUT_CURRENCY, formatUsd, maskUpiId, upiIdProblem } from "@workspace/gullak-core";
import { fxColumns } from "../lib/fx";
import { authAddress, requireAuth } from "../lib/auth";
import { getSponsorStatus, operatorAddress } from "../lib/chain";
import { byAccount, byIp, isUniqueViolation, rateLimit, sendError } from "../lib/http";
import {
  ONE_DAY_AGO,
  SPONSOR_CAP_MESSAGE,
  checkAuthorization,
  countSince,
  findByAuthorization,
  preflightAuthorization,
  respondWithResult,
  sponsorCapReached,
} from "../lib/ledger";
import { LEASE_ON_INSERT, claim, drive, isRetryable, rearm, testFaults } from "../lib/settlement";

/**
 * UPI payouts: cash out to your own UPI ID, or send to someone else's (Send to UPI).
 * Testnet mock of Agora's redeem route, as one ledger row driven through stages:
 *   1. transfer: the member's signed EIP-3009 authorization moves AUSD to the Gullak desk (gasless relay);
 *   2. settle: the desk swaps that AUSD for CTK (Agora's test token) on the Instant Settlement pair;
 *   3. the bank-side rupee payout to the UPI ID is simulated and given a reference.
 * If step 2 fails after step 1 landed, the desk returns the AUSD (refund), and
 * the row says "refunded" only once that transaction is mined.
 */
const router: IRouter = Router();

const cashoutLimitAccount = rateLimit({ name: "cashout-account", limit: 3, windowMs: 60_000, key: byAccount });
const cashoutLimitIp = rateLimit({ name: "cashout-ip", limit: 10, windowMs: 60_000, key: byIp });

const clean = (text: string | undefined, max: number): string | null =>
  text?.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) || null;

router.post("/cashouts", requireAuth, cashoutLimitAccount, cashoutLimitIp, async (req, res): Promise<void> => {
  const body = CreateCashoutBody.safeParse(req.body);
  if (!body.success) {
    sendError(res, 400, "bad_request", body.error.message);
    return;
  }
  const me = authAddress(res);
  const upiProblem = upiIdProblem(body.data.upiId);
  if (upiProblem) {
    sendError(res, 422, "bad_upi_id", upiProblem);
    return;
  }
  const recipientName = clean(body.data.recipientName, 40);
  const note = clean(body.data.note, 140);
  const desk = operatorAddress();
  if (!desk) {
    sendError(res, 503, "sponsor_unavailable", "Payouts are not available right now.");
    return;
  }

  const checked = await checkAuthorization(body.data, me);
  if (!checked.ok) {
    sendError(res, checked.status, checked.code, checked.message);
    return;
  }
  const auth = checked.auth;
  if (auth.to !== getAddress(desk)) {
    sendError(res, 400, "bad_destination", "Payouts must be paid to the Gullak desk.");
    return;
  }
  if (auth.value > LIMITS.maxCashoutUnits) {
    sendError(res, 422, "over_cashout_limit", `Pay out up to ${formatUsd(LIMITS.maxCashoutUnits)} at a time.`);
    return;
  }

  const [member] = await db
    .select({ address: membersTable.address })
    .from(membersTable)
    .where(eq(membersTable.address, me));
  if (!member) {
    sendError(res, 404, "not_registered", "Finish setting up your profile first.");
    return;
  }

  // A retry carries the same signed authorization: answer with what it already did.
  const existing = await findByAuthorization(auth.from, auth.nonce);
  if (existing && (existing.kind !== "cashout" || existing.amount !== auth.value.toString())) {
    sendError(res, 409, "nonce_used", "This payout was already submitted.");
    return;
  }
  if (existing && !isRetryable(existing)) {
    const claimed = existing.status === "pending" ? await claim(existing.id) : null;
    const result = claimed ? await drive(claimed, { auth }) : { row: existing };
    await respondWithResult(res, me, result, { created: false, parse: (i) => CreateCashoutResponse.parse(i) });
    return;
  }

  const [myCount, capReached] = await Promise.all([
    countSince(
      and(
        eq(transfersTable.kind, "cashout"),
        eq(transfersTable.fromAddress, me),
        inArray(transfersTable.status, ["pending", "confirmed"]),
        gt(transfersTable.createdAt, ONE_DAY_AGO),
      ),
    ),
    sponsorCapReached(),
  ]);
  if (myCount >= LIMITS.dailyCashoutCount) {
    sendError(res, 422, "over_daily_count", `You can make up to ${LIMITS.dailyCashoutCount} UPI payouts a day.`);
    return;
  }
  if (capReached) {
    sendError(res, 503, "sponsor_daily_cap", SPONSOR_CAP_MESSAGE);
    return;
  }

  const sponsor = await getSponsorStatus();
  if (!sponsor.relayReady) {
    sendError(res, 503, "sponsor_unavailable", sponsor.problem ?? "Payouts are not available right now.");
    return;
  }
  const problem = await preflightAuthorization(auth);
  if (problem) {
    if (problem.err) req.log.warn({ err: problem.err }, "Pre-flight chain read failed");
    sendError(res, problem.status, problem.code, problem.message);
    return;
  }

  let row;
  if (existing) {
    row = await rearm(existing.id);
  } else {
    const fx = await fxColumns(PAYOUT_CURRENCY);
    try {
      [row] = await db
        .insert(transfersTable)
        .values({
          ...fx,
          kind: "cashout",
          stage: "transfer",
          fromAddress: auth.from,
          toAddress: auth.to,
          amount: auth.value.toString(),
          authNonce: auth.nonce,
          validBefore: new Date(Number(auth.validBefore) * 1000),
          payoutTo: `UPI ${maskUpiId(body.data.upiId)}`,
          payoutName: recipientName,
          note,
          leaseUntil: LEASE_ON_INSERT,
        })
        .returning();
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }
  if (!row) {
    sendError(res, 409, "in_progress", "This payout is already being processed.");
    return;
  }

  const result = await drive(row, { auth, faults: testFaults(req) });
  if (result.error) req.log.warn({ err: result.error, transferId: row.id, stage: result.row.stage }, "Payout did not complete in-request");
  await respondWithResult(res, me, result, { created: !existing, parse: (i) => CreateCashoutResponse.parse(i) });
});

export default router;

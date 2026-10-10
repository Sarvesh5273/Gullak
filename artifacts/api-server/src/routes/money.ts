import { Router, type IRouter } from "express";
import { and, desc, eq, gt, inArray, or } from "drizzle-orm";
import { type Address } from "viem";
import { db, membersTable, transfersTable } from "@workspace/db";
import {
  CreateDepositBody,
  CreateDepositResponse,
  CreateTransferBody,
  CreateTransferResponse,
  GetActivityItemParams,
  GetActivityItemResponse,
  GetMyBalanceResponse,
  ListMyActivityQueryParams,
  ListMyActivityResponse,
} from "@workspace/api-zod";
import { LIMITS, SETTLEMENT_PAIR_ADDRESS, currencyForCountry, formatUsd } from "@workspace/gullak-core";
import { fxColumns } from "../lib/fx";
import { authAddress, requireAuth } from "../lib/auth";
import { getAusdBalance, getSponsorStatus } from "../lib/chain";
import { canView, isOwner, toActivityItems } from "../lib/activity";
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
  sumSince,
} from "../lib/ledger";
import { LEASE_ON_INSERT, claim, drive, isRetryable, rearm, reconcile } from "../lib/settlement";

const router: IRouter = Router();

const sendLimitAccount = rateLimit({ name: "send-account", limit: 6, windowMs: 60_000, key: byAccount });
const sendLimitIp = rateLimit({ name: "send-ip", limit: 20, windowMs: 60_000, key: byIp });
const depositLimitAccount = rateLimit({ name: "deposit-account", limit: 5, windowMs: 60 * 60_000, key: byAccount });
const depositLimitIp = rateLimit({ name: "deposit-ip", limit: 10, windowMs: 60 * 60_000, key: byIp });

/** Total the add-money desk will hand out across all accounts per rolling 24h. */
const DESK_DAILY_CAP_UNITS = LIMITS.dailyDepositUnits * 20n;

router.get("/me/balance", requireAuth, async (req, res): Promise<void> => {
  const address = authAddress(res);
  try {
    const amount = await getAusdBalance(address);
    res.json(GetMyBalanceResponse.parse({ address, amount: amount.toString() }));
  } catch (err) {
    req.log.warn({ err }, "Balance read failed");
    sendError(res, 502, "rpc_error", "Could not read your balance from Monad. Try again.");
  }
});

router.get("/me/activity", requireAuth, async (req, res): Promise<void> => {
  const query = ListMyActivityQueryParams.safeParse(req.query);
  if (!query.success) {
    sendError(res, 400, "bad_request", query.error.message);
    return;
  }
  const viewer = authAddress(res);
  const rows = await db
    .select()
    .from(transfersTable)
    .where(
      or(
        eq(transfersTable.fromAddress, viewer),
        and(
          eq(transfersTable.toAddress, viewer),
          or(eq(transfersTable.status, "confirmed"), eq(transfersTable.kind, "deposit")),
        ),
      ),
    )
    .orderBy(desc(transfersTable.createdAt))
    .limit(query.data.limit ?? 50);
  // Nudge any of the viewer's unfinished money movements along; the receipt screen awaits its own.
  for (const row of rows.filter((r) => r.status === "pending" && isOwner(r, viewer)).slice(0, 3)) {
    reconcile(row.id).catch((err) => req.log.error({ err, transferId: row.id }, "Reconcile failed"));
  }
  res.json(ListMyActivityResponse.parse(await toActivityItems(rows, viewer)));
});

router.get("/activity/:id", requireAuth, async (req, res): Promise<void> => {
  const params = GetActivityItemParams.safeParse(req.params);
  if (!params.success) {
    sendError(res, 400, "bad_request", params.error.message);
    return;
  }
  const viewer = authAddress(res);
  let [row] = await db.select().from(transfersTable).where(eq(transfersTable.id, params.data.id));
  if (!row || !canView(row, viewer)) {
    sendError(res, 404, "not_found", "Not found.");
    return;
  }
  if (row.status === "pending" && isOwner(row, viewer)) {
    // An interrupted or slow movement: settle what the chain already decided.
    row = (await reconcile(row.id)) ?? row;
  }
  const [item] = await toActivityItems([row], viewer);
  res.json(GetActivityItemResponse.parse(item));
});

router.post("/transfers", requireAuth, sendLimitAccount, sendLimitIp, async (req, res): Promise<void> => {
  const body = CreateTransferBody.safeParse(req.body);
  if (!body.success) {
    sendError(res, 400, "bad_request", body.error.message);
    return;
  }
  const me = authAddress(res);
  const note = body.data.note?.replace(/[\u0000-\u001f\u007f]/g, " ").trim() || null;
  const checked = await checkAuthorization(body.data, me);
  if (!checked.ok) {
    sendError(res, checked.status, checked.code, checked.message);
    return;
  }
  const auth = checked.auth;
  const { from, to, value, nonce } = auth;
  if (to === from) {
    sendError(res, 400, "self_transfer", "You can't send money to yourself.");
    return;
  }
  if (value > LIMITS.maxSendUnits) {
    sendError(res, 422, "over_send_limit", `Sends are limited to ${formatUsd(LIMITS.maxSendUnits)} each.`);
    return;
  }

  const [recipient] = await db
    .select({ address: membersTable.address, country: membersTable.country })
    .from(membersTable)
    .where(eq(membersTable.address, to));
  if (!recipient) {
    sendError(res, 404, "recipient_not_found", "Gullak only relays sends to Gullak members.");
    return;
  }

  // A retry carries the same signed authorization: answer with what it already did.
  const existing = await findByAuthorization(from, nonce);
  if (existing && (existing.kind !== "send" || existing.toAddress !== to || existing.amount !== value.toString())) {
    sendError(res, 409, "nonce_used", "This transfer was already submitted.");
    return;
  }
  if (existing && !isRetryable(existing)) {
    const claimed = existing.status === "pending" ? await claim(existing.id) : null;
    const result = claimed ? await drive(claimed, { auth }) : { row: existing };
    await respondWithResult(res, me, result, { created: false, parse: (i) => CreateTransferResponse.parse(i) });
    return;
  }

  const mySendsToday = and(
    eq(transfersTable.kind, "send"),
    eq(transfersTable.fromAddress, from),
    inArray(transfersTable.status, ["pending", "confirmed"]),
    gt(transfersTable.createdAt, ONE_DAY_AGO),
  );
  const [sentToday, sendsToday, capReached] = await Promise.all([
    sumSince(mySendsToday),
    countSince(mySendsToday),
    sponsorCapReached(),
  ]);
  if (sentToday + value > LIMITS.dailySendUnits) {
    sendError(res, 422, "over_daily_limit", `Daily sending limit is ${formatUsd(LIMITS.dailySendUnits)}.`);
    return;
  }
  if (sendsToday >= LIMITS.dailySendCount) {
    sendError(res, 422, "over_daily_count", `You can make up to ${LIMITS.dailySendCount} sends a day.`);
    return;
  }
  if (capReached) {
    sendError(res, 503, "sponsor_daily_cap", SPONSOR_CAP_MESSAGE);
    return;
  }

  const sponsor = await getSponsorStatus();
  if (!sponsor.relayReady) {
    sendError(res, 503, "sponsor_unavailable", sponsor.problem ?? "Gas sponsorship is not available right now.");
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
    const fx = await fxColumns(currencyForCountry(recipient.country));
    try {
      [row] = await db
        .insert(transfersTable)
        .values({
          ...fx,
          kind: "send",
          stage: "transfer",
          fromAddress: from,
          toAddress: to,
          amount: value.toString(),
          note,
          authNonce: nonce,
          validBefore: new Date(Number(auth.validBefore) * 1000),
          leaseUntil: LEASE_ON_INSERT,
        })
        .returning();
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }
  if (!row) {
    sendError(res, 409, "in_progress", "This transfer is already being processed.");
    return;
  }

  const result = await drive(row, { auth });
  if (result.row.status === "failed") req.log.error({ err: result.error, transferId: row.id }, "Relay failed");
  await respondWithResult(res, me, result, { created: !existing, parse: (i) => CreateTransferResponse.parse(i) });
});

router.post("/deposits", requireAuth, depositLimitAccount, depositLimitIp, async (req, res): Promise<void> => {
  const body = CreateDepositBody.safeParse(req.body);
  if (!body.success) {
    sendError(res, 400, "bad_request", body.error.message);
    return;
  }
  const me: Address = authAddress(res);
  const amount = BigInt(body.data.amount);
  if (amount > LIMITS.maxDepositUnits) {
    sendError(res, 422, "over_deposit_limit", `Add up to ${formatUsd(LIMITS.maxDepositUnits)} at a time.`);
    return;
  }

  const [member] = await db
    .select({ address: membersTable.address, country: membersTable.country })
    .from(membersTable)
    .where(eq(membersTable.address, me));
  if (!member) {
    sendError(res, 404, "not_registered", "Finish setting up your profile first.");
    return;
  }

  const live = inArray(transfersTable.status, ["pending", "confirmed"]);
  const myDepositsToday = and(eq(transfersTable.kind, "deposit"), eq(transfersTable.toAddress, me), live, gt(transfersTable.createdAt, ONE_DAY_AGO));
  const [mine, myCount, everyone, capReached] = await Promise.all([
    sumSince(myDepositsToday),
    countSince(myDepositsToday),
    sumSince(and(eq(transfersTable.kind, "deposit"), live, gt(transfersTable.createdAt, ONE_DAY_AGO))),
    sponsorCapReached(),
  ]);
  if (mine + amount > LIMITS.dailyDepositUnits) {
    sendError(res, 422, "over_daily_limit", `You can add up to ${formatUsd(LIMITS.dailyDepositUnits)} per day.`);
    return;
  }
  if (myCount >= LIMITS.dailyDepositCount) {
    sendError(res, 422, "over_daily_count", `You can add money up to ${LIMITS.dailyDepositCount} times a day.`);
    return;
  }
  if (everyone + amount > DESK_DAILY_CAP_UNITS) {
    sendError(res, 503, "desk_daily_cap", "Add-money is paused for today. Try again tomorrow.");
    return;
  }
  if (capReached) {
    sendError(res, 503, "sponsor_daily_cap", SPONSOR_CAP_MESSAGE);
    return;
  }

  const sponsor = await getSponsorStatus();
  if (!sponsor.depositReady || BigInt(sponsor.depositInventory ?? "0") < amount) {
    sendError(res, 503, "desk_unavailable", sponsor.problem ?? "Add-money is not available right now.");
    return;
  }

  const fx = await fxColumns(currencyForCountry(member.country));
  const [row] = await db
    .insert(transfersTable)
    .values({
      ...fx,
      kind: "deposit",
      stage: "deliver",
      fromAddress: SETTLEMENT_PAIR_ADDRESS,
      toAddress: me,
      amount: amount.toString(),
      leaseUntil: LEASE_ON_INSERT,
    })
    .returning();

  const result = await drive(row, { deliver: { to: me, amount } });
  if (result.row.status === "failed") req.log.error({ err: result.error, transferId: row.id }, "Deposit failed");
  await respondWithResult(res, me, result, { created: true, parse: (i) => CreateDepositResponse.parse(i) });
});

export default router;

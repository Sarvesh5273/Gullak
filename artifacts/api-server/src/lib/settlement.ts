import { randomBytes } from "node:crypto";
import type { Request } from "express";
import { and, asc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { getAddress, type Address, type Hex } from "viem";
import { db, transfersTable, type InsertTransfer, type TransferRow } from "@workspace/db";
import {
  ChainSubmitError,
  deliverDeposit,
  isAmbiguous,
  OPERATOR_PAUSED_MESSAGE,
  operatorWritesPaused,
  redeemToDesk,
  refundFromDesk,
  relayTransfer,
  txOutcome,
  type SettledTx,
  type SubmitHooks,
  type TransferAuthorization,
} from "./chain";
import { logger } from "./logger";

/**
 * Drives a ledger row through its operator transactions (see TRANSFER_STAGES)
 * and resolves interrupted ones from the chain.
 *
 * Guarantees:
 * - Every operator transaction is recorded (hash, nonce, signed bytes) before
 *   broadcast, so a crash or timeout leaves enough to find out what happened.
 * - A row only becomes `failed` at the transfer/deliver stage when nothing can
 *   land any more (simulation failed, reverted, or its nonce went to another
 *   transaction). Otherwise it stays `pending` until the chain says.
 * - "Refunded" is recorded only after the refund transaction is mined.
 * - At most one unresolved operator transaction per row, and no decision on a
 *   stale view: recording a signed transaction and every stage change are
 *   compare-and-set writes on (status, stage, that stage's recorded hash).
 *   Nothing is broadcast unless the record write wins. A driver whose view is
 *   stale (say its lease expired while it waited in the queue) is superseded
 *   and stops, so a swap or refund can never be sent twice for one row, and a
 *   landed swap can't be "refunded" by someone who didn't see it.
 * - The DB lease (120 s) keeps one driver per row in normal operation, so a
 *   request and the background reconciler don't race. After a crash the
 *   lease simply expires and the reconciler picks the row up.
 */

const LEASE = sql`now() + interval '120 seconds'`;
const MAX_REFUND_BROADCASTS = 3;

export const MESSAGES = {
  notSent: "The network did not accept this transfer. No money moved.",
  notCashedOut: "This payout did not go through. No money moved.",
  refunded: "The payout didn't go through, so your money was returned.",
} as const;

/**
 * Dev-only fault injection for the on-chain recovery checks (smoke test and
 * restart check). The crash faults kill this process with SIGKILL at the
 * named point, like a power cut: no cleanup, no lease release.
 */
const TEST_FAULTS = [
  "settle-fails",
  "stop-after-transfer",
  "crash-after-transfer-broadcast",
  "crash-before-settle-broadcast",
  "crash-after-settle-broadcast",
  "crash-after-refund-broadcast",
] as const;
export type TestFault = (typeof TEST_FAULTS)[number];
const NO_FAULTS: ReadonlySet<TestFault> = new Set();

/** Reads the comma-separated `x-gullak-test-fault` header; always empty in production. */
export function testFaults(req: Request): ReadonlySet<TestFault> {
  if (process.env["NODE_ENV"] === "production") return NO_FAULTS;
  const values = (req.get("x-gullak-test-fault") ?? "").split(",").map((v) => v.trim());
  return new Set(TEST_FAULTS.filter((f) => values.includes(f)));
}

function crashForTest(point: string): void {
  if (process.env["NODE_ENV"] === "production") return;
  // Pipes to the workflow log are synchronous on Linux, so this line lands before the kill.
  process.stderr.write(`TEST FAULT: killing the API server (SIGKILL) ${point}\n`);
  process.kill(process.pid, "SIGKILL");
}

export type DriveOptions = {
  /** The member's signed authorization. Only a request holding it can broadcast the transfer stage. */
  auth?: TransferAuthorization;
  /** Only the original add-money request may broadcast a delivery; recovery never re-delivers. */
  deliver?: { to: Address; amount: bigint };
  faults?: ReadonlySet<TestFault>;
};

export type DriveResult = { row: TransferRow; error?: unknown };

type Leg = "transfer" | "deliver" | "settle" | "refund";

type LegOutcome =
  | { kind: "landed"; blockNumber: bigint; settleMs: number | null }
  | { kind: "failed"; error: unknown }
  | { kind: "pending"; error?: unknown }
  | { kind: "superseded" };

function hashColumn(leg: Leg, hash: string | null): Partial<InsertTransfer> {
  if (leg === "settle") return { settlementTxHash: hash };
  if (leg === "refund") return { refundTxHash: hash };
  return { txHash: hash };
}

function legHash(row: TransferRow, leg: Leg): string | null {
  if (leg === "settle") return row.settlementTxHash;
  if (leg === "refund") return row.refundTxHash;
  return row.txHash;
}

function hashField(leg: Leg) {
  if (leg === "settle") return transfersTable.settlementTxHash;
  if (leg === "refund") return transfersTable.refundTxHash;
  return transfersTable.txHash;
}

/** Thrown when the row moved on under this driver; it stops without writing. */
class Superseded extends Error {
  constructor(readonly leg: Leg) {
    super(`Superseded at ${leg}`);
  }
}

/**
 * Applies a stage change only if the row is exactly as this driver last saw
 * it: still pending, same stage, same recorded transaction for that stage.
 */
async function advance(seen: TransferRow, set: Partial<InsertTransfer>): Promise<TransferRow> {
  const leg = seen.stage as Leg;
  const hash = legHash(seen, leg);
  const [row] = await db
    .update(transfersTable)
    .set(set)
    .where(
      and(
        eq(transfersTable.id, seen.id),
        eq(transfersTable.status, "pending"),
        eq(transfersTable.stage, seen.stage),
        hash === null ? isNull(hashField(leg)) : eq(hashField(leg), hash),
      ),
    )
    .returning();
  if (!row) throw new Superseded(leg);
  return row;
}

/**
 * Records the signed transaction for this stage before it is broadcast. The
 * write only succeeds if the row is still pending at this stage with nothing
 * recorded or in flight; otherwise another driver got there first and this
 * transaction is never sent.
 */
function recordSigned(
  id: string,
  leg: Leg,
  faults: ReadonlySet<TestFault>,
  onRecorded: (row: TransferRow) => void,
): SubmitHooks {
  return {
    onSigned: async (tx) => {
      const [row] = await db
        .update(transfersTable)
        .set({
          ...hashColumn(leg, tx.hash),
          inflight: { nonce: tx.nonce, raw: tx.raw, signedAt: Date.now() },
          leaseUntil: LEASE,
        })
        .where(
          and(
            eq(transfersTable.id, id),
            eq(transfersTable.status, "pending"),
            eq(transfersTable.stage, leg),
            isNull(transfersTable.inflight),
            isNull(hashField(leg)),
          ),
        )
        .returning();
      if (!row) throw new ChainSubmitError("superseded", `Another driver already recorded a ${leg} transaction`);
      onRecorded(row);
      if (faults.has(`crash-before-${leg}-broadcast` as TestFault)) crashForTest(`after recording, before broadcasting the ${leg} transaction`);
    },
    onBroadcast: () => {
      if (faults.has(`crash-after-${leg}-broadcast` as TestFault)) crashForTest(`after broadcasting the ${leg} transaction`);
    },
  };
}

/** Signs, records, broadcasts and waits. Returns the outcome and the row as recorded (with the new hash). */
async function broadcast(
  row: TransferRow,
  leg: Leg,
  faults: ReadonlySet<TestFault>,
  run: (hooks: SubmitHooks) => Promise<SettledTx>,
): Promise<{ outcome: LegOutcome; row: TransferRow }> {
  const recorded: { row: TransferRow | null } = { row: null };
  try {
    const tx = await run(recordSigned(row.id, leg, faults, (r) => (recorded.row = r)));
    return { outcome: { kind: "landed", blockNumber: tx.blockNumber, settleMs: tx.settleMs }, row: recorded.row ?? row };
  } catch (error) {
    if (error instanceof ChainSubmitError && error.code === "superseded") return { outcome: { kind: "superseded" }, row };
    // Nothing recorded means nothing was broadcast; a recorded one is only failed when the chain said so.
    const outcome: LegOutcome = recorded.row && isAmbiguous(error) ? { kind: "pending", error } : { kind: "failed", error };
    return { outcome, row: recorded.row ?? row };
  }
}

async function reread(id: string): Promise<TransferRow> {
  const [row] = await db.select().from(transfersTable).where(eq(transfersTable.id, id));
  if (!row) throw new Error(`Ledger row ${id} disappeared`);
  return row;
}

async function check(row: TransferRow, leg: Leg): Promise<LegOutcome> {
  const hash = legHash(row, leg);
  if (!hash || !row.inflight) return { kind: "failed", error: new Error("Never broadcast") };
  try {
    const outcome = await txOutcome(hash as Hex, row.inflight);
    if (outcome.status === "success") return { kind: "landed", blockNumber: outcome.blockNumber, settleMs: null };
    if (outcome.status === "pending") return { kind: "pending" };
    return { kind: "failed", error: new ChainSubmitError("reverted", `Transaction ${hash} ${outcome.status}`) };
  } catch (error) {
    return { kind: "pending", error }; // RPC trouble: ask again later
  }
}

function payoutReference(): string {
  return `GLK-${randomBytes(4).toString("hex").toUpperCase()}`;
}

/**
 * Runs a leased row as far as it can go now. Returns the latest row, plus the
 * last chain error (for the HTTP response) when it stopped short.
 */
export async function drive(claimed: TransferRow, opts: DriveOptions = {}): Promise<DriveResult> {
  let row = claimed;
  let lastError: unknown;
  // Settle time is shown only when this run broadcast and timed every leg itself.
  const fromStart = !row.inflight && (row.stage === "transfer" || row.stage === "deliver");
  let elapsed: number | null = fromStart ? 0 : null;
  const addTime = (ms: number | null) => {
    elapsed = elapsed === null || ms === null ? null : elapsed + ms;
  };
  const log = logger.child({ transferId: row.id, kind: row.kind });
  const faults = opts.faults ?? NO_FAULTS;
  let superseded = false;

  try {
    if (operatorWritesPaused) {
      // Not a failure: the row is left exactly as it is for an unpaused server.
      log.warn({ stage: row.stage }, "Operator writes paused; not driving this row");
      return { row, error: new ChainSubmitError("not_sent", OPERATOR_PAUSED_MESSAGE) };
    }
    for (let step = 0; step < 6 && row.status === "pending"; step++) {
      const leg = row.stage;

      if (leg === "transfer" || leg === "deliver") {
        let outcome: LegOutcome;
        if (row.inflight) outcome = await check(row, leg);
        else if (leg === "transfer" && opts.auth) {
          const auth = opts.auth;
          ({ outcome, row } = await broadcast(row, leg, faults, (h) => relayTransfer(auth, h)));
        } else if (leg === "deliver" && opts.deliver) {
          const { to, amount } = opts.deliver;
          ({ outcome, row } = await broadcast(row, leg, faults, (h) => deliverDeposit(to, amount, h)));
        } else {
          // Signed transactions are recorded before broadcast, so none exists: nothing can land.
          outcome = { kind: "failed", error: new ChainSubmitError("not_sent", "Interrupted before broadcast") };
        }

        if (outcome.kind === "superseded") throw new Superseded(leg);
        if (outcome.kind === "pending") {
          lastError = outcome.error;
          break;
        }
        if (outcome.kind === "failed") {
          lastError = outcome.error;
          log.warn({ err: outcome.error, stage: leg }, "Nothing moved");
          row = await advance(row, {
            status: "failed",
            error: row.kind === "cashout" ? MESSAGES.notCashedOut : MESSAGES.notSent,
            inflight: null,
            ...hashColumn(leg, null),
          });
          break;
        }
        addTime(outcome.settleMs);
        if (row.kind === "cashout") {
          row = await advance(row, { stage: "settle", inflight: null, attempts: 0, blockNumber: outcome.blockNumber });
          if (faults.has("stop-after-transfer")) {
            log.warn("Test fault: stopping after the transfer, as if the request died");
            break;
          }
          continue;
        }
        row = await advance(row, {
          status: "confirmed",
          stage: "done",
          inflight: null,
          blockNumber: outcome.blockNumber,
          settleMs: elapsed,
          confirmedAt: new Date(),
        });
        continue;
      }

      if (leg === "settle") {
        let outcome: LegOutcome;
        if (row.inflight) outcome = await check(row, leg);
        else if (faults.has("settle-fails")) {
          outcome = { kind: "failed", error: new ChainSubmitError("simulation_failed", "Test fault: settlement rejected") };
        } else {
          const amount = BigInt(row.amount);
          ({ outcome, row } = await broadcast(row, leg, faults, (h) => redeemToDesk(amount, h)));
        }

        if (outcome.kind === "superseded") throw new Superseded(leg);
        if (outcome.kind === "pending") {
          lastError = outcome.error;
          break;
        }
        if (outcome.kind === "failed") {
          // The AUSD is at the desk: it goes back to the sender.
          lastError = outcome.error;
          log.error({ err: outcome.error }, "Settlement failed; refunding");
          row = await advance(row, { stage: "refund", inflight: null, attempts: 0, settlementTxHash: null });
          continue;
        }
        addTime(outcome.settleMs);
        row = await advance(row, {
          status: "confirmed",
          stage: "done",
          inflight: null,
          payoutRef: payoutReference(),
          settleMs: elapsed,
          confirmedAt: new Date(),
        });
        continue;
      }

      if (leg === "refund") {
        let outcome: LegOutcome;
        if (row.inflight) outcome = await check(row, leg);
        else if (row.attempts >= MAX_REFUND_BROADCASTS) {
          log.error({ amount: row.amount, to: row.fromAddress }, "REFUND PENDING: refund broadcasts exhausted; operator action needed");
          break;
        } else {
          const to = getAddress(row.fromAddress);
          const amount = BigInt(row.amount);
          ({ outcome, row } = await broadcast(row, leg, faults, (h) => refundFromDesk(to, amount, h)));
        }

        if (outcome.kind === "superseded") throw new Superseded(leg);
        if (outcome.kind === "pending") break;
        if (outcome.kind === "failed") {
          // Retried by the next reconcile; the row stays pending ("returning your money").
          // Only mined reverts count towards the cap: they are the ones that burn gas.
          const minedRevert = outcome.error instanceof ChainSubmitError && outcome.error.code === "reverted";
          log.error({ err: outcome.error, amount: row.amount, to: row.fromAddress }, "REFUND PENDING: refund did not land");
          row = await advance(row, { inflight: null, refundTxHash: null, attempts: row.attempts + (minedRevert ? 1 : 0) });
          break;
        }
        row = await advance(row, { status: "failed", stage: "refunded", inflight: null, error: MESSAGES.refunded });
        log.warn({ refund: row.refundTxHash }, "Refund confirmed");
        continue;
      }

      break;
    }
  } catch (err) {
    if (!(err instanceof Superseded)) throw err;
    superseded = true;
    log.warn({ stage: err.leg }, "Superseded: the row moved on under this driver; stopping without changes");
    row = await reread(row.id);
  } finally {
    // A superseded driver leaves the lease to whoever holds it now.
    if (!superseded) await db.update(transfersTable).set({ leaseUntil: null }).where(eq(transfersTable.id, row.id));
  }
  return { row, error: lastError };
}

const leaseFree = or(isNull(transfersTable.leaseUntil), lt(transfersTable.leaseUntil, sql`now()`));

/** Takes the lease on a pending row unless another driver holds it. */
export async function claim(id: string): Promise<TransferRow | null> {
  const [row] = await db
    .update(transfersTable)
    .set({ leaseUntil: LEASE })
    .where(and(eq(transfersTable.id, id), eq(transfersTable.status, "pending"), leaseFree))
    .returning();
  return row ?? null;
}

/**
 * Re-arms a row that failed before any money moved, so a retry with the same
 * signed authorization can try again. The EIP-3009 nonce still guarantees it
 * moves money at most once.
 */
export async function rearm(id: string): Promise<TransferRow | null> {
  const [row] = await db
    .update(transfersTable)
    .set({ status: "pending", error: null, txHash: null, inflight: null, attempts: 0, leaseUntil: LEASE })
    .where(and(eq(transfersTable.id, id), eq(transfersTable.status, "failed"), eq(transfersTable.stage, "transfer"), leaseFree))
    .returning();
  return row ?? null;
}

export const LEASE_ON_INSERT = LEASE;

/** True when a failed row moved no money and its authorization may be retried. */
export function isRetryable(row: TransferRow): boolean {
  return row.status === "failed" && row.stage === "transfer";
}

/** Drives one pending row if it is free. Returns the latest row, or null when someone else holds it. */
export async function reconcile(id: string, opts: DriveOptions = {}): Promise<TransferRow | null> {
  const row = await claim(id);
  if (!row) return null;
  return (await drive(row, opts)).row;
}

let sweeping = false;

/** Resolves pending rows nobody is driving (after a restart, a timeout, or a dropped connection). */
export async function sweepPending(limit = 10): Promise<void> {
  if (sweeping || operatorWritesPaused) return;
  sweeping = true;
  try {
    const rows = await db
      .select({ id: transfersTable.id })
      .from(transfersTable)
      .where(and(eq(transfersTable.status, "pending"), leaseFree))
      .orderBy(asc(transfersTable.createdAt))
      .limit(limit);
    for (const { id } of rows) {
      try {
        await reconcile(id);
      } catch (err) {
        logger.error({ err, transferId: id }, "Reconcile failed");
      }
    }
  } catch (err) {
    logger.error({ err }, "Pending sweep failed");
  } finally {
    sweeping = false;
  }
}

/** Sweeps at startup and every 30 s while the process is awake. */
export function startReconciler(): void {
  void sweepPending();
  setInterval(() => void sweepPending(), 30_000).unref();
}

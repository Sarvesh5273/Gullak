import { sql } from "drizzle-orm";
import {
  bigint,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Where a money movement is in its sequence of operator transactions:
 *   send:    transfer -> done
 *   deposit: deliver -> done
 *   cashout: transfer (AUSD to desk) -> settle (Instant Settlement swap) -> done,
 *            or settle fails -> refund -> refunded
 * A failed row whose stage is still `transfer`/`deliver` moved no money.
 */
export const TRANSFER_STAGES = ["transfer", "deliver", "settle", "refund", "refunded", "done"] as const;
export type TransferStage = (typeof TRANSFER_STAGES)[number];

/**
 * The operator transaction for the current stage, recorded after signing and
 * before broadcast, so an interrupted request can be resolved from the chain
 * (receipt, nonce consumed, or rebroadcast of the identical signed bytes).
 */
export type InflightTx = { nonce: number; raw: string; signedAt: number };

/**
 * Every money movement Gullak put on-chain: relayed sends (EIP-3009),
 * add-money deliveries from the settlement desk, and cash-outs (a relayed
 * send to the desk, then a redeem swap through Instant Settlement). The chain is the source of
 * truth for balances; this table is the human-readable ledger (who, note,
 * settlement time) and the input to per-account daily limits.
 */
export const transfersTable = pgTable(
  "transfers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind", { enum: ["send", "deposit", "cashout"] }).notNull(),
    fromAddress: text("from_address").notNull(),
    toAddress: text("to_address").notNull(),
    /** AUSD base units (6 decimals). */
    amount: numeric("amount", { precision: 78, scale: 0 }).notNull(),
    note: text("note"),
    status: text("status", { enum: ["pending", "confirmed", "failed"] })
      .notNull()
      .default("pending"),
    /** EIP-3009 nonce for sends; null for deposits. */
    authNonce: text("auth_nonce"),
    txHash: text("tx_hash"),
    blockNumber: bigint("block_number", { mode: "bigint" }),
    /** Milliseconds from broadcast to receipt, measured by the relayer. */
    settleMs: integer("settle_ms"),
    error: text("error"),
    /** Cash-outs: masked payout destination (e.g. `UPI mo•••@okhdfc`); the full ID is never stored. */
    payoutTo: text("payout_to"),
    /** Cash-outs: simulated bank-side payout reference shown on the receipt. */
    payoutRef: text("payout_ref"),
    /** Cash-outs: the Instant Settlement redeem swap (AUSD -> desk inventory). */
    settlementTxHash: text("settlement_tx_hash"),
    /** Cash-outs: the desk returning the AUSD after a failed settlement. */
    refundTxHash: text("refund_tx_hash"),
    /** Send to UPI: the name the sender gave the recipient (e.g. "Mom"); null for a cash-out to yourself. */
    payoutName: text("payout_name"),
    stage: text("stage", { enum: TRANSFER_STAGES }).notNull().default("done"),
    /** Operator transaction for the current stage; null when none is in flight. */
    inflight: jsonb("inflight").$type<InflightTx>(),
    /** Refund transactions that were mined but reverted (caps refund retries). */
    attempts: integer("attempts").notNull().default(0),
    /** EIP-3009 validBefore: after this an unused authorization can never move money. */
    validBefore: timestamp("valid_before", { withTimezone: true }),
    /** A request or the reconciler is driving this row until then. */
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    /**
     * Exchange-rate snapshot at creation, for the local value on the receipt:
     * the recipient's currency for sends, the member's for deposits, INR for
     * cash-outs. Null when the amount is shown in dollars only.
     */
    fxCurrency: text("fx_currency"),
    /** Local units per US dollar, decimal string. */
    fxRate: text("fx_rate"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("transfers_from_nonce_uq")
      .on(t.fromAddress, t.authNonce)
      .where(sql`${t.authNonce} is not null`),
    index("transfers_from_created_idx").on(t.fromAddress, t.createdAt),
    index("transfers_to_created_idx").on(t.toAddress, t.createdAt),
    index("transfers_pending_idx").on(t.createdAt).where(sql`${t.status} = 'pending'`),
  ],
);

export const insertTransferSchema = createInsertSchema(transfersTable).omit({
  id: true,
  createdAt: true,
});
export type InsertTransfer = z.infer<typeof insertTransferSchema>;
export type TransferRow = typeof transfersTable.$inferSelect;

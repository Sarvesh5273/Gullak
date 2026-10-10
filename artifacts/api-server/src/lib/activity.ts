import { inArray } from "drizzle-orm";
import { db, membersTable, type TransferRow } from "@workspace/db";
import type { ActivityItem } from "@workspace/api-zod";
import { explorerTxUrl } from "@workspace/gullak-core";

const DESK_COUNTERPARTY_NAME = "Agora Instant Settlement";

type PayoutState = NonNullable<ActivityItem["payout"]>["state"];

/** A UPI payout's progress in words the app can show; "refunded" only once the return is mined. */
function payoutState(row: TransferRow): PayoutState {
  if (row.status === "confirmed") return "paid";
  if (row.status === "failed") return row.stage === "refunded" ? "refunded" : "not_sent";
  if (row.stage === "settle") return "settling";
  if (row.stage === "refund") return "refunding";
  return "sending";
}

/** The account whose money movement this is: the sender, or the member an add-money is for. */
export function isOwner(row: TransferRow, viewer: string): boolean {
  return row.kind === "deposit" ? row.toAddress === viewer : row.fromAddress === viewer;
}

/** True when `viewer` may see this row: owners see every state, recipients of a send only settled money. */
export function canView(row: TransferRow, viewer: string): boolean {
  if (isOwner(row, viewer)) return true;
  return row.toAddress === viewer && row.status === "confirmed";
}

/** Shapes ledger rows from the viewer's point of view (send / receive / deposit / cashout). */
export async function toActivityItems(rows: TransferRow[], viewer: string): Promise<ActivityItem[]> {
  const others = new Set<string>();
  for (const row of rows) {
    if (row.kind === "send") others.add(row.fromAddress === viewer ? row.toAddress : row.fromAddress);
  }
  const members = others.size
    ? await db.select().from(membersTable).where(inArray(membersTable.address, [...others]))
    : [];
  const byAddress = new Map(members.map((m) => [m.address, m]));

  return rows.map((row): ActivityItem => {
    const kind: ActivityItem["kind"] =
      row.kind === "deposit" || row.kind === "cashout" ? row.kind : row.fromAddress === viewer ? "send" : "receive";
    const otherAddress = kind === "deposit" || kind === "receive" ? row.fromAddress : row.toAddress;
    const member = byAddress.get(otherAddress);
    const counterparty =
      kind === "deposit"
        ? { address: otherAddress, handle: null, displayName: DESK_COUNTERPARTY_NAME }
        : kind === "cashout"
          ? { address: otherAddress, handle: null, displayName: row.payoutName ?? row.payoutTo ?? "Cash out" }
          : { address: otherAddress, handle: member?.handle ?? null, displayName: member?.displayName ?? "Unknown account" };
    return {
      id: row.id,
      kind,
      status: row.status,
      amount: row.amount,
      counterparty,
      payout:
        kind === "cashout"
          ? {
              destination: row.payoutTo ?? "UPI",
              recipientName: row.payoutName,
              state: payoutState(row),
              reference: row.payoutRef,
              settlementTxHash: row.settlementTxHash,
              settlementExplorerUrl: row.settlementTxHash ? explorerTxUrl(row.settlementTxHash) : null,
              refundTxHash: row.refundTxHash,
              refundExplorerUrl: row.refundTxHash ? explorerTxUrl(row.refundTxHash) : null,
            }
          : null,
      fx: row.fxCurrency && row.fxRate ? { currency: row.fxCurrency, rate: Number(row.fxRate) } : null,
      note: row.note,
      txHash: row.txHash,
      explorerUrl: row.txHash ? explorerTxUrl(row.txHash) : null,
      blockNumber: row.blockNumber === null ? null : row.blockNumber.toString(),
      settleMs: row.settleMs,
      error: row.status === "failed" ? row.error : null,
      createdAt: row.createdAt,
      confirmedAt: row.confirmedAt,
    };
  });
}

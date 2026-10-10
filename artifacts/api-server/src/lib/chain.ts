import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  keccak256,
  TransactionReceiptNotFoundError,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import {
  AUSD_ADDRESS,
  CTK_ADDRESS,
  LIMITS,
  MONAD_TESTNET_RPC_URL,
  SETTLEMENT_PAIR_ADDRESS,
  SPONSOR_POLICY,
  ausdAbi,
  ausdToCtkUnits,
  erc20Abi,
  gullakChain,
  resolveOperatorKey,
  settlementPairAbi,
  type OperatorKeySource,
} from "@workspace/gullak-core";
import { logger } from "./logger";

const rpcUrl = process.env["MONAD_RPC_URL"] || MONAD_TESTNET_RPC_URL;
const transport = http(rpcUrl, { timeout: 10_000, retryCount: 2 });

export const publicClient = createPublicClient({
  chain: gullakChain,
  transport,
  pollingInterval: 300,
});


// ---------------------------------------------------------------------------
// Operator (gas sponsor + add-money desk) key
// ---------------------------------------------------------------------------

type OperatorState =
  | { ok: true; account: PrivateKeyAccount; source: OperatorKeySource }
  | { ok: false; problem: string };

/**
 * The operator signs relay and desk transactions. It never sees user keys.
 * The key itself is never stored or logged; only its address is.
 */
function loadOperator(): OperatorState {
  const resolved = resolveOperatorKey(process.env);
  if (!resolved.ok) return resolved;
  return { ok: true, account: privateKeyToAccount(resolved.privateKey), source: resolved.source };
}

const operator = loadOperator();
if (operator.ok) {
  logger.info({ operator: operator.account.address, keySource: operator.source }, "Operator wallet loaded");
} else {
  logger.error({ problem: operator.problem }, "Operator wallet unavailable; sends and add-money are disabled");
}

const walletClient = operator.ok
  ? createWalletClient({ account: operator.account, chain: gullakChain, transport })
  : null;

export function operatorAddress(): Address | null {
  return operator.ok ? operator.account.address : null;
}

/**
 * Development and the published app derive the same operator wallet from
 * SESSION_SECRET, and two servers sending from one wallet race for its nonces.
 * OPERATOR_WRITES_PAUSED=true (set for development only) keeps this server off
 * the chain as a writer: no new payments, no settlement driving, nothing signed
 * or broadcast. Chain reads (balances, receipts) still work.
 */
export const operatorWritesPaused = process.env["OPERATOR_WRITES_PAUSED"] === "true";
export const OPERATOR_PAUSED_MESSAGE =
  "Payments are paused on this server because it shares its operator wallet with the published app.";
if (operatorWritesPaused) logger.warn("OPERATOR_WRITES_PAUSED is set: this server will not sign or send operator transactions");

// ---------------------------------------------------------------------------
// Sponsor status (cached briefly; /config and every money request read it)
// ---------------------------------------------------------------------------

export type SponsorStatus = {
  configured: boolean;
  address: string | null;
  monBalance: string | null;
  relayReady: boolean;
  depositReady: boolean;
  depositInventory: string | null;
  problem: string | null;
};

let statusCache: { at: number; value: SponsorStatus } | null = null;
const STATUS_TTL_MS = 10_000;

export async function getSponsorStatus(force = false): Promise<SponsorStatus> {
  if (!force && statusCache && Date.now() - statusCache.at < STATUS_TTL_MS) return statusCache.value;
  if (!operator.ok) {
    return {
      configured: false,
      address: null,
      monBalance: null,
      relayReady: false,
      depositReady: false,
      depositInventory: null,
      problem: operator.problem,
    };
  }
  const address = operator.account.address;
  try {
    const [mon, ctk] = await Promise.all([
      publicClient.getBalance({ address }),
      publicClient.readContract({ address: CTK_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
    ]);
    const inventory = ctk / 10n ** 12n; // CTK (18 dp) -> AUSD units (6 dp) at the pair's fixed 1:1
    // Stop above zero: users can't drain the reserve the operator needs for admin.
    const hasGas = mon >= SPONSOR_POLICY.reserveWei;
    const hasInventory = inventory >= LIMITS.maxDepositUnits;
    const problems: string[] = [];
    if (operatorWritesPaused) problems.push(OPERATOR_PAUSED_MESSAGE);
    if (!hasGas) problems.push("The gas sponsor needs test MON (faucet.monad.xyz).");
    if (!hasInventory) problems.push("The add-money desk has no CTK inventory yet (run operator setup).");
    const value: SponsorStatus = {
      configured: true,
      address,
      monBalance: mon.toString(),
      relayReady: hasGas && !operatorWritesPaused,
      depositReady: hasGas && hasInventory && !operatorWritesPaused,
      depositInventory: inventory.toString(),
      problem: problems.length ? problems.join(" ") : null,
    };
    statusCache = { at: Date.now(), value };
    return value;
  } catch (err) {
    logger.warn({ err }, "Could not read sponsor status from RPC");
    return {
      configured: true,
      address,
      monBalance: null,
      relayReady: false,
      depositReady: false,
      depositInventory: null,
      problem: "Could not reach Monad RPC.",
    };
  }
}

export async function getAusdBalance(address: Address): Promise<bigint> {
  return publicClient.readContract({ address: AUSD_ADDRESS, abi: ausdAbi, functionName: "balanceOf", args: [address] });
}

export async function isAuthorizationUsed(authorizer: Address, nonce: Hex): Promise<boolean> {
  return publicClient.readContract({
    address: AUSD_ADDRESS,
    abi: ausdAbi,
    functionName: "authorizationState",
    args: [authorizer, nonce],
  });
}

// ---------------------------------------------------------------------------
// Transaction submission: one at a time, simulated first, explicit gas limit.
// Monad charges the declared gas limit, so the limit is estimate + 20%.
// Each transaction is signed locally and reported through `onSigned` before
// it is broadcast, so the ledger always knows the hash of anything that might
// land, even if this process dies mid-request.
// ---------------------------------------------------------------------------

/**
 * Definitive (nothing will land): simulation_failed, not_sent,
 * sponsor_out_of_gas, reverted (mined, no effect).
 * Ambiguous (may still land; resolve from the chain later): broadcast_failed,
 * receipt_timeout.
 * superseded: another driver already recorded a transaction for this step, so
 * this one was not broadcast and the caller must not act on its stale view.
 */
export type ChainErrorCode =
  | "simulation_failed"
  | "not_sent"
  | "sponsor_out_of_gas"
  | "reverted"
  | "broadcast_failed"
  | "receipt_timeout"
  | "superseded";

export class ChainSubmitError extends Error {
  constructor(
    readonly code: ChainErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
  }
}

export function isAmbiguous(err: unknown): boolean {
  return !(err instanceof ChainSubmitError) || err.code === "broadcast_failed" || err.code === "receipt_timeout";
}

export type SettledTx = { hash: Hex; blockNumber: bigint; settleMs: number };
export type SignedTx = { hash: Hex; nonce: number; raw: Hex };
export type SubmitHooks = {
  /** Must persist the signed transaction; if it throws, nothing is broadcast. */
  onSigned?: (tx: SignedTx) => Promise<void>;
  /** Called once the node accepted the transaction, before waiting for its receipt. */
  onBroadcast?: (tx: SignedTx) => void;
};

const RECEIPT_TIMEOUT_MS = 20_000;

let queueTail: Promise<unknown> = Promise.resolve();
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queueTail.then(task, task);
  queueTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function shortError(err: unknown): string {
  const anyErr = err as { shortMessage?: string; message?: string };
  return (anyErr?.shortMessage ?? anyErr?.message ?? String(err)).split("\n")[0].slice(0, 300);
}

async function submit(label: string, to: Address, data: Hex, hooks: SubmitHooks = {}): Promise<SettledTx> {
  // Backstop: callers check the sponsor status first, so this should never fire.
  if (operatorWritesPaused) throw new ChainSubmitError("not_sent", OPERATOR_PAUSED_MESSAGE);
  if (!operator.ok || !walletClient) {
    throw new ChainSubmitError("not_sent", operator.ok ? "Wallet client missing" : operator.problem);
  }
  const account = operator.account;
  const client = walletClient;
  return enqueue(async () => {
    let gas: bigint;
    try {
      const estimate = await publicClient.estimateGas({ account: account.address, to, data });
      gas = estimate + estimate / 5n;
    } catch (err) {
      throw new ChainSubmitError("simulation_failed", shortError(err), err);
    }
    let signed: SignedTx;
    try {
      const nonce = await publicClient.getTransactionCount({ address: account.address, blockTag: "pending" });
      const request = await client.prepareTransactionRequest({ account, chain: gullakChain, to, data, gas, nonce });
      const raw = await client.signTransaction(request);
      signed = { hash: keccak256(raw), nonce, raw };
      await hooks.onSigned?.(signed);
    } catch (err) {
      if (err instanceof ChainSubmitError) throw err;
      throw new ChainSubmitError("not_sent", shortError(err), err);
    }
    const started = Date.now();
    try {
      await publicClient.sendRawTransaction({ serializedTransaction: signed.raw });
    } catch (err) {
      const message = shortError(err);
      statusCache = null;
      if (/insufficient funds/i.test(message)) throw new ChainSubmitError("sponsor_out_of_gas", message, err);
      if (!/already known|known transaction|already imported/i.test(message)) {
        throw new ChainSubmitError("broadcast_failed", message, err);
      }
    }
    hooks.onBroadcast?.(signed);
    let receipt: TransactionReceipt;
    try {
      receipt = await publicClient.waitForTransactionReceipt({ hash: signed.hash, timeout: RECEIPT_TIMEOUT_MS, pollingInterval: 250 });
    } catch (err) {
      throw new ChainSubmitError("receipt_timeout", shortError(err), err);
    } finally {
      statusCache = null;
    }
    const settleMs = Date.now() - started;
    if (receipt.status !== "success") {
      throw new ChainSubmitError("reverted", `Transaction ${signed.hash} reverted`);
    }
    logger.info({ label, hash: signed.hash, block: receipt.blockNumber.toString(), settleMs, gasUsed: receipt.gasUsed.toString(), gasLimit: gas.toString() }, "Transaction settled");
    return { hash: signed.hash, blockNumber: receipt.blockNumber, settleMs };
  });
}

async function findReceipt(hash: Hex): Promise<TransactionReceipt | null> {
  try {
    return await publicClient.getTransactionReceipt({ hash });
  } catch (err) {
    if (err instanceof TransactionReceiptNotFoundError) return null;
    throw err;
  }
}

export type TxOutcome =
  | { status: "success"; blockNumber: bigint }
  | { status: "reverted" }
  | { status: "dropped" }
  | { status: "pending" };

/**
 * What became of an operator transaction we signed: mined (success/reverted),
 * dropped (its nonce was consumed by a different transaction, so it can never
 * land), or still pending. A pending one older than a few seconds is
 * rebroadcast byte-for-byte, which is idempotent: same hash, same nonce.
 */
export async function txOutcome(hash: Hex, inflight: { nonce: number; raw: string; signedAt: number }): Promise<TxOutcome> {
  const desk = operatorAddress();
  if (!desk) throw new ChainSubmitError("not_sent", "Operator wallet unavailable");
  const mined = (r: TransactionReceipt): TxOutcome =>
    r.status === "success" ? { status: "success", blockNumber: r.blockNumber } : { status: "reverted" };

  const receipt = await findReceipt(hash);
  if (receipt) return mined(receipt);
  const confirmedNonce = await publicClient.getTransactionCount({ address: desk, blockTag: "latest" });
  if (confirmedNonce > inflight.nonce) {
    // The nonce is used. Look once more in case the receipt was just indexed.
    await new Promise((r) => setTimeout(r, 750));
    const again = await findReceipt(hash);
    return again ? mined(again) : { status: "dropped" };
  }
  if (!operatorWritesPaused && Date.now() - inflight.signedAt > 10_000) {
    await publicClient.sendRawTransaction({ serializedTransaction: inflight.raw as Hex }).catch((err) => {
      logger.warn({ hash, err: shortError(err) }, "Rebroadcast of in-flight transaction failed");
    });
  }
  return { status: "pending" };
}

export type TransferAuthorization = {
  from: Address;
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
  signature: Hex;
};

/** Broadcasts a user-signed EIP-3009 transfer. The operator only pays gas. */
export function relayTransfer(auth: TransferAuthorization, hooks?: SubmitHooks): Promise<SettledTx> {
  const data = encodeFunctionData({
    abi: ausdAbi,
    functionName: "transferWithAuthorization",
    args: [auth.from, auth.to, auth.value, auth.validAfter, auth.validBefore, auth.nonce, auth.signature],
  });
  return submit("transfer", AUSD_ADDRESS, data, hooks);
}

/**
 * Add-money (testnet): the desk swaps its CTK inventory for exactly `amount`
 * AUSD on Agora's Instant Settlement pair, delivered straight to the member.
 * In production this is Agora's USD -> AUSD mint route.
 */
export function deliverDeposit(to: Address, amount: bigint, hooks?: SubmitHooks): Promise<SettledTx> {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
  const data = encodeFunctionData({
    abi: settlementPairAbi,
    functionName: "swapTokensForExactTokens",
    args: [amount, ausdToCtkUnits(amount), [CTK_ADDRESS, AUSD_ADDRESS], to, deadline],
  });
  return submit("deposit", SETTLEMENT_PAIR_ADDRESS, data, hooks);
}

/**
 * Cash-out redeem leg (testnet): after a member's AUSD reaches the desk, the
 * desk swaps exactly that AUSD back into CTK inventory on the Instant
 * Settlement pair. In production this is Agora's AUSD -> USD redeem route that
 * funds the local payout. The quote is read first so a pair fee can't make
 * the swap revert on a too-tight minimum.
 */
export async function redeemToDesk(amount: bigint, hooks?: SubmitHooks): Promise<SettledTx> {
  const desk = operatorAddress();
  if (!desk) throw new ChainSubmitError("not_sent", "Operator wallet unavailable");
  const [, ctkOut] = await publicClient.readContract({
    address: SETTLEMENT_PAIR_ADDRESS,
    abi: settlementPairAbi,
    functionName: "getAmountsOut",
    args: [amount, [AUSD_ADDRESS, CTK_ADDRESS]],
  });
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
  const data = encodeFunctionData({
    abi: settlementPairAbi,
    functionName: "swapExactTokensForTokens",
    args: [amount, ctkOut, [AUSD_ADDRESS, CTK_ADDRESS], desk, deadline],
  });
  return submit("cashout-redeem", SETTLEMENT_PAIR_ADDRESS, data, hooks);
}

/** Returns AUSD the desk received for a cash-out whose redeem leg failed. */
export function refundFromDesk(to: Address, amount: bigint, hooks?: SubmitHooks): Promise<SettledTx> {
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] });
  return submit("cashout-refund", AUSD_ADDRESS, data, hooks);
}

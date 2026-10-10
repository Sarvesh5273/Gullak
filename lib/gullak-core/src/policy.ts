import { AUSD_UNIT } from "./money";

/**
 * Limits shared by the app (to explain them up front) and the server (to
 * enforce them). Testnet values; they bound what one account can drain from
 * the gas sponsor and the add-money desk.
 */
export const LIMITS = {
  /** Largest single send. */
  maxSendUnits: 500n * AUSD_UNIT,
  /** Sends per account per rolling 24 hours. */
  dailySendUnits: 2_000n * AUSD_UNIT,
  /** Number of sends per account per rolling 24 hours (each one costs the gas sponsor). */
  dailySendCount: 20,
  /** Largest single add-money. */
  maxDepositUnits: 100n * AUSD_UNIT,
  /** Add-money per account per rolling 24 hours. */
  dailyDepositUnits: 300n * AUSD_UNIT,
  /** Number of add-money requests per account per rolling 24 hours. */
  dailyDepositCount: 5,
  /** Largest single cash-out. */
  maxCashoutUnits: 500n * AUSD_UNIT,
  /** Number of cash-outs per account per rolling 24 hours (each one is two sponsored transactions). */
  dailyCashoutCount: 5,
  /** How long a signed transfer authorization stays valid. */
  transferValiditySeconds: 10 * 60,
  /** The relayer rejects authorizations valid for longer than this. */
  maxTransferValiditySeconds: 60 * 60,
} as const;

/**
 * Gas sponsor budget. Testnet MON comes from a faucet a few MON at a time, and
 * Monad charges the declared gas limit (not gas used), so every sponsored
 * transaction costs its full limit whatever amount it moves.
 */
export const SPONSOR_POLICY = {
  /** Below this the API stops sponsoring, keeping gas for operator admin (0.25 MON). */
  reserveWei: 250_000_000_000_000_000n,
  /**
   * Sponsored transactions (sends + add-money) across all accounts per rolling
   * 24 hours. Bounds the burn to about 1.5 MON a day however many accounts exist.
   */
  dailyTxCap: 60,
  /** Gas limits we actually send (estimate + 20%), measured on Monad testnet. Cash-out = send + redeem swap. */
  typicalGas: { send: 136_000n, deposit: 250_000n, cashout: 365_000n },
} as const;

/**
 * Scoped signing session (client-side policy around the Mera session).
 * One passkey prompt unlocks the account; the session then signs without
 * prompts, but only Gullak sign-in statements and AUSD transfers, only up to
 * a budget, and only until it idles out, ages out, or the app is backgrounded.
 */
export const SESSION_POLICY = {
  idleMs: 10 * 60_000,
  maxAgeMs: 30 * 60_000,
  backgroundGraceMs: 2 * 60_000,
  /** Sends above what is left of this need a fresh passkey confirmation. */
  budgetUnits: 200n * AUSD_UNIT,
} as const;

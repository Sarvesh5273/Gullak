import { ApiError, type TransferInput } from '@workspace/api-client-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Address } from 'viem';
import { useWallet } from '@/contexts/WalletContext';

type Held = {
  intent: string;
  input: TransferInput;
  budgeted: bigint;
  /** The last attempt got no clear answer, so it may still move money. */
  uncertain: boolean;
};

/** Re-sign rather than reuse when less than this much validity is left. */
const MIN_VALIDITY_LEFT_S = 90;

/**
 * Keeps one signed transfer authorization per screen so a retry sends the
 * *same* authorization. Its EIP-3009 nonce can move money only once, so
 * tapping "try again" after a timeout or dropped connection never pays twice;
 * the server answers with whatever the first attempt did.
 *
 * A new authorization is signed only when what is being paid changes (or the
 * old one is about to expire). The server returns an error only when nothing
 * moved, so after an error answer the session budget is given back. After no
 * answer (network failure, 500) it is kept, and `uncertainIntent` lets the
 * screen warn before the member pays something different instead.
 */
export function useHeldAuthorization() {
  const { authorizeTransfer, releaseBudget } = useWallet();
  const held = useRef<Held | null>(null);
  const [uncertainIntent, setUncertainIntent] = useState<string | null>(null);

  const drop = useCallback(
    (h: Held) => {
      if (!h.uncertain) releaseBudget(h.budgeted);
    },
    [releaseBudget],
  );

  /** Returns the authorization to send: the held one if it is for the same payment and still valid. */
  const authorize = useCallback(
    async (to: Address, value: bigint, intent: string): Promise<TransferInput> => {
      const h = held.current;
      const now = Math.floor(Date.now() / 1000);
      if (h && h.intent === intent && h.input.validBefore - now > MIN_VALIDITY_LEFT_S) return h.input;
      const signed = await authorizeTransfer(to, value);
      if (h) drop(h);
      held.current = { intent, input: signed.input, budgeted: signed.budgeted, uncertain: false };
      setUncertainIntent(null);
      return signed.input;
    },
    [authorizeTransfer, drop],
  );

  /** The server took it (settled, settling, or returned): forget it; the budget stays spent. */
  const accepted = useCallback(() => {
    held.current = null;
    setUncertainIntent(null);
  }, []);

  /** Records how the attempt failed; the authorization is kept for a retry. */
  const failed = useCallback((err: unknown) => {
    const h = held.current;
    if (!h) return;
    const answered = err instanceof ApiError && err.status !== 500 && typeof (err.data as { code?: unknown } | null)?.code === 'string';
    h.uncertain = !answered;
    setUncertainIntent(answered ? null : h.intent);
  }, []);

  useEffect(
    () => () => {
      if (held.current) drop(held.current);
    },
    [drop],
  );

  return { authorize, accepted, failed, uncertainIntent };
}

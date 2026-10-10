import { getGetFxRatesQueryKey, useGetFxRates } from '@workspace/api-client-react';
import { formatLocal, usdUnitsToLocal } from '@workspace/gullak-core';
import { useCallback } from 'react';

/**
 * Daily USD exchange rates from the API (which caches the public source).
 * `localFor` returns null for dollars or when rates are unavailable, so
 * callers simply hide the local line instead of showing a guessed number.
 */
export function useFx() {
  const query = useGetFxRates({
    query: { queryKey: getGetFxRatesQueryKey(), staleTime: 30 * 60_000, retry: 1 },
  });
  const data = query.data;

  const rateFor = useCallback(
    (currency: string): number | null => {
      if (currency === 'USD') return 1;
      return data?.rates.find((r) => r.currency === currency)?.rate ?? null;
    },
    [data],
  );

  /** "≈ ₹484.15" for an AUSD amount, or null. */
  const localFor = useCallback(
    (units: bigint | string, currency: string): string | null => {
      if (currency === 'USD') return null;
      const rate = rateFor(currency);
      return rate === null ? null : `≈ ${formatLocal(usdUnitsToLocal(units, rate), currency)}`;
    },
    [rateFor],
  );

  return { rates: data ?? null, rateFor, localFor };
}

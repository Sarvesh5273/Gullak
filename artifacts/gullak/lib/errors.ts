import { isMeraError } from '@category-labs/mera';
import { ApiError } from '@workspace/api-client-react';

/** Server errors carry { error, code }; this returns the human sentence. */
export function apiErrorMessage(err: unknown, fallback = 'Something went wrong. Try again.'): string {
  if (err instanceof ApiError) {
    const data = err.data as { error?: unknown } | null;
    if (data && typeof data.error === 'string') return data.error;
    if (err.status === 0 || err.status >= 500) return "Couldn't reach Gullak. Check your connection and try again.";
  }
  if (err instanceof TypeError) return "Couldn't reach Gullak. Check your connection and try again.";
  return fallback;
}

export function apiErrorCode(err: unknown): string | null {
  if (err instanceof ApiError) {
    const data = err.data as { code?: unknown } | null;
    return data && typeof data.code === 'string' ? data.code : null;
  }
  return null;
}

export function apiErrorStatus(err: unknown): number | null {
  return err instanceof ApiError ? err.status : null;
}

/**
 * Why a send or payout failed, for the form. The server answers with an error
 * only when no money moved; with no clear answer the same signed payment is
 * retried, which can't pay twice.
 */
export function paymentFailureMessage(err: unknown): string {
  const answered = err instanceof ApiError && err.status !== 500 && apiErrorCode(err) !== null;
  return answered
    ? apiErrorMessage(err)
    : "We couldn't confirm this payment. Tap again to check: it retries the same payment, so it can't go out twice.";
}

/** Shown when the member changes a payment whose last attempt got no clear answer. */
export const UNCERTAIN_EARLIER_PAYMENT =
  "Your last attempt didn't get a clear answer and may still go through. Check Activity before paying a different amount.";

/** Operator-facing detail (e.g. "fund the sponsor"), appended only in development builds. */
export function devDetail(problem: string | null | undefined): string {
  return __DEV__ && problem ? `\n\nOperator note: ${problem}` : '';
}

/** Passkey failures in plain language. */
export function passkeyErrorMessage(err: unknown): string {
  if (isMeraError(err)) {
    switch (err.code) {
      case 'PRF_UNAVAILABLE':
        return "This passkey provider can't hold a Gullak wallet (it lacks the PRF feature). Use Google Password Manager on Android or Chrome, or iCloud Keychain on Apple devices.";
      case 'PASSKEY_OPERATION_FAILED':
        return 'The passkey request was cancelled or could not open. Try again.';
      case 'CRYPTO_UNAVAILABLE':
        return "This device is missing the secure random generator passkeys need.";
      default:
        return `Passkey error (${err.code}).`;
    }
  }
  return err instanceof Error && err.message ? err.message : 'The passkey request failed.';
}

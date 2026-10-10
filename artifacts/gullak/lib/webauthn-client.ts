import type { WebAuthnClient } from '@category-labs/mera';

/** Web: Mera's built-in client (navigator.credentials) is used when this is undefined. */
export function getWebAuthnClient(): WebAuthnClient | undefined {
  return undefined;
}

export function isFramed(): boolean {
  try {
    return typeof window !== 'undefined' && window.self !== window.top;
  } catch {
    return true;
  }
}

/** Why passkeys cannot work here, or null when they can. */
export function passkeyUnavailableReason(): string | null {
  if (typeof window === 'undefined' || typeof window.PublicKeyCredential === 'undefined') {
    return "This browser doesn't support passkeys. Try a recent Chrome, Safari or Edge.";
  }
  if (!window.isSecureContext) return 'Passkeys need a secure (https) page.';
  return null;
}

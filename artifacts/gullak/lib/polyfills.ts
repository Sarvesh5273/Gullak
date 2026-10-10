import { getRandomValues } from 'expo-crypto';

/**
 * Hermes has no Web Crypto. Mera (WebAuthn challenges) and viem need
 * crypto.getRandomValues; expo-crypto provides a CSPRNG-backed one.
 * Browsers already have it, so this is a no-op on web.
 */
const g = globalThis as { crypto?: Partial<Crypto> };
if (!g.crypto) g.crypto = {};
if (typeof g.crypto.getRandomValues !== 'function') {
  g.crypto.getRandomValues = getRandomValues as Crypto['getRandomValues'];
}

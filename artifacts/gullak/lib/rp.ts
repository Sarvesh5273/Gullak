import { Platform } from 'react-native';

export const RP_NAME = 'Gullak';

function hostOf(domain: string | undefined): string {
  if (!domain) throw new Error('EXPO_PUBLIC_DOMAIN is not set; the app cannot reach its server.');
  return new URL(/^https?:\/\//.test(domain) ? domain : `https://${domain}`).hostname;
}

/** Host of the Gullak server. Also the audience of sign-in statements. */
export function apiHost(): string {
  return hostOf(process.env.EXPO_PUBLIC_DOMAIN);
}

/**
 * Passkey relying party: the web origin's host in a browser, the server's
 * host in the native app (linked to the app by /.well-known/assetlinks.json).
 * In production both are the published domain, so one passkey works in both.
 */
export function rpId(): string {
  if (Platform.OS === 'web') return window.location.hostname;
  return apiHost();
}

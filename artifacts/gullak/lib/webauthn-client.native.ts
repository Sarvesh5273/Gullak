import { NativeModules, Platform } from 'react-native';
import type { WebAuthnClient } from '@category-labs/mera';

let client: WebAuthnClient | undefined;

/** Native: Mera's react-native-passkey client, loaded only when the module is linked. */
export function getWebAuthnClient(): WebAuthnClient | undefined {
  if (!client) {
    // Lazy so that Expo Go (no passkey module) never evaluates it.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('@category-labs/mera/react-native-webauthn-client') as typeof import('@category-labs/mera/react-native-webauthn-client');
    client = mod.reactNativeWebAuthnClient;
  }
  return client;
}

export function isFramed(): boolean {
  return false;
}

/** Why passkeys cannot work here, or null when they can. */
export function passkeyUnavailableReason(): string | null {
  if (!NativeModules.Passkey) {
    return "Expo Go can't use passkeys. Open Gullak in your browser, or install the Gullak Android build.";
  }
  if (Platform.OS === 'android' && typeof Platform.Version === 'number' && Platform.Version < 28) {
    return 'Passkeys need Android 9 or newer.';
  }
  return null;
}

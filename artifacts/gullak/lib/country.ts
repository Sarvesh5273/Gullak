import { countryFromTimeZone } from '@workspace/gullak-core';

/** Country guess for a new account, from the device time zone (changeable in Account). */
export function guessCountry(): string {
  try {
    return countryFromTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch {
    return countryFromTimeZone(null);
  }
}

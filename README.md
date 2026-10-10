# Gullak

A dollar account for people who support family across borders. Sign up with a passkey, hold AUSD on Monad, pay another member by @handle or pay a family member's UPI ID. Gullak pays every network fee.

Built for **Monad Metropolis 2026** (Consumer Products & Payments).

> **Testnet demo. No real money moves.** AUSD and CTK are Agora's test tokens on Monad testnet, rupee amounts are indicative, and the UPI payout is simulated.

## Try it

| | |
|---|---|
| Web app | https://gullak-family-money-app.replit.app |
| Android app (install page, APK, SHA-256) | https://gullak-family-money-app.replit.app/android |
| Demo video (1:59) | *link added at submission* |

**Android:** you need Android 9 or newer, a 64-bit ARM phone, Google Play services, a screen lock and a Google account.
1. Open the install page on the phone and install the APK.
2. **Create my Gullak**, then pick a name and @handle, then **Create with passkey**.
3. **Add money** ($25).
4. **Send** to an @handle (no passkey prompt inside the session budget).
5. **Send** → **Not on Gullak? Send to their UPI ID**.
6. Stateless test: Settings → Apps → Gullak → Storage → **Clear data**, reopen, then **I already have one**. The same account and balance come back.

Every receipt links to the transaction on the Monad testnet explorer. Shared daily limits protect the test gas budget, so if the app says it's paused, try again later.

## What is on-chain and what is simulated

| Step | On Monad testnet | Simulated |
|---|---|---|
| Passkey sign-up / sign-in | Mera passkey account (PRF-derived key, held only in app memory) | — |
| Add money | Desk swaps CTK → AUSD on Agora's Instant Settlement pair; the AUSD lands in the member's account | No card or bank deposit |
| Send to @handle | Direct AUSD transfer (EIP-3009), gas paid by Gullak. **Not** an Instant Settlement swap | — |
| Send to UPI | Member's AUSD goes to the desk, which swaps AUSD → CTK on the Instant Settlement pair | Rupee payout and INR amount |

Recorded on a real Android phone against the published app (10 Oct 2026), timed from the first frame of the landing screen, with idle time included:
- confirmed funding at 37.7 s
- first member-signed payment confirmed at 68.1 s
- after clearing app data, the restored account 8.9 s after tapping "I already have one"

## Sponsor integrations

- **Mera** (`@category-labs/mera`) is the whole account layer: there is no seed phrase, extension, email or password. In `artifacts/gullak/lib/keys.ts`:
  - `createPasskeyWithPrfOutput` creates the passkey and reads PRF in one ceremony
  - `createSecp256k1SigningSession` signs without prompts inside a session that Gullak scopes
  - `getPasskeyPrfOutput` signs in and recovers the account
- **Agora AUSD** is the balance and payment asset. Transfers use EIP-3009 `transferWithAuthorization`, so members never pay gas.
- **Agora Instant Settlement** (CTK/AUSD pair) handles money in (Add money) and money out (Send to UPI / cash out) through a desk wallet that holds the approved-swapper role. On mainnet that role requires KYC with Agora, so a licensed operator would do this, not end users.

**Session scope.** These limits are enforced by the app around the Mera session; they are not a cryptographic boundary.
- Only sign-in statements and AUSD transfers sign without a prompt, up to $200 per session.
- A larger send asks for the passkey again.
- The session locks after 10 minutes idle, 30 minutes total, 2 minutes in the background, or on **Lock now**.

Each transfer signature itself is bound to its exact recipient, amount, expiry and nonce. Session limits live in `lib/gullak-core/src/policy.ts`.

Contracts (Monad testnet, chain 10143):
- AUSD: `0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC`
- CTK: `0x7BEb5D9DB0d85cBEa543C04f0dE8c23c2176cd9D`
- Instant Settlement pair: `0x1Aa8958Aa34cEC8096EF4381cb335effe977b0ae`

## Repository layout

pnpm monorepo (Node 24, TypeScript):

| Path | What |
|---|---|
| `artifacts/gullak` | Expo / React Native app (Android and web); `server/` serves the web build and the Android install page |
| `artifacts/api-server` | Express API: sign-in tokens, member directory, gasless relaying, Instant Settlement desk, crash-safe settlement ledger |
| `lib/gullak-core` | Shared chain config, contract ABIs, limits and session policy |
| `lib/db` | Drizzle schema (PostgreSQL) |
| `lib/api-spec`, `lib/api-zod`, `lib/api-client-react` | OpenAPI spec and generated Zod schemas / React Query client |
| `scripts` | Operator status and setup, API smoke test, headless web e2e (virtual PRF passkey), crash-recovery check, APK publishing |

## Running it yourself

You need Node 24, pnpm 10, PostgreSQL, and a Monad testnet wallet with a few test MON (from https://faucet.monad.xyz) to act as the relayer and settlement desk.

```bash
pnpm install
cp .env.example .env        # fill in the values, then export them in your shell
pnpm --filter @workspace/db run push              # create tables
pnpm --filter @workspace/scripts run operator     # desk address, balances, gas runway
pnpm --filter @workspace/scripts run operator setup   # one-time: Instant Settlement whitelist and approvals (spends test MON)
PORT=8080 pnpm --filter @workspace/api-server run dev   # API (PORT is required)
```

The app scripts are written for the Replit environment. Elsewhere:
- **Web:** `EXPO_PUBLIC_DOMAIN=<host serving /api> node artifacts/gullak/scripts/build.js --web-only`, then `PORT=3999 node artifacts/gullak/server/serve.js`. The web app and `/api` must share one HTTPS host, because the passkey rpId is that host.
- **Android:** `EXPO_PUBLIC_DOMAIN=<host> bash artifacts/gullak/scripts/build-android.sh`. Set `GULLAK_SIGNING_DIR` to your own signing key, and put that key's SHA-256 in `ANDROID_CERT_SHA256` so `/.well-known/assetlinks.json` lets the app use passkeys. Signing keys are not in this repository.

Checks: `pnpm run typecheck`. `pnpm --filter @workspace/scripts run smoke` with `SMOKE_CHAIN=0` runs only the free checks; without it, the smoke test spends test MON.

## Known limits

- Testnet only. Test tokens, simulated UPI payout, indicative rupee rates.
- Tested on one real Android phone (Android 16), in Safari on macOS and in headless Chromium end-to-end tests. iOS is untested.
- Each member holds their own balance; there is no shared balance yet.
- The API runs as a single instance (in-memory rate limits and transaction queue).
- Gas sponsorship is capped at 60 transactions a day across all users.
- The funding and payout partners described in the write-up (licensed remittance and UPI partners, an Agora institutional account) do not exist yet.

## License

MIT, see [LICENSE](LICENSE).

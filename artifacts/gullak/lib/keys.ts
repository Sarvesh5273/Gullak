import {
  createPasskeyWithPrfOutput,
  createSecp256k1SigningSession,
  getPasskeyPrfOutput,
  type PasskeyCredentialMetadata,
  type Secp256k1SigningSession,
} from '@category-labs/mera';
import { toViemAccount } from '@category-labs/mera/viem';
import { HDKey } from '@scure/bip32';
import { entropyToMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import type { LocalAccount } from 'viem';
import { RP_NAME, rpId } from './rp';
import { getWebAuthnClient } from './webauthn-client';

/** Standard Ethereum path, so the same passkey always yields the same address. */
const DERIVATION_PATH = "m/44'/60'/0'/0/0";

export type UnlockedKey = {
  session: Secp256k1SigningSession;
  account: LocalAccount;
  credential: PasskeyCredentialMetadata;
};

/**
 * PRF output -> BIP-39 mnemonic -> seed -> m/44'/60'/0'/0/0, as Mera documents.
 * The mnemonic form keeps the account portable to any standard wallet.
 * Byte buffers are zeroed once Mera has copied the key into its session.
 */
function keyFromPrf(prfOutput: Uint8Array, credential: PasskeyCredentialMetadata): UnlockedKey {
  let seed: Uint8Array | undefined;
  let master: HDKey | undefined;
  let child: HDKey | undefined;
  try {
    seed = mnemonicToSeedSync(entropyToMnemonic(prfOutput, wordlist));
    master = HDKey.fromMasterSeed(seed);
    child = master.derive(DERIVATION_PATH);
    if (!child.privateKey) throw new Error('Key derivation failed.');
    const session = createSecp256k1SigningSession({ privateKey: child.privateKey });
    return { session, account: toViemAccount(session), credential };
  } finally {
    prfOutput.fill(0);
    seed?.fill(0);
    child?.wipePrivateData();
    master?.wipePrivateData();
  }
}

/** Creates a new passkey (one or two prompts) and opens a signing session for it. */
export async function createKey(label: string): Promise<UnlockedKey> {
  const created = await createPasskeyWithPrfOutput({
    rp: { id: rpId(), name: RP_NAME },
    user: { name: label, displayName: label },
    webAuthnClient: getWebAuthnClient(),
  });
  return keyFromPrf(created.prfOutput, {
    credentialId: created.credentialId,
    ...(created.transports ? { transports: created.transports } : {}),
  });
}

/**
 * Asks a passkey for its PRF output (one prompt) and opens a signing session.
 * With `credential`, only that passkey may answer; without, the user picks.
 */
export async function unlockKey(credential?: PasskeyCredentialMetadata): Promise<UnlockedKey> {
  const result = await getPasskeyPrfOutput({
    rpId: rpId(),
    ...(credential ? { credential } : {}),
    webAuthnClient: getWebAuthnClient(),
  });
  const transports = credential?.credentialId === result.credentialId ? credential.transports : undefined;
  return keyFromPrf(result.prfOutput, {
    credentialId: result.credentialId,
    ...(transports ? { transports } : {}),
  });
}

import { defineChain, type Address } from "viem";

/**
 * Monad testnet and the Agora contracts Gullak uses on it.
 * Every address and the EIP-712 domain below were checked on-chain (Oct 2026).
 */

export const MONAD_TESTNET_RPC_URL = "https://testnet-rpc.monad.xyz";
export const EXPLORER_URL = "https://testnet.monadvision.com";

export const gullakChain = defineChain({
  id: 10143,
  name: "Monad Testnet",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [MONAD_TESTNET_RPC_URL] } },
  blockExplorers: { default: { name: "MonadVision", url: EXPLORER_URL } },
  testnet: true,
});

export const CHAIN_ID = 10143;

/** Agora Dollar (AUSD). Supports EIP-3009 and EIP-2612. */
export const AUSD_ADDRESS: Address = "0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC";
export const AUSD_DECIMALS = 6;
export const AUSD_SYMBOL = "AUSD";

/** Agora's test counter-asset for the Instant Settlement pair. */
export const CTK_ADDRESS: Address = "0x7BEb5D9DB0d85cBEa543C04f0dE8c23c2176cd9D";
export const CTK_DECIMALS = 18;

/** Agora Instant Settlement pair (CTK/AUSD, fixed 1:1, zero fee). Callers need the approved-swapper role. */
export const SETTLEMENT_PAIR_ADDRESS: Address = "0x1Aa8958Aa34cEC8096EF4381cb335effe977b0ae";
/** Testnet-only self-service whitelisting for the pair. */
export const WHITELISTER_ADDRESS: Address = "0x7c10F56d6f04a51376393a1C3670e966863F6BD5";
/** Testnet AUSD faucet. */
export const AUSD_FAUCET_ADDRESS: Address = "0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C";

/**
 * The token's EIP-712 domain, read from `eip712Domain()`.
 * Note: the domain name is "Agora Dollar", not the ERC-20 symbol "AUSD".
 */
export const AUSD_EIP712_DOMAIN = {
  name: "Agora Dollar",
  version: "1",
  chainId: CHAIN_ID,
  verifyingContract: AUSD_ADDRESS,
} as const;

export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export function explorerTxUrl(hash: string): string {
  return `${EXPLORER_URL}/tx/${hash}`;
}

export function explorerAddressUrl(address: string): string {
  return `${EXPLORER_URL}/address/${address}`;
}

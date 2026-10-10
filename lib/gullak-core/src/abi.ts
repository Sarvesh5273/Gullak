import { parseAbi } from "viem";

/** AUSD: ERC-20 plus the EIP-3009 functions Gullak relays. */
export const ausdAbi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 value) returns (bool)",
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

/** Minimal ERC-20 surface (CTK reads, approvals, and desk refunds of AUSD). */
export const erc20Abi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 value) returns (bool)",
  "function transfer(address to, uint256 value) returns (bool)",
]);

/** Agora Instant Settlement pair. Uniswap-v2-router-style entry points on the pair itself. */
export const settlementPairAbi = parseAbi([
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)",
  "function swapTokensForExactTokens(uint256 amountOut, uint256 amountInMax, address[] path, address to, uint256 deadline) returns (uint256[] amounts)",
  "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)",
  "function getAmountsIn(uint256 amountOut, address[] path) view returns (uint256[] amounts)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
]);

export const whitelisterAbi = parseAbi([
  "function setApprovedSwapper(address swapper)",
]);

export const ausdFaucetAbi = parseAbi([
  "function requestFunds(address recipient)",
  "function token() view returns (address)",
]);

/**
 * Operator wallet admin (gas sponsor + add-money desk).
 *
 *   pnpm --filter @workspace/scripts run operator           # status
 *   pnpm --filter @workspace/scripts run operator setup     # one-time desk setup
 *
 * Setup: whitelist the operator on Agora's Instant Settlement pair (testnet
 * self-service), claim AUSD from the faucet, approve the pair, and convert the
 * AUSD into CTK inventory. The desk later swaps CTK -> AUSD straight to members.
 * Needs test MON for gas first (https://faucet.monad.xyz).
 */
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  formatGwei,
  formatUnits,
  http,
  maxUint256,
  parseEther,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  AUSD_ADDRESS,
  AUSD_DECIMALS,
  AUSD_FAUCET_ADDRESS,
  CTK_ADDRESS,
  CTK_DECIMALS,
  SETTLEMENT_PAIR_ADDRESS,
  SPONSOR_POLICY,
  WHITELISTER_ADDRESS,
  ausdFaucetAbi,
  erc20Abi,
  explorerTxUrl,
  gullakChain,
  resolveOperatorKey,
  settlementPairAbi,
  whitelisterAbi,
} from "@workspace/gullak-core";

const resolved = resolveOperatorKey(process.env);
if (!resolved.ok) {
  console.error(resolved.problem);
  process.exit(1);
}
const account = privateKeyToAccount(resolved.privateKey);
const transport = http(process.env["MONAD_RPC_URL"] || undefined, { timeout: 15_000, retryCount: 2 });
const publicClient = createPublicClient({ chain: gullakChain, transport, pollingInterval: 300 });
const walletClient = createWalletClient({ account, chain: gullakChain, transport });

async function balances() {
  const [mon, ausd, ctk, ausdAllowance, ctkAllowance] = await Promise.all([
    publicClient.getBalance({ address: account.address }),
    publicClient.readContract({ address: AUSD_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }),
    publicClient.readContract({ address: CTK_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }),
    publicClient.readContract({ address: AUSD_ADDRESS, abi: erc20Abi, functionName: "allowance", args: [account.address, SETTLEMENT_PAIR_ADDRESS] }),
    publicClient.readContract({ address: CTK_ADDRESS, abi: erc20Abi, functionName: "allowance", args: [account.address, SETTLEMENT_PAIR_ADDRESS] }),
  ]);
  return { mon, ausd, ctk, ausdAllowance, ctkAllowance };
}

/** How many more sends / add-moneys the MON above the reserve pays for at today's gas price. */
async function printRunway(mon: bigint) {
  const gasPrice = await publicClient.getGasPrice();
  const spendable = mon > SPONSOR_POLICY.reserveWei ? mon - SPONSOR_POLICY.reserveWei : 0n;
  const sends = spendable / (gasPrice * SPONSOR_POLICY.typicalGas.send);
  const deposits = spendable / (gasPrice * SPONSOR_POLICY.typicalGas.deposit);
  console.log(
    `  runway: ~${sends} sends or ~${deposits} add-moneys at ${formatGwei(gasPrice)} gwei` +
      ` (keeps ${formatEther(SPONSOR_POLICY.reserveWei)} MON reserve; app cap ${SPONSOR_POLICY.dailyTxCap} tx/day)`,
  );
}

function printBalances(b: Awaited<ReturnType<typeof balances>>) {
  console.log(`  MON  ${formatEther(b.mon)}`);
  console.log(`  AUSD ${formatUnits(b.ausd, AUSD_DECIMALS)}`);
  console.log(`  CTK  ${formatUnits(b.ctk, CTK_DECIMALS)}  (desk inventory)`);
  console.log(`  pair allowance: AUSD ${b.ausdAllowance > 0n ? "yes" : "no"}, CTK ${b.ctkAllowance > 0n ? "yes" : "no"}`);
}

async function send(label: string, to: Address, request: Parameters<typeof walletClient.writeContract>[0]) {
  process.stdout.write(`- ${label} ... `);
  const { request: simulated } = await publicClient.simulateContract({ ...request, account } as never);
  const gasEstimate = await publicClient.estimateContractGas({ ...request, account } as never);
  const hash: Hex = await walletClient.writeContract({ ...(simulated as object), gas: gasEstimate + gasEstimate / 5n } as never);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
  if (receipt.status !== "success") throw new Error(`${label} reverted: ${hash}`);
  console.log(`ok  ${explorerTxUrl(hash)}`);
  void to;
}

async function setup() {
  if (process.env["OPERATOR_WRITES_PAUSED"] === "true") {
    // Same wallet as the published app: sending from here races its nonces.
    console.error("OPERATOR_WRITES_PAUSED is set: this environment must not send operator transactions.");
    process.exit(1);
  }
  let b = await balances();
  if (b.mon < parseEther("0.1")) {
    console.error(`Operator has ${formatEther(b.mon)} MON. Claim test MON for ${account.address} at https://faucet.monad.xyz first.`);
    process.exit(1);
  }

  await send("Whitelist operator on the Instant Settlement pair", WHITELISTER_ADDRESS, {
    address: WHITELISTER_ADDRESS,
    abi: whitelisterAbi,
    functionName: "setApprovedSwapper",
    args: [account.address],
  } as never);

  try {
    const before = b.ausd;
    await send("Claim AUSD from the testnet faucet", AUSD_FAUCET_ADDRESS, {
      address: AUSD_FAUCET_ADDRESS,
      abi: ausdFaucetAbi,
      functionName: "requestFunds",
      args: [account.address],
    } as never);
    b = await balances();
    console.log(`  faucet paid ${formatUnits(b.ausd - before, AUSD_DECIMALS)} AUSD`);
  } catch (err) {
    console.log(`skipped (${(err as Error).message.split("\n")[0]})`);
  }

  if (b.ausdAllowance < maxUint256 / 2n) {
    await send("Approve pair to spend AUSD", SETTLEMENT_PAIR_ADDRESS, {
      address: AUSD_ADDRESS,
      abi: erc20Abi,
      functionName: "approve",
      args: [SETTLEMENT_PAIR_ADDRESS, maxUint256],
    } as never);
  }
  if (b.ctkAllowance < maxUint256 / 2n) {
    await send("Approve pair to spend CTK", SETTLEMENT_PAIR_ADDRESS, {
      address: CTK_ADDRESS,
      abi: erc20Abi,
      functionName: "approve",
      args: [SETTLEMENT_PAIR_ADDRESS, maxUint256],
    } as never);
  }

  b = await balances();
  if (b.ausd > 0n) {
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
    const [, ctkOut] = await publicClient.readContract({
      address: SETTLEMENT_PAIR_ADDRESS,
      abi: settlementPairAbi,
      functionName: "getAmountsOut",
      args: [b.ausd, [AUSD_ADDRESS, CTK_ADDRESS]],
    });
    await send(`Convert ${formatUnits(b.ausd, AUSD_DECIMALS)} AUSD into CTK inventory`, SETTLEMENT_PAIR_ADDRESS, {
      address: SETTLEMENT_PAIR_ADDRESS,
      abi: settlementPairAbi,
      functionName: "swapExactTokensForTokens",
      args: [b.ausd, ctkOut, [AUSD_ADDRESS, CTK_ADDRESS], account.address, deadline],
    } as never);
  }

  console.log("\nAfter setup:");
  printBalances(await balances());
}

async function main() {
  const command = process.argv[2] ?? "status";
  console.log(`Operator ${account.address} (key source: ${resolved.ok ? resolved.source : "?"})`);
  if (command === "setup") {
    await setup();
    return;
  }
  const b = await balances();
  printBalances(b);
  await printRunway(b.mon);
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});

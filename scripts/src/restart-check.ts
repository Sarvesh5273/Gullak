/**
 * Kills the API server mid-payout, then checks that recovery after a restart
 * finishes the original payout (or its refund) without moving money twice.
 *
 *   pnpm --filter @workspace/scripts run restart-check arm <scenario>
 *   (restart the API server workflow)
 *   pnpm --filter @workspace/scripts run restart-check verify
 *
 * Scenarios (each kills the server with SIGKILL via the dev-only
 * `x-gullak-test-fault` header):
 *   after-collect  after the member's AUSD transfer to the desk is broadcast
 *   before-swap    after the Agora swap is signed and recorded, before it is broadcast
 *   after-swap     after the Agora swap is broadcast, before its result is saved
 *   after-refund   settlement fails, the refund is broadcast, then the crash
 *
 * `verify` behaves like the app: it retries the same signed authorization,
 * then polls the receipt. It checks the final state, that the member paid
 * exactly once (or was made whole), that the operator sent exactly two
 * transactions (no second swap or refund), and that a later retry returns
 * the same receipt. Each scenario spends ~0.04 test MON; the first `arm`
 * also adds $3 (~0.025 MON).
 *
 * State (a throwaway testnet key and the pending authorization) lives in
 * .local/restart-check.json.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createPublicClient, http, toHex, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import {
  AUSD_ADDRESS,
  AUSD_EIP712_DOMAIN,
  AUTH_TOKEN_TTL_SECONDS,
  MONAD_TESTNET_RPC_URL,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  ausdAbi,
  buildAuthMessage,
  encodeAuthToken,
  formatUsd,
  gullakChain,
} from "@workspace/gullak-core";

const API = process.env["API_BASE"] ?? "http://localhost:80/api";
const AUDIENCE = process.env["REPLIT_DEV_DOMAIN"] ?? "";
const STATE_FILE = path.resolve(import.meta.dirname, "../../.local/restart-check.json");
const AMOUNT = 500_000n; // $0.50 per scenario

const SCENARIOS = {
  "after-collect": { faults: "crash-after-transfer-broadcast", expect: "paid" },
  "before-swap": { faults: "crash-before-settle-broadcast", expect: "paid" },
  "after-swap": { faults: "crash-after-settle-broadcast", expect: "paid" },
  "after-refund": { faults: "settle-fails,crash-after-refund-broadcast", expect: "refunded" },
} as const;
type Scenario = keyof typeof SCENARIOS;

type Auth = { from: Hex; to: Hex; value: string; validAfter: number; validBefore: number; nonce: Hex; signature: Hex };
type State = {
  privateKey: Hex;
  armed?: {
    scenario: Scenario;
    auth: Auth;
    armedAt: string;
    desk: Address;
    operatorNonceBefore: number;
    balanceBefore: string;
  };
};

const publicClient = createPublicClient({ chain: gullakChain, transport: http(MONAD_TESTNET_RPC_URL) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
}

function loadState(): State | null {
  return existsSync(STATE_FILE) ? (JSON.parse(readFileSync(STATE_FILE, "utf8")) as State) : null;
}
function saveState(state: State) {
  mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function token(account: PrivateKeyAccount) {
  const issuedAt = new Date();
  const message = buildAuthMessage({
    address: account.address,
    audience: AUDIENCE,
    issuedAt,
    expiresAt: new Date(issuedAt.getTime() + AUTH_TOKEN_TTL_SECONDS * 1000),
    nonce: randomBytes(16).toString("hex"),
  });
  return encodeAuthToken(message, await account.signMessage({ message }));
}

async function call(method: string, p: string, auth?: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${API}${p}`, {
    method,
    headers: {
      ...(auth ? { authorization: `Bearer ${auth}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(90_000),
  });
  const json = (await res.json().catch(() => null)) as Record<string, any> | null;
  return { status: res.status, json };
}

const operatorNonce = (desk: Address) => publicClient.getTransactionCount({ address: desk, blockTag: "latest" });
const ausdBalance = (who: Address) =>
  publicClient.readContract({ address: AUSD_ADDRESS, abi: ausdAbi, functionName: "balanceOf", args: [who] });

async function apiUp(): Promise<boolean> {
  try {
    const res = await fetch(`${API}/healthz`, { signal: AbortSignal.timeout(3_000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function arm(scenario: Scenario) {
  let state = loadState();
  if (state?.armed) throw new Error(`A ${state.armed.scenario} check is still armed; run verify first.`);
  if (!state) {
    state = { privateKey: generatePrivateKey() };
    saveState(state);
  }
  const account = privateKeyToAccount(state.privateKey);
  const t = await token(account);

  let r = await call("GET", "/me", t);
  if (r.status === 404) {
    r = await call("POST", "/members", t, { handle: `restart_${randomBytes(3).toString("hex")}`, displayName: "Restart Check" });
    if (r.status !== 201) throw new Error(`Register failed: ${r.status} ${JSON.stringify(r.json)}`);
    console.log(`Registered @${r.json?.["handle"]} (${account.address})`);
  }
  const balance = await ausdBalance(account.address);
  if (balance < AMOUNT) {
    r = await call("POST", "/deposits", t, { amount: "3000000" });
    if (r.status !== 201) throw new Error(`Add money failed: ${r.status} ${JSON.stringify(r.json)}`);
    console.log(`Added $3 (${r.json?.["explorerUrl"]})`);
  }

  const config = await call("GET", "/config");
  const desk = config.json?.["sponsor"]?.["address"] as Address | undefined;
  if (!desk) throw new Error("No desk address");

  const validBefore = BigInt(Math.floor(Date.now() / 1000) + 1800);
  const nonce = toHex(randomBytes(32));
  const signature = await account.signTypedData({
    domain: AUSD_EIP712_DOMAIN,
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: { from: account.address, to: desk, value: AMOUNT, validAfter: 0n, validBefore, nonce },
  });
  const auth: Auth = { from: account.address, to: desk, value: AMOUNT.toString(), validAfter: 0, validBefore: Number(validBefore), nonce, signature };

  state.armed = {
    scenario,
    auth,
    armedAt: new Date().toISOString(),
    desk,
    operatorNonceBefore: await operatorNonce(desk),
    balanceBefore: (await ausdBalance(account.address)).toString(),
  };
  saveState(state);
  console.log(`Armed ${scenario}: auth nonce ${nonce}, operator nonce ${state.armed.operatorNonceBefore}, balance ${formatUsd(state.armed.balanceBefore)}`);

  let answered: string;
  try {
    r = await call("POST", "/cashouts", t, { ...auth, upiId: "mother.sharma@okhdfc", recipientName: "Mom" }, {
      "x-gullak-test-fault": SCENARIOS[scenario].faults,
    });
    answered = `${r.status} ${JSON.stringify(r.json)?.slice(0, 160)}`;
  } catch (err) {
    answered = `no answer (${(err as Error).cause ? String((err as any).cause?.code ?? (err as Error).message) : (err as Error).message})`;
  }
  await sleep(3_000);
  const up = await apiUp();
  check("the payout request got no answer", !answered.startsWith("2"), answered);
  check("the API server is down", !up);
  console.log("\nNow inspect the ledger row, restart the API server workflow, then run verify.");
}

async function verify() {
  const state = loadState();
  if (!state?.armed) throw new Error("Nothing armed.");
  const { scenario, auth, desk, operatorNonceBefore, balanceBefore, armedAt } = state.armed;
  const account = privateKeyToAccount(state.privateKey);
  const expect = SCENARIOS[scenario].expect;

  const upStart = Date.now();
  while (!(await apiUp())) {
    if (Date.now() - upStart > 180_000) throw new Error("API did not come back");
    await sleep(1_000);
  }
  const t0 = Date.now();
  const since = () => `${((Date.now() - t0) / 1000).toFixed(0)} s`;
  console.log(`API is up. Scenario ${scenario}, expecting "${expect}".`);
  const t = await token(account);
  const body = { ...auth, upiId: "mother.sharma@okhdfc", recipientName: "Mom" };

  // 1. The app taps again with the same signed authorization.
  let r = await call("POST", "/cashouts", t, body);
  const id = String(r.json?.["id"] ?? "");
  check(
    "retrying the same authorization finds the original payout (no new collection)",
    (r.status === 202 || r.status === 200) && !!id,
    `${r.status} ${r.json?.["payout"]?.["state"] ?? r.json?.["code"]}, id ${id}`,
  );
  const firstTx = r.json?.["txHash"] as string | null;

  // 2. The receipt screen polls until it settles.
  let last = String(r.json?.["payout"]?.["state"] ?? "");
  console.log(`  [${since()}] ${last}`);
  let item = r.json;
  while (Date.now() - t0 < 300_000) {
    if (item?.["status"] !== "pending") break;
    await sleep(5_000);
    const g = await call("GET", `/activity/${id}`, t);
    item = g.json;
    const state2 = String(item?.["payout"]?.["state"] ?? item?.["status"]);
    if (state2 !== last) console.log(`  [${since()}] ${state2}`);
    last = state2;
  }
  const payout = item?.["payout"] ?? {};
  check(`recovered to "${expect}"`, payout["state"] === expect, `${payout["state"]} after ${since()}`);
  check("collection transaction is the one recorded before the crash", !firstTx || item?.["txHash"] === firstTx, String(item?.["txHash"]));
  console.log(`  collection  ${item?.["explorerUrl"] ?? "-"}`);
  console.log(`  swap        ${payout["settlementExplorerUrl"] ?? "-"}`);
  console.log(`  refund      ${payout["refundExplorerUrl"] ?? "-"}`);

  // 3. Chain evidence.
  const used = await publicClient.readContract({
    address: AUSD_ADDRESS,
    abi: ausdAbi,
    functionName: "authorizationState",
    args: [auth.from, auth.nonce],
  });
  check("the member's authorization was used on-chain (collected)", used === true);
  const balanceAfter = await ausdBalance(account.address);
  const delta = balanceAfter - BigInt(balanceBefore);
  const wantDelta = expect === "refunded" ? 0n : -AMOUNT;
  check(
    expect === "refunded" ? "member balance is back where it started" : "member paid exactly once",
    delta === wantDelta,
    `${formatUsd(balanceBefore)} -> ${formatUsd(balanceAfter)}`,
  );
  const nonceAfter = await operatorNonce(desk);
  check(
    `operator sent exactly 2 transactions (collection + ${expect === "refunded" ? "refund" : "swap"}; a duplicate would make 3)`,
    nonceAfter - operatorNonceBefore === 2,
    `${operatorNonceBefore} -> ${nonceAfter}`,
  );

  // 4. A later retry returns the same receipt; the ledger has one row for it.
  r = await call("POST", "/cashouts", t, body);
  check("a later retry returns the same receipt", r.status === 200 && r.json?.["id"] === id, `${r.status} ${r.json?.["payout"]?.["state"]}`);
  const activity = await call("GET", "/me/activity?limit=50", t);
  const rows = ((activity.json as unknown as Array<Record<string, any>>) ?? []).filter(
    (x) => x["kind"] === "cashout" && new Date(x["createdAt"]).getTime() >= new Date(armedAt).getTime() - 5_000,
  );
  check("Activity shows one payout for this attempt", rows.length === 1, `${rows.length}`);

  delete state.armed;
  saveState(state);
  console.log(failures ? `\n${failures} check(s) failed` : "\nAll restart checks passed");
  process.exit(failures ? 1 : 0);
}

async function main() {
  if (!AUDIENCE) throw new Error("REPLIT_DEV_DOMAIN is not set");
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "arm" && arg && arg in SCENARIOS) await arm(arg as Scenario);
  else if (cmd === "verify") await verify();
  else throw new Error(`Usage: restart-check arm <${Object.keys(SCENARIOS).join("|")}> | verify`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

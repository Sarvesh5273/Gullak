/**
 * End-to-end API check with two throwaway accounts.
 *
 *   pnpm --filter @workspace/scripts run smoke
 *
 * Always checks sign-in, profiles, lookups and transfer/cash-out validation.
 * When the operator is funded it also runs, for real on Monad testnet:
 * add $3, send $1 (and retry it), Send to UPI $1 (and retry it), a payout
 * whose settlement fails and is refunded, and a payout interrupted after the
 * transfer that the reconciler finishes. 9 sponsored transactions, ~0.14 MON.
 * The two fault cases use the dev-only `x-gullak-test-fault` header.
 */
import { randomBytes } from "node:crypto";
import { toHex, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import {
  AUSD_EIP712_DOMAIN,
  AUTH_TOKEN_TTL_SECONDS,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  buildAuthMessage,
  encodeAuthToken,
  formatUsd,
} from "@workspace/gullak-core";

const API = process.env["API_BASE"] ?? "http://localhost:80/api";
const AUDIENCE = process.env["REPLIT_DEV_DOMAIN"] ?? "";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
}

async function token(account: PrivateKeyAccount, opts: { audience?: string; issuedAt?: Date; ttlSeconds?: number } = {}) {
  const issuedAt = opts.issuedAt ?? new Date();
  const expiresAt = new Date(issuedAt.getTime() + (opts.ttlSeconds ?? AUTH_TOKEN_TTL_SECONDS) * 1000);
  const message = buildAuthMessage({
    address: account.address,
    audience: opts.audience ?? AUDIENCE,
    issuedAt,
    expiresAt,
    nonce: randomBytes(16).toString("hex"),
  });
  return encodeAuthToken(message, await account.signMessage({ message }));
}

async function call(method: string, path: string, auth?: string, body?: unknown, extraHeaders: Record<string, string> = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(auth ? { authorization: `Bearer ${auth}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return { status: res.status, json };
}

async function signTransfer(signer: PrivateKeyAccount, from: Hex, to: Hex, value: bigint) {
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + 600);
  const nonce = toHex(randomBytes(32));
  const signature = await signer.signTypedData({
    domain: AUSD_EIP712_DOMAIN,
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: { from, to, value, validAfter: 0n, validBefore, nonce },
  });
  return { from, to, value: value.toString(), validAfter: 0, validBefore: Number(validBefore), nonce, signature };
}

async function main() {
  if (!AUDIENCE) throw new Error("REPLIT_DEV_DOMAIN is not set");
  const a = privateKeyToAccount(generatePrivateKey());
  const b = privateKeyToAccount(generatePrivateKey());
  const suffix = randomBytes(3).toString("hex");
  const ta = await token(a);
  const tb = await token(b);

  let r = await call("GET", "/me", ta);
  check("new account has no profile", r.status === 404, String(r.json?.["code"]));

  r = await call("GET", "/me", await token(a, { audience: "evil.example.com" }));
  check("token for another site is rejected", r.status === 401, String(r.json?.["error"]));
  r = await call("GET", "/me", await token(a, { issuedAt: new Date(Date.now() - 3_600_000), ttlSeconds: 600 }));
  check("expired token is rejected", r.status === 401, String(r.json?.["error"]));
  r = await call("GET", "/me", ta.slice(0, -4) + "0000");
  check("tampered token is rejected", r.status === 401, String(r.json?.["error"]));

  r = await call("POST", "/members", ta, { handle: `smoke_a_${suffix}`, displayName: "Smoke A", country: "AE" });
  check("register A (country AE)", r.status === 201 && r.json?.["country"] === "AE", `${r.json?.["handle"]} ${r.json?.["country"]}`);
  r = await call("POST", "/members", tb, { handle: `smoke_b_${suffix}`, displayName: "Smoke B" });
  check("register B", r.status === 201, String(r.json?.["handle"]));
  r = await call("POST", "/members", ta, { handle: `smoke_c_${suffix}`, displayName: "Again" });
  check("second profile for A is refused", r.status === 409, String(r.json?.["code"]));
  r = await call("POST", "/members", tb, { handle: `smoke_a_${suffix}`, displayName: "Dup" });
  check("duplicate profile refused", r.status === 409, String(r.json?.["code"]));

  r = await call("GET", `/members/SMOKE_B_${suffix}`, ta);
  check("exact handle lookup (case-insensitive)", r.status === 200 && r.json?.["address"] === b.address);
  r = await call("GET", "/members/smoke_nobody_x", ta);
  check("unknown handle is 404", r.status === 404);

  r = await call("GET", `/members/smoke_b_${suffix}`, ta);
  check("B defaults to India", r.json?.["country"] === "IN", String(r.json?.["country"]));
  r = await call("PATCH", "/me", tb, { country: "ZZ" });
  check("unsupported country is rejected", r.status === 400 && r.json?.["code"] === "bad_country", String(r.json?.["code"]));
  r = await call("PATCH", "/me", tb, { country: "gb" });
  check("malformed country is rejected", r.status === 400, String(r.json?.["code"]));
  r = await call("PATCH", "/me", tb, { country: "GB" });
  check("B changes country to GB", r.status === 200 && r.json?.["country"] === "GB", String(r.json?.["country"]));
  r = await call("PATCH", "/me", tb, { country: "IN" });
  check("B changes back to IN", r.status === 200 && r.json?.["country"] === "IN", String(r.json?.["country"]));

  r = await call("GET", "/fx");
  const fxRates = (r.json?.["rates"] as Array<{ currency: string; rate: number }> | undefined) ?? [];
  const inr = fxRates.find((x) => x.currency === "INR")?.rate;
  check(
    "exchange rates with attribution",
    r.status === 200 && typeof inr === "number" && inr > 50 && inr < 200 && typeof r.json?.["sourceUrl"] === "string",
    `INR ${inr}, as of ${String(r.json?.["asOf"])}, ${fxRates.length} currencies`,
  );

  r = await call("GET", "/me/balance", ta);
  check("balance read", r.status === 200, `${formatUsd(String(r.json?.["amount"] ?? "0"))}`);

  const forged = await signTransfer(b, a.address, b.address, 1_000_000n);
  r = await call("POST", "/transfers", ta, forged);
  check("transfer signed by someone else is rejected", r.status === 400 && r.json?.["code"] === "bad_signature", String(r.json?.["code"]));

  const tooBig = await signTransfer(a, a.address, b.address, 501_000_000n);
  r = await call("POST", "/transfers", ta, tooBig);
  check("over-limit transfer is rejected", r.status === 422, String(r.json?.["code"]));

  const config = await call("GET", "/config");
  const sponsor = config.json?.["sponsor"] as { relayReady: boolean; depositReady: boolean; address: Hex | null } | undefined;

  // Payout requests are rate limited to 3 a minute per account: A makes three below, B the rest.
  const notToDesk = await signTransfer(b, b.address, a.address, 1_000_000n);
  r = await call("POST", "/cashouts", tb, { ...notToDesk, upiId: "smoke@okhdfc" });
  check("cash-out not paid to the desk is rejected", r.status === 400 && r.json?.["code"] === "bad_destination", String(r.json?.["code"]));
  if (sponsor?.address) {
    const badUpi = await signTransfer(b, b.address, sponsor.address, 1_000_000n);
    r = await call("POST", "/cashouts", tb, { ...badUpi, upiId: "not-a-upi-id" });
    check("cash-out with a bad UPI ID is rejected", r.status === 422 && r.json?.["code"] === "bad_upi_id", String(r.json?.["code"]));
  }

  if (process.env["SMOKE_CHAIN"] === "0") {
    console.log("\nSMOKE_CHAIN=0: skipped the on-chain part (no MON spent).");
  } else if (!sponsor?.depositReady) {
    const transfer = await signTransfer(a, a.address, b.address, 1_000_000n);
    r = await call("POST", "/transfers", ta, transfer);
    check(
      "unfunded path fails explicitly",
      (r.status === 503 && r.json?.["code"] === "sponsor_unavailable") || (r.status === 422 && r.json?.["code"] === "insufficient_funds"),
      `${r.status} ${String(r.json?.["code"])}`,
    );
    console.log("\nOperator not ready for add-money; skipped the on-chain part.");
  } else {
    r = await call("POST", "/deposits", ta, { amount: "3000000" });
    const depositFx = r.json?.["fx"] as { currency?: string } | null | undefined;
    check(
      "add $3 via Instant Settlement (AED snapshot)",
      r.status === 201 && depositFx?.currency === "AED",
      `${r.json?.["settleMs"]} ms, ${r.json?.["explorerUrl"]}, fx ${JSON.stringify(depositFx)}`,
    );
    const transfer = await signTransfer(a, a.address, b.address, 1_000_000n);
    r = await call("POST", "/transfers", ta, transfer);
    const sendFx = r.json?.["fx"] as { currency?: string } | null | undefined;
    const sendId = r.json?.["id"];
    const sendHash = r.json?.["txHash"];
    check(
      "gasless send $1 A -> B (recipient's INR snapshot)",
      r.status === 201 && sendFx?.currency === "INR",
      `${r.json?.["settleMs"]} ms, ${r.json?.["explorerUrl"]}, fx ${JSON.stringify(sendFx)}`,
    );
    r = await call("POST", "/transfers", ta, transfer);
    check(
      "retrying the same signed send returns the first result, no second payment",
      r.status === 200 && r.json?.["id"] === sendId && r.json?.["txHash"] === sendHash,
      `${r.status} ${String(r.json?.["code"] ?? r.json?.["status"])}`,
    );
    const activity = await call("GET", "/me/activity", tb);
    const received = (activity.json as unknown as Array<Record<string, unknown>>) ?? [];
    check("B sees exactly one receive", received.filter((x) => x["kind"] === "receive").length === 1 && received[0]?.["amount"] === "1000000");

    if (sponsor.address) {
      const desk = sponsor.address;
      type Payout = { state?: string; destination?: string; recipientName?: string | null; settlementExplorerUrl?: string; refundExplorerUrl?: string | null };

      const toMom = await signTransfer(a, a.address, desk, 1_000_000n);
      r = await call("POST", "/cashouts", ta, { ...toMom, upiId: "mother.sharma@okhdfc", recipientName: "Mom", note: "For Diwali" });
      let payout = r.json?.["payout"] as Payout | undefined;
      const momId = r.json?.["id"];
      check(
        "Send to UPI $1 to Mom via Instant Settlement",
        r.status === 201 && payout?.state === "paid" && payout?.recipientName === "Mom" && payout?.destination === "UPI mo•••@okhdfc" && r.json?.["note"] === "For Diwali",
        `${r.status} ${r.json?.["settleMs"] ?? r.json?.["code"]} ms, ${payout?.settlementExplorerUrl}, fx ${JSON.stringify(r.json?.["fx"])}`,
      );
      r = await call("POST", "/cashouts", ta, { ...toMom, upiId: "mother.sharma@okhdfc", recipientName: "Mom" });
      check("retrying the same Send to UPI returns the first result", r.status === 200 && r.json?.["id"] === momId, `${r.status} ${String(r.json?.["code"] ?? "")}`);

      const before = BigInt(String((await call("GET", "/me/balance", ta)).json?.["amount"] ?? "0"));
      const doomed = await signTransfer(a, a.address, desk, 500_000n);
      r = await call("POST", "/cashouts", ta, { ...doomed, upiId: "mother.sharma@okhdfc", recipientName: "Mom" }, { "x-gullak-test-fault": "settle-fails" });
      payout = r.json?.["payout"] as Payout | undefined;
      const after = BigInt(String((await call("GET", "/me/balance", ta)).json?.["amount"] ?? "0"));
      check(
        "failed settlement is refunded, and says so only after the refund is mined",
        r.status === 201 && r.json?.["status"] === "failed" && payout?.state === "refunded" && !!payout?.refundExplorerUrl && after === before,
        `${r.status} ${payout?.state}, refund ${payout?.refundExplorerUrl}, balance ${formatUsd(before)} -> ${formatUsd(after)}`,
      );

      const interrupted = await signTransfer(b, b.address, desk, 500_000n);
      r = await call("POST", "/cashouts", tb, { ...interrupted, upiId: "smoke.b@okhdfc" }, { "x-gullak-test-fault": "stop-after-transfer" });
      payout = r.json?.["payout"] as Payout | undefined;
      const stuckId = String(r.json?.["id"] ?? "");
      check("cash-out interrupted after the transfer is reported as settling", r.status === 202 && payout?.state === "settling", `${r.status} ${payout?.state}`);
      r = await call("GET", `/activity/${stuckId}`, tb);
      payout = r.json?.["payout"] as Payout | undefined;
      check(
        "reading it finishes the settlement from chain state",
        r.status === 200 && r.json?.["status"] === "confirmed" && payout?.state === "paid" && payout?.recipientName === null && !!payout?.settlementExplorerUrl,
        `${r.json?.["status"]} ${payout?.state}, ${payout?.settlementExplorerUrl}`,
      );
    }
  }

  console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

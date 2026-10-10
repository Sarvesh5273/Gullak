/**
 * Browser check of the Gullak web app with a virtual passkey.
 *
 *   pnpm --filter @workspace/scripts run e2e-web
 *
 * Drives headless Chromium over the DevTools protocol with a virtual platform
 * authenticator that supports PRF. It creates an account, walks Home,
 * Activity, Account, Add money, Send, Cash out and Send to UPI, then locks
 * and unlocks (saved passkey), forgets the device and signs in again
 * (discoverable passkey), checking that the same account comes back each
 * time. Screenshots go to .local/shots/.
 *
 * E2E_CHAIN=1 also adds $10, sends $1 to another member's @handle, and sends
 * $1 to a UPI ID with the first answer cut off, checking that tapping again
 * pays once (~0.08 test MON).
 *
 * Env: APP_URL (default https://$REPLIT_EXPO_DEV_DOMAIN), CHROMIUM_PATH,
 * API_BASE (default http://localhost:80/api).
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { AUTH_TOKEN_TTL_SECONDS, buildAuthMessage, encodeAuthToken } from "@workspace/gullak-core";

const CHROMIUM = process.env["CHROMIUM_PATH"] ?? "/repl/tools/bin/chromium";
const APP = process.env["APP_URL"] ?? `https://${process.env["REPLIT_EXPO_DEV_DOMAIN"] ?? ""}`;
const API = process.env["API_BASE"] ?? "http://localhost:80/api";
// Sign-in tokens name the API's host; the dev server is reached via localhost.
const AUDIENCE = /^http:\/\/localhost[:/]/.test(API) ? (process.env["REPLIT_DEV_DOMAIN"] ?? "") : new URL(API).host;
const SHOTS = path.resolve(import.meta.dirname, "../../.local/shots");
const STORAGE_KEY = "gullak.account.v1";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type CdpMessage = { id?: number; method?: string; params?: any; result?: any; error?: { message: string }; sessionId?: string };

class Cdp {
  private nextId = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private handlers: ((msg: CdpMessage) => void)[] = [];

  private constructor(private ws: WebSocket) {
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as CdpMessage;
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      } else {
        for (const h of this.handlers) h(msg);
      }
    };
  }

  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("Could not connect to Chromium"));
    });
    return new Cdp(ws);
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    const id = ++this.nextId;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  on(handler: (msg: CdpMessage) => void) {
    this.handlers.push(handler);
  }

  close() {
    this.ws.close();
  }
}

async function launchChromium(profileDir: string) {
  const proc = spawn(
    CHROMIUM,
    ["--headless=new", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${profileDir}`, "about:blank"],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const wsUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Chromium did not start")), 30_000);
    proc.stderr.on("data", (d: Buffer) => {
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(String(d));
      if (m) {
        clearTimeout(timer);
        resolve(m[1]!);
      }
    });
    proc.on("exit", (code) => reject(new Error(`Chromium exited early (${code})`)));
  });
  return { proc, wsUrl };
}

type Account = ReturnType<typeof privateKeyToAccount>;

async function authHeader(account: Account) {
  const issuedAt = new Date();
  const message = buildAuthMessage({
    address: account.address,
    audience: AUDIENCE,
    issuedAt,
    expiresAt: new Date(issuedAt.getTime() + AUTH_TOKEN_TTL_SECONDS * 1000),
    nonce: randomBytes(16).toString("hex"),
  });
  return `Bearer ${encodeAuthToken(message, await account.signMessage({ message }))}`;
}

async function registerOtherMember(handle: string, displayName: string): Promise<Account> {
  const account = privateKeyToAccount(generatePrivateKey());
  const res = await fetch(`${API}/members`, {
    method: "POST",
    headers: { authorization: await authHeader(account), "content-type": "application/json" },
    body: JSON.stringify({ handle, displayName }),
  });
  if (res.status !== 201) throw new Error(`Could not register @${handle}: ${res.status}`);
  return account;
}

/** The member's AUSD balance in base units, read by the server from Monad. */
async function balanceOf(account: Account): Promise<bigint> {
  const res = await fetch(`${API}/me/balance`, { headers: { authorization: await authHeader(account) } });
  if (!res.ok) throw new Error(`Balance read failed: ${res.status}`);
  return BigInt(((await res.json()) as { amount: string }).amount);
}

async function main() {
  // Passkeys need a secure context: https, or http://localhost for a local production build.
  if (!/^(https:\/\/.+|http:\/\/localhost(:\d+)?)$/.test(APP)) throw new Error("Set APP_URL or REPLIT_EXPO_DEV_DOMAIN");
  if (!AUDIENCE) throw new Error("REPLIT_DEV_DOMAIN is not set (needed for a localhost API_BASE)");
  mkdirSync(SHOTS, { recursive: true });

  const profileDir = mkdtempSync(path.join(os.tmpdir(), "gullak-e2e-"));
  const { proc, wsUrl } = await launchChromium(profileDir);
  const cdp = await Cdp.connect(wsUrl);
  const pageErrors: string[] = [];

  try {
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const page = (method: string, params: Record<string, unknown> = {}) => cdp.send(method, params, sessionId);

    cdp.on((msg) => {
      if (msg.sessionId !== sessionId) return;
      if (msg.method === "Runtime.exceptionThrown") {
        pageErrors.push(msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text);
      } else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
        pageErrors.push(msg.params.args.map((a: any) => a.value ?? a.description ?? "").join(" "));
      } else if (msg.method === "Page.javascriptDialogOpening") {
        void page("Page.handleJavaScriptDialog", { accept: true });
      }
    });

    await page("Page.enable");
    await page("Runtime.enable");
    await page("Emulation.setDeviceMetricsOverride", { width: 402, height: 874, deviceScaleFactor: 2, mobile: true });
    await page("WebAuthn.enable", { enableUI: false });
    const { authenticatorId } = await page("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        ctap2Version: "ctap2_1",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
        hasPrf: true,
      },
    });

    const evaluate = async <T>(expression: string): Promise<T> => {
      const r = await page("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value as T;
    };
    const waitUntil = async (what: string, expression: string, timeoutMs = 30_000) => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (await evaluate<boolean>(expression).catch(() => false)) return;
        await sleep(250);
      }
      throw new Error(`Timed out waiting for ${what}`);
    };
    const sel = (testId: string) => `[data-testid="${testId}"]`;
    const waitFor = (testId: string, timeoutMs?: number) =>
      waitUntil(testId, `!!document.querySelector(${JSON.stringify(sel(testId))})`, timeoutMs);
    const waitForText = (text: string, timeoutMs?: number) =>
      waitUntil(`"${text}"`, `document.body.innerText.includes(${JSON.stringify(text)})`, timeoutMs);
    const waitForEnabled = (testId: string, timeoutMs?: number) =>
      waitUntil(
        `${testId} enabled`,
        `(() => { const el = document.querySelector(${JSON.stringify(sel(testId))}); return !!el && el.getAttribute('aria-disabled') !== 'true'; })()`,
        timeoutMs,
      );
    const clickAt = async (expression: string) => {
      const box = await evaluate<{ x: number; y: number } | null>(`(() => {
        const el = ${expression};
        if (!el) return null;
        el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()`);
      if (!box) throw new Error(`Nothing to click for ${expression}`);
      await page("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
      await page("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
      await page("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
      await sleep(150);
    };
    const click = async (testId: string) => {
      await waitFor(testId);
      await clickAt(`document.querySelector(${JSON.stringify(sel(testId))})`);
    };
    const clickText = async (text: string) => {
      await waitForText(text);
      // Icon fonts render glyphs from the Private Use Area; ignore them when matching labels.
      await clickAt(`[...document.querySelectorAll('a,[role="button"],[role="tab"],[role="link"],button')]
        .filter((el) => el.innerText.replace(/[\\uE000-\\uF8FF]/g, '').trim() === ${JSON.stringify(text)} && el.getBoundingClientRect().width > 0)
        .pop()`);
    };
    const type = async (testId: string, text: string) => {
      await click(testId);
      await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel(testId))}); el.focus(); el.select(); })()`);
      await page("Input.insertText", { text });
      await sleep(100);
    };
    const shot = async (name: string) => {
      await sleep(600);
      const { data } = await page("Page.captureScreenshot", { format: "png" });
      writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(data, "base64"));
    };
    const savedAccount = async () => {
      const raw = await evaluate<string | null>(`localStorage.getItem(${JSON.stringify(STORAGE_KEY)})`);
      return raw ? (JSON.parse(raw) as { address: string; handle?: string }) : null;
    };
    const balanceText = () =>
      evaluate<string>(`document.querySelector(${JSON.stringify(sel("text-balance"))})?.innerText ?? ''`);

    const suffix = randomBytes(3).toString("hex");
    const handle = `e2e_${suffix}`;
    const friend = `e2e_f_${suffix}`;
    const friendAccount = await registerOtherMember(friend, "Ravi Kumar");

    // --- create -----------------------------------------------------------
    await page("Page.navigate", { url: `${APP}/welcome` });
    await waitFor("button-start-create", 90_000);
    await shot("01-welcome");
    await click("button-start-create");
    await type("input-name", "Asha Verma");
    await type("input-handle", handle);
    await waitForEnabled("button-create", 15_000);
    await shot("02-create");
    await click("button-create");
    await waitUntil("balance", `/\\$\\d/.test(document.querySelector(${JSON.stringify(sel("text-balance"))})?.innerText ?? '')`, 60_000);
    const created = await savedAccount();
    check("passkey sign-up opens Home with a dollar balance", true, await balanceText());
    check("account is remembered on this device", !!created && created.handle === handle, created?.address ?? "none");
    check("Home greets by first name", await evaluate<boolean>(`document.body.innerText.includes('Asha')`));
    await shot("03-home");

    // --- tabs -------------------------------------------------------------
    await clickText("Activity");
    await waitForText("shows up here");
    check("Activity tab shows the empty state", true);
    await shot("04-activity");
    await clickText("Account");
    await waitForText("Quick sends left");
    check("Account tab shows the profile", await evaluate<boolean>(`document.body.innerText.includes('@${handle}')`));
    await shot("05-account");
    const countryRow = () => evaluate<string>(`document.querySelector(${JSON.stringify(sel("row-country"))})?.innerText ?? ''`);
    check("Account shows the guessed country", (await countryRow()).includes("·"), await countryRow());
    await click("row-country");
    await waitFor("country-AE");
    await shot("05b-country");
    await click("country-AE");
    await waitUntil(
      "country saved",
      `(document.querySelector(${JSON.stringify(sel("row-country"))})?.innerText ?? '').includes('AED')`,
      15_000,
    );
    check("changing country to UAE is saved", true, await countryRow());
    await clickText("Home");
    await waitFor("button-add-money");

    // --- add money (desk may be unfunded) --------------------------------
    await click("button-add-money");
    await waitFor("button-confirm-deposit");
    await shot("06-add-money");
    await click("modal-close");
    await waitFor("button-send");

    // --- send screen --------------------------------------------------------
    await click("button-send");
    await type("input-recipient", friend);
    await waitForText("Ravi Kumar", 15_000);
    check("Send finds a member by handle", true, `@${friend}`);
    await type("input-amount", "5");
    await type("input-note", "Chai money");
    await sleep(400);
    const sendDisabled = await evaluate<boolean>(
      `document.querySelector(${JSON.stringify(sel("button-confirm-send"))})?.getAttribute('aria-disabled') === 'true'`,
    );
    const hasBalance = !(await balanceText().catch(() => "$0.00")).startsWith("$0.00");
    check("Send is blocked when the balance is too low", hasBalance || sendDisabled);
    const recipientLocal = () =>
      evaluate<string>(`document.querySelector(${JSON.stringify(sel("text-recipient-local"))})?.innerText ?? ''`);
    await waitUntil("recipient local amount", `!!document.querySelector(${JSON.stringify(sel("text-recipient-local"))})`, 15_000);
    check("Send shows what Ravi gets in rupees", (await recipientLocal()).startsWith("Ravi gets ≈ ₹"), await recipientLocal());
    check("rates are credited", await evaluate<boolean>(`document.body.innerText.includes('Exchange Rate API')`));
    await shot("07-send");
    await click("modal-close");

    // --- cash-out screen (no on-chain spend: new account has $0) -----------
    await waitFor("button-cash-out");
    await click("button-cash-out");
    await waitFor("input-upi-id");
    await type("input-cashout-amount", "5");
    await type("input-upi-id", "asha-at-bank");
    await evaluate(`(document.activeElement instanceof HTMLElement && document.activeElement.blur(), true)`); // blur shows the hint
    await waitForText("A UPI ID has an @", 5_000);
    check("Cash out flags a malformed UPI ID", true);
    await type("input-upi-id", "asha@okhdfc");
    await sleep(400);
    const cashoutDisabled = await evaluate<boolean>(
      `document.querySelector(${JSON.stringify(sel("button-confirm-cashout"))})?.getAttribute('aria-disabled') === 'true'`,
    );
    check("Cash out is blocked when the balance is too low", hasBalance || cashoutDisabled);
    check("Cash out explains the testnet payout", await evaluate<boolean>(`document.body.innerText.includes('simulated')`));
    const payoutLocal = await evaluate<string>(`document.querySelector(${JSON.stringify(sel("text-cashout-local"))})?.innerText ?? ''`);
    check("Cash out shows the rupee payout", /^≈ ₹[\d,]+\.\d\d to your bank$/.test(payoutLocal), payoutLocal);
    await shot("07b-cash-out");
    await click("modal-close");

    // --- send to UPI screen (someone without Gullak) --------------------------
    await click("button-send");
    await click("link-send-upi");
    await waitFor("input-recipient-name");
    await type("input-recipient-name", "Mom");
    await type("input-upi-id", "mother@okhdfc");
    await type("input-cashout-amount", "5");
    const momLocal = () => evaluate<string>(`document.querySelector(${JSON.stringify(sel("text-cashout-local"))})?.innerText ?? ''`);
    await waitUntil("Mom's rupee amount", `!!document.querySelector(${JSON.stringify(sel("text-cashout-local"))})`, 15_000);
    check("Send to UPI shows what Mom gets", /^Mom gets ≈ ₹[\d,]+\.\d\d$/.test(await momLocal()), await momLocal());
    const upiCopy = await evaluate<string>("document.body.innerText");
    check(
      "Send to UPI labels CTK as a test token, rupees as indicative and the payout as simulated",
      upiCopy.includes("CTK, Agora's test token") && upiCopy.includes("indicative") && upiCopy.includes("simulated"),
    );
    const upiButton = await evaluate<string>(`document.querySelector(${JSON.stringify(sel("button-confirm-cashout"))})?.innerText ?? ''`);
    check("Send to UPI names the recipient on the button", upiButton.includes("Send $5.00 to Mom"), upiButton.trim());
    await shot("07c-send-upi");
    await click("modal-close");

    // --- on-chain: add money, send to @handle, then Send to UPI with the first
    // response lost. Opt-in (spends ~0.08 test MON): E2E_CHAIN=1.
    if (process.env["E2E_CHAIN"] === "1") {
      const balanceIs = (usd: string) =>
        waitUntil(`balance of $${usd}`, `(document.querySelector(${JSON.stringify(sel("text-balance"))})?.innerText ?? '').startsWith('$${usd}')`, 30_000);
      await waitFor("button-add-money");
      await click("button-add-money");
      await click("preset-10");
      await click("button-confirm-deposit");
      await waitForText("Added to your Gullak", 90_000);
      check("Add money lands on Monad", true);
      await click("button-receipt-done");
      await balanceIs("10.00");

      await click("button-send");
      await type("input-recipient", friend);
      await waitForText("Ravi Kumar", 15_000);
      await type("input-amount", "1");
      await type("input-note", "Chai money");
      await waitForEnabled("button-confirm-send", 15_000);
      await click("button-confirm-send");
      await waitForText("Sent to Ravi Kumar", 90_000);
      await shot("13-receipt-send-handle");
      await click("button-receipt-done");
      await balanceIs("9.00");
      const friendGot = await balanceOf(friendAccount);
      check(`Send to @handle lands on Monad (@${friend} holds $1)`, friendGot === 1_000_000n, `${friendGot} base units`);

      await click("button-send");
      await click("link-send-upi");
      await type("input-recipient-name", "Mom");
      await type("input-upi-id", "mother@okhdfc");
      await type("input-cashout-amount", "1");
      await type("input-note", "For groceries");

      // The server handles the first POST, but the app never sees the answer.
      let cutOff = 0;
      cdp.on((msg) => {
        if (msg.sessionId !== sessionId || msg.method !== "Fetch.requestPaused") return;
        const { requestId, request } = msg.params;
        if (request.method === "POST" && cutOff === 0) {
          cutOff += 1;
          void page("Fetch.failRequest", { requestId, errorReason: "ConnectionReset" });
        } else {
          void page("Fetch.continueRequest", { requestId });
        }
      });
      await page("Fetch.enable", { patterns: [{ urlPattern: "*/api/cashouts*", requestStage: "Response" }] });
      await waitForEnabled("button-confirm-cashout", 15_000);
      await click("button-confirm-cashout");
      await waitForText("couldn't confirm this payment", 90_000);
      check("A lost answer asks to tap again", cutOff === 1);
      await shot("10-send-upi-lost-answer");
      await page("Fetch.disable");

      await click("button-confirm-cashout");
      await waitForText("Sent to Mom", 90_000);
      const receipt = await evaluate<string>("document.body.innerText");
      check("Tapping again opens the same payout's receipt", true);
      check(
        "Receipt labels the simulated payout, CTK test token and indicative rupees",
        receipt.includes("UPI payout simulated") && receipt.includes("CTK, Agora's test token") && receipt.includes("(indicative)"),
      );
      await shot("11-receipt-send-upi");
      await click("button-receipt-done");
      await balanceIs("8.00");
      check("Only $1 left the balance for the payout", true, await balanceText());
      await clickText("Activity");
      await waitForText("Mom");
      // Inactive tabs stay mounted, so count only rows that are on top at their own centre.
      const momRows = await evaluate<number>(
        `[...document.querySelectorAll('[data-testid^="activity-"]')].filter((el) => {
          const r = el.getBoundingClientRect();
          const hit = r.width > 0 && document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          return !!hit && el.contains(hit) && el.innerText.includes('Mom');
        }).length`,
      );
      check("Activity shows one payout to Mom", momRows === 1, `${momRows}`);
      await shot("12-activity-after-upi");
      await clickText("Home");
    }

    // --- lock and unlock with the saved passkey ---------------------------
    await clickText("Account");
    await click("button-lock");
    await waitFor("button-unlock");
    await shot("08-locked");
    await click("button-unlock");
    await waitFor("text-balance", 60_000);
    const unlocked = await savedAccount();
    check("unlock restores the same account", unlocked?.address === created?.address, unlocked?.address ?? "none");

    // --- forget device, then sign in with the discoverable passkey ---------
    await clickText("Account");
    await clickText("Forget this device");
    await waitFor("button-signin", 15_000);
    check("forget device clears the saved account", (await savedAccount()) === null);
    await click("button-signin");
    await waitFor("text-balance", 60_000);
    const signedIn = await savedAccount();
    check("passkey sign-in on a fresh device finds the same account", signedIn?.address === created?.address, signedIn?.address ?? "none");
    await shot("09-home-again");

    const { credentials } = await page("WebAuthn.getCredentials", { authenticatorId });
    check("one passkey was created", credentials.length === 1, `${credentials.length}`);
  } catch (err) {
    failures += 1;
    console.log(`FAIL  ${(err as Error).message}`);
    try {
      const { targetInfos } = await cdp.send("Target.getTargets");
      console.log(`      open pages: ${targetInfos.map((t: any) => t.url).join(", ")}`);
    } catch {
      // ignore
    }
  } finally {
    if (pageErrors.length) {
      console.log(`\nPage errors (${pageErrors.length}):`);
      for (const e of pageErrors.slice(0, 10)) console.log(`  - ${String(e).split("\n")[0]}`);
    }
    cdp.close();
    const exited = new Promise((resolve) => proc.once("exit", resolve));
    proc.kill();
    await Promise.race([exited, sleep(5_000)]);
    rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }

  console.log(`\nScreenshots: ${SHOTS}`);
  console.log(failures === 0 ? "All browser checks passed." : `${failures} browser check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

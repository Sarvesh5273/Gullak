/**
 * Publishes a signed Android APK for public download:
 *
 *   pnpm --filter @workspace/scripts run publish-apk [path/to/app.apk]
 *
 * Refuses unless the APK is com.gullak.app signed by exactly one certificate
 * that ANDROID_CERT_SHA256 lists (the release key). Uploads it to App Storage;
 * /api/downloads/gullak.apk redirects there (the new file is live immediately,
 * also for the published app). Then writes artifacts/gullak/server/android-release.json,
 * the details the /android install page shows (live after the next publish).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Storage } from "@google-cloud/storage";

const ROOT = path.resolve(import.meta.dirname, "../..");
// Must match ANDROID_APK_OBJECT_KEY in artifacts/api-server/src/routes/downloads.ts.
const OBJECT_KEY = "downloads/gullak-android.apk";
const DOWNLOAD_PATH = "/api/downloads/gullak.apk";
const PACKAGE_NAME = "com.gullak.app";
const DEFAULT_APK = path.join(ROOT, "artifacts/gullak/android/app/build/outputs/apk/release/app-release.apk");
const RELEASE_JSON = path.join(ROOT, "artifacts/gullak/server/android-release.json");
const TOOLS = path.join(ROOT, ".cache/gullak-android");

function fail(message: string): never {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function buildTool(name: string): string {
  const dir = path.join(TOOLS, "sdk/build-tools");
  if (!existsSync(dir)) fail(`no Android build tools at ${dir} (run build-android.sh once)`);
  const versions = readdirSync(dir).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const tool = path.join(dir, versions.at(-1) ?? "", name);
  if (!existsSync(tool)) fail(`missing ${tool}`);
  return tool;
}

function run(tool: string, args: string[]): string {
  return execFileSync(tool, args, {
    encoding: "utf8",
    env: { ...process.env, JAVA_HOME: path.join(TOOLS, "jdk"), PATH: `${path.join(TOOLS, "jdk/bin")}:${process.env["PATH"]}` },
  });
}

function digest(file: string, algorithm: "sha256" | "md5"): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const hash = createHash(algorithm);
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest()));
  });
}

const colonHex = (hex: string) => hex.toUpperCase().match(/../g)!.join(":");

async function main() {
  const apk = path.resolve(process.argv[2] ?? DEFAULT_APK);
  if (!existsSync(apk)) fail(`no APK at ${apk}`);
  const bucketId = process.env["DEFAULT_OBJECT_STORAGE_BUCKET_ID"];
  if (!bucketId) fail("DEFAULT_OBJECT_STORAGE_BUCKET_ID is not set (App Storage isn't provisioned)");

  // --- what is it, and who signed it ---------------------------------------
  const badging = run(buildTool("aapt2"), ["dump", "badging", apk]);
  const field = (re: RegExp) => re.exec(badging)?.[1] ?? fail(`aapt2 output has no ${re}`);
  const packageName = field(/^package: name='([^']+)'/m);
  const versionName = field(/versionName='([^']+)'/);
  const versionCode = Number(field(/versionCode='(\d+)'/));
  const minSdk = Number(field(/^(?:minSdkVersion|sdkVersion):'(\d+)'/m));
  if (packageName !== PACKAGE_NAME) fail(`package is ${packageName}, expected ${PACKAGE_NAME}`);

  const certs = run(buildTool("apksigner"), ["verify", "--print-certs", apk]);
  const signers = [...certs.matchAll(/certificate SHA-256 digest: ([0-9a-f]{64})/g)].map((m) => colonHex(m[1]!));
  if (signers.length !== 1) fail(`expected exactly one signer, found ${signers.length}`);
  const signerSha256 = signers[0]!;
  const trusted = (process.env["ANDROID_CERT_SHA256"] ?? "").split(",").map((f) => f.trim().toUpperCase());
  if (!trusted.includes(signerSha256)) {
    fail(`signer ${signerSha256} is not in ANDROID_CERT_SHA256, so Android would refuse passkeys`);
  }

  const bytes = statSync(apk).size;
  const sha256 = (await digest(apk, "sha256")).toString("hex");
  const md5 = (await digest(apk, "md5")).toString("base64");
  console.log(`==> ${packageName} ${versionName} (${versionCode}), minSdk ${minSdk}, ${(bytes / 1e6).toFixed(1)} MB`);
  console.log(`    sha256 ${sha256}`);
  console.log(`    signed by ${signerSha256}`);

  // --- upload, then check the stored copy against the local file ----------
  const storage = new Storage({
    credentials: {
      audience: "replit",
      subject_token_type: "access_token",
      token_url: "http://127.0.0.1:1106/token",
      type: "external_account",
      credential_source: {
        url: "http://127.0.0.1:1106/credential",
        format: { type: "json", subject_token_field_name: "access_token" },
      },
      universe_domain: "googleapis.com",
    },
    projectId: "",
  });
  const file = storage.bucket(bucketId).file(OBJECT_KEY);
  console.log(`==> Uploading to App Storage (${OBJECT_KEY})`);
  await file.save(createReadStream(apk) as unknown as Buffer, {
    resumable: true,
    contentType: "application/vnd.android.package-archive",
    // Browsers get these headers from GCS directly (the API redirects to a signed URL).
    metadata: {
      cacheControl: "public, max-age=300",
      contentDisposition: 'attachment; filename="gullak.apk"',
      metadata: { sha256, versionName, versionCode: String(versionCode), signerSha256 },
    },
  });
  const [meta] = await file.getMetadata();
  if (Number(meta.size) !== bytes || meta.md5Hash !== md5) {
    fail(`stored object doesn't match (size ${meta.size} vs ${bytes}, md5 ${meta.md5Hash} vs ${md5})`);
  }
  console.log(`    stored and verified (size and MD5 match)`);

  const release = {
    packageName,
    versionName,
    versionCode,
    minSdk,
    bytes,
    sha256,
    signerSha256,
    downloadPath: DOWNLOAD_PATH,
    publishedAt: new Date().toISOString(),
  };
  writeFileSync(RELEASE_JSON, `${JSON.stringify(release, null, 2)}\n`);
  console.log(`==> Wrote ${path.relative(ROOT, RELEASE_JSON)}; republish so /android shows these details.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

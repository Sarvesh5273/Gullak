import { Router, type IRouter } from "express";
import { appBucketId, signObjectUrl } from "../lib/objectStorage";
import { byIp, rateLimit, sendError } from "../lib/http";

/**
 * Public download of the signed Android APK. The object lives in App Storage
 * (put there by `pnpm --filter @workspace/scripts run publish-apk`; keep the
 * key in sync) and this route redirects to a short-lived signed GCS URL, so the
 * ~50 MB transfer, range requests and resumes are handled by GCS rather than
 * by this server. The install page lives at /android (artifacts/gullak/server/serve.js).
 */
export const ANDROID_APK_OBJECT_KEY = "downloads/gullak-android.apk";
// Long enough for a slow phone download, including a resume or two.
const SIGNED_URL_TTL_SEC = 30 * 60;
// How long a successful "the APK is in storage" check is trusted.
const PRESENCE_TTL_MS = 5 * 60_000;

const downloadLimitIp = rateLimit({ name: "apk-download-ip", limit: 20, windowMs: 60 * 60_000, key: byIp });

let presentUntil = 0;

/** True if the APK object exists (HEAD via a signed URL), cached for a few minutes. */
async function apkIsPresent(bucketName: string): Promise<boolean> {
  if (Date.now() < presentUntil) return true;
  const url = await signObjectUrl({ bucketName, objectName: ANDROID_APK_OBJECT_KEY, method: "HEAD", ttlSec: 60 });
  const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(10_000) });
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`App Storage HEAD returned ${res.status}`);
  presentUntil = Date.now() + PRESENCE_TTL_MS;
  return true;
}

const router: IRouter = Router();

router.get("/downloads/gullak.apk", downloadLimitIp, async (req, res): Promise<void> => {
  const bucketName = appBucketId();
  if (!bucketName) {
    req.log.error("APK download requested but DEFAULT_OBJECT_STORAGE_BUCKET_ID is not set");
    sendError(res, 503, "not_configured", "The Android download isn't available right now.");
    return;
  }
  try {
    if (!(await apkIsPresent(bucketName))) {
      req.log.error({ key: ANDROID_APK_OBJECT_KEY }, "APK download requested but no APK is in App Storage");
      sendError(res, 404, "not_published", "The Android download isn't available right now.");
      return;
    }
    const url = await signObjectUrl({
      bucketName,
      objectName: ANDROID_APK_OBJECT_KEY,
      method: "GET",
      ttlSec: SIGNED_URL_TTL_SEC,
    });
    req.log.info("APK download redirected to App Storage");
    res.setHeader("Cache-Control", "no-store");
    res.redirect(302, url);
  } catch (err) {
    req.log.error({ err }, "APK download: App Storage unavailable");
    sendError(res, 502, "storage_error", "Couldn't reach the download store. Try again in a minute.");
  }
});

export default router;

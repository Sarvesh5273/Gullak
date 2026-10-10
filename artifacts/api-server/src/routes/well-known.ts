import { Router, type IRouter } from "express";

/**
 * Digital Asset Links: lets the Android app use passkeys for this domain.
 * Must be served from the passkey rpId host over HTTPS, as JSON, without redirects.
 * ANDROID_CERT_SHA256 lists the SHA-256 fingerprints (colon-separated hex) of every
 * certificate that signs the app (the release key in .local/signing), comma-separated.
 */
const ANDROID_PACKAGE_NAME = "com.gullak.app";

const router: IRouter = Router();

router.get("/assetlinks.json", (req, res): void => {
  const fingerprints = (process.env["ANDROID_CERT_SHA256"] ?? "")
    .split(",")
    .map((f) => f.trim().toUpperCase())
    .filter((f) => /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(f));

  if (fingerprints.length === 0) {
    req.log.warn("assetlinks.json requested but ANDROID_CERT_SHA256 has no valid fingerprints");
    res.status(404).json({ error: "Android app links are not configured.", code: "not_configured" });
    return;
  }

  res.setHeader("Cache-Control", "public, max-age=300");
  res.json([
    {
      relation: ["delegate_permission/common.handle_all_urls", "delegate_permission/common.get_login_creds"],
      target: {
        namespace: "android_app",
        package_name: ANDROID_PACKAGE_NAME,
        sha256_cert_fingerprints: fingerprints,
      },
    },
  ]);
});

export default router;

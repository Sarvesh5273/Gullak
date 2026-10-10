import { existsSync } from "node:fs";
import path from "node:path";
import { Router, type IRouter } from "express";
import { sendError } from "../lib/http";

/**
 * Development only (mounted when NODE_ENV is not production): lets a phone
 * download the Android build made by artifacts/gullak/scripts/build-android.sh.
 */
const APK_RELATIVE_PATH = "artifacts/gullak/android/app/build/outputs/apk/release/app-release.apk";

function findApk(): string | null {
  let dir = process.cwd();
  while (dir !== path.dirname(dir)) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) {
      const apk = path.join(dir, APK_RELATIVE_PATH);
      return existsSync(apk) ? apk : null;
    }
    dir = path.dirname(dir);
  }
  return null;
}

const router: IRouter = Router();

router.get("/dev/gullak.apk", (_req, res): void => {
  const apk = findApk();
  if (!apk) {
    sendError(res, 404, "not_built", "No Android build yet. Run artifacts/gullak/scripts/build-android.sh.");
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  res.download(apk, "gullak.apk");
});

export default router;

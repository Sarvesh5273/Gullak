/**
 * Standalone production server for the Gullak static builds.
 *
 * Serves the output of build.js (static-build/):
 * - GET / or /manifest with an expo-platform header → Expo Go manifest JSON
 * - GET /expo-go → landing page with the Expo Go QR code
 * - GET /android → Android install page (APK details from android-release.json)
 * - files of the web app (static-build/web), then Expo Go bundles and assets
 * - any other page request → the web app's index.html (client-side routes)
 *
 * /api and /.well-known are routed to the API server by the platform.
 * Zero external dependencies — uses only Node.js built-ins (http, fs, path).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const STATIC_ROOT = path.resolve(__dirname, '..', 'static-build');
const WEB_ROOT = path.join(STATIC_ROOT, 'web');
const TEMPLATE_PATH = path.resolve(__dirname, 'templates', 'landing-page.html');
const ANDROID_TEMPLATE_PATH = path.resolve(__dirname, 'templates', 'android.html');
// Written by `pnpm --filter @workspace/scripts run publish-apk` (uploads the APK itself to App Storage).
const ANDROID_RELEASE_PATH = path.resolve(__dirname, 'android-release.json');
const basePath = (process.env.BASE_PATH || '/').replace(/\/+$/, '');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.map': 'application/json',
};

function getAppName() {
  try {
    const appJsonPath = path.resolve(__dirname, '..', 'app.json');
    const appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf-8'));
    return typeof appJson.expo?.name === 'string'
      ? appJson.expo.name
      : 'App Landing Page';
  } catch {
    return 'App Landing Page';
  }
}

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function toScriptString(value) {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026');
}

function serveManifest(platform, res) {
  const manifestPath = path.join(STATIC_ROOT, platform, 'manifest.json');

  if (!fs.existsSync(manifestPath)) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({ error: `Manifest not found for platform: ${platform}` }),
    );
    return;
  }

  const manifest = fs.readFileSync(manifestPath, 'utf-8');
  res.writeHead(200, {
    'content-type': 'application/json',
    'expo-protocol-version': '1',
    'expo-sfv-version': '0',
  });
  res.end(manifest);
}

function serveLandingPage(req, res, landingPageTemplate, appName) {
  const forwardedProto = req.headers['x-forwarded-proto'];
  const protocol = forwardedProto || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers['host'];
  const baseUrl = `${protocol}://${host}`;
  const expsUrl = `exps://${host}${basePath}`;

  const html = landingPageTemplate
    .replace(/BASE_URL_PLACEHOLDER/g, baseUrl)
    .replace(/EXPS_URL_ATTRIBUTE_PLACEHOLDER/g, escapeHtml(expsUrl))
    .replace(/EXPS_URL_JSON_PLACEHOLDER/g, toScriptString(expsUrl))
    .replace(/APP_NAME_PLACEHOLDER/g, escapeHtml(appName));

  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}

/** The Android install page, filled from android-release.json; null if no APK was published. */
function renderAndroidPage() {
  let release;
  try {
    release = JSON.parse(fs.readFileSync(ANDROID_RELEASE_PATH, 'utf-8'));
  } catch {
    console.error('android-release.json missing or invalid; /android is unavailable');
    return null;
  }
  const values = {
    DOWNLOAD_URL_PLACEHOLDER: release.downloadPath,
    WEB_APP_URL_PLACEHOLDER: `${basePath}/`,
    VERSION_PLACEHOLDER: release.versionName,
    SIZE_PLACEHOLDER: (release.bytes / 1e6).toFixed(1),
    PACKAGE_PLACEHOLDER: release.packageName,
    APK_SHA256_PLACEHOLDER: release.sha256,
    SIGNER_SHA256_PLACEHOLDER: release.signerSha256,
  };
  let html = fs.readFileSync(ANDROID_TEMPLATE_PATH, 'utf-8');
  for (const [key, value] of Object.entries(values)) {
    html = html.replaceAll(key, escapeHtml(String(value)));
  }
  return html;
}

/** Returns the file under `root` for a URL path, or null (also for traversal attempts). */
function resolveFile(root, urlPath) {
  const filePath = path.join(root, path.normalize(urlPath));
  if (!filePath.startsWith(root + path.sep)) return null;
  try {
    return fs.statSync(filePath).isFile() ? filePath : null;
  } catch {
    return null;
  }
}

/** Prefers the .br/.gz siblings that build.js writes, when the client accepts them. */
function pickEncoding(req, filePath) {
  const accept = String(req.headers['accept-encoding'] || '');
  if (/\bbr\b/.test(accept) && fs.existsSync(`${filePath}.br`)) {
    return { file: `${filePath}.br`, encoding: 'br' };
  }
  if (/\bgzip\b/.test(accept) && fs.existsSync(`${filePath}.gz`)) {
    return { file: `${filePath}.gz`, encoding: 'gzip' };
  }
  return { file: filePath, encoding: null };
}

function sendFile(req, res, filePath, cacheControl) {
  const ext = path.extname(filePath).toLowerCase();
  const { file, encoding } = pickEncoding(req, filePath);
  res.writeHead(200, {
    'content-type': MIME_TYPES[ext] || 'application/octet-stream',
    'cache-control': cacheControl,
    vary: 'accept-encoding',
    ...(encoding ? { 'content-encoding': encoding } : {}),
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(file).pipe(res);
}

const landingPageTemplate = fs.readFileSync(TEMPLATE_PATH, 'utf-8');
const appName = getAppName();
const androidPage = renderAndroidPage();

const server = http.createServer((req, res) => {
  let pathname;
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    pathname = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }

  if (basePath && pathname.startsWith(basePath)) {
    pathname = pathname.slice(basePath.length) || '/';
  }

  if (pathname === '/' || pathname === '/manifest') {
    const platform = req.headers['expo-platform'];
    if (platform === 'ios' || platform === 'android') {
      return serveManifest(platform, res);
    }
  }

  if (pathname === '/expo-go') {
    return serveLandingPage(req, res, landingPageTemplate, appName);
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' });
    res.end('Method Not Allowed');
    return;
  }

  if (pathname === '/android' || pathname === '/android/') {
    if (!androidPage) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('The Android download is not available.');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' });
    res.end(req.method === 'HEAD' ? undefined : androidPage);
    return;
  }

  // Web app files first; hashed bundles can be cached for good.
  const webFile = resolveFile(WEB_ROOT, pathname);
  if (webFile) {
    const immutable = pathname.startsWith('/_expo/static/') || pathname.startsWith('/assets/');
    return sendFile(req, res, webFile, immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=300');
  }

  // Expo Go bundles and assets (timestamped paths).
  const goFile = resolveFile(STATIC_ROOT, pathname);
  if (goFile && !goFile.startsWith(WEB_ROOT + path.sep)) {
    return sendFile(req, res, goFile, 'public, max-age=3600');
  }

  // Page requests are client-side routes of the web app.
  if (!path.extname(pathname)) {
    const index = path.join(WEB_ROOT, 'index.html');
    if (fs.existsSync(index)) return sendFile(req, res, index, 'no-cache');
    return serveLandingPage(req, res, landingPageTemplate, appName);
  }

  res.writeHead(404);
  res.end('Not Found');
});

const port = parseInt(process.env.PORT || '3000', 10);
server.listen(port, '0.0.0.0', () => {
  console.log(`Serving Gullak static build on port ${port}`);
});

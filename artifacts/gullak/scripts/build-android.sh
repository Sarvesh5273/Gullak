#!/usr/bin/env bash
# Builds an installable Android app (release APK) of Gullak in this workspace,
# without EAS or Android Studio.
#
#   bash artifacts/gullak/scripts/build-android.sh [--clean]
#
# The first run downloads a JDK and the Android SDK into $GULLAK_ANDROID_TOOLS
# (default .cache/gullak-android at the workspace root, about 6 GB with the
# Gradle caches; git ignores .cache/). Home and /tmp share a small scratch
# quota that this would overflow, so all of it, temp files included, stays on
# the workspace disk. The script
# then regenerates android/ from app.json (expo prebuild; --clean starts over)
# and builds an arm64 APK. EXPO_PUBLIC_DOMAIN is required: the APK's API host
# and passkey rpId. For the published app that is its *.replit.app host.
#
# The APK is signed with Gullak's release key from $GULLAK_SIGNING_DIR
# (default .local/signing: gullak-release.p12 + gullak-release.pass, outside git
# and published builds). assetlinks.json must list that certificate
# (ANDROID_CERT_SHA256) or Android refuses passkeys for the app. The script
# checks this at the end.
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORKSPACE_ROOT="$(cd "$APP_DIR/../.." && pwd)"
TOOLS="${GULLAK_ANDROID_TOOLS:-$WORKSPACE_ROOT/.cache/gullak-android}"
SIGNING_DIR="${GULLAK_SIGNING_DIR:-$WORKSPACE_ROOT/.local/signing}"
KEYSTORE="$SIGNING_DIR/gullak-release.p12"
KEYSTORE_PASS="$SIGNING_DIR/gullak-release.pass"
KEY_ALIAS="gullak"
CMDLINE_TOOLS_URL="https://dl.google.com/android/repository/commandlinetools-linux-13114758_latest.zip"
JDK_URL="https://api.adoptium.net/v3/binary/latest/17/ga/linux/x64/jdk/hotspot/normal/eclipse"
CMAKE_VERSION="3.22.1"

CLEAN=""
[ "${1:-}" = "--clean" ] && CLEAN="--clean"

export EXPO_PUBLIC_REPL_ID="${EXPO_PUBLIC_REPL_ID:-${REPL_ID:-}}"
if [ -z "${EXPO_PUBLIC_DOMAIN:-}" ]; then
  echo "ERROR: set EXPO_PUBLIC_DOMAIN, the APK's API host and passkey rpId:" >&2
  echo "  the published *.replit.app host, or \$REPLIT_DEV_DOMAIN for a dev build" >&2
  exit 1
fi
export EXPO_PUBLIC_DOMAIN
if [ ! -s "$KEYSTORE" ] || [ ! -s "$KEYSTORE_PASS" ]; then
  echo "ERROR: release key missing: need $KEYSTORE and $KEYSTORE_PASS" >&2
  exit 1
fi

# Keep the SDK in step with the React Native version the app uses.
RN_DIR="$(cd "$APP_DIR" && dirname "$(node -p "require.resolve('react-native/package.json')")")"
toml() { sed -n "s/^$1 = \"\(.*\)\"$/\1/p" "$RN_DIR/gradle/libs.versions.toml"; }
COMPILE_SDK="$(toml compileSdk)"
BUILD_TOOLS="$(toml buildTools)"
NDK_VERSION="$(toml ndkVersion)"

echo "==> Toolchain in $TOOLS (SDK $COMPILE_SDK, build-tools $BUILD_TOOLS, NDK $NDK_VERSION)"
mkdir -p "$TOOLS/tmp"
export TMPDIR="$TOOLS/tmp"
export GRADLE_USER_HOME="$TOOLS/gradle-home"
export GRADLE_OPTS="${GRADLE_OPTS:-} -Djava.io.tmpdir=$TMPDIR"

if [ ! -x "$TOOLS/jdk/bin/java" ]; then
  echo "==> Downloading JDK 17"
  rm -rf "$TOOLS/jdk" && mkdir -p "$TOOLS/jdk"
  curl -fsSL "$JDK_URL" | tar -xz -C "$TOOLS/jdk" --strip-components=1
fi
export JAVA_HOME="$TOOLS/jdk"
export PATH="$JAVA_HOME/bin:$PATH"

export ANDROID_HOME="$TOOLS/sdk"
SDKMANAGER="$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager"
if [ ! -x "$SDKMANAGER" ]; then
  echo "==> Downloading Android command-line tools"
  tmp="$(mktemp -d)"
  curl -fsSL -o "$tmp/tools.zip" "$CMDLINE_TOOLS_URL"
  unzip -q "$tmp/tools.zip" -d "$tmp"
  mkdir -p "$ANDROID_HOME/cmdline-tools"
  rm -rf "$ANDROID_HOME/cmdline-tools/latest"
  mv "$tmp/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest"
  rm -rf "$tmp"
fi

echo "==> Installing SDK packages"
{ yes || true; } | "$SDKMANAGER" --licenses > /dev/null
"$SDKMANAGER" --install \
  "platform-tools" \
  "platforms;android-$COMPILE_SDK" \
  "build-tools;$BUILD_TOOLS" \
  "ndk;$NDK_VERSION" \
  "cmake;$CMAKE_VERSION" | grep -v "^\[" || true
for required in "platforms/android-$COMPILE_SDK" "build-tools/$BUILD_TOOLS" "ndk/$NDK_VERSION" "cmake/$CMAKE_VERSION"; do
  [ -d "$ANDROID_HOME/$required" ] || { echo "ERROR: SDK package missing: $required" >&2; exit 1; }
done

echo "==> Generating android/ from app.json"
cd "$APP_DIR"
# prebuild copies expo, react and react-native into "dependencies"; this
# workspace keeps them in devDependencies (autolinking reads both), so the
# original package.json goes back afterwards.
cp package.json "$TOOLS/package.json.orig"
trap 'cp "$TOOLS/package.json.orig" "$APP_DIR/package.json"' EXIT
CI=1 pnpm exec expo prebuild --platform android --no-install $CLEAN
cp "$TOOLS/package.json.orig" package.json
trap - EXIT

echo "==> Building the release APK for $EXPO_PUBLIC_DOMAIN (arm64-v8a)"
cd "$APP_DIR/android"
# Memory: fits the workspace (about 15 GB shared with Metro and the API).
# In-process Kotlin and --no-daemon leave no JVMs running afterwards.
NODE_ENV=production ./gradlew assembleRelease \
  --no-daemon \
  --max-workers=3 \
  -Dorg.gradle.jvmargs="-Xmx4g -XX:MaxMetaspaceSize=1g -Dfile.encoding=UTF-8 -Djava.io.tmpdir=$TMPDIR" \
  -Pkotlin.compiler.execution.strategy=in-process \
  -PreactNativeArchitectures=arm64-v8a

APK="$APP_DIR/android/app/build/outputs/apk/release/app-release.apk"
[ -f "$APK" ] || { echo "ERROR: no APK at $APK" >&2; exit 1; }

# Gradle signs with prebuild's debug key; re-sign with the release key.
# The password is read from its file, never put on the command line; a PKCS12
# key shares the keystore password (a second --key-pass file: would read line 2).
echo "==> Signing with the release key ($KEY_ALIAS)"
BT="$ANDROID_HOME/build-tools/$BUILD_TOOLS"
ALIGNED="$TMPDIR/gullak-aligned.apk"
"$BT/zipalign" -f -P 16 4 "$APK" "$ALIGNED"
"$BT/apksigner" sign --ks "$KEYSTORE" --ks-type PKCS12 --ks-key-alias "$KEY_ALIAS" \
  --ks-pass "file:$KEYSTORE_PASS" --out "$APK" "$ALIGNED" < /dev/null
rm -f "$ALIGNED" "$APK.idsig"
"$BT/zipalign" -c -P 16 4 "$APK" > /dev/null || { echo "ERROR: signed APK is not aligned" >&2; exit 1; }
SIGNERS="$("$BT/apksigner" verify --print-certs "$APK" | grep -c 'certificate SHA-256 digest')"
[ "$SIGNERS" = "1" ] || { echo "ERROR: expected 1 signer, found $SIGNERS" >&2; exit 1; }

SIGNED_WITH="$("$ANDROID_HOME/build-tools/$BUILD_TOOLS/apksigner" verify --print-certs "$APK" \
  | sed -n 's/.*certificate SHA-256 digest: \([0-9a-f]*\).*/\1/p' | head -1 | tr 'a-f' 'A-F')"
ADVERTISED="$(echo "${ANDROID_CERT_SHA256:-}" | tr -d ': ' | tr 'a-f' 'A-F')"
echo "==> APK ready: $APK ($(du -h "$APK" | cut -f1))"
echo "    signed with SHA-256 $SIGNED_WITH"
if [ -z "$ADVERTISED" ] || [[ ",$ADVERTISED," != *",$SIGNED_WITH,"* ]]; then
  echo "ERROR: assetlinks.json (ANDROID_CERT_SHA256) does not list this certificate; passkeys will be refused." >&2
  exit 1
fi
echo "    matches assetlinks.json, so Android will allow passkeys for $EXPO_PUBLIC_DOMAIN"

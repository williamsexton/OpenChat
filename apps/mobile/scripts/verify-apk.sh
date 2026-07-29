#!/usr/bin/env bash
set -euo pipefail

apk_path=${1:?usage: verify-apk.sh path/to/app.apk}
android_sdk=${ANDROID_SDK_ROOT:?ANDROID_SDK_ROOT must point to the Android SDK}
java_home=${JAVA_HOME:?JAVA_HOME must point to Java 17}
build_tools="$android_sdk/build-tools/36.0.0"
apkanalyzer="$android_sdk/cmdline-tools/latest/bin/apkanalyzer"

test -f "$apk_path"

badging=$("$build_tools/aapt" dump badging "$apk_path")
[[ "$badging" == *"package: name='com.openchat.mobile'"* ]]
[[ "$badging" == *"versionName='0.1.0'"* ]]
[[ "$badging" == *"sdkVersion:'24'"* ]]

signature=$(
  env JAVA_HOME="$java_home" PATH="$java_home/bin:/usr/bin:/bin" \
    "$build_tools/apksigner" verify --verbose --print-certs "$apk_path"
)
[[ "$signature" == *"Verified using v2 scheme (APK Signature Scheme v2): true"* ]]
[[ "$signature" == *"Number of signers: 1"* ]]

manifest=$(
  env JAVA_HOME="$java_home" PATH="$java_home/bin:/usr/bin:/bin" \
    "$apkanalyzer" manifest print "$apk_path"
)
[[ "$manifest" == *'android:usesCleartextTraffic="false"'* ]]
[[ "$manifest" == *'android:name="android.permission.POST_NOTIFICATIONS"'* ]]
[[ "$manifest" == *'android:name="com.google.firebase.messaging.default_notification_color"'* ]]

verify_tmp=$(mktemp -d /private/tmp/openchat-apk-verify.XXXXXX)
trap 'rm -rf "$verify_tmp"' EXIT
unzip -p "$apk_path" assets/index.android.bundle >"$verify_tmp/index.android.bundle"

rg -aq 'https://chat\.creeger\.com/api' "$verify_tmp/index.android.bundle"
rg -aq 'wss://chat\.creeger\.com/ws' "$verify_tmp/index.android.bundle"
if rg -aq 'http://10\.0\.2\.2:3030/api|ws://10\.0\.2\.2:3030/ws' \
  "$verify_tmp/index.android.bundle"; then
  echo "FAIL: emulator development endpoint is present in the APK" >&2
  exit 1
fi

archive_listing=$(unzip -l "$apk_path")
[[ "$archive_listing" == *'lib/arm64-v8a/'* ]]
[[ "$archive_listing" == *'lib/armeabi-v7a/'* ]]
[[ "$archive_listing" == *'lib/x86_64/'* ]]

echo "$badging" | sed -n '1p'
echo "$signature" | rg 'Verified using v2|Number of signers|certificate SHA-256'
echo "Production API and WebSocket endpoints verified; emulator endpoint absent."
shasum -a 256 "$apk_path"

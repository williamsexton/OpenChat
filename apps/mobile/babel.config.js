// Required by react-native-reanimated: plugin must be listed last.
// Expo SDK 57 auto-configures the expo preset; this file only exists
// to add the reanimated plugin. Added by P3-T1 (DR-005).
module.exports = function (api) {
  // NOT api.cache(true). babel-preset-expo inlines EXPO_PUBLIC_* at transform
  // time, and an unconditional cache keeps the FIRST build's inlined values
  // forever — changing the env var silently has no effect.
  //
  // Cost of learning this (2026-07-27): every physical-device E2E run failed at
  // login for hours. The APK kept the 10.0.2.2 baked in by an earlier emulator
  // build, so the app dialled an address no physical device can route, and hung
  // on a spinner. Rebuilding "with" EXPO_PUBLIC_API_HOST=127.0.0.1 changed
  // nothing because the transform was served from cache.
  //
  // Keying the cache on these vars makes a host change actually rebuild.
  // Metro keeps a second cache; when in doubt purge $TMPDIR/metro-*.
  api.cache.invalidate(
    () =>
      [
        process.env.EXPO_PUBLIC_API_HOST,
        process.env.EXPO_PUBLIC_API_URL,
        process.env.EXPO_PUBLIC_WS_URL,
        process.env.EXPO_PUBLIC_ENABLE_DEV_LOGIN,
      ].join('|'),
  );
  return {
    presets: ['babel-preset-expo'],
    plugins: ['react-native-reanimated/plugin'],
  };
};

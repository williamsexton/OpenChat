const { withAndroidManifest } = require('@expo/config-plugins');

const FIREBASE_NOTIFICATION_COLOR =
  'com.google.firebase.messaging.default_notification_color';

/**
 * expo-notifications and @react-native-firebase/messaging both declare the
 * default FCM notification color. Mark the app-owned value as authoritative so
 * Android's manifest merger can combine the two libraries on every clean
 * prebuild.
 */
module.exports = function withFirebaseNotificationManifestFix(config) {
  return withAndroidManifest(config, (mod) => {
    const application = mod.modResults.manifest.application?.[0];
    const colorEntry = application?.['meta-data']?.find(
      (entry) => entry.$?.['android:name'] === FIREBASE_NOTIFICATION_COLOR,
    );

    if (!colorEntry) {
      throw new Error(
        `Missing ${FIREBASE_NOTIFICATION_COLOR}; check the expo-notifications plugin configuration`,
      );
    }

    colorEntry.$['tools:replace'] = 'android:resource';
    return mod;
  });
};

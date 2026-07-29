# Install OpenChat on Android

You do not need a computer, developer account, Android Studio, or any other
developer tools. You only need an Android phone and the OpenChat APK file.

## What you need

- An Android phone running Android 7 or newer
- The file `OpenChat-0.1.0-android.apk`
- Your normal OpenChat login

The APK is about 135 MB. Get it from the person distributing OpenChat, preferably
through a private Google Drive, Dropbox, OneDrive, or similar download link.

## Install the app

1. Download `OpenChat-0.1.0-android.apk` on the Android phone.
2. Open the phone's **Downloads** or **Files** app.
3. Tap the downloaded APK.
4. Android may say that the browser or Files app is not allowed to install
   unknown apps. Tap **Settings**.
5. Turn on **Allow from this source** for the app you used to open the APK.
6. Go back and tap **Install**.
7. When installation finishes, tap **Open**.
8. Allow notifications when OpenChat asks.
9. Sign in with your normal OpenChat account.

After installation, you can turn **Allow from this source** back off. OpenChat
will continue to work.

## Expected security messages

Android calls any app installed outside Google Play an “unknown app.” That
message is expected for this private APK.

Only install the file if it came directly from the OpenChat distributor. If
Google Play Protect specifically reports that the app is harmful, stop and
contact the distributor instead of overriding the warning.

For someone who wants to verify the exact file, its SHA-256 fingerprint is:

```text
272348670feb316482277464b327b23ad8ecf35fb715a56507780053eb62d4d7
```

## Test notifications

1. Sign in to OpenChat and allow notifications.
2. Leave OpenChat by returning to the Home screen, or lock the phone.
3. From a different OpenChat account, send this account a direct message or
   mention it in a channel.
4. A notification should appear on the phone.
5. Tap the notification; OpenChat should open the relevant conversation.

This build connects to the live OpenChat service at `chat.creeger.com`, not a
developer server.

## Install an update later

Download the newer APK, tap it, and choose **Update**. Your existing OpenChat
installation and sign-in should remain in place.

If Android says **App not installed** because the signatures do not match, ask
the distributor for a build signed by the same key. Uninstalling the old app
usually fixes the mismatch, but it also clears that app's local settings and
sign-in, so only do that if instructed.

## Troubleshooting

- **Cannot find the download:** Open **Files** or **My Files**, then open
  **Downloads**.
- **Install button is unavailable:** Follow the prompt to enable **Allow from
  this source** for the browser or Files app that opened the APK.
- **No notification appears:** Open Android **Settings → Apps → OpenChat →
  Notifications** and make sure notifications are allowed. Also check that
  battery-saving settings are not putting OpenChat into a restricted mode.
- **Cannot sign in:** Confirm the phone has internet access and that the normal
  OpenChat website is available.

## Distributor note

This APK is a private sideload build signed with the build Mac's Android debug
certificate. It is suitable for direct testing, but it is not the artifact to
publish to Google Play. Future sideload updates must use the same signing
certificate.

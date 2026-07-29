# Install OpenChat on an iPhone with TestFlight

You do not need a Mac, Xcode, a developer account, or any programming tools.
You only need an iPhone, an Apple Account, and the OpenChat invitation.

If the person distributing OpenChat wants to skip TestFlight Beta App Review
for a small number of trusted people, see
[Share OpenChat with a trusted friend using internal TestFlight](./TESTFLIGHT-INTERNAL-TESTERS.md).

## What the person sharing OpenChat sends you

They will send one of these:

- an email invitation from TestFlight; or
- a public TestFlight link.

An invitation is not an App Store purchase. TestFlight is Apple's official app
for installing beta versions.

## Install OpenChat

1. On the iPhone, open the **App Store**.
2. Search for **TestFlight**. Confirm that the developer is **Apple**, then tap
   **Get**.
3. Open the OpenChat invitation:
   - For an email invitation, open the email on the iPhone and tap
     **View in TestFlight**.
   - For a public link, tap the link on the iPhone.
4. TestFlight opens. Tap **Accept** if it appears, then tap **Install**.
5. When installation finishes, tap **Open**.
6. When OpenChat asks for notification permission, tap **Allow**. This is
   required for message and call alerts.
7. Tap **Sign in** and finish the sign-in page that opens. The page returns you
   to OpenChat automatically.

That is the entire setup. You do not need to enable Developer Mode or change
anything in iPhone Settings.

## Getting updates

Open **TestFlight** to see available updates. Automatic updates are normally on;
you can tap OpenChat in TestFlight to check the **Automatic Updates** switch.

TestFlight builds expire after 90 days. Before then, the person sharing OpenChat
can provide a newer build through the same invitation.

## If something does not work

- **The invitation opens a web page but not TestFlight:** install TestFlight
  first, then tap the invitation again.
- **TestFlight says the build is unavailable:** ask the sender for a current
  invitation or build. The beta may still be processing, awaiting Apple's beta
  review, full, or expired.
- **No notifications arrive:** open **Settings → Apps → OpenChat →
  Notifications** and turn on **Allow Notifications**.
- **Sign-in stays in Safari:** return to OpenChat. If it still shows the sign-in
  screen, close and reopen OpenChat and try once more.

## One-time steps for the person distributing OpenChat

After the build finishes processing in App Store Connect:

1. Open **App Store Connect → OpenChat → TestFlight**.
2. Create an **Internal Testing** group first.
3. For people who are not App Store Connect users, create an
   **External Testing** group and add the build.
4. Enter a short **What to Test** note and submit the first external build for
   TestFlight review.
5. After approval, invite people by email or create a public link and send it
   with the installation steps above.

Apple currently allows up to 100 internal testers and 10,000 external testers.
The first external build requires beta review; later builds may not require a
full review.

## Apple references

- [TestFlight overview](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/)
- [Invite external testers](https://developer.apple.com/help/app-store-connect/test-a-beta-version/invite-external-testers)
- [Upload builds](https://developer.apple.com/help/app-store-connect/manage-builds/upload-builds/)

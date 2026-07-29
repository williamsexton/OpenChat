# Share OpenChat with a trusted friend using internal TestFlight

Internal TestFlight is the fastest way to put a build on a trusted friend's
iPhone. Apple does not perform TestFlight Beta App Review for internal testing.

The tradeoff is that an internal tester must be an App Store Connect user. This
is appropriate for a small number of trusted people. Use external testing for a
larger audience or anyone who should not have access to OpenChat's App Store
Connect record.

## What your friend needs

- an iPhone supported by the current OpenChat build;
- an Apple Account with two-factor authentication enabled;
- the free **TestFlight** app from Apple; and
- access to the email address you invite.

They do not need a Mac, Xcode, an Apple Developer membership, a cable, Developer
Mode, or any programming tools.

## 1. Add your friend to App Store Connect

You need the Account Holder, Admin, or App Manager role to perform these steps.

1. Sign in to [App Store Connect](https://appstoreconnect.apple.com/).
2. Open **Users and Access**.
3. Click the add button (**+**) next to Users.
4. Enter your friend's first name, last name, and Apple Account email address.
5. Select the **Marketing** role. This is an internal-TestFlight-eligible role
   with less development authority than Developer or App Manager.
6. Under app access, give them access to **OpenChat only**.
7. Do not grant access to **Certificates, Identifiers & Profiles**, financial
   reports, or other apps.
8. Send the invitation.

Your friend must accept Apple's App Store Connect invitation before they can be
selected as an internal tester.

## 2. Add the production build to an internal group

1. In App Store Connect, open **Apps → OpenChat → TestFlight**.
2. Wait for the uploaded iOS build to finish processing.
3. Click the add button (**+**) next to **Internal Testing**.
4. Name the group, for example **Trusted Friends**.
5. Enable automatic distribution if you want future processed builds to appear
   for the group automatically.
6. Open the group and click **Add Builds**.
7. Select the current OpenChat build.
8. For **What to Test**, enter:

   > Test sign-in, messaging, background notifications, and tapping a
   > notification to open the correct conversation.

9. Click **Add**.
10. Click **Invite Testers**, select your friend, and click **Add**.

Internal builds become available after Apple finishes processing them. They do
not require TestFlight Beta App Review.

## 3. What your friend does

Send your friend these instructions:

1. Accept the App Store Connect invitation in your email.
2. Install **TestFlight** from the iPhone App Store. Confirm the developer is
   Apple.
3. Open the TestFlight invitation email on the iPhone.
4. Tap **View in TestFlight**, then **Accept** and **Install**.
5. Open OpenChat.
6. Tap **Allow** when OpenChat asks for notification permission.
7. Sign in normally.

## Important limitations

- Internal testing does not provide a reusable public link. Your friend receives
  an email invitation tied to their App Store Connect user.
- Internal testers can see the OpenChat information permitted by their role.
  Limit their access to OpenChat and avoid granting certificate or report
  permissions.
- A TestFlight build is available for up to 90 days. Upload a newer build before
  it expires.
- Apple allows up to 100 internal testers per app.
- Removing someone from the internal group prevents access to future builds.
  Remove their App Store Connect user as well if they should no longer have any
  account access.

## When to use external testing instead

Use an external TestFlight group when you want a public invitation link, want to
invite many people, or do not want testers to have App Store Connect access. The
first external build normally requires TestFlight Beta App Review. External
testers can then join by email or public link without becoming members of your
App Store Connect team.

## Apple references

- [Add internal testers](https://developer.apple.com/help/app-store-connect/test-a-beta-version/add-internal-testers)
- [Edit access to apps](https://developer.apple.com/help/app-store-connect/manage-your-team/edit-access-to-apps/)
- [Role permissions](https://developer.apple.com/help/app-store-connect/reference/account-management/role-permissions)
- [Invite external testers](https://developer.apple.com/help/app-store-connect/test-a-beta-version/invite-external-testers)

# Enable production push notifications on Android and iOS

This runbook enables remote push delivery for the production OpenChat service at
`chat.creeger.com`. It is written for the current Docker Compose deployment
described in [`DEPLOY.md`](DEPLOY.md), where the checkout lives at `/opt/chat`
and exactly one `api` container runs.

## Current release status

As of 2026-07-29, the push implementation is **not on upstream `main` yet**.

- Upstream draft PR:
  <https://github.com/MinionEnjoyer/OpenChat/pull/4>
- Upstream target: `MinionEnjoyer/OpenChat:main`
- PR head: `williamsexton:pr/integration-upstream-20260729`
- Focused release PR:
  <https://github.com/williamsexton/OpenChat/pull/1>
- Focused release head: `williamsexton:testflight-2026-07-28`

PR 4 is conflict-free and its Verify and Contract jobs pass. Merge PR 4 into
upstream `main` before telling the production host to deploy `main`.

## What is already inside the mobile builds

The release inputs on the focused release branch were checked directly:

| Platform | Application ID | Firebase project | Push environment |
|---|---|---|---|
| Android | `com.openchat.mobile` | `openchat-app-f9272` | FCM |
| iOS/TestFlight | `com.openchat.mobile` | `openchat-app-f9272` | production APNs through FCM |

The Android `google-services.json` and iOS `GoogleService-Info.plist` are
compiled into their respective apps. They are not backend secrets and should
not be copied to the production server.

The APNs `.p8` authentication key is stored in Firebase. It also does not belong
on the OpenChat production server.

The production API needs one additional secret: the Firebase service-account
JSON stored in the `FCM_SERVICE_ACCOUNT` environment variable. Without it, the
API deliberately starts with `NoopPushTransport`; chat still works, but no
remote notifications are sent.

## Responsibilities

### OpenChat/Firebase owner

Provide a Firebase Admin service-account JSON from project
`openchat-app-f9272`. Its filename commonly resembles:

```text
openchat-app-f9272-firebase-adminsdk-<suffix>.json
```

Verify it contains all of these fields without sharing their values:

- `"type": "service_account"`
- `"project_id": "openchat-app-f9272"`
- `"private_key"`
- `"client_email"`

Transfer it to the production operator using a secrets manager or another
encrypted channel. Do not commit it, attach it to a PR, or send it in ordinary
chat or email.

### Production operator

Merge/deploy the push-capable API, install the service-account JSON as a
server-only secret, verify the migration, and run the two-platform smoke test
below.

## Production operator procedure

These commands assume an Ubuntu/Debian host, `/opt/chat`, and the production
Docker Compose stack. Substitute the actual secure download path for
`/tmp/openchat-app-f9272-firebase-adminsdk.json`.

### 1. Confirm the code has reached upstream main

Do not deploy the focused `testflight-2026-07-28` branch directly to production.
After PR 4 is reviewed and merged:

```bash
cd /opt/chat
git fetch origin
git checkout main
git pull --ff-only origin main
git status --short
git log -1 --oneline
```

`git status --short` should print nothing. The latest commit must include the
merged upstream PR 4.

### 2. Install and validate the Firebase credential

Install `jq` if it is not already available:

```bash
command -v jq || sudo apt-get update
command -v jq || sudo apt-get install -y jq
```

Move the downloaded credential into a root-owned directory:

```bash
sudo install -d -m 700 /opt/chat/secrets
sudo install -m 600 /tmp/openchat-app-f9272-firebase-adminsdk.json /opt/chat/secrets/firebase-service-account.json
```

Validate the credential without printing its private key:

```bash
sudo jq -e '
  .type == "service_account" and
  .project_id == "openchat-app-f9272" and
  (.private_key | type == "string") and
  (.client_email | type == "string")
' /opt/chat/secrets/firebase-service-account.json >/dev/null &&
echo "Firebase credential structure and project ID are correct"
```

If this command does not print the success message, stop. Do not deploy a
credential from another Firebase project.

### 3. Add only the push secret to the server environment

Back up the existing production environment:

```bash
cd /opt/chat
sudo cp -p .env .env.before-production-push
```

Remove any old value and append the compact JSON without displaying it:

```bash
sudo sed -i '/^FCM_SERVICE_ACCOUNT=/d' .env
sudo jq -c . /opt/chat/secrets/firebase-service-account.json |
  sed 's/^/FCM_SERVICE_ACCOUNT=/' |
  sudo tee -a .env >/dev/null
sudo chmod 600 .env
```

This modifies only `FCM_SERVICE_ACCOUNT`. Do not replace the production `.env`
with a developer's `.env.dev`; doing so would overwrite production database,
Redis, Authentik, JWT, LiveKit, and host configuration.

Confirm the variable exists without printing it:

```bash
grep -q '^FCM_SERVICE_ACCOUNT=' .env &&
echo "FCM_SERVICE_ACCOUNT is present"
```

### 4. Deploy the merged API

```bash
cd /opt/chat
./scripts/deploy.sh
docker compose ps
```

The `api`, `postgres`, and `redis` services must be running. The API container
automatically applies Prisma migrations before starting.

Confirm the migration state:

```bash
docker compose exec -T api npx prisma migrate status
```

It must report that the database schema is up to date. In particular, migration
`20260725203000_add_notification_settings_and_device_tokens` must be applied.

### 5. Prove the API received the correct credential

This command parses the in-container secret but prints only its project ID:

```bash
docker compose exec -T api node -e '
const raw = process.env.FCM_SERVICE_ACCOUNT;
if (!raw) throw new Error("FCM_SERVICE_ACCOUNT is absent");
const value = JSON.parse(raw);
if (value.project_id !== "openchat-app-f9272") {
  throw new Error("Wrong Firebase project: " + value.project_id);
}
console.log("FCM configured for", value.project_id);
'
```

Expected output:

```text
FCM configured for openchat-app-f9272
```

Check startup logs:

```bash
docker compose logs --since=10m api |
  grep -E 'Push dispatch worker subscribed|push notifications are disabled|FCM_SERVICE_ACCOUNT'
```

The logs should include:

```text
Push dispatch worker subscribed to chat:events
```

They must not include:

```text
FCM_SERVICE_ACCOUNT is not set — push notifications are disabled
```

### 6. Confirm there is only one production API dispatcher

The current architecture is deliberately single-API-instance. Every API process
subscribes to the same Redis event channel, so two live API processes produce
two identical notifications.

```bash
docker ps \
  --filter label=com.docker.compose.service=api \
  --filter status=running \
  --format '{{.Names}}'
```

For the production project, this must identify only one `api` container. Stop
any stale copy of the stack or manually launched API process before testing.

## Two-platform production acceptance test

Use two OpenChat accounts: the phone being tested is the recipient, and a
different account sends the message. Test Android and iOS separately.

### Prepare each phone

1. Install the current production Android APK or TestFlight iOS build.
2. Open the app and allow notifications when prompted.
3. Sign in to the production service at `chat.creeger.com`.
4. Leave the app open for at least ten seconds so its FCM token is registered.
5. Return to the Home screen. Do not swipe-kill the app.

Confirm that production has registered both platforms:

```bash
cd /opt/chat
docker compose exec -T postgres sh -lc \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
  "SELECT platform, count(*) FROM \"DeviceToken\" GROUP BY platform ORDER BY platform;"'
```

After both phones have signed in, the result must include at least one
`android` row and at least one `ios` row.

### Test direct messages

For Android, then iOS:

1. Keep the recipient phone backgrounded or locked.
2. From the second account, send exactly one direct message with unique text,
   such as `prod android push 2026-07-29 01` or
   `prod ios push 2026-07-29 01`.
3. Confirm exactly one notification arrives.
4. Confirm its sender and message preview are correct.
5. Tap it and confirm OpenChat opens the correct DM.

Check the server:

```bash
docker compose logs --since=5m api |
  grep 'push dispatched'
```

The matching event should report at least one successful token, for example
`tokens=1 success=1`.

### Test channel mentions

For Android, then iOS:

1. Background the recipient phone.
2. From the second account in a mutual channel, send one message containing an
   explicit mention of the recipient.
3. Confirm exactly one notification arrives.
4. Tap it and confirm OpenChat opens the correct channel.

Both direct-message and mention tests must pass on both platforms before
production push is considered enabled.

## Failure guide

| Symptom | Most likely cause |
|---|---|
| API works but no pushes are attempted | `FCM_SERVICE_ACCOUNT` absent; API selected `NoopPushTransport` |
| API logs FCM `401` or `403` | Invalid/revoked service account or missing Firebase messaging permission/API |
| No `android` or `ios` row in `DeviceToken` | App permission denied, wrong/old client build, or token registration failed |
| FCM accepts Android but not iOS | iOS client or APNs configuration is incomplete |
| FCM reports success but iOS receives nothing | APNs `.p8` is missing/wrong in Firebase, or the build is not using production APNs |
| Only Android fails | APK lacks the matching `google-services.json`, notification permission is denied, or Android battery restrictions interfere |
| Two identical notifications arrive | More than one API process is subscribed to the Redis event channel |
| Notification arrives but opens the wrong screen | Old app build or stale notification payload; confirm the release build and unique test text |
| Wrong Firebase project reported by the server check | Backend service account does not match the client project `openchat-app-f9272` |

## Credential rotation

If the Firebase service-account JSON was ever committed, pasted into chat,
emailed without encryption, or placed in a shared developer `.env`, revoke that
key in Google Cloud/Firebase and generate a dedicated production replacement.
Update `FCM_SERVICE_ACCOUNT`, redeploy the API, repeat the in-container project
check, and run both platform tests again.

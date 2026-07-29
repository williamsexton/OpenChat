# Deploy & update

The workflow: **develop locally → clean → push to git → the server pulls and rebuilds.**
After the one-time setup, every future change goes live with `git push` here + a deploy on the
server.

For production mobile push credentials and the required Android/iOS acceptance
test, follow [`PRODUCTION-PUSH-ENABLEMENT.md`](PRODUCTION-PUSH-ENABLEMENT.md).

> Examples below assume the app lives in `/opt/chat` on your server and you run the commands there.
> Substitute your own host and paths.

---

## The golden rule

Real secrets and personal data live **only** in the server's local `.env` (and the `livekit.yaml`
rendered from it). These are gitignored and are never pushed or pulled. Git only ever carries
code + templates. That is what lets you push freely without leaking anything.

---

## A. Clean — verify no secrets before pushing

From the repo root, every time before you push:

```bash
./scripts/check-secrets.sh
```

It fails if `.env`, `livekit.yaml`, or any obvious secret/public-IP is tracked. Fix anything it
flags. To untrack a file that slipped in:

```bash
git rm --cached <file>        # then commit the removal
```

## B. First-time git setup (once)

```bash
# in the repo root
git init
git add -A
./scripts/check-secrets.sh        # must pass
git commit -m "OpenChat: initial import"
git branch -M main

# create the remote (private!) and push — pick one:
gh repo create openchat --private --source=. --push        # GitHub CLI
# — or —
git remote add origin git@github.com:<you>/openchat.git
git push -u origin main
```

Keep the repo **private** — it describes your infrastructure even though it holds no secrets.

## C. First-time server setup (once) — convert the live host to a git checkout

The server currently holds the app files plus the live `.env` / `livekit.yaml` / database volumes.
Turn its app directory into a git checkout **without** disturbing those local files:

```bash
cd /opt/chat

# 1) Safety backup of the whole directory (excluding data volumes, which live in Docker).
sudo tar --exclude=postgres-data --exclude=redis-data -czf /root/chat-backup-$(date +%s).tar.gz .

# 2) Initialise git in place and attach the remote.
sudo git init
sudo git remote add origin <your-remote-url>
sudo git fetch origin

# 3) Adopt the pushed tree. .env, livekit.yaml, and volumes are gitignored, so they are LEFT
#    untouched — only tracked files are reset to match the repo.
sudo git checkout -f -b main origin/main

# 4) Sanity check: your secrets are still there and untracked.
ls -la .env livekit.yaml
git status --short          # .env / livekit.yaml must NOT appear
```

If `git status` shows `.env` or `livekit.yaml`, stop — the `.gitignore` didn't apply; do not commit.

**Add the deployment vars to the server's `.env`.** `docker-compose.yml` now reads these from
`.env` with *generic* defaults (real IPs are kept out of git), so the server must supply its own:

```bash
# append to /opt/chat/.env if not already present — use YOUR real values
LAN_HOST_IP=192.168.1.10        # the LAN IP of the reverse-proxy host
WEB_PORT=8810                    # host port the web container binds
# CHAT_HOST/AUTH_HOST/SHARE_HOST/WATCH_HOST already default to *.example.com
```

Without `LAN_HOST_IP`, `extra_hosts` falls back to a placeholder and server-side OIDC breaks.

Then confirm the stack still builds from the checkout:

```bash
docker compose up -d --build && docker compose ps
```

## D. Ongoing updates — push here, deploy there

**On your machine:**

```bash
./scripts/check-secrets.sh
git add -A && git commit -m "describe the change"
git push
```

**On the server (`/opt/chat`):**

```bash
./scripts/deploy.sh
```

`deploy.sh` does `git pull` → `docker compose up -d --build` → prune. Migrations run
automatically when the API container starts. That's it — the push is now live.

To roll back, check out a previous commit on the server and re-run `deploy.sh`:

```bash
git checkout <good-commit-sha> && ./scripts/deploy.sh
```

## E. Optional — auto-deploy on push

If you want a `git push` to go live with no manual step, run a tiny poller on the server (cron
every minute) that deploys only when the remote advanced:

```bash
# /opt/chat/scripts/auto-deploy.sh  (cron: * * * * * /opt/chat/scripts/auto-deploy.sh)
cd /opt/chat
git fetch origin main --quiet
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || ./scripts/deploy.sh
```

Keep it manual until you trust the pipeline — an auto-deploy will happily ship a broken build.

## What survives a deploy

| Item | Where it lives | Touched by deploy? |
|---|---|---|
| Code + templates | git | replaced on pull |
| `.env` (secrets, IPs, passwords) | local file, gitignored | **never** |
| `livekit.yaml` (rendered) | local file, gitignored | **never** (unless you delete it) |
| Postgres / Redis data | Docker volumes | **never** |

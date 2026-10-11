# Runbook

What it takes to run the trainer that no file in this repository can state. Commands are in the package manifests. Worker names, bindings, routes and schedules are in the Wrangler files.

## Outside the repository

- **Cloudflare** holds the API Worker, the coach Worker, the dashboard Worker and the `personal-trainer` D1 database. Runtime credentials are Worker secrets. Never put them in Wrangler configuration, source, logs or CI output.
- **The coach's secrets.** `trainer-coach` holds `ANTHROPIC_API_KEY`, its model key, and `COACH_AGENT_TOKEN`, a random string of at least 32 characters with no dot. The API Worker holds the same `COACH_AGENT_TOKEN`. To rotate it, put the new value on both Workers; between the two puts the coach is refused, so do it when nobody is chatting. The coach's conversation lives in its Durable Object, not in D1, so the weekly backup does not contain it.
- **GitHub branch protection** on `main` requires a pull request whose `checks`, `test`, `d1` and `web` jobs pass on a branch that is up to date. It applies to admins too and blocks force pushes. Merging is what deploys.
- **GitHub secrets** hold `CLOUDFLARE_API_TOKEN`, a narrowly scoped deployment token, and `CLOUDFLARE_ACCOUNT_ID`. Interactive Wrangler login is for the operator's own session, not a credential to copy into CI.
- **WorkOS and Withings** are registered against the public hostnames: the connector's resource indicator, the dashboard's callback URLs and the Withings notification subscription. Register a new address with its provider before changing an origin. A redirect does not repair an OAuth audience mismatch.
- **The dashboard's cookie password** must survive any hosting change, or every existing session stops being readable.
- **The weekly backup** is a launchd agent in Marco's `~/Library/LaunchAgents`. It runs `bun run backup` from the main checkout on Sundays at 12:00 and shows a notification when it fails. It uses Wrangler's interactive login, so an expired login fails the backup. A run missed while the Mac is off happens at the next wake. The backups are only as safe as that Mac's own backup.

## Releasing

CI deploys `main` once every check has passed: the API, then the coach, then the dashboard, whose service binding must find the coach. Do not run a manual deployment while a release is in progress. The coach has no public address to probe; after a release, check it by sending a message in the app.

A failed release can mean the new Worker or a migration is already live. Inspect the deployment history, the public health endpoints and the database before retrying. A red job is not proof that nothing changed.

A Worker rollback replaces code and configuration. It does not undo D1 migrations, record writes, token revocations or provider-side changes, so every migration must keep working with the previously deployed Worker.

## Withings

Only one environment may synchronize the real Withings account. A refresh token rotates when it is used, so copying an older database back can restore a token Withings has already invalidated. Reconcile provider credentials separately from the record.

## Recovering the record

D1 Time Travel is the short-term recovery. Check the account's actual retention window, because plans differ. A restore overwrites current data and cancels in-flight queries. Before restoring, pause writers and the Withings catch-up, note the current restore position and identify which later writes will be lost.

`bun run backup` keeps a portable copy off the Cloudflare account. It needs `TRAINER_BACKUP_DIR`, an absolute directory outside the repository. Each export is restored into in-memory SQLite before it is kept, which proves the file loads, not that the API works against it. To trust a backup, import it into a separate, explicitly named database and check representative API reads.

An export contains health records and provider credentials. Keep it private, with an explicit retention policy, and make sure it can be recovered without the machine that created it.

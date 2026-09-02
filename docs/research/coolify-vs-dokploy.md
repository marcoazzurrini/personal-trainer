# Coolify vs Dokploy on one Hetzner VPS

Checked 2026-09-02. Current releases: Coolify v4.3.14 (2026-08-28, plus v4.4-rc.1 pre-release), Dokploy v0.30.5 (2026-09-02).

Use case: one shared-vCPU 4 GB Hetzner box (CX23 or CAX11 class: 2 vCPU, 4 GB, 40 GB NVMe, [hetzner.com/cloud/cost-optimized](https://www.hetzner.com/cloud/cost-optimized/)), several small Deno/Node APIs, one shared Postgres, tiny traffic, solo developer.

## Verdict

Pick **Coolify**, with auto-update switched off and updates applied by hand after reading the release notes.

Three reasons decide it:

1. **Backups.** Coolify backs up Postgres on a cron schedule to local disk and/or S3, with retention settings (count, days, max size) for each destination, and it backs up its own database the same way. Dokploy backups go to S3-compatible storage only, with a "keep latest N" option. Both can restore from the UI.
2. **No Swarm on a single box.** Coolify runs plain Docker containers. Dokploy initialises Docker Swarm on install and runs every app and database as a Swarm service. That adds a layer (advertise address, overlay network, IPVS, MTU) whose failure modes fill Dokploy's own troubleshooting pages, and it buys nothing on one server.
3. **Maturity and licence.** Coolify has shipped since 2021, reached a stable v4.0.0 on 2026-04-27, and is plain Apache-2.0. Dokploy is younger (April 2024), still 0.x, and its repo carries a proprietary licence for an optional `/proprietary` directory. Both had upgrade regressions in the last month, so neither is "set and forget".

Where Dokploy wins: it is lighter (Next.js app + Postgres + Traefik, no Redis or websocket server), has a first-party Deno example, and its UI is simpler. If you want the leanest control plane and are happy to learn Swarm, it is a fine second choice.

## Comparison table

| | Coolify | Dokploy |
|---|---|---|
| First commit | Jan 2021 | Apr 2024 |
| Licence | Apache-2.0 | Apache-2.0 plus proprietary `/proprietary` dir |
| Stack | PHP/Laravel, Livewire | TypeScript, Next.js, tRPC |
| Stars (2026-09-02) | 61,315 | 37,046 |
| Releases in 2026 so far | 35 | 37 |
| Control-plane containers | app, postgres:15, redis:7, soketi (realtime), Traefik proxy | app, postgres:16, Traefik |
| Documented minimum | 2 cores, 2 GB RAM, 30 GB | 2 GB RAM, 30 GB (no CPU figure) |
| Orchestration | plain Docker (Swarm is experimental) | Docker Swarm, required |
| Git sources | public URL, GitHub App, deploy key | GitHub App, GitLab, Bitbucket, Gitea, generic SSH |
| Build types | Nixpacks, Railpack, Dockerfile, Compose, static | Nixpacks (default), Railpack, Dockerfile, Heroku/Paketo buildpacks, static |
| Prebuilt image | yes | yes |
| Docker Compose stack | yes (own build pack) | yes (compose or stack mode) |
| One-click Postgres | yes, default `postgres:16-alpine` | yes, default `postgres:18` |
| DB backup destinations | local and S3 | S3 only |
| DB backup retention | count / days / max size per destination | keep latest N |
| Compose-defined DB backup | not documented | Backups tab on compose services (code has `backupType: compose`) |
| Volume backups | not documented | named volumes to S3 |
| Env scopes | resource, environment, project, team | service, environment, project, external vault |
| Build vs runtime | per-variable flags, build secrets | not found in docs |
| Proxy | Traefik default, Caddy experimental | Traefik only |
| HTTPS | Let's Encrypt HTTP challenge, DNS challenge for wildcard | Let's Encrypt, custom certs, wildcard via Cloudflare guide |
| Auto-update | on by default, daily 00:00 | none self-hosted (Cloud only) |
| Control-plane backup | S3/manual DB backup + APP_KEY + SSH keys | S3 archive of DB + `/etc/dokploy`, restore in UI |
| Self-hosted price | free, nothing gated | free; SSO, SCIM, audit logs, custom roles gated |

## 1. What each tool is

**Coolify** is a self-hosted PaaS written in PHP (Laravel), by Andras Bacsai and Peak Labs. Repo created 2021-01-25, Apache-2.0, 61,315 stars ([github.com/coollabsio/coolify](https://github.com/coollabsio/coolify)). It sat in a long beta (`v4.0.0-beta.449` on 2025-11-26), released v4.0.0 on 2026-04-27, and v4.3.0 on 2026-08-12. Patch releases come every few days: v4.3.4 through v4.3.14 all landed 2026-08-16 to 2026-08-28 ([releases](https://github.com/coollabsio/coolify/releases)).

**Dokploy** is a self-hosted PaaS in TypeScript (Next.js, tRPC, Drizzle), by Mauricio Siu, now "Dokploy Technology, Inc." Repo created 2024-04-19, 37,046 stars ([github.com/Dokploy/dokploy](https://github.com/Dokploy/dokploy)). `LICENSE.MD` is Apache-2.0 for everything outside a `/proprietary` directory, which is under `LICENSE_PROPRIETARY.md`. Minor releases: v0.27.0 (2026-02-10), v0.28.0 (2026-02-27), v0.29.0 (2026-04-17), v0.30.0 (2026-08-14); patches v0.30.3 to v0.30.5 in the last four days ([releases](https://github.com/Dokploy/dokploy/releases)).

## 2. Control-panel footprint

**Coolify** documents "2 cores, 2 GB RAM, 30 GB free space" as minimum and says to size up for many apps ([installation](https://coolify.io/docs/get-started/installation)). `docker-compose.yml` plus `docker-compose.prod.yml` define four services: `coolify` (Laravel app, `PHP_MEMORY_LIMIT` default 256M), `postgres:15-alpine`, `redis:7-alpine`, and `soketi` (`coollabsio/coolify-realtime`) ([compose](https://github.com/coollabsio/coolify/blob/main/docker-compose.yml), [prod compose](https://github.com/coollabsio/coolify/blob/main/docker-compose.prod.yml)). A separate `coolify-proxy` Traefik container serves ports 80/443. Ports 8000 (UI), 6001 (realtime), 6002 (terminal), 22, 80, 443 must be open ([firewall](https://coolify.io/docs/knowledge-base/server/firewall)). The docs warn that "high server usage could prevent to use Coolify" when apps share the box ([server intro](https://coolify.io/docs/knowledge-base/server/introduction)).

**Dokploy** documents "at least 2GB of RAM" and 30 GB disk; ports 80, 443, 3000 must be free or install fails ([installation](https://docs.dokploy.com/docs/core/installation)). The install script (fetched from `dokploy.com/install.sh` today) runs `docker swarm init --advertise-addr`, creates the `dokploy-network` overlay, then creates Swarm services `dokploy-postgres` (`postgres:16`) and `dokploy` (port 3000, host mode), and a plain `docker run` container `dokploy-traefik` (`traefik:v3.6.7`) on 80/443. There is no Redis: the script has no Redis service and a code search for `dokploy-redis` in the repo returns nothing. Issue [#4928](https://github.com/Dokploy/dokploy/issues/4928) (2026-07-28) records that Redis was removed from the script between v0.29.10 and v0.29.13. The architecture page lists three components: Next.js app, PostgreSQL, Traefik ([architecture](https://docs.dokploy.com/docs/core/architecture)).

Neither project publishes measured idle RAM figures. Expect Coolify to be heavier (five containers plus PHP) than Dokploy (three).

## 3. Deploy sources

**Coolify**: public repo URL, GitHub App (private repos, push-to-deploy webhooks, PR previews), or deploy key ([GitHub overview](https://coolify.io/docs/applications/ci-cd/github/overview)). Build packs: Nixpacks, Railpack, Dockerfile, Docker Compose, static ([build packs](https://coolify.io/docs/applications/build-packs)). Prebuilt images from any registry are supported. Deno is not named in Coolify's docs, but Nixpacks detects `deno.json` and runs `deno task start` or `deno run --allow-all` ([nixpacks.com](https://nixpacks.com/docs/providers/deno)), and Railpack detects `deno.json`/`deno.jsonc` and runs `main.ts` with `deno run --allow-all` ([railpack.com](https://railpack.com/languages/deno)). A Dockerfile is the safe route either way.

**Dokploy**: GitHub App, GitLab, Bitbucket, Gitea, generic Git over SSH, Docker image from a registry, and file drop ([applications](https://docs.dokploy.com/docs/core/applications), [GitHub](https://docs.dokploy.com/docs/core/github)). Build types: Nixpacks (default), Railpack, Dockerfile, Heroku and Paketo buildpacks, static ([build type](https://docs.dokploy.com/docs/core/applications/build-type)). Dokploy has a Deno guide that uses the Dockerfile build type with port 8080 ([Deno example](https://docs.dokploy.com/docs/core/deno)). Railpack in Dokploy gained Deno support in 2025 ([#1559](https://github.com/Dokploy/dokploy/issues/1559)).

Docker Compose: Coolify treats your compose file as "the single source of truth" and warns "Do not define custom networks" because Traefik then picks an unpredictable network ([compose build pack](https://coolify.io/docs/applications/build-packs/docker-compose)). Dokploy offers compose mode and a Swarm "stack" mode (no `build` in stack mode); UI env vars are written to a `.env` that you must reference with `env_file` or `${VAR}` ([compose](https://docs.dokploy.com/docs/core/docker-compose)).

## 4. Databases

**Coolify**: one-click Postgres, default image `postgres:16-alpine`, image editable ([databases.php](https://github.com/coollabsio/coolify/blob/main/bootstrap/helpers/databases.php)). Apps reach it by an internal URL when "in the same network"; public access is by port mapping (needs restart) or a "Public Port" Nginx TCP proxy ([databases](https://coolify.io/docs/databases)). For a compose stack to reach a database created elsewhere, enable "Connect to Predefined Network" and address it as `postgres-<uuid>`; the docs warn plain service-name DNS then stops working ([compose network](https://coolify.io/docs/knowledge-base/docker/compose)). So a shared Postgres across projects works, with that hostname rule.

**Dokploy**: Postgres, MySQL, MariaDB, MongoDB, Redis; default Postgres image `postgres:18` per the schema ([postgres.ts](https://github.com/Dokploy/dokploy/blob/canary/packages/server/src/db/schema/postgres.ts)), changeable under Advanced > Custom Docker Image. Databases sit on `dokploy-network` with an internal hostname; an external port can be exposed ([databases](https://docs.dokploy.com/docs/core/databases)). Cross-project sharing is not stated in docs; since every service joins the same overlay network, it works in practice, but I could not find a first-party sentence saying so.

## 5. Backups

**Coolify**: scheduled `pg_dump` (custom format) with cron presets, to local storage (default) and/or S3-compatible storage ([backups](https://coolify.io/docs/databases/backups)). Retention fields exist per destination: `database_backup_retention_amount_locally`, `_days_locally`, `_max_storage_locally` and the S3 equivalents ([ScheduledDatabaseBackup.php](https://github.com/coollabsio/coolify/blob/main/app/Models/ScheduledDatabaseBackup.php)). Restore is `pg_restore` from the dump; the docs note custom format is version-sensitive and suggest plain/tar for cross-version moves ([postgresql](https://coolify.io/docs/databases/postgresql)). Volumes and databases inside compose stacks: not documented as backed up. Open bugs: S3 upload failing on Docker rate limits ([#9514](https://github.com/coollabsio/coolify/issues/9514)), import of a Coolify-made backup failing ([#9860](https://github.com/coollabsio/coolify/issues/9860), closed).

**Dokploy**: cron-scheduled backups to an S3 destination only; there is a Test button ([backups](https://docs.dokploy.com/docs/core/databases/backups)). Retention is `keepLatestCount` in the schema ([backups.ts](https://github.com/Dokploy/dokploy/blob/canary/packages/server/src/db/schema/backups.ts)); the docs page does not mention it. Restore from S3 in the UI for Postgres, MySQL, MariaDB, MongoDB; only Dokploy-made dumps are guaranteed ([restore](https://docs.dokploy.com/docs/core/databases/restore)). Compose services have a Backups tab and the schema has `backupType: "compose"`. Named volumes (not bind mounts) can be backed up to S3 on a schedule, with an option to stop the container first ([volume backups](https://docs.dokploy.com/docs/core/volume-backups)). Local-disk destination: not supported.

## 6. Environment variables and secrets

**Coolify**: per-resource variables plus `{{team.X}}`, `{{project.X}}`, `{{environment.X}}`; each variable has independent build-time and runtime flags; Docker build secrets keep values out of image layers; multiline and literal modes ([env vars](https://coolify.io/docs/knowledge-base/environment-variables)). Recent bugs: shared-variable interpolation broke in compose after beta.465 ([#8932](https://github.com/coollabsio/coolify/issues/8932), fixed), literal variables lost in developer mode ([#10406](https://github.com/coollabsio/coolify/issues/10406), open).

**Dokploy**: project, environment and service scopes with `${{project.X}}` / `${{environment.X}}`; external secret managers (Vault, Infisical, Doppler, AWS, Azure) fetched at deploy time ([variables](https://docs.dokploy.com/docs/core/variables)). Values are encrypted at rest since PR [#4789](https://github.com/Dokploy/dokploy/pull/4789) (2026-07-10). Build-arg vs runtime distinction: not found in docs.

## 7. Domains and HTTPS

**Coolify**: Traefik by default, Caddy "experimental"; switching regenerates labels and needs a restart of every resource ([proxies](https://coolify.io/docs/knowledge-base/server/proxies)). Let's Encrypt via HTTP challenge by default; DNS challenge (Hetzner and Cloudflare tokens shown) is required for wildcards ([dns challenge](https://coolify.io/docs/knowledge-base/proxy/traefik/dns-challenge), [wildcard](https://coolify.io/docs/knowledge-base/proxy/traefik/wildcard-certs)). Dynamic config is editable in the UI.

**Dokploy**: Traefik only, config in `/etc/dokploy/traefik/` and editable in the UI; Let's Encrypt resolver; custom certificates; wildcard certificates covered in the Cloudflare guide ([domains](https://docs.dokploy.com/docs/core/domains), [cloudflare](https://docs.dokploy.com/docs/core/domains/cloudflare)). Compose domains need a redeploy after changes.

## 8. Upgrades

**Coolify**: "Auto Update Enabled" is on by default; checks hourly, installs daily at 00:00; disable it and use the Update button ([self-update](https://coolify.io/docs/knowledge-base/self-update)). Manual: `curl -fsSL https://cdn.coollabs.io/coolify/install.sh | bash`, with an optional version argument; docs say "Always back up your Coolify data before starting an upgrade" ([upgrade](https://coolify.io/docs/get-started/upgrade)). Evidence of instability: v4.3.4 to v4.3.14 in twelve days is a lot of hot-fixing; [#11436](https://github.com/coollabsio/coolify/issues/11436) (2026-08-20, closed) reports the proxy losing project networks after a reboot with empty Traefik logs.

**Dokploy**: no auto-update in self-hosted; the comparison page lists updates as "Manual" ([differences](https://docs.dokploy.com/docs/core/differences)). Update with `curl -sSL https://dokploy.com/install.sh | sh -s update` or the UI ([installation](https://docs.dokploy.com/docs/core/installation)). Evidence: v0.30.3 (2026-08-30) broke compose `.env` loading for compose files in subdirectories ([#5252](https://github.com/Dokploy/dokploy/issues/5252), [#5259](https://github.com/Dokploy/dokploy/issues/5259), fixed in v0.30.4); updating Dokploy does not update the pinned Traefik container ([#5221](https://github.com/Dokploy/dokploy/issues/5221), open); a zombie `curl` process after v0.30.0 ([#5098](https://github.com/Dokploy/dokploy/issues/5098)).

## 9. Swarm on a single server

Coolify's default is plain Docker; Swarm is "an experimental feature" needing an external registry ([swarm](https://coolify.io/docs/knowledge-base/docker/swarm)). Dokploy always initialises Swarm and runs apps as Swarm services with health-check, restart and rollout settings ([advanced](https://docs.dokploy.com/docs/core/applications/advanced)). Consequences on one box: the install needs a valid advertise address ([networking](https://docs.dokploy.com/docs/core/troubleshooting/networking)); a start-order race can leave Dokploy unable to reach its Postgres after reboot, fixed by scaling the service to 0 and back ([instance](https://docs.dokploy.com/docs/core/troubleshooting/instance)); Hetzner private networks use MTU 1450 and needed a custom-MTU option ([#3446](https://github.com/Dokploy/dokploy/issues/3446), closed).

## 10. If the VPS dies

**Coolify**: back up the built-in Coolify DB dump (S3 or manual), `APP_KEY` from `/data/coolify/source/.env`, and `/data/coolify/ssh/keys/`; restore into a fresh install of the same version with `pg_restore` and `APP_PREVIOUS_KEYS` ([backup-restore](https://coolify.io/docs/knowledge-base/how-to/backup-restore-coolify)). App volumes are not included.

**Dokploy**: scheduled archive of `dokploy-postgres` plus `/etc/dokploy` to S3, restored from the UI; after a new IP you must fix server settings, Git providers and DNS ([backups](https://docs.dokploy.com/docs/core/backups)). App volumes need the separate volume backups.

## 11. Gotchas

- Docker bypasses ufw on both. Coolify's docs say so and suggest the provider firewall or `ufw-docker` ([firewall](https://coolify.io/docs/knowledge-base/server/firewall)). Dokploy publishes port 3000 on all interfaces; binding to loopback is an open request ([#2661](https://github.com/Dokploy/dokploy/issues/2661)).
- Disk: Coolify has scheduled/threshold Docker cleanup ([cleanup](https://coolify.io/docs/knowledge-base/server/automated-cleanup)). Dokploy's docs say a full disk can put its Postgres into recovery mode and give manual `docker system prune` commands ([instance](https://docs.dokploy.com/docs/core/troubleshooting/instance)).
- Hetzner DNS inside containers can fail; Dokploy suggests `"dns": ["1.1.1.1","8.8.8.8"]` in `daemon.json` ([networking](https://docs.dokploy.com/docs/core/troubleshooting/networking)).
- Coolify: no custom networks in compose files; proxy switch needs label regeneration.
- Dokploy: files mounted by relative path from the repo are lost on redeploy; use named volumes ([compose](https://docs.dokploy.com/docs/core/docker-compose)).

## 12. Paid offerings

Coolify self-hosted has "Full access to all features. No limitation or restrictions"; Cloud is $5/month for 2 servers ([pricing](https://coolify.io/pricing)). Dokploy self-hosted is free and shares the same deployment engine, but custom roles, SSO/SAML, SCIM, audit logs, whitelabel and advanced monitoring are Cloud or Enterprise only; Cloud is $4.50/server/month ([differences](https://docs.dokploy.com/docs/core/differences), [cloud](https://docs.dokploy.com/docs/core/cloud)).

## What I could not verify

- Measured idle RAM/CPU of either control plane. Neither project publishes numbers.
- A first-party statement that a Dokploy database can be used by apps in other projects.
- Dokploy docs for `keepLatestCount` retention and for compose-service backups; both exist in code and the UI, not in the docs pages I read.
- Dokploy build-time vs runtime variable handling.
- Whether Coolify backs up volumes or compose-defined databases (docs are silent; I assume no).
- Hetzner prices: CX23/CAX11 showed as "currently unavailable" with no price today.
- Whether Coolify's Traefik version is pinned per release.

## Sources

- https://github.com/coollabsio/coolify and https://github.com/coollabsio/coolify/releases
- https://github.com/Dokploy/dokploy and https://github.com/Dokploy/dokploy/releases
- https://github.com/Dokploy/dokploy/blob/canary/LICENSE.MD
- https://coolify.io/docs/get-started/installation, /get-started/upgrade, /knowledge-base/self-update
- https://coolify.io/docs/applications/build-packs, /applications/build-packs/docker-compose, /applications/ci-cd/github/overview
- https://coolify.io/docs/databases, /databases/postgresql, /databases/backups
- https://coolify.io/docs/knowledge-base/environment-variables, /server/proxies, /proxy/traefik/dns-challenge, /proxy/traefik/wildcard-certs
- https://coolify.io/docs/knowledge-base/how-to/backup-restore-coolify, /server/firewall, /server/automated-cleanup, /server/introduction, /docker/compose, /docker/swarm
- https://coolify.io/pricing
- https://docs.dokploy.com/docs/core/installation, /architecture, /applications, /applications/build-type, /applications/advanced, /deno, /github
- https://docs.dokploy.com/docs/core/databases, /databases/backups, /databases/restore, /backups, /volume-backups, /docker-compose, /docker-compose/utilities
- https://docs.dokploy.com/docs/core/variables, /domains, /domains/cloudflare, /cluster, /cloud, /differences
- https://docs.dokploy.com/docs/core/troubleshooting/networking, /troubleshooting/instance
- https://dokploy.com/install.sh (fetched 2026-09-02)
- https://nixpacks.com/docs/providers/deno, https://railpack.com/languages/deno
- https://www.hetzner.com/cloud/cost-optimized/
- GitHub issues cited inline: coolify #11436, #9514, #9860, #8932, #10406; dokploy #4928, #5221, #5252, #5259, #5098, #3446, #2661, #1559, PR #4789, PR #1801

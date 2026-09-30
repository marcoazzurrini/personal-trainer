# Bun owns development tooling, not the Workers runtime

Status: accepted. ADR-0015 still owns production hosting and database boundaries.

## Why change

Deno remained in the repository after the API stopped running as a Supabase
Edge Function and later as a Deno server. Keeping Deno imports, tasks, locks and
permission-oriented test launchers alongside npm-based Cloudflare and web tools
made development harder to explain and maintain.

Use Bun for dependency installation, project scripts and the former Deno tests.
Use Oxfmt and Oxlint through Ultracite, including its bundled anti-slop preset.
Do not vendor a second copy of anti-slop or retain a Deno compatibility layer.

## One dependency graph

The root package owns the Bun version, API tooling and D1 tests. The web
application is its only workspace. One committed `bun.lock` resolves both
packages. The separate D1 package was removed when ADR-0015 retired the completed
PostgreSQL transfer tooling. Installation is frozen in CI; dependency changes
must update that lock deliberately. Lefthook is
a local development dependency installed by the root prepare script, not a
custom launcher that fetches its own package at commit time.

Node remains available for tools that target it. Installing with Bun does not
mean forcing every executable to use Bun with `--bun`. Wrangler, Vite, Nitro,
Vitest and Playwright keep their supported execution paths.

## Script ownership

First-party scripts use TypeScript throughout. The root `scripts/` directory
contains the API builder, deployment command, shared source-revision helper
and secret scanner, with their checks in `scripts/tests/`. API fixtures and the
disposable runner live with API tests. Database tests, including migration-history
and configuration checks, live in `db/tests/`. There is no root `tests/` directory;
each area owns its tests. Duplicate checks are consolidated rather than retained
in both suites. The one-time Withings setup commands are retired;
Git history preserves them without retaining an active credential-writing tool.
Normal Withings synchronization is unchanged.

Build output remains generated and ignored. Removing a local `dist/` directory
does not remove the builder or weaken the immutable release verification required
by ADR-0015. A future build regenerates its output when needed.

## Tests exercise the real runtime

Bun runs API assertions and the local tooling and D1 suites. Miniflare
still supplies an isolated Worker and ephemeral D1; workerd executes the API.
Tests must establish the harness identity before destructive setup, refuse
remote bindings and discard all temporary state after success or failure.

The dashboard keeps Vitest and Playwright. Its built artifact is still tested
inside workerd. Neither application moves its production runtime to Bun or Node.

Bun does not reproduce Deno's process permission sandbox. The API harness instead
starts test clients with a clean environment, disables implicit dotenv loading,
guards their HTTP requests and blocks unconfigured Worker outbound requests.
Those safeguards prevent ordinary tests from accidentally targeting a live
record; they are not an operating-system sandbox for malicious test code or
installed dependencies. Test code and dependencies remain trusted local code.

Automatic dotenv loading for runtime and test commands is disabled in each
package's Bun configuration, since Bun resolves that configuration from the
selected working directory. Development commands explicitly load their intended
local secret file. Build and test commands must not acquire credentials merely
because a local `.env` exists. A synthetic-file test verifies this behavior for
both packages, not just the configuration text.

Bun 1.4.2's package manager is a separate boundary: `bun install` still loads
`.env`, even with `env = false` or `--no-env-file`. Dependency installation is a
trusted operation, not an isolated test run. CI installs from a clean checkout
without local credential files. The runtime setting must not be presented as
protection for installation lifecycle scripts.

## Formatting and linting

Ultracite supplies the Oxfmt defaults and Oxlint core, React, TanStack and
anti-slop presets. Explicit project overrides explain genuine conventions or
runtime boundaries; disabling the entire anti-slop preset or exempting all tests
is not an acceptable migration shortcut. Safe automatic fixes are followed by
type checks and behavioral tests. A style change is not permission to change API
refusals, stored arithmetic, authentication or database coordination.

Generated files, retained recovery material and skill documents are not formatter
inputs. Skill frontmatter is executable product configuration and must not be
rewritten as a side effect of changing development tools. Historical ADRs and
verification reports retain their original Deno-era context.

## References

- [Bun workspaces](https://bun.com/docs/pm/workspaces)
- [Bun tests](https://bun.com/docs/test)
- [Bun configuration](https://bun.com/docs/runtime/bunfig)
- [Ultracite's Oxlint, Oxfmt and anti-slop integration](https://www.ultracite.ai/docs/provider/oxlint)
- [Miniflare](https://developers.cloudflare.com/workers/testing/miniflare/)

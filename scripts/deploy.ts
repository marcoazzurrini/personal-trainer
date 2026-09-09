// Coolify 4.3.14 copies git_commit_sha into the deployment queue, then checks
// out that commit. POST /deploy does not accept a commit. Keep the application
// pin and the queue request inside the same serialized CI job.
export interface DeploymentConfig {
  origin: string;
  application: string;
  token: string;
  sha: string;
  repository: string;
  healthUrl: string;
}

const SHA = /^[a-f0-9]{40}$/;
const ID = /^[a-zA-Z0-9_-]+$/;
const TIMEOUT_MS = 15 * 60 * 1000;
const REQUEST_MS = 10_000;
const CONFIG_KEYS = [
  "COOLIFY_WEBHOOK",
  "COOLIFY_TOKEN",
  "GITHUB_SHA",
  "GITHUB_REPOSITORY",
  "DEPLOY_HEALTH_URL",
] as const;

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Deployment response must be a JSON object.");
  }
  return value as ObjectValue;
}

function https(value: string): URL {
  try {
    const url = new URL(value);
    if (
      url.protocol === "https:" && !url.username && !url.password && !url.hash
    ) return url;
  } catch {
    /* Use the same refusal without echoing a credential-bearing URL. */
  }
  throw new Error(
    "Deployment URLs must use HTTPS without credentials or fragments.",
  );
}

export function deploymentConfig(
  env: Record<string, string | undefined>,
): DeploymentConfig {
  for (const key of CONFIG_KEYS) {
    if (!env[key]?.trim()) {
      throw new Error(
        `Deployment requires ${key}; missing configuration is not success.`,
      );
    }
  }
  const webhook = https(env.COOLIFY_WEBHOOK!);
  const application = webhook.searchParams.get("uuid") ?? "";
  if (
    webhook.pathname !== "/api/v1/deploy" || !ID.test(application) ||
    webhook.searchParams.getAll("uuid").length !== 1 ||
    [...webhook.searchParams.keys()].some((key) =>
      !["uuid", "force"].includes(key)
    )
  ) {
    throw new Error(
      "COOLIFY_WEBHOOK must select exactly one application with /api/v1/deploy?uuid=<uuid>.",
    );
  }
  if (!SHA.test(env.GITHUB_SHA!)) {
    throw new Error("GITHUB_SHA must be the full lowercase tested commit SHA.");
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY!)) {
    throw new Error(
      "GITHUB_REPOSITORY must identify the tested owner/repository.",
    );
  }
  if (/[\r\n]/.test(env.COOLIFY_TOKEN!)) {
    throw new Error("COOLIFY_TOKEN must be a single-line token.");
  }
  const health = https(env.DEPLOY_HEALTH_URL!);
  if (health.pathname !== "/api/health" || health.search) {
    throw new Error(
      "DEPLOY_HEALTH_URL must be the public /api/health URL without a query.",
    );
  }
  return {
    origin: webhook.origin,
    application,
    token: env.COOLIFY_TOKEN!,
    sha: env.GITHUB_SHA!,
    repository: env.GITHUB_REPOSITORY!,
    healthUrl: health.href,
  };
}

interface Dependencies {
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

export async function deploy(
  config: DeploymentConfig,
  dependencies: Dependencies = {},
): Promise<string> {
  const send = dependencies.fetch ?? fetch;
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ??
    ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + (dependencies.timeoutMs ?? TIMEOUT_MS);
  function remaining(): number {
    const ms = deadline - now();
    if (ms <= 0) {
      throw new Error(
        "Deployment verification timed out; the tested revision is not proven live and healthy.",
      );
    }
    return ms;
  }
  // Bound headers AND body consumption. Never follow a redirect with the token,
  // print a response body, or retry a write whose outcome is unknown.
  async function request(path: string, method = "GET", body?: ObjectValue) {
    const signal = AbortSignal.timeout(Math.min(REQUEST_MS, remaining()));
    try {
      const response = await send(`${config.origin}/api/v1${path}`, {
        method,
        redirect: "error",
        signal,
        headers: {
          authorization: `Bearer ${config.token}`,
          "content-type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error();
      }
      return object(await response.json());
    } catch {
      throw new Error(
        `Coolify ${method} failed or returned invalid JSON. Check connectivity and read/write/deploy permissions; response details withheld.`,
      );
    }
  }
  const applicationPath = `/applications/${config.application}`;
  const application = await request(applicationPath);
  const settings = object(application.settings);
  if (
    application.uuid !== config.application ||
    application.git_repository !== config.repository ||
    application.git_branch !== "main" || application.build_pack !== "dockerfile"
  ) {
    throw new Error(
      "Coolify must build this repository's main branch with its Dockerfile.",
    );
  }
  if (
    settings.is_auto_deploy_enabled !== false ||
    settings.is_preview_deployments_enabled !== false ||
    settings.include_source_commit_in_build !== true ||
    settings.inject_build_args_to_dockerfile !== true ||
    settings.use_build_secrets !== false
  ) {
    throw new Error(
      "Verify Coolify settings: disable automatic/preview deploys, enable source-commit build arguments and Dockerfile argument injection, and disable build secrets. CI does not change these operator settings.",
    );
  }

  await request(applicationPath, "PATCH", { git_commit_sha: config.sha });
  const pinned = await request(applicationPath);
  if (pinned.git_commit_sha !== config.sha) {
    throw new Error(
      "Coolify did not retain the tested commit pin; no deployment requested.",
    );
  }
  const accepted = await request("/deploy", "POST", {
    uuid: config.application,
    force: true,
  });
  const deployments = accepted.deployments;
  if (!Array.isArray(deployments) || deployments.length !== 1) {
    throw new Error(
      "Coolify must accept exactly one deployment and return its ID.",
    );
  }
  const queued = object(deployments[0]);
  const id = queued.deployment_uuid;
  if (
    queued.resource_uuid !== config.application ||
    typeof id !== "string" || !ID.test(id)
  ) {
    throw new Error(
      "Coolify did not return a deployment ID for the selected application.",
    );
  }

  while (true) {
    remaining();
    const deployment = await request(`/deployments/${id}`);
    if (deployment.deployment_uuid !== id || deployment.commit !== config.sha) {
      throw new Error(
        "The queued deployment does not identify the exact tested commit.",
      );
    }
    if (
      !["queued", "in_progress", "finished"].includes(String(deployment.status))
    ) {
      throw new Error(
        "Coolify deployment failed, was cancelled, or returned an unknown status.",
      );
    }
    if (deployment.status === "finished") {
      const signal = AbortSignal.timeout(Math.min(REQUEST_MS, remaining()));
      let healthy = false;
      try {
        const response = await send(config.healthUrl, {
          redirect: "error",
          signal,
          cache: "no-store",
          headers: { "cache-control": "no-cache" },
        });
        if (response.ok) {
          const health = object(await response.json());
          healthy = health.status === "ok" && health.revision === config.sha;
        } else {
          await response.body?.cancel();
        }
      } catch { /* The old container or proxy may still be switching. */ }
      remaining();
      if (healthy) return id;
    }
    await sleep(Math.min(5000, remaining()));
  }
}

if (import.meta.main) {
  try {
    const config = deploymentConfig(
      Object.fromEntries(CONFIG_KEYS.map((key) => [key, Deno.env.get(key)])),
    );
    const id = await deploy(config);
    console.log(
      `Deployment ${id}: tested revision ${config.sha} is live and healthy.`,
    );
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : "Deployment verification failed.",
    );
    Deno.exit(1);
  }
}

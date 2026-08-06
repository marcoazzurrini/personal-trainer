// A thin GitHub REST client for docs proposals: create a branch off main,
// commit the changes to it, open a pull request. Plain fetch — the API is
// five small calls, not worth an SDK. Import-free on purpose: the unit
// tests run this file outside the edge runtime, against a stub server.

export interface GithubConfig {
  apiBase: string; // https://api.github.com, or the stub in tests
  token: string;
  repo: string; // "owner/name"
}

export interface DocChange {
  repoPath: string; // path inside the repository
  content: string | null; // null = delete the file
}

// Routes translate this into an ApiError; the message is written for the
// LLM on the other end, like every other error in this API.
export class GithubError extends Error {}

async function gh(
  cfg: GithubConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const res = await fetch(`${cfg.apiBase}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${cfg.token}`,
      accept: "application/vnd.github+json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = (json as { message?: string }).message ?? "no detail";
    throw new GithubError(
      `GitHub replied ${res.status} to ${method} ${path}: ${detail}`,
    );
  }
  return json;
}

// The sha is GitHub's optimistic lock: an update or delete must present
// the sha of the file version it replaces. null = the file does not exist.
async function fileSha(
  cfg: GithubConfig,
  contentsPath: string,
  branch: string,
): Promise<string | null> {
  const res = await fetch(`${cfg.apiBase}${contentsPath}?ref=${branch}`, {
    headers: {
      authorization: `Bearer ${cfg.token}`,
      accept: "application/vnd.github+json",
    },
  });
  if (res.status === 404) {
    await res.body?.cancel();
    return null;
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = (json as { message?: string }).message ?? "no detail";
    throw new GithubError(
      `GitHub replied ${res.status} to GET ${contentsPath}: ${detail}`,
    );
  }
  return (json as { sha: string }).sha;
}

// btoa corrupts characters outside Latin-1, so encode to UTF-8 bytes first;
// chunked because String.fromCharCode takes its input as arguments.
function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export async function openDocsProposal(
  cfg: GithubConfig,
  opts: { title: string; rationale: string; changes: DocChange[] },
): Promise<{ prUrl: string; branch: string }> {
  const repo = `/repos/${cfg.repo}`;

  const main = await gh(cfg, "GET", `${repo}/git/ref/heads/main`) as {
    object: { sha: string };
  };
  const branch = `docs/${crypto.randomUUID().slice(0, 8)}`;
  await gh(cfg, "POST", `${repo}/git/refs`, {
    ref: `refs/heads/${branch}`,
    sha: main.object.sha,
  });

  for (const change of opts.changes) {
    const contents = `${repo}/contents/${change.repoPath}`;
    const sha = await fileSha(cfg, contents, branch);
    if (change.content === null) {
      if (sha === null) {
        throw new GithubError(
          `Cannot delete ${change.repoPath}: no such file on main.`,
        );
      }
      await gh(cfg, "DELETE", contents, {
        message: `Docs proposal: delete ${change.repoPath}`,
        sha,
        branch,
      });
    } else {
      await gh(cfg, "PUT", contents, {
        message: `Docs proposal: ${
          sha === null ? "create" : "update"
        } ${change.repoPath}`,
        content: base64(change.content),
        branch,
        ...(sha === null ? {} : { sha }),
      });
    }
  }

  const pr = await gh(cfg, "POST", `${repo}/pulls`, {
    title: opts.title,
    head: branch,
    base: "main",
    body: `${opts.rationale}\n\n---\n` +
      "Proposed by the coach via POST /api/docs-proposals.",
  }) as { html_url: string };

  return { prUrl: pr.html_url, branch };
}

export async function listDocsProposals(
  cfg: GithubConfig,
): Promise<{ title: string; url: string; branch: string }[]> {
  const pulls = await gh(
    cfg,
    "GET",
    `/repos/${cfg.repo}/pulls?state=open&per_page=100`,
  ) as { title: string; html_url: string; head: { ref: string } }[];
  return pulls
    .filter((p) => p.head.ref.startsWith("docs/"))
    .map((p) => ({ title: p.title, url: p.html_url, branch: p.head.ref }));
}

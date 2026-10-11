// A thin GitHub REST client for the issues the coach files. Plain fetch —
// three small calls, not worth an SDK. Response schemas need no database;
// unit tests exercise this client against a local stub server.
//
// The coach files issues; it does not open pull requests. It has the
// conversations and none of the repository, so what it can produce well is
// evidence, not a diff. The change itself is written from the repository,
// where the tests and the rest of the code are visible.

import { z } from "@hono/zod-openapi";
import { Data, Effect, Redacted } from "effect";

export interface GithubConfig {
  apiBase: string; // https://api.github.com, or the stub in tests
  // Unwrapped only into the Authorization header.
  token: Redacted.Redacted<string>;
  repo: string; // "owner/name"
}

// Every issue the coach files carries this label. It is what separates its
// reports from anything filed by hand, and what GET /issues filters on.
export const COACH_LABEL = "coach";

// The one enum on the whole endpoint. A bug is the system doing something
// wrong; an improvement is anything that would work better. Both become a
// label alongside COACH_LABEL, so the issue list sorts itself.
export const ISSUE_KINDS = ["bug", "improvement"] as const;
export type IssueKind = (typeof ISSUE_KINDS)[number];

// Routes translate this into a refusal; the message is written for the
// LLM on the other end, like every other error in this API. The status is
// carried so a route can tell a mistake by the caller (a wrong issue
// number) from GitHub being unreachable — a 502 in answer to a typo tells
// the caller nothing it can act on.
export class GithubError extends Data.TaggedError("GithubError")<{
  readonly message: string;
  readonly status: number;
}> {}

const nonempty = z.string().refine((value) => value.trim().length > 0);
const httpUrl = nonempty.refine((value) => {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
});
const timestamp = nonempty.refine((value) =>
  Number.isFinite(Date.parse(value))
);
const positiveIssueNumber = z.number().refine(Number.isSafeInteger).positive();
const openedIssue = z.object({
  number: positiveIssueNumber,
  html_url: httpUrl,
});
const postedComment = z.object({ html_url: httpUrl });
type GithubWrite =
  | { title: string; body: string; labels: string[] }
  | { body: string };

function retryAdvice(method: "GET" | "POST"): string {
  return method === "GET"
    ? "Try the read again later."
    : "The write may already exist at GitHub. Check existing issues or comments before retrying; do not blindly repeat the write.";
}

function malformed(method: "GET" | "POST"): GithubError {
  return new GithubError({
    status: 502,
    message: `GitHub returned an unusable response. ${retryAdvice(method)}`,
  });
}

function unreachable(method: "GET" | "POST", outcome: string): GithubError {
  return new GithubError({
    status: 502,
    message: `GitHub ${outcome}. ${retryAdvice(method)}`,
  });
}

const gh = Effect.fn("github.request")(function* <Result>(
  cfg: GithubConfig,
  method: "GET" | "POST",
  path: string,
  schema: z.ZodType<Result>,
  body?: GithubWrite
): Effect.fn.Return<Result, GithubError> {
  const headers = new Headers({
    authorization: `Bearer ${Redacted.value(cfg.token)}`,
    accept: "application/vnd.github+json",
    // GitHub requires an explicit User-Agent in the Workers runtime.
    "user-agent": "personal-trainer",
  });
  if (body !== undefined) {
    headers.set("content-type", "application/json");
  }
  // One attempt, never retried: a write whose answer was lost may already
  // exist at GitHub, and only the caller can reconcile that. The deadline
  // covers the headers and the body alike, and interrupting the fetch aborts
  // it through the signal.
  const { res, json } = yield* Effect.tryPromise({
    try: async (signal) => {
      const options =
        method === "GET"
          ? { signal, method, headers }
          : {
              signal,
              method,
              headers,
              body: body === undefined ? undefined : JSON.stringify(body),
            };
      const response = await fetch(`${cfg.apiBase}${path}`, options);
      const parsed: unknown = await response.json().catch((error) => {
        if (signal.aborted) {
          throw error;
        }
        return {};
      });
      return { res: response, json: parsed };
    },
    catch: () => unreachable(method, "could not be reached"),
  }).pipe(
    Effect.timeoutOrElse({
      duration: "5 seconds",
      orElse: () =>
        Effect.fail(unreachable(method, "timed out after 5 seconds")),
    })
  );
  if (!res.ok) {
    const failure = z.object({ message: z.string() }).safeParse(json);
    const detail = failure.success ? failure.data.message : "no detail";
    return yield* new GithubError({
      status: res.status,
      message: `GitHub replied ${res.status} to ${method} ${path}: ${detail}`,
    });
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    return yield* malformed(method);
  }
  return parsed.data;
});

// The issue's markdown, assembled here rather than accepted from the caller.
// Every report reading the same way is the point: whoever picks it up in the
// repository gets the evidence in a known place instead of re-interviewing
// the coach through Marco. Lives in this file, next to the call that posts
// it, because that keeps it reachable from the unit tests — the route that
// builds it cannot run without a GitHub token.
export function issueBody(opts: {
  problem: string;
  evidence: string | null;
  suggestion: string | null;
  docs: string[];
  requestId: string;
}): string {
  const parts = [`## The problem\n\n${opts.problem}`];
  if (opts.evidence) {
    parts.push(`## What was seen\n\n${opts.evidence}`);
  }
  if (opts.suggestion) {
    parts.push(`## What the coach suggests\n\n${opts.suggestion}`);
  }
  if (opts.docs.length > 0) {
    parts.push(
      `## Documents involved\n\n${opts.docs
        .map((d) => `- \`${d}\``)
        .join("\n")}`
    );
  }
  // Says how much authority the report carries. The observations are
  // first-hand and the diagnosis is not — the coach cannot read the code it
  // is describing, so a confident-sounding cause is still a guess.
  parts.push(
    `---\n\nFiled by the coach through \`POST /issues\` · request \`${opts.requestId}\`\n\n` +
      "The coach has the conversations, not the repository: what it saw is " +
      "first-hand, why it thinks it happened is not. Check the code before " +
      "believing the diagnosis."
  );
  return parts.join("\n\n");
}

export const openIssue = Effect.fn("github.openIssue")(function* (
  cfg: GithubConfig,
  opts: { title: string; body: string; kind: IssueKind }
): Effect.fn.Return<{ number: number; url: string }, GithubError> {
  const issue = yield* gh(
    cfg,
    "POST",
    `/repos/${cfg.repo}/issues`,
    openedIssue,
    {
      title: opts.title,
      body: opts.body,
      labels: [COACH_LABEL, opts.kind],
    }
  );
  return { number: issue.number, url: issue.html_url };
});

export interface CoachIssue {
  number: number;
  title: string;
  url: string;
  kind: string | null;
  created_at: string;
}

const coachIssues = z.array(
  z.object({
    number: positiveIssueNumber,
    title: z.string(),
    html_url: httpUrl,
    created_at: timestamp,
    labels: z.array(z.object({ name: z.string() })),
    // Only presence matters: any supplied pull_request value excludes this entry.
    pull_request: z
      .unknown()
      .optional()
      .transform((value) => value !== undefined),
  })
);

export const listCoachIssues = Effect.fn("github.listCoachIssues")(function* (
  cfg: GithubConfig
): Effect.fn.Return<CoachIssue[], GithubError> {
  const raw = yield* gh(
    cfg,
    "GET",
    `/repos/${cfg.repo}/issues?state=open&labels=${COACH_LABEL}&per_page=100`,
    coachIssues
  );
  return (
    raw
      // GitHub's REST API counts every pull request as an issue, so this
      // endpoint returns both and the pull_request key is the only thing that
      // tells them apart. Without this filter a labelled pull request would
      // list as something the coach filed, and it would then be told the
      // problem was already reported when nobody had reported it.
      .filter((i) => !i.pull_request)
      .map((i) => ({
        number: i.number,
        title: i.title,
        url: i.html_url,
        kind:
          i.labels
            .map((l) => l.name)
            .find((n) => ISSUE_KINDS.some((kind) => kind === n)) ?? null,
        created_at: i.created_at,
      }))
  );
});

export const commentOnIssue = Effect.fn("github.commentOnIssue")(function* (
  cfg: GithubConfig,
  issueNumber: number,
  body: string
): Effect.fn.Return<{ url: string }, GithubError> {
  const comment = yield* gh(
    cfg,
    "POST",
    `/repos/${cfg.repo}/issues/${issueNumber}/comments`,
    postedComment,
    { body }
  );
  return { url: comment.html_url };
});

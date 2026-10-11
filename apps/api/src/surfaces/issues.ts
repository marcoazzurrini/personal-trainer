// The coach's one channel for "something about this system is in the way".
// It files a GitHub issue; it never writes code, and it never edits the live
// documents. The change is made from the repository afterwards, where the
// tests and the rest of the code can be seen. So what this asks for is the
// half the coach alone has — what it did, what came back, how often — and not
// the half it would have to guess at.

import { Config, Effect, Option } from "effect";

import {
  Invalid,
  Misconfigured,
  NotFound,
  Upstream,
} from "../shared/refusals.ts";
import {
  commentOnIssue,
  issueBody,
  listCoachIssues,
  openIssue,
} from "./github.ts";
import type { GithubConfig, GithubError, IssueKind } from "./github.ts";

// What a report may name as a document: lowercase words joined by hyphens,
// nested with slashes — "tasks/programming", "method/hypertrophy" — the way
// the skill writes them. The documents themselves ship in the plugin
// and never pass through this function; this only refuses a name that could
// not be one, so an issue never cites a document that cannot exist.
const DOC_NAME_RE = /^[a-z0-9-]+(?:\/[a-z0-9-]+)*$/u;

export const MAX_DOC_NAME = 80;

export function isDocName(name: string): boolean {
  return name.length <= MAX_DOC_NAME && DOC_NAME_RE.test(name);
}

const MAX_TITLE = 200;
const MAX_PROBLEM = 4000;
const MAX_EVIDENCE = 8000;
const MAX_SUGGESTION = 4000;
const MAX_COMMENT = 8000;
const MAX_DOCS = 10;

export interface CoachIssue {
  number: number;
  title: string;
  url: string;
  kind: string | null;
  created_at: string;
}

export interface OpenedIssue {
  number: number;
  url: string;
  kind: IssueKind;
  title: string;
}

// The bindings the relay reads, through the request's ConfigProvider.
export interface IssueBindings {
  GITHUB_TOKEN?: string;
  GITHUB_REPO?: string;
  GITHUB_API_BASE?: string;
}

// Read only for this request, from its own bindings. Missing GitHub
// configuration must not disable unrelated record reads, and bindings must
// never leak across environments.
const settings = Config.all({
  token: Config.option(Config.Redacted("GITHUB_TOKEN")),
  repo: Config.option(Config.String("GITHUB_REPO")),
  apiBase: Config.String("GITHUB_API_BASE").pipe(
    Config.withDefault("https://api.github.com")
  ),
});

const config = Effect.fn("issues.config")(function* (): Effect.fn.Return<
  GithubConfig,
  Misconfigured
> {
  // A binding of the wrong type is a deployment bug, not a refusal.
  const { token, repo, apiBase } = yield* settings.pipe(Effect.orDie);
  if (Option.isNone(token) || Option.isNone(repo)) {
    return yield* new Misconfigured({
      message:
        "Filing issues needs GITHUB_TOKEN and GITHUB_REPO configured on the server.",
    });
  }
  return { apiBase, token: token.value, repo: repo.value };
});

// GitHub's own answer, relayed as the 502 it is.
function upstream(error: GithubError): Effect.Effect<never, Upstream> {
  return Effect.fail(new Upstream({ message: error.message }));
}

// Length stays a check on the parsed value rather than a schema max: the
// message is about reports, not about strings, and it is the same sentence
// for five different fields.
function capped(
  value: string,
  max: number,
  field: string
): Effect.Effect<string, Invalid> {
  if (value.length > max) {
    return Effect.fail(
      new Invalid({
        message: `"${field}" exceeds ${max} characters. Say the essential thing; a report nobody finishes reading is not a report.`,
      })
    );
  }
  return Effect.succeed(value);
}

// Defense in depth for public reports, not a general secret classifier.
// Only the explicit [REDACTED] marker is safe in a credential position.
function requireSanitizedReport(value: string): Effect.Effect<void, Invalid> {
  const credentials = value.matchAll(
    /(?:\bbearer\s+|\b(?:set-cookie|cookie)["']?\s*[:=]\s*["']?|(?:--cookie(?:-jar)?\s+|(?:^|\s)-b\s*)["']?)(?<credential>[^\r\n"'`]+)/giu
  );
  for (const [, credential] of credentials) {
    if (credential.trim() === "[REDACTED]") {
      continue;
    }
    return Effect.fail(
      new Invalid({
        message:
          "Public reports must be sanitized. Remove authorization credentials and cookies from every field, or replace their entire value with [REDACTED]. Use synthetic personal details; ask consent before publishing sensitive details that cannot be removed. No report was sent.",
      })
    );
  }
  return Effect.void;
}

// Optional, and validated as document names rather than free text so a
// report about a document names something that can actually be fetched.
// The count and the name rules stay here: both messages number the offending
// entry, which a per-element schema error cannot phrase the same way.
function parseDocs(
  raw: string[] | null | undefined
): Effect.Effect<string[], Invalid> {
  if (raw === undefined || raw === null) {
    return Effect.succeed([]);
  }
  if (raw.length > MAX_DOCS) {
    return Effect.fail(
      new Invalid({
        message: `"docs" names at most ${MAX_DOCS} documents. A report touching more than that is really several reports.`,
      })
    );
  }
  const misnamed = raw.findIndex((name) => !isDocName(name));
  if (misnamed !== -1) {
    return Effect.fail(
      new Invalid({
        message: `"docs[${misnamed}]" must be a document name as the skill writes them: lowercase words, hyphens, slashes for nesting, no extension — like "tasks/programming" (max ${MAX_DOC_NAME} chars).`,
      })
    );
  }
  return Effect.succeed(raw);
}

/** Every open coach-filed issue in the repository. */
export const listIssues = Effect.fn("issues.listIssues")(
  function* (): Effect.fn.Return<CoachIssue[], Misconfigured | Upstream> {
    return yield* listCoachIssues(yield* config()).pipe(
      Effect.catchTag("GithubError", upstream)
    );
  }
);

export const fileIssue = Effect.fn("issues.fileIssue")(function* (b: {
  kind: IssueKind;
  title: string;
  problem: string;
  evidence?: string | null;
  suggestion?: string | null;
  docs?: string[];
  request_id: string;
}): Effect.fn.Return<OpenedIssue, Invalid | Misconfigured | Upstream> {
  for (const value of [
    b.title,
    b.problem,
    b.evidence,
    b.suggestion,
    ...(b.docs ?? []),
    b.request_id,
  ]) {
    if (value !== null && value !== undefined) {
      yield* requireSanitizedReport(value);
    }
  }
  const { kind } = b;
  const title = yield* capped(b.title, MAX_TITLE, "title");
  const problem = yield* capped(b.problem, MAX_PROBLEM, "problem");
  // Required for a bug and optional for an improvement. A bug without the
  // call that produced it cannot be reproduced from the repository, which is
  // the only place it can be fixed — the report would arrive as a rumour. An
  // improvement is allowed to start as an idea.
  const rawEvidence = b.evidence ?? null;
  if (kind === "bug" && rawEvidence === null) {
    return yield* new Invalid({
      message:
        '"evidence" is required for a bug: the sanitized call, sanitized response, and when. Remove credentials and cookies; substitute synthetic personal details. Nobody can reproduce it from the repository without that, and a bug that cannot be reproduced cannot be fixed. If you cannot show it, file it as an improvement and say what you suspect.',
    });
  }
  const evidence =
    rawEvidence === null
      ? null
      : yield* capped(rawEvidence, MAX_EVIDENCE, "evidence");
  const rawSuggestion = b.suggestion ?? null;
  const suggestion =
    rawSuggestion === null
      ? null
      : yield* capped(rawSuggestion, MAX_SUGGESTION, "suggestion");
  const docs = yield* parseDocs(b.docs);

  const opened = yield* openIssue(yield* config(), {
    title,
    kind,
    body: issueBody({
      problem,
      evidence,
      suggestion,
      docs,
      requestId: b.request_id,
    }),
  }).pipe(Effect.catchTag("GithubError", upstream));

  // request_id is only a marker in the GitHub body. Repeating it may create
  // another issue; reconcile uncertain delivery in GitHub before trying again.
  return { ...opened, kind, title };
});

/**
 * Adds to a report already open.
 *
 * Hitting the same problem again belongs on the open issue, not in a second
 * one: the value of a repeat is that it makes a pattern, and a pattern split
 * across two issues reads as two anecdotes.
 *
 * Like issue creation, this is a stateless relay with no deduplication.
 * Reconcile uncertain delivery in GitHub before repeating a comment.
 */
export const commentOnReport = Effect.fn("issues.commentOnReport")(function* (
  issueNumber: number,
  rawNote: string
): Effect.fn.Return<
  { url: string },
  Invalid | Misconfigured | NotFound | Upstream
> {
  yield* requireSanitizedReport(rawNote);
  const note = yield* capped(rawNote, MAX_COMMENT, "note");
  return yield* commentOnIssue(yield* config(), issueNumber, note).pipe(
    Effect.catchTag(
      "GithubError",
      (error): Effect.Effect<never, NotFound | Upstream> =>
        // A wrong number is the caller's mistake, and answering it with a 502
        // would say the server is broken when it is not. Errors are prompts.
        error.status === 404
          ? Effect.fail(
              new NotFound({
                message: `No issue #${issueNumber} in the repository. GET /issues lists the open ones with their numbers.`,
              })
            )
          : upstream(error)
    )
  );
});

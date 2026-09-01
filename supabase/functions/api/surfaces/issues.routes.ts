import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { commentOnReport, fileIssue, listIssues } from "./issues.ts";
import { ISSUE_KINDS } from "./github.ts";
import {
  body,
  idParam,
  optionalText,
  query,
  requestId,
  text,
} from "../shared/schema.ts";

// The only enum on the endpoint, and it decides what else is required. Its
// message carries the whole distinction rather than listing two words,
// because the choice is the one piece of triage the coach does for us.
const kindError = () =>
  '"kind" must be one of: bug, improvement. A bug is the system doing something wrong — a call that failed, a number that came back wrong, an error message that sent you the wrong way; it also requires "evidence". An improvement is anything that would work better, including a document that has proven incomplete or a capability the API is missing.';

const docsError = () =>
  '"docs" must be an array of document names, like ["tasks/programming"]. Leave it out if no document is involved.';

export const issues = new OpenAPIHono();

const Issue = z.object({
  number: z.int(),
  title: z.string(),
  url: z.string(),
  kind: z.string().nullable(),
  created_at: z.string(),
});

const OpenedIssue = z.object({
  number: z.int(),
  url: z.string(),
  kind: z.enum(ISSUE_KINDS),
  title: z.string(),
});

issues.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Issues"],
    summary: "Open reports the coach has filed",
    request: { query: query({}) },
    responses: {
      200: {
        description: "Every open coach-filed issue in the repository.",
        content: {
          "application/json": {
            schema: z.object({ issues: z.array(Issue) }),
          },
        },
      },
      502: { description: "GitHub could not be reached." },
    },
  }),
  async (c) => c.json({ issues: await listIssues() }),
);

issues.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["Issues"],
    summary: "File a report",
    description:
      "Files a GitHub issue. `evidence` is required for a bug — the call, the response, and when — because a bug that cannot be reproduced cannot be fixed. An improvement is allowed to start as an idea.",
    request: {
      query: query({}),
      body: {
        content: {
          "application/json": {
            schema: body({
              kind: z.enum(ISSUE_KINDS, { error: kindError }),
              title: text(),
              problem: text(),
              evidence: optionalText(),
              suggestion: optionalText(),
              docs: z.array(z.string({ error: docsError }), {
                error: docsError,
              }).optional().meta({
                description:
                  'Document names as GET /docs/index writes them, like ["tasks/programming"].',
              }),
              request_id: requestId(),
            }),
          },
        },
      },
    },
    responses: {
      201: {
        description: "The issue that was opened.",
        content: {
          "application/json": {
            schema: z.object({ issue: OpenedIssue }),
          },
        },
      },
      200: {
        description:
          "The issue this request_id already opened. A retry, answered before anything reaches GitHub.",
        content: {
          "application/json": {
            schema: z.object({ issue: OpenedIssue }),
          },
        },
      },
      422: {
        description:
          "A bug without evidence, a field over its length, or a docs entry that is not a document name.",
      },
      502: { description: "GitHub could not be reached." },
    },
  }),
  async (c) => {
    const { issue, created } = await fileIssue(c.req.valid("json"));
    return created ? c.json({ issue }, 201) : c.json({ issue }, 200);
  },
);

issues.openapi(
  createRoute({
    method: "post",
    path: "/{number}/comments",
    tags: ["Issues"],
    summary: "Add to a report already open",
    description:
      "Hitting the same problem again belongs on the open issue: the value of a repeat is that it makes a pattern, and a pattern split across two issues reads as two anecdotes.",
    request: {
      query: query({}),
      params: z.object({ number: idParam("issue") }),
      body: {
        content: { "application/json": { schema: body({ note: text() }) } },
      },
    },
    responses: {
      201: {
        description: "The comment that was added.",
        content: {
          "application/json": {
            schema: z.object({ comment: z.object({ url: z.string() }) }),
          },
        },
      },
      404: { description: "No issue carries that number." },
      502: { description: "GitHub could not be reached." },
    },
  }),
  async (c) =>
    c.json({
      comment: await commentOnReport(
        c.req.valid("param").number,
        c.req.valid("json").note,
      ),
    }, 201),
);

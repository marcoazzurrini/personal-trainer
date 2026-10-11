import { defineTool } from "@flue/runtime";
import { env } from "cloudflare:workers";
import * as v from "valibot";

import { API_METHODS, apiRequest, apiResult } from "../api-call.ts";
import type { ApiCall, ApiReply, JsonObject } from "../api-call.ts";

/** One request to the API through the service binding, with the coach's secret. */
export async function callApi(
  call: ApiCall,
  signal?: AbortSignal
): Promise<ApiReply> {
  const { API, COACH_AGENT_TOKEN } = env;
  if (!COACH_AGENT_TOKEN) {
    throw new Error(
      "The coach has no API credential configured, so the record cannot be read or written. Tell Marco the app needs its COACH_AGENT_TOKEN secret."
    );
  }
  const request = apiRequest(call, COACH_AGENT_TOKEN);
  return await apiResult(await API.fetch(new Request(request, { signal })));
}

// The API is never ported to tools: this is the curl of the documents, with
// the base URL and the token already applied.
export const apiTool = defineTool({
  name: "api",
  description:
    'Call the training and nutrition API, exactly as the personal-trainer skill documents describe its curl calls. "path" is relative to the documents\' base URL (for example "/training-state" or "/sessions/12/sets"); never include the host. Authorization is already applied. Returns the HTTP status and the JSON body; a refusal\'s body says what a correct call looks like.',
  input: v.object({
    method: v.picklist(API_METHODS),
    path: v.string(),
    query: v.optional(v.record(v.string(), v.string())),
    body: v.optional(v.record(v.string(), v.unknown())),
  }),
  timeoutMs: 30_000,
  async run({ data, signal }) {
    const { body, ...call } = data;
    return {
      output: await callApi(
        // SAFETY: the model's arguments arrive as parsed JSON, so every value
        // in the body is a JSON value.
        body === undefined ? call : { ...call, body: body as JsonObject },
        signal
      ),
    };
  },
});

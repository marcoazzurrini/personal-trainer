// How the coach's one API tool turns a model's call into a request. Pure, so
// the rules below are tested without a Worker: the model chooses a method and a
// path under the API's base, never a host, and never sees the credential.

export const API_METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE"] as const;
export type ApiMethod = (typeof API_METHODS)[number];

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface JsonObject {
  [key: string]: JsonValue;
}

export interface ApiCall {
  method: ApiMethod;
  path: string;
  query?: Record<string, string>;
  body?: JsonObject;
}

// A service binding ignores the host, so this name is only a placeholder that
// can never resolve on the public internet.
const API_ORIGIN = "https://trainer-api.internal";

export class ApiPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiPathError";
  }
}

// oxlint-disable-next-line typescript/consistent-type-definitions -- Tool output must be assignable to Flue's JSON value type, and an interface is not.
export type ApiReply = { status: number; body: JsonValue };

/** The path the API mounts every route under, joined to the model's path. */
export function apiUrl(path: string, query: Record<string, string> = {}): URL {
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    /[?#\\]|\.\.|:\/\//u.test(path)
  ) {
    throw new ApiPathError(
      `"${path}" is not a path under the API's base URL. Write it as the documents do, for example "/training-state", and pass query parameters in "query".`
    );
  }
  // The documents write paths relative to a base that already ends in /api.
  const relative = path.replace(/^(?:\/api)+(?=\/|$)/u, "") || "/";
  const url = new URL(`/api${relative}`, API_ORIGIN);
  for (const [name, value] of Object.entries(query)) {
    url.searchParams.set(name, value);
  }
  return url;
}

export function apiRequest(call: ApiCall, token: string): Request {
  const headers = new Headers({
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
  });
  let body: string | undefined;
  if (call.body !== undefined) {
    if (call.method === "GET") {
      throw new ApiPathError(
        'A GET request has no body. Put filters in "query".'
      );
    }
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(call.body);
  }
  return new Request(apiUrl(call.path, call.query), {
    method: call.method,
    headers,
    body,
    redirect: "manual",
  });
}

/** What the model reads back: the status and the API's own words. */
export async function apiResult(response: Response): Promise<ApiReply> {
  const text = await response.text();
  try {
    // SAFETY: JSON.parse only ever produces JSON values.
    return { status: response.status, body: JSON.parse(text) as JsonValue };
  } catch {
    return { status: response.status, body: text };
  }
}

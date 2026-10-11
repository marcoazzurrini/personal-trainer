import type { D1Database } from "@cloudflare/workers-types";

import type { IssueBindings } from "./surfaces/issues.ts";

/** Secrets and capabilities are supplied to each invocation, never read globally. */
export interface Bindings extends IssueBindings {
  DB: D1Database;
  AUTH_ISSUER?: string;
  AUTH_JWKS_URL?: string;
  ALLOWED_SUBJECT?: string;
  PUBLIC_ORIGIN?: string;
  WEB_AUTH_ISSUER?: string;
  WEB_AUTH_CLIENT_ID?: string;
  WEB_AUTH_JWKS_URL?: string;
  WITHINGS_CLIENT_ID?: string;
  WITHINGS_CLIENT_SECRET?: string;
  WITHINGS_API_BASE?: string;
}

export interface Invocation {
  waitUntil: (promise: Promise<unknown>) => void;
  passThroughOnException: () => void;
}

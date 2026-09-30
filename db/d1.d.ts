// Drizzle's D1 declarations reference global binding types. Expose only those
// types, not Workers' global fetch/Response declarations in Bun tooling tests.
import type {
  D1Database as Binding,
  D1PreparedStatement as PreparedStatement,
  D1Result as QueryResult,
  D1Response as QueryResponse,
} from "@cloudflare/workers-types";

declare global {
  type D1Database = Binding;
  type D1PreparedStatement = PreparedStatement;
  type D1Result<T = unknown> = QueryResult<T>;
  type D1Response = QueryResponse;
}

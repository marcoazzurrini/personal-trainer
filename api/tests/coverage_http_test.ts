import { test } from "node:test";

import { assertEquals } from "./assertions.ts";
import { api } from "./helpers.ts";
// Imports no API handler: its normalization/not-found branches can only appear
// in coverage collected by the separately running HTTP server.
test("an HTTP-only probe exercises the API normalization branch", async () => {
  const response = await api.get("/api/no-such-coverage-route");
  assertEquals(response.status, 404);
  assertEquals(
    response.body.error,
    "No route for GET /api/no-such-coverage-route."
  );
});

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import postgres from "postgres";
import { constraintMessages } from "../supabase/functions/api/shared/errors.ts";
import { api, uuid } from "./helpers.ts";

// The error map, held against the database it describes.
//
// errors.ts names 28 constraints and gives each a message written for the
// coach. The names only mean something while the constraints exist: rename
// one in a migration and its message silently demotes to the generic
// fallback, which is exactly the kind of quiet regression a suite exists to
// catch. So every named constraint is checked against the live catalog, and
// a failure names the orphaned entry.

const DB_URL = Deno.env.get("TEST_DATABASE_URL") ??
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

Deno.test("every named constraint exists in the database", async () => {
  const db = postgres(DB_URL);
  try {
    // Unique/check/foreign-key constraints live in pg_constraint; a partial
    // unique *index* (mesocycles_one_active_per_track) only in pg_indexes.
    const rows = await db`
      select conname as name from pg_constraint
      union
      select indexname from pg_indexes where schemaname = 'public'`;
    const live = new Set(rows.map((r) => r.name as string));
    for (const name of Object.keys(constraintMessages)) {
      assert(
        live.has(name),
        `errors.ts writes a message for "${name}", but no constraint or ` +
          "index with that name exists — renamed in a migration? The " +
          "message now never fires and callers get the generic fallback.",
      );
    }
  } finally {
    await db.end();
  }
});

Deno.test("a null in a required column is a prompt, not a 500", async () => {
  // The one reproducible way through every validator to a not-null
  // violation: PATCH a near-zero food's kcal to an explicit null. The
  // energy check passes on its 20 kcal floor, Postgres refuses the write,
  // and before the 23502 branch existed the answer was "Internal error".
  const name = `Constraint Probe ${uuid()}`;
  await api.post("/foods", {
    name,
    kcal_100g: 2,
    protein_100g: 0,
    carbs_100g: 0,
    fat_100g: 0,
    source: "estimate",
    source_note: "tripwire probe",
  });
  const { status, body } = await api.patch(
    `/foods/${encodeURIComponent(name)}`,
    { kcal_100g: null },
  );
  assertEquals(status, 422);
  assertStringIncludes(body.error, '"kcal_100g"');
  await api.delete(`/foods/${encodeURIComponent(name)}`);
});

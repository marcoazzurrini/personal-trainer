import { assert, assertEquals } from "@std/assert";
import postgres from "postgres";
import {
  api,
  type ApiResponse,
  DB_URL,
  ensureCatalogue,
  resetTraining,
  today,
  uuid,
} from "./helpers.ts";

Deno.test("discard and every actual writer honor the same session boundary", async (t) => {
  await resetTraining();
  await ensureCatalogue();
  const db = postgres(DB_URL);
  const gate = await db.reserve();
  // A trigger holds the winning operation mid-write. Database lock state,
  // not a sleep or request launch order, proves both calls overlap.
  async function blocked(count: number) {
    const end = Date.now() + 5000;
    while (Date.now() < end) {
      const [{ n }] = await db`select count(*)::int as n from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'`;
      if (n >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(
      `Expected ${count} blocked operations at the controlled boundary.`,
    );
  }
  try {
    await db`create function test_session_gate() returns trigger language plpgsql as $$
      begin
        perform pg_advisory_xact_lock(90254);
        if TG_OP = 'DELETE' then return old; end if;
        return new;
      end $$`;
    for (const writer of ["correct", "append", "start", "finish"] as const) {
      for (const deletionWins of [false, true]) {
        await t.step(
          `${writer}: ${deletionWins ? "deletion" : "logging"} wins`,
          async () => {
            const draft = await api.post("/sessions", {
              request_id: uuid(),
              date: today(),
              rationale: "Controlled race",
              sets: [{
                exercise: "squat",
                kind: "working",
                target_reps: 8,
                target_weight_kg: 100,
              }],
            });
            assertEquals(draft.status, 201);
            const session = draft.body.session;
            const write = () =>
              writer === "correct"
                ? api.patch(`/sets/${session.sets[0].id}`, {
                  reps: 8,
                  weight_kg: 100,
                  effort: "hard",
                })
                : writer === "append"
                ? api.post(`/sessions/${session.id}/sets`, {
                  exercise: "squat",
                  kind: "working",
                  reps: 8,
                  weight_kg: 100,
                  effort: "hard",
                  request_id: uuid(),
                })
                : api.patch(`/sessions/${session.id}`, {
                  [writer === "start" ? "started_at" : "completed_at"]:
                    new Date().toISOString(),
                });
            const remove = () => api.delete(`/sessions/${session.id}`);
            const table =
              deletionWins || writer === "correct" || writer === "append"
                ? "sets"
                : "sessions";
            const event = deletionWins
              ? "delete"
              : writer === "append"
              ? "insert"
              : "update";
            await db.unsafe(
              `create trigger test_session_gate before ${event} on ${table} for each row execute function test_session_gate()`,
            );
            let first: Promise<ApiResponse> | undefined;
            let second: Promise<ApiResponse> | undefined;
            try {
              await gate`select pg_advisory_lock(90254)`;
              first = deletionWins ? remove() : write();
              await blocked(1);
              second = deletionWins ? write() : remove();
              await blocked(2);
              await gate`select pg_advisory_unlock(90254)`;
              const [winner, loser] = await Promise.all([first, second]);
              assertEquals(
                winner.status,
                !deletionWins && writer === "append" ? 201 : 200,
              );
              assertEquals(loser.status, deletionWins ? 404 : 409);
              const saved = await api.get(`/sessions/${session.id}`);
              assertEquals(saved.status, deletionWins ? 404 : 200);
              if (
                !deletionWins && (writer === "correct" || writer === "append")
              ) {
                assert(
                  saved.body.session.sets.some((s: { reps: number | null }) =>
                    s.reps === 8
                  ),
                );
              }
            } finally {
              await gate`select pg_advisory_unlock_all()`;
              await Promise.allSettled(
                [first, second].filter((p) => p !== undefined),
              );
              await db.unsafe(`drop trigger test_session_gate on ${table}`);
            }
          },
        );
      }
    }
  } finally {
    await gate`select pg_advisory_unlock_all()`;
    gate.release();
    await db`drop function test_session_gate()`;
    await db.end();
  }
});

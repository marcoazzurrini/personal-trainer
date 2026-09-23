import { assert, assertEquals } from "@std/assert";
import d1 from "./d1.ts";
import { api, ensureCatalogue, resetTraining, today, uuid } from "./helpers.ts";

Deno.test("discard and every actual writer honor the same session boundary", async (t) => {
  await resetTraining();
  await ensureCatalogue();
  const db = d1();
  try {
    for (
      const writer of [
        "correct",
        "report",
        "append",
        "start",
        "finish",
      ] as const
    ) {
      // Launch order is varied, not asserted to be the database's commit order.
      // Sequential cases also hold both outcomes without relying on scheduling.
      for (
        const order of [
          "write first",
          "discard first",
          "write then discard",
          "discard then write",
        ] as const
      ) {
        await t.step(`${writer}: ${order}`, async () => {
          const draft = await api.post("/sessions", {
            request_id: uuid(),
            date: today(),
            rationale: "Session boundary race",
            sets: [{
              exercise: "squat",
              kind: "working",
              target_reps: 8,
              target_weight_kg: 100,
            }],
          });
          assertEquals(draft.status, 201);
          const session = draft.body.session;
          const at = new Date().toISOString();
          const write = () =>
            writer === "correct"
              ? api.patch(`/sets/${session.sets[0].id}`, {
                reps: 8,
                weight_kg: 100,
                effort: "hard",
              })
              : writer === "report"
              ? api.patch(`/sessions/${session.id}`, {
                sets: [{
                  id: session.sets[0].id,
                  reps: 8,
                  weight_kg: 100,
                  effort: "hard",
                }],
                notes: "Reported together",
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
                [writer === "start" ? "started_at" : "completed_at"]: at,
              });
          const remove = () => api.delete(`/sessions/${session.id}`);
          const [written, discarded] = order === "write then discard"
            ? [await write(), await remove()]
            : order === "discard then write"
            ? await (async () => {
              const discarded = await remove();
              return [await write(), discarded];
            })()
            : order === "write first"
            ? await Promise.all([write(), remove()])
            : (await Promise.all([remove(), write()])).reverse();
          if (order === "write then discard") {
            assertEquals(discarded.status, 409);
          }
          if (order === "discard then write") {
            assertEquals(discarded.status, 200);
          }
          const saved = await api.get(`/sessions/${session.id}`);
          if (discarded.status === 200) {
            assertEquals(written.status, 404);
            assertEquals(saved.status, 404);
            assertEquals(
              (await db`select count(*) as n from sets where session_id = ${session.id}`)[
                0
              ].n,
              0,
            );
            assertEquals((await remove()).status, 404);
          } else {
            assertEquals(discarded.status, 409);
            assertEquals(written.status, writer === "append" ? 201 : 200);
            assertEquals(saved.status, 200);
            assertEquals(
              saved.body.session.sets.length,
              writer === "append" ? 2 : 1,
            );
            if (writer === "start" || writer === "finish") {
              assertEquals(
                saved.body
                  .session[writer === "start" ? "started_at" : "completed_at"],
                at,
              );
            } else {
              assert(
                saved.body.session.sets.some((
                  s: {
                    reps: number | null;
                    weight_kg: number | null;
                    effort: string | null;
                  },
                ) =>
                  s.reps === 8 && s.weight_kg === 100 && s.effort === "hard"
                ),
              );
              if (writer === "report") {
                assertEquals(saved.body.session.notes, "Reported together");
              }
            }
            assertEquals((await remove()).status, 409);
          }
        });
      }
    }
  } finally {
    await db.end();
  }
});

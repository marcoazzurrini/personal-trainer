import { assert, assertEquals } from "@std/assert";
import fc from "fast-check";
import {
  body,
  idParam,
  optionalNumber,
  optionalRequestId,
  optionalTimestamp,
} from "../supabase/functions/api/shared/schema.ts";
import { requireNotFuture } from "../supabase/functions/api/shared/dates.ts";
import {
  docUrl,
  isDocName,
  MAX_DOC_NAME,
} from "../supabase/functions/api/surfaces/docs.ts";
import { ApiError } from "../supabase/functions/api/shared/errors.ts";

// The gatekeepers, tested as laws. Every request the API accepts or refuses
// passes through these few shapes, so a wrong edge here is a wrong edge on
// every route at once.
//
// They live in schema.ts now. What a schema cannot express lives where the
// rule belongs — requireNotFuture compares against a date read from Postgres,
// so it sits with the calendar in dates.ts — and it is held to the same laws
// here as before.

// deno-lint-ignore no-explicit-any
function issues(schema: any, value: unknown): string[] {
  const r = schema.safeParse(value);
  return r.success ? [] : r.error.issues.map((i: { code: string }) => i.code);
}

// deno-lint-ignore no-explicit-any
function accepted(schema: any, value: unknown): unknown {
  const r = schema.safeParse(value);
  assert(
    r.success,
    `expected acceptance, got ${JSON.stringify(r.error?.issues)}`,
  );
  return r.data;
}

function refused(fn: () => void): boolean {
  try {
    fn();
    return false;
  } catch (e) {
    assert(e instanceof ApiError && e.status === 422);
    return true;
  }
}

Deno.test("a body refuses exactly the unknown keys", () => {
  // Generated accept-lists against generated bodies: an unrecognized_keys
  // issue is raised iff some key is outside accepts ∪ {request_id}. The
  // exhaustive form of the guards suite's examples, including the empty body
  // and the empty accept-list.
  const key = fc.constantFrom(
    "day",
    "grams",
    "food",
    "scale",
    "note",
    "kcal",
    "request_id",
    "meal",
    "units",
  );
  fc.assert(
    fc.property(
      fc.uniqueArray(key, { maxLength: 5 }),
      fc.uniqueArray(key, { maxLength: 5 }),
      (accepts, keys) => {
        // Every accepted field is optional and permissive, so the only issue
        // a well-formed value can raise is the one under test.
        const shape = Object.fromEntries(
          accepts.filter((k) => k !== "request_id").map((
            k,
          ) => [k, optionalNumber()]),
        );
        const schema = body(shape);
        const value = Object.fromEntries(
          keys.map((k) => [k, k === "request_id" ? crypto.randomUUID() : 1]),
        );
        const unknown = keys.some(
          (k) => k !== "request_id" && !accepts.includes(k),
        );
        assertEquals(
          issues(schema, value).includes("unrecognized_keys"),
          unknown,
        );
      },
    ),
  );
});

Deno.test("the lexicographic future check agrees with the calendar", () => {
  // requireNotFuture compares ISO strings with `>`. That is only correct
  // because both sides are zero-padded YYYY-MM-DD — this property holds the
  // string comparison and the real chronology to the same answer for every
  // pair of dates, so a format change that broke the trick would fail here.
  const isoDay = fc.integer({ min: 0, max: 40_000 })
    .map((n) => new Date(n * 86_400_000).toISOString().slice(0, 10));
  fc.assert(fc.property(isoDay, isoDay, (day, today) => {
    const future = Date.parse(day) > Date.parse(today);
    assertEquals(refused(() => requireNotFuture(day, today, "day")), future);
    if (!future) assertEquals(requireNotFuture(day, today, "day"), day);
  }));
});

Deno.test("a request id accepts any case and answers in one", () => {
  // Retry safety depends on the same id comparing equal on the second send,
  // so the stored form must not depend on how the caller happened to case it.
  const schema = optionalRequestId();
  fc.assert(
    fc.property(
      fc.uuid(),
      fc.array(fc.boolean(), { minLength: 36, maxLength: 36 }),
      (id, caps) => {
        const mixed = id.split("").map((ch, i) =>
          caps[i] ? ch.toUpperCase() : ch
        ).join("");
        const out = accepted(schema, mixed);
        assertEquals(out, id.toLowerCase());
        // Idempotent: feeding the answer back changes nothing.
        assertEquals(accepted(schema, out), out);
      },
    ),
  );
});

Deno.test("an id parameter accepts exactly the positive integers", () => {
  const schema = idParam("test");
  fc.assert(fc.property(fc.integer({ min: 1, max: 2_000_000_000 }), (n) => {
    assertEquals(accepted(schema, String(n)), n);
  }));
  for (const bad of ["0", "-3", "1.5", "banana", "", "NaN", "Infinity"]) {
    assert(issues(schema, bad).length > 0, bad);
  }
});

Deno.test("a valid timestamp round-trips to the same instant", () => {
  // Whatever offset the caller wrote, the stored UTC form names the same
  // moment. A timestamp with no offset at all is refused: it would name a
  // different instant depending on the runtime's zone.
  const schema = optionalTimestamp();
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 4_000_000_000_000 }),
      fc.integer({ min: -12, max: 12 }),
      (ms, offsetH) => {
        const iso = new Date(ms).toISOString();
        assertEquals(accepted(schema, iso), iso);
        // The same instant written with an explicit offset.
        const sign = offsetH < 0 ? "-" : "+";
        const hh = String(Math.abs(offsetH)).padStart(2, "0");
        const local = new Date(ms + offsetH * 3_600_000).toISOString()
          .replace("Z", `${sign}${hh}:00`);
        assertEquals(accepted(schema, local), iso);
        // The same wall-clock text with the offset stripped, and the bare
        // date, both parse — that is the trap — but are refused.
        assert(issues(schema, iso.replace("Z", "")).length > 0);
        assert(issues(schema, iso.slice(0, 10)).length > 0);
      },
    ),
  );
});

Deno.test("an accepted doc name can never leave the docs folder", () => {
  // The safety of GET /docs/* is this one regex. For anything it accepts —
  // and fc.string covers traversal attempts, URL tricks, and unicode — the
  // resolved URL must still be inside docs/. What it rejects is someone
  // else's problem; what it accepts must be safe.
  const base = docUrl("index").href.replace(/index\.md$/, "");
  fc.assert(fc.property(fc.string({ maxLength: 120 }), (name) => {
    if (!isDocName(name)) return;
    assert(name.length <= MAX_DOC_NAME);
    assert(docUrl(name).href.startsWith(base), name);
  }));
  // The shapes an attack would actually take.
  for (const evil of ["../secrets", "a/../../x", "a//b", ".", "..", "a/.b"]) {
    assertEquals(isDocName(evil), false, evil);
  }
});

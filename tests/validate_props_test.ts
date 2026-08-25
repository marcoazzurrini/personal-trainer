import { assert, assertEquals } from "@std/assert";
import fc from "fast-check";
import {
  assertKnownFields,
  optionalTimestamp,
  optionalUuid,
  requireIdParam,
  requireNotFuture,
} from "../supabase/functions/api/lib/validate.ts";
import {
  docUrl,
  isDocName,
  MAX_DOC_NAME,
} from "../supabase/functions/api/lib/doc_names.ts";
import { ApiError } from "../supabase/functions/api/lib/errors.ts";

// The gatekeepers, tested as laws. Every request the API accepts or refuses
// passes through these few functions, so a wrong edge here is a wrong edge on
// every route at once.

function refused(fn: () => void): boolean {
  try {
    fn();
    return false;
  } catch (e) {
    assert(e instanceof ApiError && e.status === 422);
    return true;
  }
}

Deno.test("assertKnownFields refuses exactly the unknown keys", () => {
  // Generated accept-lists against generated bodies: refused iff some key is
  // outside accepts ∪ {request_id}. The exhaustive form of the guards suite's
  // examples, including the empty body and the empty accept-list.
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
        const body = Object.fromEntries(keys.map((k) => [k, 1]));
        const unknown = keys.some((k) =>
          k !== "request_id" && !accepts.includes(k)
        );
        assertEquals(
          refused(() => assertKnownFields(body, accepts, "the test body")),
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

Deno.test("optionalUuid accepts any case and answers in one", () => {
  // Retry safety depends on the same id comparing equal on the second send,
  // so the stored form must not depend on how the caller happened to case it.
  fc.assert(
    fc.property(
      fc.uuid(),
      fc.array(fc.boolean(), { minLength: 36, maxLength: 36 }),
      (id, caps) => {
        const mixed = id.split("").map((ch, i) =>
          caps[i] ? ch.toUpperCase() : ch
        )
          .join("");
        const out = optionalUuid({ f: mixed }, "f");
        assertEquals(out, id.toLowerCase());
        // Idempotent: feeding the answer back changes nothing.
        assertEquals(optionalUuid({ f: out! }, "f"), out);
      },
    ),
  );
});

Deno.test("requireIdParam accepts exactly the positive integers", () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 2_000_000_000 }), (n) => {
    assertEquals(requireIdParam(String(n), "test"), n);
  }));
  for (const bad of ["0", "-3", "1.5", "banana", "", "NaN", "Infinity"]) {
    assert(refused(() => requireIdParam(bad, "test")), bad);
  }
});

Deno.test("a valid timestamp round-trips to the same instant", () => {
  // Whatever offset the caller wrote, the stored UTC form names the same
  // moment. A timestamp with no offset at all is refused: it would name a
  // different instant depending on the runtime's zone.
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 4_000_000_000_000 }),
      fc.integer({ min: -12, max: 12 }),
      (ms, offsetH) => {
        const iso = new Date(ms).toISOString();
        assertEquals(optionalTimestamp({ t: iso }, "t"), iso);
        // The same instant written with an explicit offset.
        const sign = offsetH < 0 ? "-" : "+";
        const hh = String(Math.abs(offsetH)).padStart(2, "0");
        const local = new Date(ms + offsetH * 3_600_000).toISOString()
          .replace("Z", `${sign}${hh}:00`);
        assertEquals(optionalTimestamp({ t: local }, "t"), iso);
        // The same wall-clock text with the offset stripped, and the bare
        // date, both parse — that is the trap — but are refused.
        assert(
          refused(() => optionalTimestamp({ t: iso.replace("Z", "") }, "t")),
        );
        assert(refused(() => optionalTimestamp({ t: iso.slice(0, 10) }, "t")));
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

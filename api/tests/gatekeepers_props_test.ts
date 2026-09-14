import { assert, assertEquals } from "@std/assert";
import fc from "fast-check";
import {
  body,
  date,
  dayParam,
  idParam,
  optionalDate,
  optionalNumber,
  optionalRequestId,
  optionalTimestamp,
} from "../shared/schema.ts";
import { requireNotFuture } from "../shared/dates.ts";
import { isDocName, MAX_DOC_NAME } from "../surfaces/issues.ts";
import { ApiError } from "../shared/errors.ts";

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
          keys.map((
            k,
          ) => [
            k,
            k === "request_id" ? "11111111-2222-3333-4444-555555555555" : 1,
          ]),
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

Deno.test("document names accept constructed names and refuse unsafe mutations", () => {
  const segment = fc.array(
    fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789-"),
    { minLength: 1, maxLength: 16 },
  ).map((chars) => chars.join(""));
  const name = fc.array(segment, { minLength: 1, maxLength: 4 })
    .map((segments) => segments.join("/"));
  // Every generated case exercises acceptance; no early return can make this
  // property vacuous. Mutations exercise refusals with the same valid core.
  fc.assert(fc.property(name, (value) => {
    assertEquals(isDocName(value), true, value);
    for (
      const bad of [
        `/${value}`,
        `${value}/`,
        `../${value}`,
        `${value}/../x`,
        `${value}//x`,
        `${value}.md`,
        `A${value}`,
        `${value} `,
        `${value}\n`,
        `${value}/%2e%2e`,
        `${value}\\x`,
      ]
    ) assertEquals(isDocName(bad), false, JSON.stringify(bad));
  }));
  assertEquals(isDocName("a".repeat(MAX_DOC_NAME)), true);
  assertEquals(isDocName("a".repeat(MAX_DOC_NAME + 1)), false);
  assertEquals(isDocName(""), false);
});

Deno.test("calendar schemas agree with Gregorian month lengths without normalization", () => {
  const required = date();
  const optional = optionalDate();
  const parameter = dayParam();
  const instant = optionalTimestamp();
  fc.assert(
    fc.property(
      fc.integer({ min: 1900, max: 2100 }),
      fc.integer({ min: 1, max: 12 }),
      fc.integer({ min: 28, max: 32 }),
      (year, month, day) => {
        const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
        const lengths = [
          31,
          leap ? 29 : 28,
          31,
          30,
          31,
          30,
          31,
          31,
          30,
          31,
          30,
          31,
        ];
        const valid = day <= lengths[month - 1];
        const value = `${year}-${String(month).padStart(2, "0")}-${
          String(day).padStart(2, "0")
        }`;
        for (const schema of [required, optional, parameter]) {
          assertEquals(schema.safeParse(value).success, valid, value);
        }
        for (const offset of ["Z", "+02:00", "-05:30"]) {
          const timestamp = `${value}T00:30:00${offset}`;
          assertEquals(instant.safeParse(timestamp).success, valid, timestamp);
        }
      },
    ),
    {
      numRuns: 500,
      examples: [[1900, 2, 29], [2000, 2, 29], [2026, 2, 30], [2026, 4, 31]],
    },
  );
});

import { z } from "@hono/zod-openapi";

// The shapes every request body is checked against, and the prose the checks
// speak in. This file replaced lib/validate.ts one helper at a time: the
// messages here are the messages there, because the client is a model and a
// reworded refusal is a changed contract.
//
// Two mechanisms carry the prose, and Zod's documented precedence decides
// between them (highest first: check-level, schema-level, per-parse, global):
//
//   - the global map below writes the formulaic sentences, deriving the field
//     name from the issue path, so a new field is phrased correctly without
//     anyone writing a message for it;
//   - the factories carry the sentences a machine cannot derive — the
//     retry-safety paragraph on request_id, the offset rule on timestamps —
//     as schema-level `error` functions, which outrank the global map.
//
// A factory's `error` is a function rather than a string so it can read the
// field name off the issue. That is what keeps `optionalText()` from having
// to be told the name of the field it is validating.

// deno-lint-ignore no-explicit-any
type Issue = any;

const at = (iss: Issue) => `"${iss.path?.join(".") ?? ""}"`;

// Present-but-wrong and absent are different sentences, and Zod cannot tell a
// required field from an optional one once an issue exists — an optional field
// only ever errors when it is present, so the distinction lives in which
// factory was used, not in the issue.
z.config({
  // Ids in a path are quoted back to the caller by value rather than by field
  // name, which is the one place a message needs the input that failed. Zod
  // withholds it by default to keep sensitive values out of logs; nothing
  // reads it here except the sentence that names the bad id.
  reportInput: true,
  customError: (iss: Issue) => {
    switch (iss.code) {
      case "invalid_type":
        return `${at(iss)} is required and must be a ${iss.expected}.`;
      case "invalid_value":
        return `${at(iss)} must be one of: ${iss.values.join(", ")}.`;
      case "too_small":
        return `${at(iss)} must be >= ${iss.minimum}.`;
      case "too_big":
        return `${at(iss)} must be <= ${iss.maximum}.`;
    }
    return undefined;
  },
  // deno-lint-ignore no-explicit-any
} as any);

// ---------------------------------------------------------------- strings

export function text() {
  const error = (iss: Issue) =>
    `${at(iss)} is required and must be a non-empty string.`;
  return z.string({ error }).trim().min(1, { error });
}

export function optionalText() {
  const error = (iss: Issue) =>
    `${at(iss)} must be a non-empty string when present.`;
  return z.string({ error }).trim().min(1, { error }).nullish();
}

// ---------------------------------------------------------------- numbers

export function number(opts: { min?: number } = {}) {
  const suffix = opts.min !== undefined ? ` >= ${opts.min}` : "";
  const error = (iss: Issue) =>
    `${at(iss)} is required and must be a number${suffix}.`;
  let s = z.number({ error }).finite({ error });
  if (opts.min !== undefined) s = s.min(opts.min, { error });
  return s;
}

export function optionalNumber(opts: { min?: number } = {}) {
  const suffix = opts.min !== undefined ? ` >= ${opts.min}` : "";
  const error = (iss: Issue) =>
    `${at(iss)} must be a number${suffix} when present.`;
  let s = z.number({ error }).finite({ error });
  if (opts.min !== undefined) s = s.min(opts.min, { error });
  return s.nullish();
}

export function int(opts: { min?: number } = {}) {
  const suffix = opts.min !== undefined ? ` >= ${opts.min}` : "";
  const error = (iss: Issue) =>
    `${at(iss)} is required and must be an integer${suffix}.`;
  let s = z.int({ error });
  if (opts.min !== undefined) s = s.min(opts.min, { error });
  return s;
}

export function optionalInt(opts: { min?: number } = {}) {
  const suffix = opts.min !== undefined ? ` >= ${opts.min}` : "";
  const error = (iss: Issue) =>
    `${at(iss)} must be an integer${suffix} when present.`;
  let s = z.int({ error });
  if (opts.min !== undefined) s = s.min(opts.min, { error });
  return s.nullish();
}

// ------------------------------------------------------------------ enums

export function oneOf<T extends string>(choices: readonly [T, ...T[]]) {
  const error = (iss: Issue) =>
    `${at(iss)} must be one of: ${choices.join(", ")}.`;
  return z.enum(choices as unknown as [T, ...T[]], { error });
}

// ------------------------------------------------------------------ dates

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function calendarDate(error: (iss: Issue) => string) {
  return z.string({ error }).regex(DATE_RE, { error }).refine(
    (v) => !Number.isNaN(Date.parse(v)),
    { error },
  );
}

export function date() {
  return calendarDate((iss) =>
    `${at(iss)} is required and must be a calendar date like "2026-08-10".`
  );
}

export function optionalDate() {
  return calendarDate((iss) =>
    `${at(iss)} must be a calendar date like "2026-08-10" when present.`
  ).nullish();
}

// An offset is required, not assumed. Without one Date.parse reads a date-time
// in whatever zone the runtime happens to be in, and a bare date as midnight
// UTC — either way the instant stored depends on something the caller never
// said. The transform normalizes to UTC ISO, as optionalTimestamp did.
const OFFSET_RE = /(?:Z|[+-]\d{2}:\d{2})$/i;

function instant(error: (iss: Issue) => string) {
  return z.string({ error })
    .refine((v) => OFFSET_RE.test(v) && !Number.isNaN(Date.parse(v)), { error })
    .transform((v) => new Date(v).toISOString());
}

export function timestamp() {
  return instant((iss) =>
    `${
      at(iss)
    } is required and must be an ISO 8601 timestamp with an explicit offset, e.g. "2026-08-05T08:30:00Z".`
  );
}

export function optionalTimestamp() {
  return instant((iss) =>
    `${
      at(iss)
    } must be an ISO 8601 timestamp with an explicit offset, e.g. "2026-08-05T08:30:00Z".`
  ).nullish();
}

// ------------------------------------------------------------------ uuids

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidString(error: (iss: Issue) => string) {
  return z.string({ error }).regex(UUID_RE, { error }).transform((v) =>
    v.toLowerCase()
  );
}

// Required on any creating POST that could otherwise write the same thing
// twice: retry safety is only a guarantee if the id is not optional.
export function requestId() {
  return uuidString((iss) =>
    `${
      at(iss)
    } is required: a fresh UUID generated for this call. It is what makes a retry safe — resending the same id returns the original result instead of writing a second row. Reuse an id only to retry the exact same call.`
  );
}

export function optionalRequestId() {
  return uuidString((iss) =>
    `${at(iss)} must be a UUID when present (generate one per creating call).`
  ).nullish();
}

// --------------------------------------------------------------- responses

// The shape sumMacros returns, which is not the shape a naive reading expects
// and is the reason this lives here rather than being retyped per route.
//
// A macro is null when no row carried it, and `unaccounted` names what the
// totals do not cover: a macro summed over rows that don't all carry it is a
// floor, not a total. Only macros with a gap appear, so an empty object means
// the totals are complete.
const gap = () => z.object({ entries: z.int(), kcal: z.number() });

export function macroTotals() {
  return z.object({
    kcal: z.number(),
    protein_g: z.number().nullable(),
    carbs_g: z.number().nullable(),
    fat_g: z.number().nullable(),
    fiber_g: z.number().nullable(),
    unaccounted: z.object({
      protein_g: gap().optional(),
      carbs_g: gap().optional(),
      fat_g: gap().optional(),
      fiber_g: gap().optional(),
    }),
  });
}

// ----------------------------------------------------------------- params

// Number("notanid") is NaN, and a NaN reaching Postgres as a bigint throws
// where the handler can only answer "internal error" — a 500 at exactly the
// moment the caller most needs a prompt telling it what to send.
export function idParam(what: string) {
  const error = (iss: Issue) =>
    `"${iss.input}" is not a valid ${what} id. Ids are positive whole numbers.`;
  return z.string({ error })
    .refine((v) => {
      const n = Number(v);
      return Number.isInteger(n) && n >= 1;
    }, { error })
    .transform((v) => Number(v));
}

export function dayParam() {
  const error = (iss: Issue) =>
    `"${iss.input}" is not a calendar date. Use YYYY-MM-DD, e.g. 2026-08-07.`;
  return z.string({ error }).refine(
    (v) => DATE_RE.test(v) && !Number.isNaN(Date.parse(v)),
    { error },
  );
}

// ------------------------------------------------------------------ bodies

// Every write names the fields it reads, and a field this endpoint does not
// read is refused rather than dropped — the reasoning that made
// assertKnownFields throw is unchanged, and so is its sentence.
//
// request_id is added here rather than by every caller, which is what
// ALWAYS_ACCEPTED did. A route that needs it required overrides it with
// requestId() in its own shape; leaving it out only means "not read here",
// never "refused here".
//
// The accepted list is read off the shape, so it cannot drift from what the
// schema actually permits the way a hand-written list could.
// A route that names request_id itself replaces the default rather than
// intersecting with it: two schemas for one key intersect to `never`, and the
// field silently stops being readable off the parsed body.
type WithRequestId<T extends z.ZodRawShape> = "request_id" extends keyof T ? T
  : T & { request_id: ReturnType<typeof optionalRequestId> };

// `what` names the thing being refused, the way assertKnownFields' third
// argument did: a nested object says 'an entry in "items"' rather than "the
// request body", so a caller with a typo two levels down is told where.
export function body<T extends z.ZodRawShape>(
  shape: T,
  what = "the request body",
) {
  const withRequestId = {
    request_id: optionalRequestId(),
    ...shape,
  } as WithRequestId<T>;
  // request_id sits last, where assertKnownFields put it: the list reads as
  // "what this endpoint is about" followed by the one field every write takes.
  const accepted = [
    ...Object.keys(shape).filter((k) => k !== "request_id"),
    "request_id",
  ].join(", ");
  return z.strictObject(withRequestId, {
    error: (iss: Issue) => {
      if (iss.code !== "unrecognized_keys") return undefined;
      const named = iss.keys.map((k: string) => `"${k}"`).join(", ");
      return `Unknown field${
        iss.keys.length > 1 ? "s" : ""
      } ${named} in ${what}. Accepted: ${accepted}. ` +
        "An unrecognised field is refused rather than ignored: dropped in silence, " +
        "a guessed or misspelled name lets the call answer 200 while the record " +
        "says something other than what was meant.";
    },
    // deno-lint-ignore no-explicit-any
  } as any);
}

import { assert, assertEquals } from "@std/assert";

// The two rules about reaching the database, held against the source that has
// to obey them: the pure arithmetic may not ask Postgres anything, and neither
// may a file that declares HTTP routes.
//
// The pure modules hold the laws the database cannot express: the Forbes
// energy math, the measure/dose/effort relationships, the macro checks, the
// day arithmetic. None of it asks Postgres anything, which is what makes all
// of it testable without a stack. One `import { sql }` would end that quietly
// — the file would still pass every test it has and the suite would still be
// green, and nothing would say so.
//
// ApiError is deliberately not forbidden here. Almost every pure module
// refuses something, the refusal sentence is the contract with a model
// client, and the code that knows why a call is wrong is the code that
// should write the sentence. ADR-0003 records that choice.
//
// shared/ is not checked as a whole, and must not be. calendar.ts and
// idempotency.ts belong to no topic and reach the database on purpose, so a
// rule over that folder would be a rule the repository does not keep.
// dates.ts is pure and is in the list below by name for exactly that reason.
// errors.ts and schema.ts never ask Postgres anything either, and are left
// out deliberately: this list means "holds a law the database cannot
// express", and the envelope and the request shapes are a different thing.
//
// The walk is transitive, because a direct `import { sql }` is not how this
// rule realistically breaks — that one is conspicuous in review. It breaks by
// a pure file reaching for a helper in its topic, which asks Postgres a
// hop further down, where nobody reading the arithmetic can see it. So the
// failure names the whole chain: the entry point alone would say a rule was
// broken without saying which import to take back.

const API_DIR = "supabase/functions/api";
const DB = `${API_DIR}/db.ts`;

// The pure modules, named one by one.
//
// A folder carried this rule until #31 dissolved it: rules/ meant "no database
// below here", and each topic owns its own arithmetic now, so there is no
// folder left to point at. A list is the honest replacement rather than a
// lesser one — the folder never covered a pure file written anywhere else
// either, and a list at least says what it checks instead of implying it
// checks a place. What it cannot do is notice a new pure module nobody adds to
// it, which is the cost taken knowingly.
//
// Each entry is checked to exist, so a file renamed out from under this list
// fails loudly here rather than dropping out of the walk in silence.
const PURE = [
  `${API_DIR}/body/trend.ts`,
  `${API_DIR}/nutrition/expenditure.ts`,
  `${API_DIR}/nutrition/rules.ts`,
  `${API_DIR}/shared/dates.ts`,
  `${API_DIR}/training/rules.ts`,
];

// Static imports, side-effect imports, re-exports and dynamic imports all
// name their target the same way.
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*)"([^"]+)"/g;

async function readable(file: string): Promise<boolean> {
  try {
    await Deno.stat(file);
    return true;
  } catch {
    return false;
  }
}

async function filesUnder(dir: string): Promise<string[]> {
  const found: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) found.push(...await filesUnder(path));
    else if (entry.name.endsWith(".ts")) found.push(path);
  }
  return found.sort();
}

// Bare specifiers are import-map entries, never a file in this tree.
function target(file: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  return new URL(specifier, `file:///${file}`).pathname.slice(1);
}

// Depth-first from one file, carrying the hops taken to arrive at it, and
// answering with the first chain that ends at the database.
//
// `seen` holds every file this walk has entered. It is what keeps two files
// that import each other from walking forever, and entering a file once is
// enough to be sure: a file that does not reach the database by one route
// does not reach it by another.
async function chainToDatabase(
  file: string,
  seen: Set<string>,
  taken: string[],
): Promise<string[] | null> {
  let source: string;
  try {
    source = await Deno.readTextFile(file);
  } catch {
    // A specifier naming no file on disk. Whatever is wrong there, deno
    // check reports it in the caller's own words; this test stays quiet
    // rather than reporting it a second time and worse.
    return null;
  }

  const lines = source.split("\n");
  for (let line = 0; line < lines.length; line++) {
    for (const [, specifier] of lines[line].matchAll(SPECIFIER)) {
      const next = target(file, specifier);
      if (next === null) continue;
      const hops = [...taken, `${file}:${line + 1}`];
      if (next === DB) return [...hops, DB];
      if (seen.has(next)) continue;
      seen.add(next);
      const found = await chainToDatabase(next, seen, hops);
      if (found !== null) return found;
    }
  }
  return null;
}

Deno.test("nothing pure reaches the database", async () => {
  const offenders: string[] = [];
  for (const file of PURE) {
    assert(
      await readable(file),
      `${file} is listed as pure and is not there. If it moved, move it in ` +
        `PURE too; if it is gone, take it out — a stale entry is a module ` +
        `nobody is checking.`,
    );
    const chain = await chainToDatabase(file, new Set([file]), []);
    if (chain !== null) offenders.push(chain.join("\n      \u2192 "));
  }

  assertEquals(
    offenders,
    [],
    `these modules are pure by rule — they may refuse, but they may not ask ` +
      `the database anything:\n  ${offenders.join("\n  ")}\nPut the query in ` +
      `the topic module beside them, and pass the values down.`,
  );
});

// The second subject, from ADR-0006: a file that declares HTTP routes parses
// the request, calls one named function, and shapes the answer. It may not
// hold the query.
//
// Checked by name rather than by content, because content classifies two ways
// at once — withings.routes.ts holds three plain Hono handlers above the token
// middleware and one createRoute below it, and docs.routes.ts holds no
// createRoute at all. *.routes.ts is a convention this migration establishes,
// so it is the convention that is enforced.
//
// And checked at one hop, where rules/ above is checked transitively. That is
// not an oversight, it is the difference between the two rules. Pure
// arithmetic has no legitimate route to the database at all, so any chain is a
// break and the failure has to name the whole chain. A route file is the
// opposite: reaching the database *through one named function in its topic*
// is the entire design, so every route file has a chain to db.ts by
// construction, and a transitive check here would fail the shape it exists to
// enforce. What is forbidden is the route building the query itself.
Deno.test("no file declaring HTTP routes imports the database", async () => {
  const files = (await filesUnder(API_DIR)).filter((f) =>
    f.endsWith(".routes.ts")
  );
  assert(files.length > 0, `no *.routes.ts found under ${API_DIR}`);

  const offenders: string[] = [];
  for (const file of files) {
    const lines = (await Deno.readTextFile(file)).split("\n");
    lines.forEach((line, i) => {
      for (const [, specifier] of line.matchAll(SPECIFIER)) {
        if (target(file, specifier) === DB) offenders.push(`${file}:${i + 1}`);
      }
    });
  }

  assertEquals(
    offenders,
    [],
    `a route file may not reach the database — it parses the request, calls ` +
      `one named function, and shapes the answer:\n  ${
        offenders.join("\n  ")
      }\nMove the query into the topic module beside it, and let that module ` +
      `open its own transaction.`,
  );
});

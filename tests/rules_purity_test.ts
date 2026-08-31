import { assert, assertEquals } from "@std/assert";

// The folder rule, held against the source that has to obey it.
//
// rules/ holds the arithmetic and the laws the database cannot express: the
// Forbes energy math, the measure/dose/effort relationships, the macro
// checks, the calendar. None of it asks Postgres anything, which is what
// makes all of it testable without a stack. One `import { sql }` would end
// that quietly — the file would still pass every test it has, the suite
// would still be green, and the folder's name would have stopped meaning
// anything by the time anyone noticed.
//
// ApiError is deliberately not forbidden here. Almost every file in rules/
// refuses something, the refusal sentence is the contract with a model
// client, and the code that knows why a call is wrong is the code that
// should write the sentence. ADR-0003 records that choice.
//
// record/ is not checked, and must not be. It is a holding pen for the reads
// and writes extracted so far, not a boundary: routes/ still holds plenty of
// its own SQL, and a test asserting otherwise would be describing a rule the
// repository does not keep.
//
// The walk is transitive, because a direct `import { sql }` is not how this
// rule realistically breaks — that one is conspicuous in review. It breaks by
// a file in rules/ reaching for a helper in record/, which asks Postgres a
// hop further down, where nobody reading the arithmetic can see it. So the
// failure names the whole chain: the entry point alone would say a rule was
// broken without saying which import to take back.

const API_DIR = "supabase/functions/api";
const DB = `${API_DIR}/db.ts`;

// Static imports, side-effect imports, re-exports and dynamic imports all
// name their target the same way.
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*)"([^"]+)"/g;

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

Deno.test("nothing under rules/ reaches the database", async () => {
  const files = await filesUnder(`${API_DIR}/rules`);
  assert(files.length > 0, `no source found under ${API_DIR}/rules`);

  const offenders: string[] = [];
  for (const file of files) {
    const chain = await chainToDatabase(file, new Set([file]), []);
    if (chain !== null) offenders.push(chain.join("\n      \u2192 "));
  }

  assertEquals(
    offenders,
    [],
    `rules/ is pure by rule — it may refuse, but it may not ask the ` +
      `database anything:\n  ${offenders.join("\n  ")}\nPut the query in ` +
      `record/ or in the route, and pass the values down.`,
  );
});

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

Deno.test("nothing under rules/ reaches the database", async () => {
  const files = await filesUnder(`${API_DIR}/rules`);
  assert(files.length > 0, `no source found under ${API_DIR}/rules`);

  const offenders: string[] = [];
  for (const file of files) {
    (await Deno.readTextFile(file)).split("\n").forEach((line, i) => {
      for (const [, specifier] of line.matchAll(SPECIFIER)) {
        if (target(file, specifier) === DB) offenders.push(`${file}:${i + 1}`);
      }
    });
  }

  assertEquals(
    offenders,
    [],
    `rules/ is pure by rule — it may refuse, but it may not ask the ` +
      `database anything:\n  ${offenders.join("\n  ")}\nPut the query in ` +
      `record/ or in the route, and pass the values down.`,
  );
});

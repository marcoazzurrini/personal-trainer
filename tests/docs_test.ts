import { assert, assertEquals } from "@std/assert";
import {
  isDocName,
  MAX_DOC_NAME,
} from "../supabase/functions/api/surfaces/issues.ts";
import {
  DOCUMENTED_TRACKS,
  TRACKS,
} from "../supabase/functions/api/training/rules.ts";
import { documentPath, SKILL, SKILL_DIR } from "./skill.ts";

// The coaching documents are files in the plugin, read by the coach from
// disk; the API never serves them. So this is a test of a folder: that
// SKILL.md is a complete and honest map of it, that nothing points at a
// document that is not there, and that nothing still speaks as if the
// documents were routes. It runs from the repository root, like
// docs_constants_test.

const KINDS = ["tasks", "reference", "method"] as const;

async function read(name: string): Promise<string> {
  return await Deno.readTextFile(documentPath(name));
}

async function exists(name: string): Promise<boolean> {
  return await Deno.stat(documentPath(name)).then(
    () => true,
    () => false,
  );
}

async function filesUnder(kind: string): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(`${SKILL_DIR}/${kind}`)) {
    if (entry.isFile && entry.name.endsWith(".md")) {
      names.push(`${kind}/${entry.name.slice(0, -3)}`);
    }
  }
  return names.sort();
}

async function everyDocument(): Promise<string[]> {
  const names: string[] = [];
  for (const kind of KINDS) names.push(...await filesUnder(kind));
  return names;
}

function namesIn(text: string): Set<string> {
  return new Set(
    [...text.matchAll(/`((?:tasks|reference|method)\/[a-z0-9-]+)`/g)].map((
      m,
    ) => m[1]),
  );
}

Deno.test("the coaching documents", async (t) => {
  const skill = await Deno.readTextFile(SKILL);

  await t.step("SKILL.md names the documents a coach needs", () => {
    for (
      const name of [
        "tasks/onboarding",
        "tasks/programming",
        "tasks/session-generation",
        "tasks/logging",
        "tasks/evaluation",
        "tasks/charts",
        "tasks/reporting-problems",
        "tasks/nutrition-onboarding",
        "tasks/nutrition-logging",
        "tasks/nutrition-checkin",
        "reference/planning",
        "reference/sessions",
        "reference/exercises",
        "reference/tracking",
        "reference/nutrition",
        "method/hypertrophy",
        "method/nutrition",
      ]
    ) {
      assert(skill.includes(`\`${name}\``), `SKILL.md should name ${name}`);
    }
  });

  await t.step("every document SKILL.md names is on disk", async () => {
    // SKILL.md is the coach's map. A row pointing at a document that is not
    // there sends it looking for a procedure that does not exist.
    const named = namesIn(skill);
    assert(named.size >= 12);
    for (const name of named) {
      assert(
        await exists(name),
        `SKILL.md names ${name}, which is not there`,
      );
    }
  });

  await t.step("every document on disk is named by SKILL.md", async () => {
    // The other direction: a document nobody is told about is one nobody
    // reads, and SKILL.md is the only place the coach learns what exists.
    const named = namesIn(skill);
    for (const name of await everyDocument()) {
      assert(named.has(name), `${name} exists but SKILL.md never names it`);
    }
  });

  await t.step("SKILL.md links every document it names", () => {
    // A name is what the API quotes; a link is how the skill loader is told
    // where the file is. The two have to agree, or the coach reads a name it
    // cannot open.
    for (const name of namesIn(skill)) {
      assert(
        skill.includes(`](${name}.md)`),
        `SKILL.md names ${name} without linking ${name}.md`,
      );
    }
  });

  await t.step(
    "documents never point at documents that are not there",
    async () => {
      // Cross-references inside the documents, not just SKILL.md's own
      // tables. A task document naming `tasks/training-onboarding` when the
      // file is `tasks/onboarding` sends the coach looking for a procedure
      // that is not there, and the check above cannot see that.
      const seen = new Set<string>();
      for (const name of await everyDocument()) {
        for (const ref of namesIn(await read(name))) seen.add(ref);
      }
      assert(seen.size >= 8, `expected cross-references, found ${seen.size}`);
      for (const ref of seen) {
        assert(
          await exists(ref),
          `a document references ${ref}, which is not there`,
        );
      }
    },
  );

  await t.step("no document still speaks of a route", async () => {
    // The documents were once served by the API, and their pointers were
    // routes. They are files now, and a route pointer would send the coach
    // to a 404.
    const texts = [["SKILL.md", skill]];
    for (const name of await everyDocument()) {
      texts.push([name, await read(name)]);
    }
    for (const [name, text] of texts) {
      assert(!text.includes("GET /docs"), `${name} still says GET /docs`);
      assert(!text.includes("/api/"), `${name} quotes an /api/ path`);
    }
  });

  await t.step("the documents read like documents", async () => {
    assert(
      (await read("reference/sessions")).includes(
        "targets or actuals, never both",
      ),
    );
    assert((await read("method/hypertrophy")).includes("# Hypertrophy"));
  });

  await t.step(
    "every name on disk is a name the API would accept",
    async () => {
      // /issues lets the coach name the documents a report is about, and checks
      // the name against the same rule. A file whose name broke it could never
      // be reported on.
      for (const name of await everyDocument()) {
        assert(isDocName(name), name);
      }
    },
  );
});

// DOCUMENTED_TRACKS says which tracks have a method document, so that
// /training-state can say so without a folder to look in. It is a claim
// about files, and this holds it to them: every track is either in the list
// with its document on disk, or out of it with none.
Deno.test("the documented tracks are the ones with a document", async () => {
  for (const track of TRACKS) {
    const onDisk = await exists(`method/${track}`);
    assertEquals(
      DOCUMENTED_TRACKS.includes(track),
      onDisk,
      `${track}: DOCUMENTED_TRACKS says ${
        DOCUMENTED_TRACKS.includes(track)
      }, the disk says ${onDisk}`,
    );
  }
});

// The rule /issues applies to the documents a report names: lowercase words,
// hyphens, slashes for nesting, no dots, no extension — the way SKILL.md
// writes them.
Deno.test("document names", () => {
  for (const good of ["tasks", "method/hypertrophy", "a-b/c-d/e2"]) {
    assert(isDocName(good), good);
  }
  for (
    const bad of ["", "..", "a..b", "a.md", "/a", "a/", "A", "a b", "a//b"]
  ) {
    assert(!isDocName(bad), bad);
  }
  assert(!isDocName("x".repeat(MAX_DOC_NAME + 1)), "over the length cap");
});

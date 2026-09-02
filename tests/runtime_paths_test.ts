import { assert, assertEquals } from "@std/assert";
import { api, BASE, resetTraining, TOKEN } from "./helpers.ts";
import { documentPath, SKILL_DIR } from "./skill.ts";

// The raw follower: a status and nothing else, for probes that only ask
// whether a path routes and do not want the helpers' envelope and shape
// checks in the way.
async function follow(path: string): Promise<number> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  await res.body?.cancel();
  return res.status;
}

// Errors are prompts — and a prompt that names a path the router cannot serve
// is worse than no prompt, because the caller obeys it and hits a 404 it has
// no way to diagnose. That is not hypothetical: every runtime message once
// wrote its paths with an /api prefix while BASE already ends in /api, so the
// very first instruction a fresh conversation followed produced /api/api/…
// and a dead end. The docs never made that mistake; only the code did.
//
// Three layers keep it dead. A static scan pins the seam itself (no runtime
// string may quote an /api-prefixed path). A live check pins the forgiveness
// (a stale context that still concatenates the old form gets an answer, not a
// 404). And a follow-the-prompt check asserts the property the other two only
// approximate: a path quoted to the caller must actually route.

const API_DIR = "api";

async function filesUnder(dir: string, ext: string): Promise<string[]> {
  const found: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) found.push(...await filesUnder(path, ext));
    else if (entry.name.endsWith(ext)) found.push(path);
  }
  return found;
}

Deno.test("no runtime string quotes an /api-prefixed path", async () => {
  // The verb anchors the pattern to paths quoted *to the caller* — the
  // middleware that forgives the doubled prefix legitimately mentions
  // /api/api in code, and that carries no verb, so it cannot false-positive
  // here.
  const quotedApiPath = /(GET|POST|PATCH|DELETE) \/api\//;
  const offenders: string[] = [];

  for (const file of await filesUnder(API_DIR, ".ts")) {
    const lines = (await Deno.readTextFile(file)).split("\n");
    lines.forEach((line, i) => {
      if (quotedApiPath.test(line)) offenders.push(`${file}:${i + 1}`);
    });
  }
  // The docs hold the same contract from the other side: paths are relative
  // to BASE, so /api/ must not appear there in any form.
  for (const file of await filesUnder(SKILL_DIR, ".md")) {
    const lines = (await Deno.readTextFile(file)).split("\n");
    lines.forEach((line, i) => {
      if (line.includes("/api/")) offenders.push(`${file}:${i + 1}`);
    });
  }

  assertEquals(
    offenders,
    [],
    `paths are written relative to BASE, which already ends in /api — drop the prefix`,
  );
});

Deno.test("a doubled /api prefix is forgiven, not 404ed", async (t) => {
  // Conversations hold their instructions in context for weeks; any client
  // that ever read an /api-prefixed path may replay it long after the strings
  // are fixed. The router collapses the doubled prefix instead of teaching
  // the same lesson twice.
  await t.step("BASE + /api/… routes", async () => {
    assertEquals(await follow("/api/exercises"), 200);
  });

  await t.step("any depth of doubling collapses", async () => {
    assertEquals(await follow("/api/api/exercises"), 200);
  });

  await t.step("a genuinely unknown route still 404s", async () => {
    const { status } = await api.get("/api/nope");
    assertEquals(status, 404);
  });
});

Deno.test("paths quoted in prompts actually route", async (t) => {
  await t.step("the cold-start note's instruction works", async () => {
    // The exact second call of a first conversation: training-state names the
    // onboarding document, and the named document must exist. It names it as
    // a document — `tasks/onboarding` — because the documents are files in
    // the plugin the coach reads from disk, so that is where the name is
    // checked.
    await resetTraining();
    const { body } = await api.get("/training-state");
    assert(body.note, "an empty record must route to onboarding");
    const names = [
      ...String(body.note).matchAll(
        /`((?:tasks|reference|method)\/[a-z0-9-]+)`/g,
      ),
    ].map((m) => m[1]);
    assert(names.length > 0, `no document named in: ${body.note}`);
    for (const name of names) {
      const onDisk = await Deno.stat(documentPath(name)).then(
        () => true,
        () => false,
      );
      assert(onDisk, `the cold-start note names "${name}", which is not there`);
    }
  });

  // There was a second step here, following the paths quoted by the documents
  // route's 404. The route is gone with the documents; the property it held —
  // that a path quoted to the caller routes — is carried by the step above,
  // the doubled-prefix test and the static scan.
});

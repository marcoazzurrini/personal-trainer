import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { test } from "node:test";

import {
  assert,
  assertEquals,
  assertRejects,
} from "../../api/tests/assertions.ts";
import { scanStaged } from "../../scripts/secrets.ts";

test("local and CI index scans refuse secrets and forced environment files", async () => {
  const cwd = await mkdtemp(nodePath.join(tmpdir(), "pt-secret-fixture-"));
  async function git(...args: string[]) {
    const child = Bun.spawn(["git", ...args], {
      cwd,
      stdout: "ignore",
      stderr: "ignore",
    });
    assertEquals(await child.exited, 0);
  }
  const synthetic = ["ghp", "p7Qr9Xs2Tu4Vw6Yz8Ab0Cd3Ef5Gh1JkLmnOP"].join("_");
  try {
    await git("init", "--quiet");
    await writeFile(`${cwd}/source.ts`, `const credential = "${synthetic}";\n`);
    await git("add", "source.ts");
    await writeFile(
      `${cwd}/source.ts`,
      "// Unstaged cleanup cannot hide the index.\n"
    );
    const failure = await assertRejects(
      () => scanStaged(cwd),
      Error,
      "github-pat"
    );
    assert(!failure.message.includes(synthetic));
    await git("add", "source.ts");
    await scanStaged(cwd);
    for (const name of [
      ".env",
      ".env.hosting",
      ".env.production",
      "web/.env",
      "db/d1/.env",
      ".dev.vars",
      ".dev.vars.staging",
      ".env.withings-fixture/receipt.json",
    ]) {
      await mkdir(nodePath.dirname(`${cwd}/${name}`), { recursive: true });
      await writeFile(`${cwd}/${name}`, synthetic);
      await git("add", "--force", name);
      const refused = await assertRejects(
        () => scanStaged(cwd),
        Error,
        "contents were not read"
      );
      assert(!refused.message.includes(synthetic));
      await git("rm", "--cached", name);
    }
    await writeFile(`${cwd}/.env.example`, "EXAMPLE_TOKEN=replace-me\n");
    await git("add", ".env.example");
    await scanStaged(cwd);
    // Only this exact fixture value in this exact path is exempt. No blanket
    // tests/ allowance, and inline gitleaks:allow comments cannot waive scans.
    await writeFile(`${cwd}/fixture.txt`, synthetic);
    await writeFile(
      `${cwd}/.gitleaks.toml`,
      `[extend]\nuseDefault = true\n[[allowlists]]\ndescription = "One synthetic fixture"\ncondition = "AND"\npaths = ['''^/scan/fixture\\.txt$''']\nregexes = ['''^${synthetic}$''']\n`
    );
    await git("add", "fixture.txt", ".gitleaks.toml");
    await scanStaged(cwd);
    await writeFile(
      `${cwd}/source.ts`,
      `const credential = "${synthetic}"; // gitleaks:allow\n`
    );
    await git("add", "source.ts");
    await assertRejects(() => scanStaged(cwd), Error, "github-pat");
  } finally {
    await rm(cwd, { recursive: true });
  }
});

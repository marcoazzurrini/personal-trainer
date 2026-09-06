import { assert, assertEquals, assertRejects } from "@std/assert";
import { scanStaged } from "./secrets.ts";

Deno.test("local and CI index scans refuse secrets and forced environment files", async () => {
  const cwd = await Deno.makeTempDir({ prefix: "pt-secret-fixture-" });
  async function git(...args: string[]) {
    const r = await new Deno.Command("git", {
      cwd,
      args,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(r.success, true);
  }
  const synthetic = "ghp_" + "p7Qr9Xs2Tu4Vw6Yz8Ab0Cd3Ef5Gh1JkLmnOP";
  try {
    await git("init", "--quiet");
    await Deno.writeTextFile(
      `${cwd}/source.ts`,
      `const credential = "${synthetic}";\n`,
    );
    await git("add", "source.ts");
    await Deno.writeTextFile(
      `${cwd}/source.ts`,
      "// Unstaged cleanup cannot hide the index.\n",
    );
    const failure = await assertRejects(
      () => scanStaged(cwd),
      Error,
      "github-pat",
    );
    assert(!failure.message.includes(synthetic));
    await git("add", "source.ts");
    await scanStaged(cwd);
    for (const name of [".env", ".env.hosting"]) {
      await Deno.writeTextFile(`${cwd}/${name}`, synthetic);
      await git("add", "--force", name);
      const refused = await assertRejects(
        () => scanStaged(cwd),
        Error,
        "contents were not read",
      );
      assert(!refused.message.includes(synthetic));
      await git("rm", "--cached", name);
    }
    // Only this exact fixture value in this exact path is exempt. No blanket
    // tests/ allowance, and inline gitleaks:allow comments cannot waive scans.
    await Deno.writeTextFile(`${cwd}/fixture.txt`, synthetic);
    await Deno.writeTextFile(
      `${cwd}/.gitleaks.toml`,
      `[extend]\nuseDefault = true\n[[allowlists]]\ndescription = "One synthetic fixture"\ncondition = "AND"\npaths = ['''^/scan/fixture\\.txt$''']\nregexes = ['''^${synthetic}$''']\n`,
    );
    await git("add", "fixture.txt", ".gitleaks.toml");
    await scanStaged(cwd);
    await Deno.writeTextFile(
      `${cwd}/source.ts`,
      `const credential = "${synthetic}"; // gitleaks:allow\n`,
    );
    await git("add", "source.ts");
    await assertRejects(() => scanStaged(cwd), Error, "github-pat");
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});

// Scan the index, not working files: an unstaged cleanup cannot hide a staged
// credential. CI's checkout populates that same index. No host secrets mount.
export const SCANNER =
  "ghcr.io/gitleaks/gitleaks@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f"; // v8.30.1

export async function scanStaged(cwd = Deno.cwd()): Promise<void> {
  async function git(...args: string[]) {
    const result = await new Deno.Command("git", {
      cwd,
      args,
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (!result.success) {
      throw new Error("Cannot read staged files; secret scan failed closed.");
    }
    return new TextDecoder().decode(result.stdout);
  }
  const paths = (await git("ls-files", "-z")).split("\0");
  if (paths.some((p) => /(^|\/)\.env(?:\.hosting)?$/.test(p))) {
    throw new Error(
      "Protected .env or .env.hosting file is staged. Unstage it; contents were not read.",
    );
  }
  const directory = await Deno.makeTempDir({ prefix: "pt-secret-scan-" });
  try {
    await git("checkout-index", "--all", `--prefix=${directory}/`);
    const result = await new Deno.Command("docker", {
      args: [
        "run",
        "--rm",
        "--network=none",
        "--mount",
        `type=bind,src=${directory},dst=/scan,readonly`,
        SCANNER,
        "dir",
        "/scan",
        "--redact=100",
        "--no-banner",
        "--ignore-gitleaks-allow",
        "--timeout=60",
        "--report-format=json",
        "--report-path=-",
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (!result.success) {
      // Never forward scanner matches, source lines, or Docker stderr. Even a
      // detector's redaction covers its matched secret, not necessarily siblings.
      let findings: Array<{ RuleID: string; File: string; StartLine: number }> =
        [];
      try {
        findings = JSON.parse(new TextDecoder().decode(result.stdout));
      } catch { /* tool failure */ }
      const locations = Array.isArray(findings)
        ? findings.map((f) =>
          `${f.RuleID} at ${JSON.stringify(f.File)}:${f.StartLine}`
        ).join("\n")
        : "";
      throw new Error(
        `Secret scan refused staged content or could not complete. Credential values withheld.\n${locations}`,
      );
    }
    console.log(
      "Staged secret scan passed (Gitleaks 8.30.1). No history or untracked files scanned.",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
}

if (import.meta.main) {
  try {
    await scanStaged();
  } catch (err) {
    console.error(
      err instanceof Error ? err.message : "Secret scan failed closed.",
    );
    Deno.exit(1);
  }
}

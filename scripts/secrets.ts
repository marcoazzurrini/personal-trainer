import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

// Scan the index, not working files: an unstaged cleanup cannot hide a staged
// credential. CI's checkout populates that same index. No host secrets mount.
export const SCANNER =
  "ghcr.io/gitleaks/gitleaks@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f"; // v8.30.1

async function command(
  args: string[],
  cwd: string
): Promise<{ code: number; stdout: string }> {
  const child = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const [code, stdout] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout };
}

export async function scanStaged(cwd = process.cwd()): Promise<void> {
  async function git(...args: string[]): Promise<string> {
    const result = await command(["git", ...args], cwd);
    if (result.code !== 0) {
      throw new Error("Cannot read staged files; secret scan failed closed.");
    }
    return result.stdout;
  }
  const paths = (await git("ls-files", "-z")).split("\0");
  if (
    paths.some((path) =>
      path
        .split("/")
        .some(
          (part) =>
            part !== ".env.example" &&
            /^(?:\.env|\.dev\.vars)(?:\.|$)/u.test(part)
        )
    )
  ) {
    throw new Error(
      "Protected environment file is staged. Unstage it; contents were not read."
    );
  }
  const directory = await mkdtemp(nodePath.join(tmpdir(), "pt-secret-scan-"));
  try {
    await git("checkout-index", "--all", `--prefix=${directory}/`);
    const result = await command(
      [
        "docker",
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
      cwd
    );
    if (result.code !== 0) {
      // Never forward matches or stderr: detector redaction may miss sibling secrets.
      let findings: { RuleID: string; File: string; StartLine: number }[] = [];
      try {
        findings = JSON.parse(result.stdout);
      } catch {
        /* A scanner failure must also block the commit. */
      }
      const locations = Array.isArray(findings)
        ? findings
            .map(
              (finding) =>
                `${finding.RuleID} at ${JSON.stringify(finding.File)}:${finding.StartLine}`
            )
            .join("\n")
        : "";
      throw new Error(
        `Secret scan refused staged content or could not complete. Credential values withheld.\n${locations}`
      );
    }
    console.log(
      "Staged secret scan passed (Gitleaks 8.30.1). No history or untracked files scanned."
    );
  } finally {
    await rm(directory, { recursive: true });
  }
}

if (import.meta.main) {
  try {
    await scanStaged();
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Secret scan failed closed."
    );
    process.exitCode = 1;
  }
}

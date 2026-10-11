import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { z } from "@hono/zod-openapi";

import { assert, assertEquals, assertStringIncludes } from "./assertions.ts";
import { PLUGIN, SKILL } from "./skill.ts";
// The plugin is files on disk that Cowork reads, so this is the one test that
// reads them the way Cowork would: the manifest, the connector, the
// marketplace entry that points at it, and the skill's frontmatter — which
// is load-bearing and fragile. A generator script used to check that block
// every time it rendered the file; the check outlives the script here.
async function json<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  return schema.parse(JSON.parse(await readFile(path, "utf-8")));
}
const manifestSchema = z.object({
  name: z.string(),
  version: z.string(),
  description: z.string(),
});
const connectorSchema = z.object({
  mcpServers: z.record(
    z.string(),
    z.object({ type: z.string(), url: z.string() })
  ),
});
const marketplaceSchema = z.object({
  plugins: z.array(z.object({ name: z.string(), source: z.string() })),
});
test("the plugin's files are what Cowork expects", async (t) => {
  await t.test("the manifest names the plugin", async () => {
    const manifest = await json(
      `${PLUGIN}/.claude-plugin/plugin.json`,
      manifestSchema
    );
    assertEquals(manifest.name, "personal-trainer");
    assert(/^\d+\.\d+\.\d+$/u.test(String(manifest.version)), "semver version");
    assert(typeof manifest.description === "string");
  });
  await t.test("the connector is one remote server, ours", async () => {
    const { mcpServers: servers } = await json(
      `${PLUGIN}/.mcp.json`,
      connectorSchema
    );
    assertEquals(Object.keys(servers), ["personal-trainer"]);
    assertEquals(servers["personal-trainer"].type, "http");
    assert(
      servers["personal-trainer"].url.endsWith("/api/mcp"),
      servers["personal-trainer"].url
    );
    assert(
      !servers["personal-trainer"].url.includes("supabase"),
      "the connector still points at the old host"
    );
  });
  await t.test("the marketplace at the root points at it", async () => {
    const { plugins } = await json(
      ".claude-plugin/marketplace.json",
      marketplaceSchema
    );
    assertEquals(plugins.length, 1);
    assertEquals(plugins[0].name, "personal-trainer");
    assertEquals(plugins[0].source, `./${PLUGIN}`);
  });
});
test("the skill's frontmatter is intact", async (t) => {
  const text = await readFile(SKILL, "utf-8");
  const lines = text.split("\n");
  await t.test("it opens with a YAML block", () => {
    assertEquals(lines[0], "---");
    const close = lines.indexOf("---", 1);
    assert(close > 1, "no closing ---");
  });
  await t.test("its keys sit at column zero", () => {
    // The documented failure: a formatter indents the keys after the long
    // description line, YAML reads them as a continuation of it, and the
    // skill loads with no permission to run curl.
    for (const key of ["name:", "description:", "allowed-tools:"]) {
      assert(
        lines.some((line) => line.startsWith(key)),
        `${key} is not a top-level key`
      );
    }
    assertEquals(
      lines.find((l) => l.startsWith("name:")),
      "name: personal-trainer"
    );
  });
  await t.test("the token comes from the connector, not the file", async () => {
    assert(!text.includes("{{"), "a template placeholder survived");
    assertStringIncludes(text, "get_api_token");
    // The BASE the skill curls and the connector it signs in with share an
    // origin: one project, one host.
    const base = text.match(/BASE="(?<url>[^"]+)"/u);
    assert(base !== null, "no BASE in the skill");
    const { origin } = new URL(base[1]);
    const { mcpServers: servers } = await json(
      `${PLUGIN}/.mcp.json`,
      connectorSchema
    );
    assertEquals(new URL(servers["personal-trainer"].url).origin, origin);
  });
});

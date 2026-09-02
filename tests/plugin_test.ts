import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { PLUGIN, SKILL } from "./skill.ts";

// The plugin is files on disk that Cowork reads, so this is the one test that
// reads them the way Cowork would: the manifest, the connector, the
// marketplace entry that points at it, and the skill's frontmatter — which
// is load-bearing and fragile. A generator script used to check that block
// every time it rendered the file; the check outlives the script here.

async function json(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await Deno.readTextFile(path));
}

Deno.test("the plugin's files are what Cowork expects", async (t) => {
  await t.step("the manifest names the plugin", async () => {
    const manifest = await json(`${PLUGIN}/.claude-plugin/plugin.json`);
    assertEquals(manifest.name, "personal-trainer");
    assert(/^\d+\.\d+\.\d+$/.test(String(manifest.version)), "semver version");
    assert(typeof manifest.description === "string");
  });

  await t.step("the connector is one remote server, ours", async () => {
    const config = await json(`${PLUGIN}/.mcp.json`);
    const servers = config.mcpServers as Record<
      string,
      { type: string; url: string }
    >;
    assertEquals(Object.keys(servers), ["personal-trainer"]);
    assertEquals(servers["personal-trainer"].type, "http");
    assert(
      servers["personal-trainer"].url.endsWith("/functions/v1/api/mcp"),
      servers["personal-trainer"].url,
    );
  });

  await t.step("the marketplace at the root points at it", async () => {
    const marketplace = await json(".claude-plugin/marketplace.json");
    const plugins = marketplace.plugins as Array<
      { name: string; source: string }
    >;
    assertEquals(plugins.length, 1);
    assertEquals(plugins[0].name, "personal-trainer");
    assertEquals(plugins[0].source, `./${PLUGIN}`);
  });
});

Deno.test("the skill's frontmatter is intact", async (t) => {
  const text = await Deno.readTextFile(SKILL);
  const lines = text.split("\n");

  await t.step("it opens with a YAML block", () => {
    assertEquals(lines[0], "---");
    const close = lines.indexOf("---", 1);
    assert(close > 1, "no closing ---");
  });

  await t.step("its keys sit at column zero", () => {
    // The documented failure: a formatter indents the keys after the long
    // description line, YAML reads them as a continuation of it, and the
    // skill loads with no permission to run curl.
    for (const key of ["name:", "description:", "allowed-tools:"]) {
      assert(
        lines.some((line) => line.startsWith(key)),
        `${key} is not a top-level key`,
      );
    }
    assertEquals(
      lines.find((l) => l.startsWith("name:")),
      "name: personal-trainer",
    );
  });

  await t.step("the token comes from the connector, not the file", () => {
    assert(!text.includes("{{"), "a template placeholder survived");
    assertStringIncludes(text, "get_api_token");
    // The BASE the skill curls and the connector it signs in with share an
    // origin: one project, one host.
    const base = text.match(/BASE="([^"]+)"/);
    assert(base !== null, "no BASE in the skill");
    const origin = new URL(base[1]).origin;
    return json(`${PLUGIN}/.mcp.json`).then((config) => {
      const servers = config.mcpServers as Record<string, { url: string }>;
      assertEquals(new URL(servers["personal-trainer"].url).origin, origin);
    });
  });
});

import { assertEquals, assertStringIncludes } from "@std/assert";
import { BASE } from "./helpers.ts";

Deno.test("reference page pins the reviewed Scalar browser bytes with SRI", async () => {
  const res = await fetch(`${BASE}/reference`);
  assertEquals(res.status, 200);
  assertStringIncludes(res.headers.get("content-type")!, "text/html");
  const html = await res.text();
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="[^"]+"[^>]*>/g)];
  assertEquals(scripts.length, 1);
  assertStringIncludes(
    scripts[0][0],
    'src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.67.0/dist/browser/standalone.js"',
  );
  assertStringIncludes(
    scripts[0][0],
    'integrity="sha384-6c7Vmx+i0yi8gBbltn0x1cavD+zsMGw2xmXXVyacPJLIGBxwaVimW5TW0WiW17Ir"',
  );
  assertStringIncludes(scripts[0][0], 'crossorigin="anonymous"');
  assertStringIncludes(html, "url: 'openapi.json'");
  const schema = await (await fetch(`${BASE}/openapi.json`)).json();
  assertEquals(schema.components.securitySchemes.bearer.scheme, "bearer");
  const refused = await fetch(`${BASE}/intake`);
  assertEquals(refused.status, 401);
  await refused.body?.cancel();
});

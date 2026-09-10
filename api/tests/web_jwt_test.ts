import { assertEquals, assertRejects } from "@std/assert";
import { JwtError, verifyJwt, verifyWebSessionJwt } from "../access/jwt.ts";
import { webSigner } from "./web_signer.ts";

Deno.test("web sessions and connector tokens have disjoint claim policies", async () => {
  const signer = await webSigner();
  const now = 1_800_000_000;
  const good = {
    iss: "https://web.example.test",
    sub: "owner",
    client_id: "client_web",
    sid: "session_test",
    exp: now + 600,
  };
  const options = {
    issuer: good.iss,
    clientId: good.client_id,
    jwks: signer.jwks,
    now,
  };
  assertEquals(
    (await verifyWebSessionJwt(await signer.sign(good), options)).sub,
    "owner",
  );
  for (
    const patch of [
      { iss: "https://other.example.test" },
      { sub: "" },
      { sub: undefined },
      { client_id: "another_app" },
      { client_id: undefined },
      { sid: undefined },
      { sid: "" },
      { sid: 42 },
      { exp: now - 61 },
      { exp: undefined },
      { exp: "tomorrow" },
      { nbf: now + 61 },
      { aud: "https://trainer.example.test/api/mcp" },
      { aud: [] },
      { aud: null },
      { act: { sub: "admin" } },
    ]
  ) {
    await assertRejects(
      () =>
        signer.sign({ ...good, ...patch }).then((token) =>
          verifyWebSessionJwt(token, options)
        ),
      JwtError,
    );
  }
  const impostor = await webSigner();
  await assertRejects(
    () =>
      impostor.sign(good).then((token) => verifyWebSessionJwt(token, options)),
    JwtError,
  );
  for (const malformed of ["not-a-token", "a.b.c", "e30.e30.e30"]) {
    await assertRejects(
      () => verifyWebSessionJwt(malformed, options),
      JwtError,
    );
  }
  await assertRejects(() =>
    signer.sign(good).then((token) =>
      verifyJwt(token, {
        issuer: good.iss,
        audience: "https://trainer.example.test/api/mcp",
        jwks: signer.jwks,
        now,
      })
    ), JwtError);
});

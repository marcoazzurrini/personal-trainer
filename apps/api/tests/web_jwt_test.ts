import { test } from "node:test";

import { Effect } from "effect";

import { JwtError, verifyJwt, verifyWebSessionJwt } from "../src/access/jwt.ts";
import { assertEquals, assertRejects } from "./assertions.ts";
import { at } from "./effects.ts";
import { webSigner } from "./web_signer.ts";

test("web sessions and connector tokens have disjoint claim policies", async () => {
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
  };
  // The verifiers read the time from the Clock; this one is stopped at now.
  const verifyWebSession = (token: string) =>
    Effect.runPromise(at(now * 1000, verifyWebSessionJwt(token, options)));
  assertEquals((await verifyWebSession(await signer.sign(good))).sub, "owner");
  for (const patch of [
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
  ]) {
    await assertRejects(
      () =>
        signer
          .sign({ ...good, ...patch })
          .then((token) => verifyWebSession(token)),
      JwtError
    );
  }
  const impostor = await webSigner();
  await assertRejects(
    () => impostor.sign(good).then((token) => verifyWebSession(token)),
    JwtError
  );
  for (const malformed of ["not-a-token", "a.b.c", "e30.e30.e30"]) {
    await assertRejects(() => verifyWebSession(malformed), JwtError);
  }
  await assertRejects(
    () =>
      signer.sign(good).then((token) =>
        Effect.runPromise(
          at(
            now * 1000,
            verifyJwt(token, {
              issuer: good.iss,
              audience: "https://trainer.example.test/api/mcp",
              jwks: signer.jwks,
            })
          )
        )
      ),
    JwtError
  );
});

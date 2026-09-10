// Synthetic signing keys only. This helper never reads an environment or DB.
export async function webSigner() {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const encode = (bytes: Uint8Array) =>
    btoa(String.fromCharCode(...bytes))
      .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  const json = (value: unknown) =>
    encode(new TextEncoder().encode(JSON.stringify(value)));
  return {
    jwks: {
      keys: [{
        ...await crypto.subtle.exportKey("jwk", pair.publicKey),
        kid: "web-test",
      }],
    },
    async sign(claims: Record<string, unknown>) {
      const payload = `${json({ alg: "ES256", kid: "web-test" })}.${
        json(claims)
      }`;
      const signature = await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        pair.privateKey,
        new TextEncoder().encode(payload),
      );
      return `${payload}.${encode(new Uint8Array(signature))}`;
    },
  };
}

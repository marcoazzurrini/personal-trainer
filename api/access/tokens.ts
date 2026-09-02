// The token the coach carries: how one is minted after a sign-in, how one is
// checked on every call, and how long it lives.
//
// A token is 32 random bytes, and only its SHA-256 is stored. A read of the
// table yields nothing a caller could present, which is what lets the subject — the sign-in server's user id —
// sit beside the hash in plain text. The plaintext exists in exactly two
// places: the connector's answer, and the conversation that received it.
//
// Minted rather than passed through. The sign-in token the connector holds
// could have been the API's bearer, and then no table would exist. But that
// token would sit in every transcript for its hour, every API call would
// verify a signature, and the test suite, which runs without the auth service,
// could never obtain one. A minted token costs one indexed select per request
// — the API already reaches the database on every call — is revoked by
// deleting its row, and is something a test can mint by inserting one. The
// migration that created api_tokens says the same at greater length.

import { sql } from "../db.ts";

// A day. Long enough that a conversation is not interrupted by a re-issue,
// short enough that a token copied out of a transcript is dead the next day.
export const TOKEN_LIFETIME_MS = 24 * 60 * 60 * 1000;

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return Array.from(
    new Uint8Array(digest),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}

// base64url, because the token travels in a JSON string and then in an
// Authorization header, and neither wants a "+" or a "/".
function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function issueToken(
  subject: string,
): Promise<{ token: string; expires_at: string }> {
  const token = randomToken();
  const tokenHash = await hashToken(token);
  const expiresAt = new Date(Date.now() + TOKEN_LIFETIME_MS);
  await sql.begin(async (tx) => {
    // The sweep. Nothing else in this system runs on a schedule, and a table
    // that grows by one row a day does not earn one; expired rows go the next
    // time a token is minted.
    await tx`delete from api_tokens where expires_at < now()`;
    await tx`
      insert into api_tokens (token_hash, subject, expires_at)
      values (${tokenHash}, ${subject}, ${expiresAt})
    `;
  });
  return { token, expires_at: expiresAt.toISOString() };
}

export async function verifyToken(
  token: string,
): Promise<{ subject: string } | null> {
  const rows = await sql<{ subject: string }[]>`
    select subject from api_tokens
    where token_hash = ${await hashToken(token)} and expires_at > now()
  `;
  return rows.length === 0 ? null : { subject: rows[0].subject };
}

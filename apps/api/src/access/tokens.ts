import type { AccessRepository } from "@trainer/db/repositories/access.ts";
import { Effect } from "effect";

import { effectful } from "../shared/database.ts";
import type { DatabaseFailure, Invalid } from "../shared/refusals.ts";
import { currentTime, instant, now } from "../shared/values.ts";

export const TOKEN_LIFETIME_MS = 24 * 60 * 60 * 1000;

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token)
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

export function tokenStore(rows: AccessRepository) {
  const repository = effectful(rows);

  const issueToken = Effect.fn("tokens.issueToken")(function* (
    subject: string
  ): Effect.fn.Return<
    { token: string; expires_at: string },
    Invalid | DatabaseFailure
  > {
    const token = btoa(
      String.fromCodePoint(...crypto.getRandomValues(new Uint8Array(32)))
    )
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/u, "");
    // One reading of the clock: the token is issued, expires and sweeps
    // against the same instant.
    const at = yield* currentTime;
    const expiresAt = new Date(at.getTime() + TOKEN_LIFETIME_MS).toISOString();
    const tokenHash = yield* Effect.promise(() => hashToken(token));
    const issuedAt = yield* instant(at.toISOString());
    yield* repository.insertToken({
      token_hash: tokenHash,
      subject,
      issued_at: issuedAt,
      expires_at: yield* instant(expiresAt),
    });
    // Cleanup is independent of minting. A failed sweep cannot hide a usable
    // token, whatever it failed with; the log names the sweep and nothing of
    // the failure.
    yield* repository
      .deleteExpiredTokens(issuedAt)
      .pipe(
        Effect.catchCause(() =>
          Effect.logError("Expired API token cleanup failed.")
        )
      );
    return { token, expires_at: expiresAt };
  });

  const verifyToken = Effect.fn("tokens.verifyToken")(function* (
    token: string
  ): Effect.fn.Return<{ subject: string } | null, DatabaseFailure> {
    const hash = yield* Effect.promise(() => hashToken(token));
    return yield* repository.findActiveToken(hash, yield* now);
  });

  return { issueToken, mint: issueToken, verifyToken };
}

export type TokenStore = ReturnType<typeof tokenStore>;

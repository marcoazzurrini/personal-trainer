import type { AccessRepository } from "../../db/repositories/access.ts";
import { databaseError } from "../shared/errors.ts";
import { instant, systemClock } from "../shared/values.ts";
import type { Clock } from "../shared/values.ts";

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

export function tokenStore(
  repository: AccessRepository,
  clock: Clock = systemClock
) {
  async function issueToken(
    subject: string
  ): Promise<{ token: string; expires_at: string }> {
    const token = btoa(
      String.fromCodePoint(...crypto.getRandomValues(new Uint8Array(32)))
    )
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/u, "");
    const now = clock();
    const expiresAt = new Date(now.getTime() + TOKEN_LIFETIME_MS).toISOString();
    try {
      await repository.insertToken({
        token_hash: await hashToken(token),
        subject,
        issued_at: instant(now.toISOString()),
        expires_at: instant(expiresAt),
      });
    } catch (error) {
      throw databaseError(error);
    }
    // Cleanup is independent of minting. A failed sweep cannot hide a usable token.
    try {
      await repository.deleteExpiredTokens(instant(now.toISOString()));
    } catch {
      console.error("Expired API token cleanup failed.");
    }
    return { token, expires_at: expiresAt };
  }

  async function verifyToken(
    token: string
  ): Promise<{ subject: string } | null> {
    try {
      return await repository.findActiveToken(
        await hashToken(token),
        instant(clock().toISOString())
      );
    } catch (error) {
      throw databaseError(error);
    }
  }
  return { issueToken, mint: issueToken, verifyToken };
}

export type TokenStore = ReturnType<typeof tokenStore>;

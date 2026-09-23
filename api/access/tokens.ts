import {
  type Clock,
  type Database,
  instant,
  rows,
  systemClock,
} from "../shared/d1.ts";

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

/** Construct for the current request's D1 binding; never retain a binding globally. */
export function tokenStore(db: Database, clock: Clock = systemClock) {
  async function issueToken(
    subject: string,
  ): Promise<{ token: string; expires_at: string }> {
    const token = btoa(
      String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const now = clock();
    const expiresAt = new Date(now.getTime() + TOKEN_LIFETIME_MS).toISOString();
    await rows(
      db,
      `INSERT INTO api_tokens (token_hash, subject, issued_at, expires_at)
      VALUES (?, ?, ?, ?)`,
      await hashToken(token),
      subject,
      instant(now.toISOString()),
      instant(expiresAt),
    );
    // Cleanup is independent of minting. A failed sweep cannot hide a usable token.
    try {
      await rows(
        db,
        "DELETE FROM api_tokens WHERE expires_at < ?",
        instant(now.toISOString()),
      );
    } catch {
      console.error("Expired API token cleanup failed.");
    }
    return { token, expires_at: expiresAt };
  }

  async function verifyToken(
    token: string,
  ): Promise<{ subject: string } | null> {
    const result = await rows<{ subject: string }>(
      db,
      "SELECT subject FROM api_tokens WHERE token_hash = ? AND expires_at > ?",
      await hashToken(token),
      instant(clock().toISOString()),
    );
    return result[0] ?? null;
  }
  return { issueToken, mint: issueToken, verifyToken };
}

export type TokenStore = ReturnType<typeof tokenStore>;

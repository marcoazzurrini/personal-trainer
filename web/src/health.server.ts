import { z } from "zod";

const buildRevision = z.string().regex(/^[a-f0-9]{40}$/u);
const buildDigest = z.string().regex(/^[a-f0-9]{64}$/u);

export function readBuildRevision(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Compiled metadata is untrusted input validated by buildRevision below.
  value: unknown = import.meta.env.TRAINER_BUILD_REVISION
): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = buildRevision.safeParse(value);
  if (!parsed.success) {
    throw new Error("The dashboard build revision is invalid.");
  }
  return parsed.data;
}

export function readBuildDigest(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Compiled metadata is untrusted input validated by buildDigest below.
  value: unknown = import.meta.env.TRAINER_BUILD_DIGEST
): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = buildDigest.safeParse(value);
  if (!parsed.success) {
    throw new Error("The dashboard build digest is invalid.");
  }
  return parsed.data;
}

export function healthResponse(
  request: Request,
  loadRevision: () => string | null = readBuildRevision,
  loadDigest: () => string | null = readBuildDigest
): Response {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "private, no-store",
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, {
      status: 405,
      headers: { ...headers, Allow: "GET, HEAD" },
    });
  }
  try {
    const body = JSON.stringify({
      status: "ok",
      revision: loadRevision(),
      build: loadDigest(),
    });
    return new Response(request.method === "HEAD" ? null : body, { headers });
  } catch {
    return new Response(
      request.method === "HEAD" ? null : JSON.stringify({ status: "error" }),
      { status: 503, headers }
    );
  }
}

export function readBuildRevision(
  value: unknown = import.meta.env.TRAINER_BUILD_REVISION,
): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value)) {
    throw new Error("The dashboard build revision is invalid.");
  }
  return value;
}

export function readBuildDigest(
  value: unknown = import.meta.env.TRAINER_BUILD_DIGEST,
): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error("The dashboard build digest is invalid.");
  }
  return value;
}

export function healthResponse(
  request: Request,
  loadRevision: () => string | null = readBuildRevision,
  loadDigest: () => string | null = readBuildDigest,
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
      { status: 503, headers },
    );
  }
}

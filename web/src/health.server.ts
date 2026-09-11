import { readFileSync } from "node:fs";

export function readBuildRevision(
  path = ".output/build-revision.txt",
): string | null {
  let value: string;
  try {
    value = readFileSync(path, "utf8").trim();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw new Error("The dashboard build revision cannot be read.");
  }
  if (!/^[a-f0-9]{40}$/.test(value)) {
    throw new Error("The dashboard build revision is invalid.");
  }
  return value;
}

export function healthResponse(
  request: Request,
  loadRevision: () => string | null = readBuildRevision,
): Response {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, {
      status: 405,
      headers: { ...headers, Allow: "GET, HEAD" },
    });
  }
  try {
    const body = JSON.stringify({ status: "ok", revision: loadRevision() });
    return new Response(request.method === "HEAD" ? null : body, { headers });
  } catch {
    return new Response(
      request.method === "HEAD" ? null : JSON.stringify({ status: "error" }),
      { status: 503, headers },
    );
  }
}

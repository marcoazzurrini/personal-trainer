import { afterEach, expect, it, vi } from "vitest";

const handler = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@tanstack/react-start/server-entry", () => ({
  default: handler,
  createServerEntry: (entry: unknown) => entry,
}));
const { default: server } = await import("../src/server.ts");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

it.each([200, 302, 404, 500])(
  "marks server response %i private, including redirects and errors",
  async (status) => {
    vi.stubEnv(
      "WORKOS_REDIRECT_URI",
      "https://dashboard.example.test/auth/callback",
    );
    handler.fetch.mockResolvedValue(
      new Response("response", {
        status,
        headers: { "Cache-Control": "public, max-age=600" },
      }),
    );
    const response = await server.fetch(new Request("http://localhost/"));
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  },
);

it("keeps unexpected server failures private without exposing the exception", async () => {
  vi.stubEnv(
    "WORKOS_REDIRECT_URI",
    "https://dashboard.example.test/auth/callback",
  );
  handler.fetch.mockRejectedValue(new Error("synthetic sensitive failure"));
  const response = await server.fetch(new Request("http://localhost/"));
  expect(response.status).toBe(500);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await response.text()).not.toContain("synthetic sensitive failure");
});

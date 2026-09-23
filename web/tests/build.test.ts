import { afterEach, expect, it, vi } from "vitest";
import { createNitro } from "nitro/builder";

vi.mock("nitro/builder", () => ({
  createNitro: vi.fn(() => Promise.resolve({})),
}));
vi.mock("nitro/vite", () => ({ nitro: vi.fn(() => ({})) }));
vi.mock(
  "@tanstack/react-start/plugin/vite",
  () => ({ tanstackStart: () => ({}) }),
);
vi.mock("@vitejs/plugin-react", () => ({ default: () => ({}) }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.resetModules();
});

it("builds the pinned Workers preset without reading Vite or Nitro dotenv files", async () => {
  vi.stubEnv("BUILD_REVISION", "a".repeat(40));
  const { default: configure } = await import("../vite.config.ts");
  if (typeof configure !== "function") {
    throw new Error("Expected a config factory");
  }
  const config = await configure({ command: "build", mode: "production" });
  expect(config.envDir).toBe(false);
  expect(config.define?.["import.meta.env.TRAINER_BUILD_REVISION"]).toBe(
    JSON.stringify("a".repeat(40)),
  );
  expect(createNitro).toHaveBeenCalledWith(
    expect.objectContaining({
      dev: false,
      preset: "cloudflare_module",
      cloudflare: { nodeCompat: true, deployConfig: true },
    }),
    { dotenv: false },
  );
});

it.each(["", "HEAD", "abc1234", "A".repeat(40)])(
  "refuses invalid build revision %j",
  async (revision) => {
    vi.stubEnv("BUILD_REVISION", revision);
    await expect(import("../vite.config.ts")).rejects.toThrow(
      "BUILD_REVISION must be the full lowercase source commit.",
    );
  },
);

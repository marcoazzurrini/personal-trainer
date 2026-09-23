import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { createNitro } from "nitro/builder";
import { nitro } from "nitro/vite";

const revision = process.env.BUILD_REVISION;
if (revision !== undefined && !/^[a-f0-9]{40}$/.test(revision)) {
  throw new Error("BUILD_REVISION must be the full lowercase source commit.");
}

export default defineConfig(async ({ command }) => ({
  envDir: false as const,
  define: {
    "import.meta.env.TRAINER_BUILD_REVISION": JSON.stringify(revision ?? null),
    "import.meta.env.TRAINER_BUILD_DIGEST": JSON.stringify(
      command === "build" ? "__TRAINER_WEB_BUILD_DIGEST_PLACEHOLDER__" : null,
    ),
  },
  plugins: [
    tanstackStart(),
    nitro({
      // This pinned Nitro Vite plugin otherwise reads .env even during builds.
      // Supply its instance explicitly so only `npm run dev` loads credentials.
      _nitro: await createNitro({
        dev: command === "serve",
        builder: "vite",
        preset: "cloudflare_module",
        compatibilityDate: "2026-09-15",
        cloudflare: { nodeCompat: true, deployConfig: true },
      }, { dotenv: false }),
    }),
    react(),
  ],
}));

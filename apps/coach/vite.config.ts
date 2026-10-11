import { cloudflare } from "@cloudflare/vite-plugin";
import { flue, flueWorkerConfig } from "@flue/vite";
import { defineConfig } from "vite";

// flue() must come before cloudflare(): it generates the Worker entry and the
// merged Wrangler configuration the Cloudflare plugin consumes.
export default defineConfig({
  plugins: [
    flue({ providers: ["anthropic"] }),
    cloudflare({ config: flueWorkerConfig() }),
  ],
});

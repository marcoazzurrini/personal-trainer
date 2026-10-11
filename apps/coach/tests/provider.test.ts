import { expect, it } from "bun:test";

import { HAIKU, openrouter } from "../src/provider.ts";

// The coach names this model; if the entry vanished, every reply would fail
// with an unknown-model error instead of reaching OpenRouter.
it("offers Claude Haiku 5.5 through OpenRouter's Anthropic wire API", () => {
  const model = openrouter.getModels().find(({ id }) => id === HAIKU);
  expect(model?.provider).toBe("openrouter");
  expect(model?.api).toBe("anthropic-messages");
  expect(model?.baseUrl).toBe("https://openrouter.ai/api");
  expect(model?.reasoning).toBe(true);
  expect(model?.contextWindow).toBe(1_000_000);
});

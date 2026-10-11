import { createProvider } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";

// The model catalog pinned with this Flue release predates Claude Haiku 5.5.
// Its entry is the Opus 5.5 entry with Haiku's identity and prices: same API,
// context window, output limit and adaptive-only thinking. Delete this file
// once the catalog lists the model itself.
const builtIn = anthropicProvider();
const template = builtIn.getModels().find(({ id }) => id === "claude-opus-5-5");
if (!template) {
  throw new Error(
    "The pinned model catalog no longer lists claude-opus-5-5; update the Claude Haiku 5.5 entry."
  );
}

export const HAIKU = "claude-haiku-5-5";

export const anthropic = createProvider({
  id: builtIn.id,
  name: builtIn.name,
  baseUrl: builtIn.baseUrl,
  auth: builtIn.auth,
  models: [
    ...builtIn.getModels().filter(({ id }) => id !== HAIKU),
    {
      ...template,
      id: HAIKU,
      name: "Claude Haiku 5.5",
      // USD per million tokens, for prompts up to 100K tokens.
      cost: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
    },
  ],
  api: anthropicMessagesApi(),
});

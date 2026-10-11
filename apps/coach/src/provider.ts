import { createProvider } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";

// The coach reaches Claude Haiku 5.5 through OpenRouter, with OPENROUTER_API_KEY.
// The model catalog pinned with this Flue release predates Haiku 5.5, so its
// entry is OpenRouter's Opus 4.7 entry with Haiku's identity and prices: same
// wire API, adaptive-only thinking, 1M context and 128K output. Delete the
// added entry once the catalog lists the model itself.
const builtIn = openrouterProvider();
const template = builtIn
  .getModels()
  .find(({ id }) => id === "anthropic/claude-opus-4.7");
if (!template) {
  throw new Error(
    "The pinned model catalog no longer lists anthropic/claude-opus-4.7 on OpenRouter; update the Claude Haiku 5.5 entry."
  );
}

export const HAIKU = "anthropic/claude-haiku-5.5";

export const openrouter = createProvider({
  id: builtIn.id,
  name: builtIn.name,
  baseUrl: builtIn.baseUrl,
  auth: builtIn.auth,
  models: [
    ...builtIn.getModels().filter(({ id }) => id !== HAIKU),
    {
      ...template,
      id: HAIKU,
      name: "Anthropic: Claude Haiku 5.5",
      // USD per million tokens, as OpenRouter lists them.
      cost: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
    },
  ],
  // OpenRouter serves Claude over the Anthropic wire API and the rest of its
  // catalog over the OpenAI one, as the built-in provider does.
  api: {
    "anthropic-messages": anthropicMessagesApi(),
    "openai-completions": openAICompletionsApi(),
  },
});

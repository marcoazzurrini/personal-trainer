import { defineTool } from "@flue/runtime";
import * as v from "valibot";

import { progressCard } from "../progress.ts";
import { callApi } from "./api.ts";

// The app draws this tool's output as the progress card, so the card shows the
// record exactly as the API returned it, never numbers the model retyped.
export const showProgress = defineTool({
  name: "show_progress",
  description:
    "Show Marco his progress card in the app: the current block and week, and his bodyweight with its trend over the last weeks. The app draws the card from this tool's result, so after calling it do not repeat its numbers; add only what the documents would have you say about them.",
  input: v.object({}),
  timeoutMs: 30_000,
  async run({ signal }) {
    const [training, bodyweight] = await Promise.all([
      callApi({ method: "GET", path: "/training-state" }, signal),
      callApi({ method: "GET", path: "/bodyweight" }, signal),
    ]);
    return { output: progressCard(training, bodyweight) };
  },
});

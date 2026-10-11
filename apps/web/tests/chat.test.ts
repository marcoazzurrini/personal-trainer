import type { FlueConversationMessage } from "@flue/react";
import { describe, expect, it } from "vitest";

import { threadMessages, toThreadMessage } from "../src/chat.tsx";

const base = {
  id: "m1",
  purpose: "assistant",
  display: "visible",
} as const;

// The thread draws what the conversation recorded: text, tool calls with their
// outcome, and a failed turn as a visible failure rather than silence.
describe("drawing the coach's conversation", () => {
  it("keeps text and tool calls in order, with results and errors", () => {
    const message: FlueConversationMessage = {
      ...base,
      role: "assistant",
      parts: [
        { type: "reasoning", text: "private", state: "done" },
        { type: "text", text: "Reading your state.", state: "done" },
        {
          type: "dynamic-tool",
          toolName: "api",
          toolCallId: "t1",
          state: "output-available",
          input: { method: "GET", path: "/training-state" },
          output: { status: 200, body: {} },
        },
        {
          type: "dynamic-tool",
          toolName: "api",
          toolCallId: "t2",
          state: "output-error",
          input: { method: "POST", path: "/sessions" },
          errorText: "timed out",
        },
      ],
    };
    expect(toThreadMessage(message)).toEqual({
      id: "m1",
      role: "assistant",
      content: [
        { type: "text", text: "Reading your state." },
        {
          type: "tool-call",
          toolCallId: "t1",
          toolName: "api",
          args: { method: "GET", path: "/training-state" },
          result: { status: 200, body: {} },
        },
        {
          type: "tool-call",
          toolCallId: "t2",
          toolName: "api",
          args: { method: "POST", path: "/sessions" },
          result: "timed out",
          isError: true,
        },
      ],
    });
  });

  it("says when a reply failed or was stopped", () => {
    const failed = toThreadMessage({
      ...base,
      role: "system",
      purpose: "advisory",
      settlement: { outcome: "failed" },
      parts: [],
    });
    expect(failed.role).toBe("assistant");
    expect(JSON.stringify(failed.content)).toContain(
      "could not finish this reply"
    );
    const stopped = toThreadMessage({
      ...base,
      role: "system",
      purpose: "advisory",
      settlement: { outcome: "aborted" },
      parts: [],
    });
    expect(JSON.stringify(stopped.content)).toContain("Stopped");
  });
});

describe("marking replies that never finished", () => {
  const user = (submissionId: string): FlueConversationMessage => ({
    id: `u-${submissionId}`,
    role: "user",
    purpose: "user",
    display: "visible",
    submissionId,
    parts: [{ type: "text", text: "ciao", state: "done" }],
  });
  const reply = (submissionId: string): FlueConversationMessage => ({
    id: `a-${submissionId}`,
    role: "assistant",
    purpose: "assistant",
    display: "visible",
    submissionId,
    parts: [],
  });

  it("marks a failed reply on its own message", () => {
    const thread = threadMessages(
      [user("s1"), reply("s1")],
      [{ submissionId: "s1", outcome: "failed" }]
    );
    expect(thread.map((message) => message.settlement?.outcome)).toEqual([
      undefined,
      "failed",
    ]);
  });

  it("adds a marker when a turn produced no reply at all", () => {
    const thread = threadMessages(
      [user("s1"), user("s2"), reply("s2")],
      [
        { submissionId: "s1", outcome: "aborted" },
        { submissionId: "s2", outcome: "completed" },
      ]
    );
    expect(thread.map((message) => message.id)).toEqual([
      "u-s1",
      "unfinished-s1",
      "u-s2",
      "a-s2",
    ]);
    expect(thread[1].settlement).toEqual({ outcome: "aborted" });
  });

  it("hides runtime plumbing", () => {
    const hidden: FlueConversationMessage = {
      ...user("s1"),
      id: "h",
      display: "hidden",
    };
    expect(threadMessages([hidden], [])).toEqual([]);
  });
});

import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import type {
  AppendMessage,
  ThreadMessageLike,
  ToolCallMessagePartProps,
} from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import { useFlueAgent } from "@flue/react";
import type {
  FlueConversationMessage,
  FlueConversationSettlement,
} from "@flue/react";
import { useCallback, useMemo } from "react";
import remarkGfm from "remark-gfm";
import { z } from "zod";

import { COACH_CONVERSATION } from "./coach-path";
import { ProgressCard } from "./progress-card";

type Part = Exclude<ThreadMessageLike["content"], string>[number];
type ToolCallPart = Extract<Part, { type: "tool-call" }>;
type ToolPart = Extract<
  FlueConversationMessage["parts"][number],
  { type: "dynamic-tool" }
>;

function toolCall(part: ToolPart): ToolCallPart {
  const call: ToolCallPart = {
    type: "tool-call",
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    // SAFETY: Flue records a tool's input as the model's parsed JSON arguments.
    args: (part.input ?? {}) as ToolCallPart["args"],
  };
  if (part.state === "output-available") {
    return { ...call, result: part.output };
  }
  if (part.state === "output-error") {
    return { ...call, result: part.errorText, isError: true };
  }
  return call;
}

// Flue's conversation is the record of the chat; assistant-ui only draws it.
// Hidden runtime plumbing never reaches the screen, and a turn that failed
// says so in the thread instead of disappearing.
export function toThreadMessage(
  message: FlueConversationMessage
): ThreadMessageLike {
  const content: Part[] = [];
  for (const part of message.parts) {
    if (part.type === "text") {
      content.push({ type: "text", text: part.text });
    } else if (part.type === "dynamic-tool") {
      content.push(toolCall(part));
    }
  }
  if (message.settlement) {
    content.push({
      type: "text",
      text:
        message.settlement.outcome === "aborted"
          ? "_Stopped._"
          : "_The coach could not finish this reply. Try again in a moment._",
    });
  }
  const thread: ThreadMessageLike = {
    id: message.id,
    role: message.role === "user" ? "user" : "assistant",
    content,
  };
  if (message.timestamp) {
    return { ...thread, createdAt: new Date(message.timestamp) };
  }
  return thread;
}

function visible(message: FlueConversationMessage): boolean {
  return (
    message.display === "visible" &&
    (message.role !== "system" || message.settlement !== undefined)
  );
}

/**
 * The visible thread, with every reply that failed or was stopped marked on
 * the turn it belongs to; a turn that never produced a reply gets a marker of
 * its own after the message that started it.
 */
export function threadMessages(
  messages: readonly FlueConversationMessage[],
  settlements: readonly FlueConversationSettlement[]
): FlueConversationMessage[] {
  const unfinished = new Map<string, "failed" | "aborted">();
  for (const { submissionId, outcome } of settlements) {
    if (outcome !== "completed") {
      unfinished.set(submissionId, outcome);
    }
  }
  const marked = new Set(
    messages.flatMap((message) =>
      message.settlement && message.submissionId ? [message.submissionId] : []
    )
  );
  const shown = messages.filter(visible);
  const thread: FlueConversationMessage[] = [];
  for (const [index, message] of shown.entries()) {
    const outcome = message.submissionId
      ? unfinished.get(message.submissionId)
      : undefined;
    const last =
      shown.findLastIndex(
        (other) => other.submissionId === message.submissionId
      ) === index;
    if (
      outcome !== undefined &&
      message.submissionId !== undefined &&
      message.role === "assistant" &&
      !marked.has(message.submissionId)
    ) {
      marked.add(message.submissionId);
      thread.push({ ...message, settlement: { outcome } });
      continue;
    }
    thread.push(message);
    if (
      outcome !== undefined &&
      message.submissionId !== undefined &&
      last &&
      !marked.has(message.submissionId)
    ) {
      marked.add(message.submissionId);
      thread.push({
        id: `unfinished-${message.submissionId}`,
        role: "assistant",
        purpose: "advisory",
        display: "visible",
        submissionId: message.submissionId,
        settlement: { outcome },
        parts: [],
      });
    }
  }
  return thread;
}

const MarkdownText = () => (
  <MarkdownTextPrimitive className="markdown" remarkPlugins={[remarkGfm]} />
);

// The record calls the coach makes, named plainly so a write never happens
// out of sight.
const ApiArgs = z.object({ method: z.string(), path: z.string() });

function apiLabel(method: string, running: boolean): string {
  if (running) {
    return "…";
  }
  return method === "GET" ? "Read" : "Saved";
}

const ApiCall = ({ args, status, isError }: ToolCallMessagePartProps) => {
  const call = ApiArgs.safeParse(args);
  if (!call.success) {
    return null;
  }
  return (
    <p className={isError ? "activity activity-error" : "activity"}>
      {apiLabel(call.data.method, status.type === "running")} {call.data.path}
    </p>
  );
};

const Progress = ({ result, status }: ToolCallMessagePartProps) =>
  status.type === "running" ? (
    <p className="activity">Loading your progress…</p>
  ) : (
    <ProgressCard data={result} />
  );

const QuietTool = () => null;

const UserMessage = () => (
  <MessagePrimitive.Root className="message message-user">
    <MessagePrimitive.Parts />
  </MessagePrimitive.Root>
);

const AssistantMessage = () => (
  <MessagePrimitive.Root className="message message-coach">
    <MessagePrimitive.Parts
      components={{
        Text: MarkdownText,
        tools: {
          by_name: { api: ApiCall, show_progress: Progress },
          Fallback: QuietTool,
        },
      }}
    />
  </MessagePrimitive.Root>
);

const shortcuts = ["I want to train", "Here's what I did", "How am I doing?"];

export const Chat = () => {
  const agent = useFlueAgent({ url: COACH_CONVERSATION });
  const messages = useMemo(
    () => threadMessages(agent.messages, agent.settlements),
    [agent.messages, agent.settlements]
  );
  const onNew = useCallback(
    async (message: AppendMessage) => {
      const text = message.content
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("")
        .trim();
      if (text) {
        await agent.sendMessage(text);
      }
    },
    [agent]
  );
  const runtime = useExternalStoreRuntime({
    messages,
    convertMessage: toThreadMessage,
    isRunning: agent.status === "submitted" || agent.status === "streaming",
    isLoading: !agent.historyReady && agent.status !== "error",
    onNew,
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="thread">
        <ThreadPrimitive.Viewport className="viewport">
          <ThreadPrimitive.Empty>
            <div className="welcome">
              <p>Ready when you are.</p>
              <p className="muted">Tell me how you feel today.</p>
            </div>
          </ThreadPrimitive.Empty>
          <ThreadPrimitive.Messages
            components={{ UserMessage, AssistantMessage }}
          />
          {agent.failedSends.length > 0 && (
            <p className="activity activity-error" role="alert">
              Your last message did not reach the coach. Check your connection
              and send it again.
            </p>
          )}
          <ThreadPrimitive.ViewportFooter className="dock">
            <div className="shortcuts">
              {shortcuts.map((prompt) => (
                <ThreadPrimitive.Suggestion
                  className="shortcut"
                  key={prompt}
                  prompt={prompt}
                  send
                >
                  {prompt}
                </ThreadPrimitive.Suggestion>
              ))}
            </div>
            <ComposerPrimitive.Root className="composer">
              <ComposerPrimitive.Input
                aria-label="Message your coach"
                className="composer-input"
                placeholder="Message your coach…"
                rows={1}
              />
              <ComposerPrimitive.Send
                aria-label="Send"
                className="composer-send"
              >
                <svg
                  aria-hidden="true"
                  fill="none"
                  height="16"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2.4"
                  viewBox="0 0 24 24"
                  width="16"
                >
                  <path d="M12 19V5M6 11l6-6 6 6" />
                </svg>
              </ComposerPrimitive.Send>
            </ComposerPrimitive.Root>
          </ThreadPrimitive.ViewportFooter>
        </ThreadPrimitive.Viewport>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
};

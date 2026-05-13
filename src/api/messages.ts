import {
  AIMessage,
  BaseMessage,
  HumanMessage,
} from "@langchain/core/messages";
import type { ChatMessage } from "./types.js";

// ===========================================================================
// messages
// ===========================================================================

type ContentBlock = { type?: string; text?: string } | string;

export function extractText(chunk: unknown): string {
  if (!chunk || typeof chunk !== "object") return "";
  const content = (chunk as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as ContentBlock[])
      .map((b) => {
        if (typeof b === "string") return b;
        if (b && typeof b === "object" && typeof b.text === "string")
          return b.text;
        return "";
      })
      .join("");
  }
  return "";
}

export function isAIChunk(chunk: unknown): boolean {
  if (!chunk || typeof chunk !== "object") return false;
  const c = chunk as {
    getType?: () => string;
    _getType?: () => string;
    type?: string;
  };
  const t = c.getType?.() ?? c._getType?.() ?? c.type;
  return t === "ai" || t === "AIMessageChunk" || t === "AIMessage";
}

export function toLangchainHistory(messages: ChatMessage[]): BaseMessage[] {
  return messages
    .filter((m) => m.role !== "system")
    .map((m) =>
      m.role === "user"
        ? new HumanMessage(m.content)
        : new AIMessage(m.content),
    );
}

export function lastUserInput(messages: ChatMessage[]): string {
  const last = messages.filter((m) => m.role !== "system").at(-1);
  return last?.role === "user" ? last.content : "";
}

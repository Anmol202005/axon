import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { tool } from "langchain";
import { z } from "zod";
import type { ChatMessage, Logger } from "../types.js";
import { extractText } from "../messages.js";

// ===========================================================================
// summarize tool — collapses long conversation history into a compact recap
// ===========================================================================

const SUMMARIZER_SYSTEM = `You are a precise conversation summarizer working in support of a CLI coding agent.

Produce a compact recap of the conversation that preserves:
- User intent and goals (what they're trying to accomplish)
- Decisions made and rationale
- Files read, written, or deleted (with paths)
- Sub-agent delegations and their outcomes
- Open questions and unfinished work

Drop:
- Filler, greetings, restated context
- Verbatim file contents (refer to them by path instead)
- Internal chain-of-thought

Use neutral third-person voice. Aim for under 400 words unless the conversation is unusually dense. Output only the summary — no preamble.`;

export interface SummarizeOptions {
  focus?: string;
  maxChars?: number;
}

// Lightweight interface for any LangChain chat model.
export interface SummarizerModel {
  invoke(input: unknown): Promise<unknown>;
}

export async function summarizeMessages(
  messages: ChatMessage[],
  model: SummarizerModel,
  opts: SummarizeOptions = {},
): Promise<string> {
  const filtered = messages.filter((m) => m.role !== "system");
  if (filtered.length === 0) return "(no conversation to summarize)";

  const transcript = filtered
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join("\n\n");

  const focusLine = opts.focus
    ? `\n\nFocus the summary on: ${opts.focus}`
    : "";

  const user = `Summarize the conversation below.${focusLine}\n\n---\n${transcript}\n---`;

  const result = await model.invoke([
    new SystemMessage(SUMMARIZER_SYSTEM),
    new HumanMessage(user),
  ]);
  const text = extractText(result) || "(summary unavailable)";
  if (opts.maxChars && text.length > opts.maxChars) {
    return text.slice(0, opts.maxChars - 3) + "...";
  }
  return text;
}

export function createSummarizeTool(opts: {
  getMessages: () => ChatMessage[];
  model: SummarizerModel;
  log?: Logger;
  indent: string;
}) {
  const { getMessages, model, log, indent } = opts;

  return tool(
    async ({ focus }) => {
      const messages = getMessages();
      const count = messages.filter((m) => m.role !== "system").length;
      if (count === 0) return "(no conversation to summarize yet)";
      log?.(
        "info",
        `${indent}∑ summarizing ${count} message(s)${focus ? ` · focus="${focus}"` : ""}`,
      );
      const summary = await summarizeMessages(messages, model, { focus });
      log?.(
        "info",
        `${indent}∑ summary produced · ${summary.length} chars`,
      );
      return summary;
    },
    {
      name: "summarize_conversation",
      description:
        "Summarize the conversation so far into a compact recap. Use when the conversation has grown long and you want to consolidate prior context — decisions, file changes, open questions — into a single string. Returns the summary as plain text.",
      schema: z.object({
        focus: z
          .string()
          .optional()
          .describe(
            "Optional focus for the summary (e.g. 'decisions made', 'files modified', 'remaining work'). Omit for a general recap.",
          ),
      }),
    },
  );
}

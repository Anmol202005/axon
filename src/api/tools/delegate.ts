import { HumanMessage } from "@langchain/core/messages";
import { tool } from "langchain";
import { z } from "zod";
import type {
  AgentRunState,
  FileChangeFn,
  Logger,
  ToolApprover,
} from "../types.js";
import { extractText } from "../messages.js";
import { shortRole, subAgentPrompt, truncate } from "../prompts.js";
import { buildAgent } from "../builder.js";

// ===========================================================================
// delegation tool
// ===========================================================================

export interface CallAgentToolOptions {
  depth: number;
  state: AgentRunState;
  log: Logger | undefined;
  indent: string;
  workspaceRoot: string;
  onFileChange: FileChangeFn | undefined;
  extraTools?: unknown[];
  planMode?: boolean;
  approver?: ToolApprover;
  abortSignal?: AbortSignal;
  onModelUsage?: (usage: { input: number; output: number }) => void;
}

export function createCallAgentTool(opts: CallAgentToolOptions) {
  const {
    depth,
    state,
    log,
    indent,
    workspaceRoot,
    onFileChange,
    extraTools = [],
    planMode = false,
    approver,
    abortSignal,
    onModelUsage,
  } = opts;

  return tool(
    async ({ systemPrompt: subSystemPrompt, prompt }) => {
      const role = shortRole(subSystemPrompt);

      if (state.callCount >= state.maxCalls) {
        log?.(
          "warn",
          `${indent}✗ delegation refused · call budget ${state.maxCalls} exhausted · role="${role}"`,
        );
        return `Delegation refused: sub-agent call budget (${state.maxCalls}) exhausted for this request. Solve this subtask yourself.`;
      }
      state.callCount++;
      const callIndex = state.callCount;

      const childDepth = depth + 1;
      const childCanDelegate = childDepth < state.maxDepth;
      log?.(
        "info",
        `${indent}↳ spawn sub-agent #${callIndex} · depth ${childDepth}/${state.maxDepth} · role="${role}" · task="${truncate(prompt)}"`,
      );
      const subAgent = buildAgent({
        systemPrompt: subAgentPrompt(subSystemPrompt, childCanDelegate),
        log,
        depth: childDepth,
        state,
        workspaceRoot,
        onFileChange,
        extraTools,
        planMode,
        approver,
        abortSignal,
        onModelUsage,
      });
      const result = await subAgent.invoke(
        { messages: [new HumanMessage(prompt)] },
        abortSignal ? { signal: abortSignal } : undefined,
      );
      const text = extractText(result.messages.at(-1)) || "";
      log?.(
        "info",
        `${indent}✓ sub-agent #${callIndex} done · role="${role}" · ${text.length} chars returned`,
      );
      return text;
    },
    {
      name: "call_agent",
      description:
        "Delegate a subtask to a sub-agent. You assign the sub-agent a role via its systemPrompt, and give it a self-contained task via prompt. Returns the sub-agent's final reply as a string.",
      schema: z.object({
        systemPrompt: z
          .string()
          .describe(
            "The role/persona system prompt to assign to the sub-agent. Should be specific to the subtask (e.g. 'You are a research analyst focused on climate policy').",
          ),
        prompt: z
          .string()
          .describe(
            "The self-contained task for the sub-agent. Include any context the sub-agent needs since it cannot see this conversation. Scope it narrowly: state exactly what to produce and what NOT to cover (so the sub-agent does not drift into adjacent topics).",
          ),
      }),
    },
  );
}

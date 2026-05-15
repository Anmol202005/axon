import { createAgent, tool, type ReactAgent } from "langchain";
import { randomUUID } from "node:crypto";
import type {
  AgentRunState,
  FileChangeFn,
  Logger,
  ToolApprover,
} from "./types.js";
import { DEFAULT_SOFT_CAP, newRunState } from "./types.js";
import type { RoleMap } from "./prompts.js";
import { buildModel } from "./model.js";
import { createFileTools } from "./tools/files.js";
import { createShellTool } from "./tools/shell.js";
import { createSearchTool } from "./tools/search.js";
import { createGitTools } from "./tools/git.js";
import { createWebTools } from "./tools/web.js";
import { createChecksTool } from "./tools/checks.js";
import {
  createExitPlanModeTool,
  EXIT_PLAN_MODE_TOOL_NAME,
} from "./tools/plan.js";
import { createCallAgentTool } from "./tools/delegate.js";

// ===========================================================================
// agent builder
// ===========================================================================

// Tools that never go through the approver. Pure reads with no workspace
// side effects, plus the internal orchestration tools (delegate, summarize)
// which would otherwise prompt on every sub-agent spawn or context compact.
// Anything that writes, deletes, executes, or talks to MCP must be gated.
const ALWAYS_ALLOWED_TOOLS = new Set<string>([
  "read_file",
  "list_files",
  "search",
  "git_status",
  "git_diff",
  "git_blame",
  "git_log",
  "call_agent",
  "summarize_conversation",
]);

export interface BuildAgentOptions {
  systemPrompt: string;
  log?: Logger;
  depth?: number;
  state?: AgentRunState;
  workspaceRoot?: string;
  onFileChange?: FileChangeFn;
  // Extra tools loaded outside the builder (e.g. MCP). Passed through to
  // sub-agents so the whole tree sees the same tool surface.
  extraTools?: unknown[];
  // When true, exposes the `exit_plan_mode` tool so the agent can present
  // a plan for approval. The actual blocking of mutating tools while plan
  // mode is active is enforced by the approver (the CLI keeps a live ref
  // and auto-denies anything not on PLAN_MODE_ALLOWED_TOOLS).
  planMode?: boolean;
  // Optional approver consulted before every gated tool call. Shared with
  // sub-agents so every tool invocation across the tree is gated.
  approver?: ToolApprover;
  // AbortSignal propagated to agent.invoke and to in-flight tools (shell
  // child processes get SIGTERM). Cancellation surfaces as an aborted
  // agent.invoke which the runner translates into a "cancelled" event.
  abortSignal?: AbortSignal;
  // Streaming callbacks. Attached to THIS agent's model only — sub-agents
  // built via delegate get a fresh model without these handlers, so only the
  // orchestrator streams to the UI.
  onModelStart?: () => void;
  onModelToken?: (token: string) => void;
  // Called on each LLM call that reports token usage. Inputs may be 0 if
  // the provider doesn't surface counts.
  onModelUsage?: (usage: { input: number; output: number }) => void;
  // Advisory budget threaded through to the delegate tool so sub-agents
  // that can themselves delegate (maxDepth > 1) see the same soft cap as
  // the orchestrator.
  softCap?: number;
  // Optional model-name override. When set, this agent is built with that
  // model instead of the one from the active BYOK config. Used by the
  // delegation pipeline to put sub-agents on a cheaper/faster model.
  modelName?: string;
  // Architecture knobs threaded through to the delegate tool so it can
  // enforce per-parent / per-depth caps and the role-required policy.
  subAgentModel?: string;
  requireRole?: boolean;
  // Active role registry — built-ins merged with any user .axon/roles/*.md.
  // Passed to the delegate tool (schema enum + prompt lookup) and to the
  // orchestrator prompt (role catalog block). When omitted, defaults to
  // just the built-ins.
  roles?: RoleMap;
}

export function buildAgent(opts: BuildAgentOptions): ReactAgent {
  const {
    systemPrompt,
    log,
    depth = 0,
    state = newRunState(),
    workspaceRoot = process.cwd(),
    onFileChange,
    extraTools = [],
    planMode = false,
    approver,
    abortSignal,
    onModelStart,
    onModelToken,
    onModelUsage,
    softCap = DEFAULT_SOFT_CAP,
    modelName,
    subAgentModel,
    requireRole,
    roles,
  } = opts;

  const indent = "  ".repeat(depth);
  const canDelegate = depth < state.maxDepth;
  const fileTools = createFileTools(workspaceRoot, log, onFileChange, indent);
  const shellTool = createShellTool(workspaceRoot, log, indent, abortSignal);
  const searchToolInstance = createSearchTool(
    workspaceRoot,
    log,
    indent,
    abortSignal,
  );
  const gitTools = createGitTools(workspaceRoot, log, indent, abortSignal);
  const webTools = createWebTools(log, indent, abortSignal);
  const checksTool = createChecksTool(
    workspaceRoot,
    log,
    indent,
    abortSignal,
  );

  const baseTools = [
    ...fileTools,
    shellTool,
    searchToolInstance,
    ...gitTools,
    ...webTools,
    checksTool,
    ...extraTools,
  ];
  if (planMode) baseTools.push(createExitPlanModeTool());
  const rawTools = canDelegate
    ? [
        ...baseTools,
        createCallAgentTool({
          depth,
          state,
          log,
          indent,
          workspaceRoot,
          onFileChange,
          extraTools,
          planMode,
          approver,
          abortSignal,
          onModelUsage,
          softCap,
          subAgentModel,
          requireRole,
          roles,
        }),
      ]
    : baseTools;

  const tools = approver
    ? rawTools.map((t) => wrapToolWithApproval(t, approver, indent, log))
    : rawTools;

  if (!canDelegate) {
    log?.(
      "info",
      `${indent}· leaf agent (depth ${depth}) · call_agent tool not registered`,
    );
  }

  const wantStream = !!(onModelStart || onModelToken);
  const wantUsage = !!onModelUsage;
  const callbacks =
    wantStream || wantUsage
      ? [
          {
            handleLLMStart: async () => {
              onModelStart?.();
            },
            handleLLMNewToken: async (token: string) => {
              onModelToken?.(token);
            },
            handleLLMEnd: async (output: any) => {
              if (!onModelUsage) return;
              const usage = extractUsage(output);
              if (usage) onModelUsage(usage);
            },
          },
        ]
      : undefined;

  return createAgent({
    model: buildModel({ callbacks, streaming: wantStream, modelName }),
    systemPrompt,
    tools: tools as never,
  });
}

// ---------------------------------------------------------------------------
// extractUsage — pull input/output token counts out of langchain's LLMResult.
// Different providers / langchain versions surface counts at different
// paths; we try the common ones and bail with undefined if none match.
// ---------------------------------------------------------------------------
function extractUsage(
  output: any,
): { input: number; output: number } | undefined {
  const sources: any[] = [
    output?.llmOutput?.tokenUsage,
    output?.llmOutput?.usage,
    output?.generations?.[0]?.[0]?.message?.usage_metadata,
    output?.generations?.[0]?.[0]?.message?.response_metadata?.tokenUsage,
    output?.generations?.[0]?.[0]?.message?.response_metadata?.usage,
    output?.generations?.[0]?.[0]?.generationInfo?.usage,
  ];
  for (const src of sources) {
    if (!src) continue;
    const input =
      src.promptTokens ??
      src.prompt_tokens ??
      src.input_tokens ??
      src.inputTokens ??
      0;
    const out =
      src.completionTokens ??
      src.completion_tokens ??
      src.output_tokens ??
      src.outputTokens ??
      0;
    if (input || out) return { input: Number(input), output: Number(out) };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// wrapToolWithApproval — returns a new langchain tool with the same name /
// description / schema as the original, but whose body first asks the
// approver. The wrapper does NOT track "always allow" state itself — that
// belongs to whoever installed the approver (the CLI), so we get the same
// answer for free on every wrapped call until the caller short-circuits.
// ---------------------------------------------------------------------------

function wrapToolWithApproval(
  rawTool: any,
  approver: ToolApprover,
  indent: string,
  log: Logger | undefined,
): any {
  const name: string = rawTool?.name ?? "<unknown tool>";
  if (ALWAYS_ALLOWED_TOOLS.has(name)) return rawTool;

  return tool(
    async (args: any) => {
      const decision = await approver({
        id: randomUUID(),
        toolName: name,
        args: (args ?? {}) as Record<string, unknown>,
      });
      if (decision.kind === "deny") {
        const reason = decision.reason?.trim() || "no reason given";
        log?.(
          "warn",
          `${indent}✗ ${name} denied by user (${reason})`,
        );
        return `User denied ${name}: ${reason}. Do not retry this exact call — ask the user how they'd like you to proceed.`;
      }
      return await rawTool.invoke(args);
    },
    {
      name,
      description: rawTool?.description ?? "",
      schema: rawTool?.schema,
    },
  );
}

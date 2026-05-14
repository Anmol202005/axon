import { createAgent, tool, type ReactAgent } from "langchain";
import { randomUUID } from "node:crypto";
import type {
  AgentRunState,
  FileChangeFn,
  Logger,
  ToolApprover,
} from "./types.js";
import { newRunState } from "./types.js";
import { buildModel } from "./model.js";
import { createFileTools } from "./tools/files.js";
import { createShellTool } from "./tools/shell.js";
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
  // Optional approver consulted before every gated tool call. Shared with
  // sub-agents so every tool invocation across the tree is gated.
  approver?: ToolApprover;
  // Streaming callbacks. Attached to THIS agent's model only — sub-agents
  // built via delegate get a fresh model without these handlers, so only the
  // orchestrator streams to the UI.
  onModelStart?: () => void;
  onModelToken?: (token: string) => void;
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
    approver,
    onModelStart,
    onModelToken,
  } = opts;

  const indent = "  ".repeat(depth);
  const canDelegate = depth < state.maxDepth;
  const fileTools = createFileTools(workspaceRoot, log, onFileChange, indent);
  const shellTool = createShellTool(workspaceRoot, log, indent);

  const baseTools = [...fileTools, shellTool, ...extraTools];
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
          approver,
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
  const callbacks = wantStream
    ? [
        {
          handleLLMStart: async () => {
            onModelStart?.();
          },
          handleLLMNewToken: async (token: string) => {
            onModelToken?.(token);
          },
        },
      ]
    : undefined;

  return createAgent({
    model: buildModel({ callbacks, streaming: wantStream }),
    systemPrompt,
    tools: tools as never,
  });
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

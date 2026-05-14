import { createAgent, type ReactAgent } from "langchain";
import type {
  AgentRunState,
  FileChangeFn,
  Logger,
  WriteApprover,
} from "./types.js";
import { newRunState } from "./types.js";
import { buildModel } from "./model.js";
import { createFileTools } from "./tools/files.js";
import { createShellTool } from "./tools/shell.js";
import { createCallAgentTool } from "./tools/delegate.js";

// ===========================================================================
// agent builder
// ===========================================================================

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
  // Optional approver consulted before any file-mutating tool touches disk.
  // Shared with sub-agents so every write across the tree is gated.
  approver?: WriteApprover;
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
  const fileTools = createFileTools(
    workspaceRoot,
    log,
    onFileChange,
    indent,
    approver,
  );
  const shellTool = createShellTool(workspaceRoot, log, indent);

  const baseTools = [...fileTools, shellTool, ...extraTools];
  const tools = canDelegate
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

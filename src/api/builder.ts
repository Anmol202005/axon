import { createAgent, type ReactAgent } from "langchain";
import type {
  AgentRunState,
  FileChangeFn,
  Logger,
} from "./types.js";
import { newRunState } from "./types.js";
import { buildModel } from "./model.js";
import { createFileTools } from "./tools/files.js";
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
  } = opts;

  const indent = "  ".repeat(depth);
  const canDelegate = depth < state.maxDepth;
  const fileTools = createFileTools(workspaceRoot, log, onFileChange, indent);

  const baseTools = [...fileTools, ...extraTools];
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
        }),
      ]
    : baseTools;

  if (!canDelegate) {
    log?.(
      "info",
      `${indent}· leaf agent (depth ${depth}) · call_agent tool not registered`,
    );
  }

  return createAgent({
    model: buildModel(),
    systemPrompt,
    tools: tools as never,
  });
}

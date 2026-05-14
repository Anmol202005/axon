import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  AgentEvent,
  ChatMessage,
  FileChangeFn,
  Logger,
  ToolApprover,
} from "./types.js";
import { makeLogEntry, newRunState } from "./types.js";
import {
  extractText,
  lastUserInput,
  toLangchainHistory,
} from "./messages.js";
import { orchestratorPrompt } from "./prompts.js";
import { buildAgent } from "./builder.js";
import { buildModel } from "./model.js";
import { loadMcpTools } from "./mcp/client.js";
import { resolveMcpConfig } from "./mcp/config.js";
import type { McpServerConfig } from "./mcp/types.js";
import { createSummarizeTool } from "./tools/summarize.js";

// ===========================================================================
// runner — programmatic entry point for the CLI
// ===========================================================================

export interface RunAgentOptions {
  messages: ChatMessage[];
  workspaceRoot?: string;
  onEvent?: (event: AgentEvent) => void;
  maxCalls?: number;
  maxDepth?: number;
  // MCP configuration. Defaults + user-config file (.forge/mcp.json) are
  // always merged in unless explicitly disabled.
  mcp?: {
    enabled?: boolean; // default true
    includeDefaults?: boolean; // default true
    configPath?: string; // override the default search path
    extraServers?: Record<string, McpServerConfig>; // programmatic additions
  };
  // Summarization tool. On by default — exposes `summarize_conversation`
  // so the agent can compact long histories on demand.
  summarize?: {
    enabled?: boolean; // default true
  };
  // Called before every gated tool call. Resolve with the user's decision
  // (allow_once / always_allow / deny). When omitted, all tools run
  // unprompted.
  onToolApprovalRequest?: ToolApprover;
  // Aborting this signal cancels in-flight agent.invoke and tools (shell
  // children are SIGTERM'd then SIGKILL'd). The runner surfaces this as a
  // "cancelled" event and resolves cleanly.
  signal?: AbortSignal;
}

export interface RunAgentResult {
  text: string;
  callCount: number;
}

export async function runAgent(
  opts: RunAgentOptions,
): Promise<RunAgentResult> {
  const {
    messages,
    workspaceRoot = process.cwd(),
    onEvent,
    maxCalls,
    maxDepth,
    mcp,
    summarize,
    onToolApprovalRequest,
    signal,
  } = opts;

  if (!messages?.length) {
    throw new Error("'messages' array required");
  }
  if (!lastUserInput(messages)) {
    throw new Error("Last message must be from the user.");
  }

  const emit = (event: AgentEvent) => onEvent?.(event);
  const log: Logger = (level, msg) =>
    emit({ type: "log", entry: makeLogEntry(level, msg) });
  const onFileChange: FileChangeFn = (path, action) =>
    emit({ type: "file_changed", path, action });

  const mcpEnabled = mcp?.enabled !== false;
  const loadedMcp = mcpEnabled
    ? await loadMcpTools(
        await resolveMcpConfig({
          workspaceRoot,
          configPath: mcp?.configPath,
          extraServers: mcp?.extraServers,
          includeDefaults: mcp?.includeDefaults !== false,
        }),
        log,
      )
    : { tools: [], close: async () => {} };

  const extraTools: unknown[] = [...loadedMcp.tools];

  if (summarize?.enabled !== false) {
    extraTools.push(
      createSummarizeTool({
        getMessages: () => messages,
        model: buildModel(),
        log,
        indent: "",
      }),
    );
  }

  try {
    log("info", `▶ orchestrator received request (workspace=${workspaceRoot})`);
    const projectMemory = await loadProjectMemory(workspaceRoot, log);
    const runState = newRunState(maxCalls, maxDepth);
    const agent = buildAgent({
      systemPrompt: orchestratorPrompt({ projectMemory }),
      log,
      depth: 0,
      state: runState,
      workspaceRoot,
      onFileChange,
      extraTools,
      approver: onToolApprovalRequest,
      abortSignal: signal,
      // Stream tokens from the orchestrator's model only. Sub-agents build a
      // separate model without these callbacks, so their output stays out of
      // the UI's live area.
      onModelStart: () => emit({ type: "token_reset" }),
      onModelToken: (token) => {
        if (token) emit({ type: "token", content: token });
      },
      onModelUsage: (usage) => emit({ type: "usage", usage }),
    });
    const result = await agent.invoke(
      { messages: toLangchainHistory(messages) },
      signal ? { signal } : undefined,
    );
    const finalText = extractText(result.messages.at(-1)) || "";
    log(
      "info",
      `■ orchestrator finished · ${runState.callCount} sub-agent call(s) · ${finalText.length} chars`,
    );
    emit({ type: "done" });
    return { text: finalText, callCount: runState.callCount };
  } catch (err) {
    // Caller cancelled via abort signal — translate to a clean event and
    // return rather than throwing, so the UI doesn't have to special-case
    // it as an error.
    if (signal?.aborted || isAbortError(err)) {
      log("warn", "orchestrator cancelled by user");
      emit({ type: "cancelled" });
      return { text: "", callCount: 0 };
    }
    const message =
      err instanceof Error ? err.message : "Internal error";
    log("error", `orchestrator error: ${message}`);
    emit({ type: "error", message });
    throw err;
  } finally {
    await loadedMcp.close();
  }
}

function isAbortError(err: unknown): boolean {
  if (!err) return false;
  const name = (err as { name?: string }).name;
  if (name === "AbortError") return true;
  const message = (err as { message?: string }).message ?? "";
  return /abort|cancel/i.test(message);
}

// ---------------------------------------------------------------------------
// loadProjectMemory — reads AXON.md from the workspace root if present.
// We accept either the canonical name (AXON.md) or a lowercased fallback
// to be friendly to projects that prefer lowercase filenames. Returns
// undefined if no memory file exists or it's empty.
// ---------------------------------------------------------------------------

async function loadProjectMemory(
  workspaceRoot: string,
  log: Logger,
): Promise<string | undefined> {
  const candidates = ["AXON.md", "axon.md"];
  for (const name of candidates) {
    const full = path.join(workspaceRoot, name);
    try {
      const text = await fs.readFile(full, "utf8");
      const trimmed = text.trim();
      if (!trimmed) continue;
      log("info", `· loaded project memory from ${name} (${trimmed.length} chars)`);
      return trimmed;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        log("warn", `failed to read ${name}: ${(err as Error).message}`);
      }
    }
  }
  return undefined;
}

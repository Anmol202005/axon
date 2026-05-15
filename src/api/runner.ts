import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  AgentEvent,
  ChatMessage,
  FileChangeFn,
  Logger,
  ToolApprover,
} from "./types.js";
import {
  DEFAULT_HARD_CAP,
  DEFAULT_MAX_DEPTH,
  DEFAULT_SOFT_CAP,
  makeLogEntry,
  newRunState,
} from "./types.js";
import type { RoleMap } from "./prompts.js";
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
import { detectProjectType, formatProjectContext } from "./projectType.js";

// ===========================================================================
// runner — programmatic entry point for the CLI
// ===========================================================================

export interface RunAgentOptions {
  messages: ChatMessage[];
  workspaceRoot?: string;
  onEvent?: (event: AgentEvent) => void;
  // Hard ceiling on total sub-agent calls in this run. Acts as a runaway-
  // loop rail; never surfaced to the model. Default: DEFAULT_HARD_CAP (25).
  maxCalls?: number;
  // Maximum delegation depth. Default: DEFAULT_MAX_DEPTH (1) — orchestrator
  // delegates to leaf specialists only. Raise it if you want sub-agents to
  // subcontract.
  maxDepth?: number;
  // Advisory budget surfaced inside the orchestrator's system prompt. Tells
  // the planner roughly how many specialists to expect to spend on a task.
  // Not enforced. Default: DEFAULT_SOFT_CAP (10).
  softCap?: number;
  // Optional per-parent fan-out cap. Each individual agent can spawn at
  // most this many sub-agents. When unset, only the global hardCap
  // applies.
  maxCallsPerAgent?: number;
  // Optional per-depth fan-out caps. Keys are child-depth integers (as
  // numbers or numeric strings, e.g. {1: 10, 2: 6}). Total spawns at each
  // depth across all branches must stay below the configured value.
  maxCallsAtDepth?: Record<number | string, number>;
  // Optional model-name override for sub-agents. Same provider as the
  // orchestrator (no provider override). Lets you run cheap/fast leaves
  // while keeping the heavy model for planning + synthesis.
  subAgentModel?: string;
  // When true, `call_agent` rejects calls without a predefined `role`.
  requireRole?: boolean;
  // Active role registry — typically the built-ins merged with whatever
  // the CLI loaded from .axon/roles/*.md. When omitted, defaults to just
  // the built-ins.
  roles?: RoleMap;
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
  // When true, the agent runs in read-only "plan mode": all mutating tools
  // are blocked by the approver and `exit_plan_mode` is exposed so the agent
  // can present a plan for user approval. The CLI flips this back to false
  // once the user accepts a plan.
  planMode?: boolean;
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
    maxCalls = DEFAULT_HARD_CAP,
    maxDepth = DEFAULT_MAX_DEPTH,
    softCap = DEFAULT_SOFT_CAP,
    maxCallsPerAgent,
    maxCallsAtDepth,
    subAgentModel,
    requireRole,
    roles,
    mcp,
    summarize,
    planMode,
    onToolApprovalRequest,
    signal,
  } = opts;

  // Normalize maxCallsAtDepth keys to numbers so the delegate lookup
  // ({state.maxCallsAtDepth[childDepth]}) works regardless of whether the
  // caller passed numeric or string keys (JSON only carries string keys).
  const normalizedDepthCaps: Record<number, number> | undefined =
    maxCallsAtDepth
      ? Object.fromEntries(
          Object.entries(maxCallsAtDepth).map(([k, v]) => [Number(k), v]),
        )
      : undefined;

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
    const projectInfo = await detectProjectType(workspaceRoot);
    if (projectInfo.kind !== "unknown") {
      log("info", `· detected ${projectInfo.summary}`);
    }
    const projectContext = formatProjectContext(projectInfo);
    const runState = newRunState(maxCalls, maxDepth, {
      maxCallsAtDepth: normalizedDepthCaps,
      maxCallsPerAgent,
    });
    const extras: string[] = [];
    if (maxCallsPerAgent) extras.push(`perAgent=${maxCallsPerAgent}`);
    if (normalizedDepthCaps)
      extras.push(`perDepth=${JSON.stringify(normalizedDepthCaps)}`);
    if (subAgentModel) extras.push(`subAgentModel=${subAgentModel}`);
    if (requireRole) extras.push(`requireRole=true`);
    log(
      "info",
      `· architecture: maxDepth=${maxDepth} · softCap=${softCap} · hardCap=${maxCalls}${extras.length ? " · " + extras.join(" · ") : ""}`,
    );
    const agent = buildAgent({
      systemPrompt: orchestratorPrompt({
        projectMemory,
        projectContext,
        planMode,
        softCap,
        maxDepth,
        roles,
      }),
      log,
      depth: 0,
      state: runState,
      workspaceRoot,
      onFileChange,
      extraTools,
      planMode,
      approver: onToolApprovalRequest,
      abortSignal: signal,
      softCap,
      subAgentModel,
      requireRole,
      roles,
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

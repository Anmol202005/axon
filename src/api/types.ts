// ===========================================================================
// types
// ===========================================================================

export type ChatRole = "user" | "assistant" | "system";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface AgentRequestBody {
  messages: ChatMessage[];
  workspaceRoot?: string;
}

export type LogLevel = "info" | "warn" | "error";

export interface LogEntry {
  t: string;
  level: LogLevel;
  msg: string;
}

export interface TokenUsage {
  input: number;
  output: number;
}

export type AgentEvent =
  | { type: "token"; content: string }
  | { type: "token_reset" }
  | { type: "log"; entry: LogEntry }
  | { type: "file_changed"; path: string; action: "write" | "delete" }
  // Emitted after each model invocation that reports usage. Counts are
  // for that single LLM call (orchestrator or sub-agent); the UI is
  // expected to sum them for per-turn / per-session totals.
  | { type: "usage"; usage: TokenUsage; model?: string }
  | { type: "done" }
  | { type: "cancelled" }
  | { type: "error"; message: string };

export type FileChangeFn = (
  path: string,
  action: "write" | "delete",
) => void;

// ---------------------------------------------------------------------------
// per-tool approval — every tool call (except a small built-in allowlist
// of read-only tools) is gated by a ToolApprover. The CLI uses this to
// prompt the user with allow-once / always-allow / deny.
// ---------------------------------------------------------------------------

export interface ToolApprovalRequest {
  id: string;
  // Tool's canonical name (e.g. "write_file", "run_command", "call_agent",
  // or any MCP tool name). The UI uses this both to display and to scope
  // an "always allow" decision to this tool only.
  toolName: string;
  // Raw arguments the agent passed to the tool. The UI may pretty-print
  // a subset (path, command, etc.) but treat anything in here as untrusted
  // for display purposes.
  args: Record<string, unknown>;
}

export type ToolApprovalDecision =
  // Allow this single invocation.
  | { kind: "allow_once" }
  // Allow this invocation and all future calls of the same tool for the
  // session. Tracked by the UI, not by the wrapper itself.
  | { kind: "always_allow" }
  // Refuse the call. `reason` is surfaced to the agent so it can ask the
  // user how to proceed instead of retrying.
  | { kind: "deny"; reason?: string };

export type ToolApprover = (
  req: ToolApprovalRequest,
) => Promise<ToolApprovalDecision>;

export type Logger = (level: LogLevel, msg: string) => void;

export interface AgentRunState {
  callCount: number;
  // Hard ceiling — the runaway-loop rail enforced in code. Default 25.
  // Never surfaced to the model; it shouldn't plan for it.
  maxCalls: number;
  // Maximum delegation depth. Default 1 — orchestrator → leaf specialists,
  // no further nesting. Sub-agents at the leaf cannot call `call_agent`.
  maxDepth: number;
  // Running count of sub-agent spawns at each depth (key = child depth).
  // Read by the delegate tool to enforce per-depth caps when configured.
  callsAtDepth: Record<number, number>;
  // Optional per-depth caps. Keys are child-depth integers; when a key is
  // present and the matching count has reached it, further spawns at that
  // depth are refused. Sourced from .axon/architecture.json.
  maxCallsAtDepth?: Record<number, number>;
  // Optional per-parent fan-out cap — each individual agent can spawn at
  // most this many sub-agents. Enforced via a closure-local counter in
  // each delegate tool instance; this field is kept on state so the cap
  // value flows everywhere alongside the rest of the architecture knobs.
  maxCallsPerAgent?: number;
}

// Default architecture:
//   - maxDepth = 1 (orchestrator delegates to leaves; no recursion)
//   - softCap  = 10 (advisory budget surfaced in the orchestrator prompt)
//   - maxCalls = 25 (silent hard ceiling — runaway-loop rail)
// Users override these via RunAgentOptions when they want a different shape
// (deeper trees, larger budgets, custom soft caps, etc.).
export const DEFAULT_MAX_DEPTH = 1;
export const DEFAULT_SOFT_CAP = 10;
export const DEFAULT_HARD_CAP = 25;

export function newRunState(
  maxCalls = DEFAULT_HARD_CAP,
  maxDepth = DEFAULT_MAX_DEPTH,
  extra?: {
    maxCallsAtDepth?: Record<number, number>;
    maxCallsPerAgent?: number;
  },
): AgentRunState {
  return {
    callCount: 0,
    maxCalls,
    maxDepth,
    callsAtDepth: {},
    maxCallsAtDepth: extra?.maxCallsAtDepth,
    maxCallsPerAgent: extra?.maxCallsPerAgent,
  };
}

export function nowTimestamp(): string {
  return new Date().toTimeString().slice(0, 8);
}

export function makeLogEntry(level: LogLevel, msg: string): LogEntry {
  return { t: nowTimestamp(), level, msg };
}

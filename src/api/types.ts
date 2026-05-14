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

export type AgentEvent =
  | { type: "token"; content: string }
  | { type: "token_reset" }
  | { type: "log"; entry: LogEntry }
  | { type: "file_changed"; path: string; action: "write" | "delete" }
  | { type: "done" }
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
  maxCalls: number;
  maxDepth: number;
}

export function newRunState(maxCalls = 10, maxDepth = 3): AgentRunState {
  return { callCount: 0, maxCalls, maxDepth };
}

export function nowTimestamp(): string {
  return new Date().toTimeString().slice(0, 8);
}

export function makeLogEntry(level: LogLevel, msg: string): LogEntry {
  return { t: nowTimestamp(), level, msg };
}

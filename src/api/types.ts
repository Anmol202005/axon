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
// write approval — every file-mutating tool consults a WriteApprover (when
// one is supplied) before touching disk. The CLI uses this to show a diff
// preview and capture an apply / reject / edit decision from the user.
// ---------------------------------------------------------------------------

export type WriteAction = "write" | "delete";

export interface WriteRequest {
  id: string;
  path: string;
  action: WriteAction;
  // Existing file contents, if any. Undefined for brand-new files.
  oldContent: string | undefined;
  // Proposed contents. Undefined for deletes.
  newContent: string | undefined;
}

export type WriteDecision =
  // Apply the write. `content` lets the approver substitute edited bytes
  // (used by the CLI's "edit in $EDITOR" flow). Ignored for deletes.
  | { kind: "apply"; content?: string }
  // Skip the write. `reason` is surfaced to the agent as the tool result so
  // it can react (e.g. ask the user what to change).
  | { kind: "reject"; reason?: string };

export type WriteApprover = (req: WriteRequest) => Promise<WriteDecision>;

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

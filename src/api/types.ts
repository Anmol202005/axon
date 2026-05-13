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

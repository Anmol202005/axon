// ===========================================================================
// mcp types
// ===========================================================================

export interface StdioMcpServer {
  transport?: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface HttpMcpServer {
  transport: "streamable_http" | "sse";
  url: string;
  headers?: Record<string, string>;
}

export type McpServerConfig = StdioMcpServer | HttpMcpServer;

export interface McpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

export function isStdio(s: McpServerConfig): s is StdioMcpServer {
  return (s as StdioMcpServer).command !== undefined;
}

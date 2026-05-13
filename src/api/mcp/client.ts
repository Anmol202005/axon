import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import type { Logger } from "../types.js";
import { isStdio, type McpConfig } from "./types.js";

// ===========================================================================
// mcp client — loads tools from configured MCP servers
// ===========================================================================

export interface LoadedMcp {
  tools: unknown[];
  close: () => Promise<void>;
}

const EMPTY_MCP: LoadedMcp = {
  tools: [],
  close: async () => {},
};

export async function loadMcpTools(
  config: McpConfig,
  log?: Logger,
): Promise<LoadedMcp> {
  const servers = config.mcpServers ?? {};
  const names = Object.keys(servers);
  if (names.length === 0) return EMPTY_MCP;

  const adapted: Record<string, Record<string, unknown>> = {};
  for (const [name, server] of Object.entries(servers)) {
    if (isStdio(server)) {
      adapted[name] = {
        transport: "stdio",
        command: server.command,
        args: server.args ?? [],
        env: server.env,
        cwd: server.cwd,
      };
    } else {
      adapted[name] = {
        transport: server.transport,
        url: server.url,
        headers: server.headers,
      };
    }
  }

  const client = new MultiServerMCPClient({
    throwOnLoadError: false,
    prefixToolNameWithServerName: true,
    additionalToolNamePrefix: "mcp",
    mcpServers: adapted as never,
  });

  try {
    const tools = await client.getTools();
    log?.(
      "info",
      `mcp: loaded ${tools.length} tool(s) from ${names.length} server(s) [${names.join(", ")}]`,
    );
    return {
      tools,
      close: async () => {
        try {
          await client.close();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log?.("warn", `mcp: error closing client: ${msg}`);
        }
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log?.("error", `mcp: failed to load tools: ${msg}`);
    try {
      await client.close();
    } catch {
      // ignore
    }
    return EMPTY_MCP;
  }
}

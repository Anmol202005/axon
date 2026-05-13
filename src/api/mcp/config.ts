import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { McpConfig, McpServerConfig } from "./types.js";

// ===========================================================================
// mcp config — defaults, user file, merge
// ===========================================================================

// Default servers bundled with the agent. Empty by default; populate here to
// give every user a baseline set of MCP tools out of the box.
//
// Example:
//   filesystem: {
//     command: "npx",
//     args: ["-y", "@modelcontextprotocol/server-filesystem", process.cwd()],
//   }
export const DEFAULT_MCP_SERVERS: Record<string, McpServerConfig> = {};

export function defaultMcpConfig(): McpConfig {
  return { mcpServers: { ...DEFAULT_MCP_SERVERS } };
}

// Tried in order. First file that parses wins.
export function userMcpConfigCandidates(workspaceRoot: string): string[] {
  return [
    path.join(workspaceRoot, ".forge", "mcp.json"),
    path.join(os.homedir(), ".forge", "mcp.json"),
  ];
}

export async function loadUserMcpConfig(
  workspaceRoot: string,
  explicitPath?: string,
): Promise<McpConfig> {
  const candidates = explicitPath
    ? [explicitPath]
    : userMcpConfigCandidates(workspaceRoot);

  for (const file of candidates) {
    try {
      const raw = await fs.readFile(file, "utf8");
      const parsed = JSON.parse(raw) as Partial<McpConfig>;
      if (parsed && typeof parsed === "object") {
        return { mcpServers: parsed.mcpServers ?? {} };
      }
    } catch {
      // try next candidate
    }
  }
  return { mcpServers: {} };
}

export function mergeMcpConfig(...configs: McpConfig[]): McpConfig {
  const merged: Record<string, McpServerConfig> = {};
  for (const c of configs) {
    for (const [name, server] of Object.entries(c.mcpServers ?? {})) {
      merged[name] = server;
    }
  }
  return { mcpServers: merged };
}

export async function resolveMcpConfig(opts: {
  workspaceRoot: string;
  configPath?: string;
  extraServers?: Record<string, McpServerConfig>;
  includeDefaults?: boolean;
}): Promise<McpConfig> {
  const {
    workspaceRoot,
    configPath,
    extraServers = {},
    includeDefaults = true,
  } = opts;

  const layers: McpConfig[] = [];
  if (includeDefaults) layers.push(defaultMcpConfig());
  layers.push(await loadUserMcpConfig(workspaceRoot, configPath));
  layers.push({ mcpServers: extraServers });
  return mergeMcpConfig(...layers);
}

import { promises as fs } from "node:fs";
import path from "node:path";

// ===========================================================================
// architecture — per-project agent-shape config at .axon/architecture.json
//
// Controls the delegation tree the orchestrator builds: how deep, how wide,
// which model leaf agents use, whether predefined roles are mandatory, etc.
//
// Every field is optional. A missing or invalid file falls back to the
// default architecture (maxDepth=1, softCap=10, hardCap=25, no per-parent
// or per-depth caps, no model override, role not required). Default
// behavior is intentionally NOT changed by introducing this file — it has
// to be edited to do anything.
// ===========================================================================

import { SUB_AGENT_ROLES, type SubAgentRole } from "../api/agent.js";

const ARCH_DIR = ".axon";
const ARCH_FILE = "architecture.json";
const ARCH_VERSION = 1;

export const ARCH_DEFAULTS = {
  maxDepth: 1,
  softCap: 10,
  hardCap: 25,
} as const;

export interface ArchitectureConfig {
  v: number;
  // Max delegation depth. 1 = orchestrator → leaves only.
  maxDepth: number;
  // Advisory budget surfaced in the orchestrator's system prompt.
  softCap: number;
  // Silent hard ceiling on total sub-agent calls. Runaway-loop rail.
  hardCap: number;
  // Optional: per-parent fan-out cap. Each individual agent can only spawn
  // this many sub-agents. Different from `softCap` (which is global). When
  // unset, only the global caps apply.
  maxCallsPerAgent?: number;
  // Optional: per-depth fan-out caps. Keys are depth numbers as strings
  // (e.g. {"1": 10, "2": 6}). The depth a sub-agent is spawned AT is
  // checked against this map — total spawns at that depth across all
  // branches must stay below the cap. When unset, only the global cap
  // applies.
  maxCallsAtDepth?: Record<string, number>;
  // Optional: model name override for sub-agents. The orchestrator still
  // uses the model from the active BYOK config; sub-agents get this one.
  // Same provider (no provider override). Lets you put a cheap fast model
  // on the leaves while keeping the heavy model for planning + synthesis.
  subAgentModel?: string;
  // When true, `call_agent` rejects calls without a predefined `role`. The
  // orchestrator must pick from SUB_AGENT_ROLES — custom systemPrompts are
  // forbidden. Useful for projects that want consistent specialist
  // behavior. Default false.
  requireRole?: boolean;
}

export function architectureDefaults(): ArchitectureConfig {
  return {
    v: ARCH_VERSION,
    maxDepth: ARCH_DEFAULTS.maxDepth,
    softCap: ARCH_DEFAULTS.softCap,
    hardCap: ARCH_DEFAULTS.hardCap,
  };
}

function architecturePath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ARCH_DIR, ARCH_FILE);
}

export function architectureFile(workspaceRoot: string): string {
  return architecturePath(workspaceRoot);
}

// ---------------------------------------------------------------------------
// loadArchitecture — read .axon/architecture.json if present. Returns the
// defaults on any read/parse failure rather than throwing, so the CLI
// keeps working with a malformed file (the user gets a notice via the
// caller, not a crash).
// ---------------------------------------------------------------------------
export interface LoadArchitectureResult {
  config: ArchitectureConfig;
  // Set when a file existed but couldn't be parsed; caller can surface it.
  warning?: string;
  // True if the file exists on disk (regardless of validity).
  fileExists: boolean;
}

export async function loadArchitecture(
  workspaceRoot: string,
): Promise<LoadArchitectureResult> {
  const file = architecturePath(workspaceRoot);
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { config: architectureDefaults(), fileExists: false };
    }
    return {
      config: architectureDefaults(),
      warning: `could not read ${file}: ${(err as Error).message}`,
      fileExists: false,
    };
  }
  try {
    const parsed = JSON.parse(text) as Partial<ArchitectureConfig>;
    const merged = sanitize(parsed);
    return { config: merged, fileExists: true };
  } catch (err) {
    return {
      config: architectureDefaults(),
      warning: `${file} is invalid JSON — using defaults. (${(err as Error).message})`,
      fileExists: true,
    };
  }
}

// sanitize — coerce a parsed JSON blob into a valid ArchitectureConfig.
// Out-of-range / wrong-type fields fall back to defaults silently. This is
// deliberately tolerant — the file is hand-edited and we don't want to
// brick the agent over a typo.
function sanitize(input: Partial<ArchitectureConfig>): ArchitectureConfig {
  const out = architectureDefaults();
  if (typeof input.maxDepth === "number" && input.maxDepth >= 0) {
    out.maxDepth = Math.floor(input.maxDepth);
  }
  if (typeof input.softCap === "number" && input.softCap >= 0) {
    out.softCap = Math.floor(input.softCap);
  }
  if (typeof input.hardCap === "number" && input.hardCap >= 0) {
    out.hardCap = Math.floor(input.hardCap);
  }
  // The hard cap should never be lower than the soft cap — if a user
  // accidentally inverts them, raise the hard cap silently so spawns can
  // still happen up to the soft target.
  if (out.hardCap < out.softCap) out.hardCap = out.softCap;
  if (
    typeof input.maxCallsPerAgent === "number" &&
    input.maxCallsPerAgent > 0
  ) {
    out.maxCallsPerAgent = Math.floor(input.maxCallsPerAgent);
  }
  if (
    input.maxCallsAtDepth &&
    typeof input.maxCallsAtDepth === "object" &&
    !Array.isArray(input.maxCallsAtDepth)
  ) {
    const map: Record<string, number> = {};
    for (const [k, v] of Object.entries(input.maxCallsAtDepth)) {
      const depth = Number(k);
      if (Number.isInteger(depth) && depth >= 1 && typeof v === "number" && v >= 0) {
        map[String(depth)] = Math.floor(v);
      }
    }
    if (Object.keys(map).length > 0) out.maxCallsAtDepth = map;
  }
  if (typeof input.subAgentModel === "string" && input.subAgentModel.trim()) {
    out.subAgentModel = input.subAgentModel.trim();
  }
  if (typeof input.requireRole === "boolean") {
    out.requireRole = input.requireRole;
  }
  return out;
}

// ---------------------------------------------------------------------------
// saveArchitecture — write the file, creating .axon/ if needed.
// ---------------------------------------------------------------------------
export async function saveArchitecture(
  workspaceRoot: string,
  cfg: ArchitectureConfig,
): Promise<void> {
  const file = architecturePath(workspaceRoot);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const out: ArchitectureConfig = { ...sanitize(cfg), v: ARCH_VERSION };
  await fs.writeFile(file, JSON.stringify(out, null, 2) + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// writeDefaultArchitectureFile — create a starter file at the architecture
// path with every knob present (using current defaults) so the user has a
// concrete template to edit. Used by the `/architecture init` command.
// ---------------------------------------------------------------------------
export async function writeDefaultArchitectureFile(
  workspaceRoot: string,
): Promise<string> {
  const file = architecturePath(workspaceRoot);
  await fs.mkdir(path.dirname(file), { recursive: true });
  // Use plain `unknown`-shaped object so the JSON renders with explicit
  // null slots for the optional knobs — gives the user a visible template
  // to fill in. sanitize() drops nulls on load so this is safe.
  const template: Record<string, unknown> = {
    v: ARCH_VERSION,
    maxDepth: ARCH_DEFAULTS.maxDepth,
    softCap: ARCH_DEFAULTS.softCap,
    hardCap: ARCH_DEFAULTS.hardCap,
    maxCallsPerAgent: null,
    maxCallsAtDepth: null,
    subAgentModel: null,
    requireRole: false,
  };
  await fs.writeFile(
    file,
    JSON.stringify(template, null, 2) + "\n",
    "utf8",
  );
  return file;
}

// ---------------------------------------------------------------------------
// formatArchitecture — render the config for the `/architecture` slash
// command. Includes the file path so the user knows where to edit.
// ---------------------------------------------------------------------------
export function formatArchitecture(
  cfg: ArchitectureConfig,
  workspaceRoot: string,
  fileExists: boolean,
): string {
  const lines: string[] = [];
  lines.push(
    `architecture (${fileExists ? architecturePath(workspaceRoot) : "defaults — no file yet"})`,
  );
  lines.push(`  maxDepth          ${cfg.maxDepth}`);
  lines.push(`  softCap           ${cfg.softCap}  (advisory budget in prompt)`);
  lines.push(`  hardCap           ${cfg.hardCap}  (silent runaway-loop rail)`);
  lines.push(
    `  maxCallsPerAgent  ${cfg.maxCallsPerAgent ?? "—"}  (per-parent fan-out)`,
  );
  lines.push(
    `  maxCallsAtDepth   ${cfg.maxCallsAtDepth ? JSON.stringify(cfg.maxCallsAtDepth) : "—"}  (per-depth fan-out)`,
  );
  lines.push(
    `  subAgentModel     ${cfg.subAgentModel ?? "—"}  (leaf model override)`,
  );
  lines.push(
    `  requireRole       ${cfg.requireRole ? "true" : "false"}  (force one of: ${SUB_AGENT_ROLES.join(", ")})`,
  );
  if (!fileExists) {
    lines.push("");
    lines.push(
      "  no .axon/architecture.json yet — run `/architecture init` to write a starter file.",
    );
  }
  return lines.join("\n");
}

// Type guard re-export so callers don't have to import from agent.js
export type { SubAgentRole };

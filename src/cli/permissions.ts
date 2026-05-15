import { promises as fs } from "node:fs";
import path from "node:path";

// ===========================================================================
// per-project permissions — persisted allow/deny lists at .axon/permissions.json
// ===========================================================================
//
// Stored relative to the workspace root so it lives with the project (and can
// be checked into git or .gitignore'd, the user's choice). Format is a
// version-tagged JSON object; missing files or invalid contents fall back to
// empty lists rather than crashing the CLI.

const PERMS_DIR = ".axon";
const PERMS_FILE = "permissions.json";
const PERMS_VERSION = 1;

export interface ProjectPermissions {
  v: number;
  // Tool names the user has authorized for all calls in this project. The
  // approver short-circuits these to allow_once without prompting.
  allowed: string[];
  // Tool names the user has blocklisted. The approver auto-denies with a
  // stock reason. Used for noisy or expensive tools the agent keeps trying.
  denied: string[];
  updatedAt?: string;
}

export function emptyPermissions(): ProjectPermissions {
  return { v: PERMS_VERSION, allowed: [], denied: [] };
}

function permissionsPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, PERMS_DIR, PERMS_FILE);
}

// ---------------------------------------------------------------------------
// loadPermissions — read .axon/permissions.json if present. Returns an empty
// (but valid) object on any read/parse failure so the CLI keeps working.
// ---------------------------------------------------------------------------
export async function loadPermissions(
  workspaceRoot: string,
): Promise<ProjectPermissions> {
  try {
    const text = await fs.readFile(permissionsPath(workspaceRoot), "utf8");
    const parsed = JSON.parse(text) as Partial<ProjectPermissions>;
    return {
      v: PERMS_VERSION,
      allowed: Array.isArray(parsed.allowed)
        ? parsed.allowed.filter((s): s is string => typeof s === "string")
        : [],
      denied: Array.isArray(parsed.denied)
        ? parsed.denied.filter((s): s is string => typeof s === "string")
        : [],
      updatedAt: parsed.updatedAt,
    };
  } catch {
    return emptyPermissions();
  }
}

// ---------------------------------------------------------------------------
// savePermissions — write the file, creating .axon/ if needed. Errors bubble
// up so the caller can decide whether to surface them (we surface in the
// activity line).
// ---------------------------------------------------------------------------
export async function savePermissions(
  workspaceRoot: string,
  perms: ProjectPermissions,
): Promise<void> {
  const file = permissionsPath(workspaceRoot);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const out: ProjectPermissions = {
    v: PERMS_VERSION,
    allowed: dedupe(perms.allowed),
    denied: dedupe(perms.denied),
    updatedAt: new Date().toISOString(),
  };
  await fs.writeFile(file, JSON.stringify(out, null, 2) + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// Mutation helpers — keep callers terse. Each returns a new permissions
// object; the caller persists.
// ---------------------------------------------------------------------------

export function addAllowed(
  perms: ProjectPermissions,
  toolName: string,
): ProjectPermissions {
  if (perms.allowed.includes(toolName)) return perms;
  return {
    ...perms,
    allowed: [...perms.allowed, toolName],
    denied: perms.denied.filter((t) => t !== toolName),
  };
}

export function addDenied(
  perms: ProjectPermissions,
  toolName: string,
): ProjectPermissions {
  if (perms.denied.includes(toolName)) return perms;
  return {
    ...perms,
    denied: [...perms.denied, toolName],
    allowed: perms.allowed.filter((t) => t !== toolName),
  };
}

export function removeEntry(
  perms: ProjectPermissions,
  toolName: string,
): ProjectPermissions {
  return {
    ...perms,
    allowed: perms.allowed.filter((t) => t !== toolName),
    denied: perms.denied.filter((t) => t !== toolName),
  };
}

function dedupe(xs: string[]): string[] {
  return Array.from(new Set(xs.filter(Boolean)));
}

export function formatPermissions(perms: ProjectPermissions): string {
  const allowed =
    perms.allowed.length > 0 ? perms.allowed.join(", ") : "(none)";
  const denied =
    perms.denied.length > 0 ? perms.denied.join(", ") : "(none)";
  return `allowed: ${allowed}\ndenied:  ${denied}`;
}

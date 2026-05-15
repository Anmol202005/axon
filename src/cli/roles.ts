import { promises as fs } from "node:fs";
import path from "node:path";
import {
  BUILTIN_ROLE_NAMES,
  BUILTIN_ROLE_PROMPTS,
  BUILTIN_ROLE_DESCRIPTIONS,
  type RoleDefinition,
  type RoleMap,
} from "../api/agent.js";

// ===========================================================================
// role registry — built-in plus user-defined sub-agent roles
// ---------------------------------------------------------------------------
// Loads role definitions from <workspace>/.axon/roles/*.md and
// ~/.axon/roles/*.md (personal). Workspace roles override personal ones,
// and either can override a built-in role of the same name. New files add
// new roles to the `call_agent` schema enum.
//
// File format — markdown with optional YAML-ish frontmatter:
//
//   ---
//   description: One-line description shown in the orchestrator's role catalog
//   ---
//   You are a SECURITY-AUDITOR specialist. ...
//   Rules:
//   - ...
//   Return format:
//   - ...
//
// The file body becomes the sub-agent's system prompt verbatim. The
// filename (minus .md) is the role identifier the orchestrator passes to
// `call_agent({ role: "<name>", prompt: "..." })`.
// ===========================================================================

const ROLES_DIR = ".axon/roles";

// Role names must be lowercase identifier-like so they fit Zod's enum and
// are safe to type into the call_agent schema.
const NAME_RE = /^[a-z][a-z0-9_-]*$/;

export interface LoadRolesResult {
  // Final merged role map (built-ins + custom overrides).
  roles: RoleMap;
  // Subset that came from user files (workspace or personal). Useful for
  // the /roles slash command to show what was loaded from disk.
  custom: RoleDefinition[];
  // Names of files that were skipped (invalid name, parse failure, etc.).
  warnings: string[];
}

export async function loadRoles(
  workspaceRoot: string,
): Promise<LoadRolesResult> {
  const merged = builtinRoleMap();
  const customList: RoleDefinition[] = [];
  const warnings: string[] = [];

  // Personal roles first, then workspace — workspace wins on collision.
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home) {
    await loadFromDir(path.join(home, ROLES_DIR), merged, customList, warnings);
  }
  await loadFromDir(
    path.join(workspaceRoot, ROLES_DIR),
    merged,
    customList,
    warnings,
  );
  return { roles: merged, custom: customList, warnings };
}

async function loadFromDir(
  dir: string,
  into: RoleMap,
  customList: RoleDefinition[],
  warnings: string[],
): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    warnings.push(`could not read ${dir}: ${(err as Error).message}`);
    return;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const name = entry.slice(0, -3).toLowerCase();
    if (!NAME_RE.test(name)) {
      warnings.push(
        `skipped ${entry}: name must be lowercase identifier (a-z, 0-9, -, _)`,
      );
      continue;
    }
    const full = path.join(dir, entry);
    let raw: string;
    try {
      raw = await fs.readFile(full, "utf8");
    } catch (err) {
      warnings.push(`could not read ${full}: ${(err as Error).message}`);
      continue;
    }
    const parsed = parseRoleFile(raw);
    if (!parsed.body.trim()) {
      warnings.push(`skipped ${full}: empty body (the system prompt is missing)`);
      continue;
    }
    // De-dupe customList by name so a workspace file replaces an earlier
    // personal entry rather than appearing twice.
    const existingIdx = customList.findIndex((d) => d.name === name);
    const def: RoleDefinition = {
      name,
      description:
        parsed.description ||
        ((BUILTIN_ROLE_DESCRIPTIONS as Record<string, string>)[name] ??
          `Custom role from ${entry}`),
      systemPrompt: parsed.body.trim(),
      source: full,
    };
    if (existingIdx >= 0) customList[existingIdx] = def;
    else customList.push(def);
    into.set(name, def);
  }
}

interface ParsedFile {
  description?: string;
  body: string;
}

// Forgiving YAML-ish frontmatter (key: value lines only) — same shape as
// the slash-command loader so users only have to learn one format.
function parseRoleFile(raw: string): ParsedFile {
  let body = raw;
  let description: string | undefined;
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fmMatch) {
    body = raw.slice(fmMatch[0].length);
    for (const line of fmMatch[1].split("\n")) {
      const m = line.match(/^([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.*)$/);
      if (!m) continue;
      const key = m[1].toLowerCase();
      const value = m[2].trim().replace(/^['"]|['"]$/g, "");
      if (key === "description") description = value;
    }
  }
  return { description, body };
}

// ---------------------------------------------------------------------------
// builtinRoleMap — fresh map seeded from the static built-ins. Callers
// mutate this to merge custom roles in; the source of truth in
// src/api/prompts.ts is untouched.
// ---------------------------------------------------------------------------
export function builtinRoleMap(): RoleMap {
  const map: RoleMap = new Map();
  for (const name of BUILTIN_ROLE_NAMES) {
    map.set(name, {
      name,
      description: BUILTIN_ROLE_DESCRIPTIONS[name],
      systemPrompt: BUILTIN_ROLE_PROMPTS[name],
      source: "builtin",
    });
  }
  return map;
}

// ---------------------------------------------------------------------------
// writeBuiltinRoleFiles — write every built-in role's prompt to
// .axon/roles/<name>.md so the user has a starting point to edit. Skips
// any file that already exists (so /roles init is idempotent and doesn't
// clobber edits the user made earlier).
// ---------------------------------------------------------------------------
export async function writeBuiltinRoleFiles(
  workspaceRoot: string,
): Promise<{ written: string[]; skipped: string[] }> {
  const dir = path.join(workspaceRoot, ROLES_DIR);
  await fs.mkdir(dir, { recursive: true });
  const written: string[] = [];
  const skipped: string[] = [];
  for (const name of BUILTIN_ROLE_NAMES) {
    const file = path.join(dir, `${name}.md`);
    try {
      await fs.access(file);
      skipped.push(file);
      continue;
    } catch {
      // file does not exist — go ahead and write
    }
    const description = BUILTIN_ROLE_DESCRIPTIONS[name];
    const body = BUILTIN_ROLE_PROMPTS[name];
    const content = `---\ndescription: ${description}\n---\n${body}\n`;
    await fs.writeFile(file, content, "utf8");
    written.push(file);
  }
  return { written, skipped };
}

export function rolesDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, ROLES_DIR);
}

// ---------------------------------------------------------------------------
// formatRoles — render the active role registry for the /roles slash
// command. Marks each row as builtin / overridden / custom.
// ---------------------------------------------------------------------------
export function formatRoles(
  roles: RoleMap,
  workspaceRoot: string,
): string {
  const builtinSet = new Set<string>(BUILTIN_ROLE_NAMES);
  const lines: string[] = [];
  lines.push(`roles directory: ${rolesDir(workspaceRoot)}`);
  lines.push("");
  for (const def of roles.values()) {
    let tag: string;
    if (def.source === "builtin") {
      tag = "[builtin]";
    } else if (builtinSet.has(def.name)) {
      tag = "[override]";
    } else {
      tag = "[custom]  ";
    }
    lines.push(`  ${tag} ${def.name}`);
    lines.push(`             ${def.description}`);
    if (def.source !== "builtin") lines.push(`             ${def.source}`);
  }
  lines.push("");
  lines.push(
    "drop *.md files into .axon/roles/ to override built-ins or add new roles.",
  );
  lines.push(
    "run /roles init to scaffold the five built-in role files for editing.",
  );
  return lines.join("\n");
}

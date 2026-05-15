import { promises as fs } from "node:fs";
import path from "node:path";

// ===========================================================================
// custom slash-command registry
// ---------------------------------------------------------------------------
// Loads user-defined slash commands from <workspace>/.axon/commands/*.md
// (and also from ~/.axon/commands/*.md so users can keep personal commands
// outside of any single project). Each file defines one command: the file
// name (minus .md) becomes the verb, and the body becomes the prompt
// template that the agent sees as the user message.
//
// File format — markdown with optional YAML-ish frontmatter:
//
//   ---
//   description: Summarize the working tree
//   args: optional free-form usage hint shown in /help
//   ---
//   You're reviewing the working tree. $ARGS
//   Focus on: $1
//
// Substitutions:
//   $ARGS     — everything the user typed after the command name
//   $1..$9    — individual whitespace-separated args
//   $WORKSPACE — the workspace root absolute path
//
// Built-in command names (clear, help, sessions, etc.) take precedence over
// custom ones. We log a warning rather than overriding them.
// ===========================================================================

const COMMANDS_DIR = ".axon/commands";

export interface CustomCommand {
  name: string;
  description: string;
  argsHint?: string;
  // Absolute path the command was loaded from — useful for error messages
  // and for the /commands list.
  source: string;
  // Raw template body with $-placeholders intact.
  template: string;
}

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

const RESERVED_NAMES = new Set<string>([
  "help",
  "exit",
  "quit",
  "clear",
  "sessions",
  "resume",
  "forget",
  "plan",
  "permissions",
  "perms",
  "commands",
  "export",
  "reload",
]);

export async function loadCustomCommands(
  workspaceRoot: string,
): Promise<Map<string, CustomCommand>> {
  const out = new Map<string, CustomCommand>();
  // Workspace commands override personal ones with the same name — load
  // personal first so the workspace pass clobbers them on collision.
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home) {
    await loadFromDir(path.join(home, COMMANDS_DIR), out);
  }
  await loadFromDir(path.join(workspaceRoot, COMMANDS_DIR), out);
  return out;
}

async function loadFromDir(
  dir: string,
  into: Map<string, CustomCommand>,
): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const name = entry.slice(0, -3).toLowerCase();
    if (!NAME_RE.test(name)) continue;
    if (RESERVED_NAMES.has(name)) continue;
    const full = path.join(dir, entry);
    let raw: string;
    try {
      raw = await fs.readFile(full, "utf8");
    } catch {
      continue;
    }
    const parsed = parseCommandFile(raw);
    into.set(name, {
      name,
      description: parsed.description || `Custom command from ${entry}`,
      argsHint: parsed.argsHint,
      source: full,
      template: parsed.body,
    });
  }
}

interface ParsedFile {
  description?: string;
  argsHint?: string;
  body: string;
}

// Very small, forgiving frontmatter parser — only `key: value` lines, no
// nested structures. Anything we don't recognize gets dropped silently.
function parseCommandFile(raw: string): ParsedFile {
  let body = raw;
  let description: string | undefined;
  let argsHint: string | undefined;
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fmMatch) {
    body = raw.slice(fmMatch[0].length);
    for (const line of fmMatch[1].split("\n")) {
      const m = line.match(/^([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.*)$/);
      if (!m) continue;
      const key = m[1].toLowerCase();
      const value = m[2].trim().replace(/^['"]|['"]$/g, "");
      if (key === "description") description = value;
      else if (key === "args" || key === "usage") argsHint = value;
    }
  }
  return { description, argsHint, body: body.trim() };
}

// ---------------------------------------------------------------------------
// substituteArgs — fill $ARGS / $1..$9 / $WORKSPACE in a template body. We
// keep this dumb on purpose: no escaping, no conditionals. Unknown $TOKENs
// are left in place so users notice typos.
// ---------------------------------------------------------------------------

export interface SubstituteContext {
  args: string;
  workspaceRoot: string;
}

export function substituteArgs(
  template: string,
  ctx: SubstituteContext,
): string {
  const parts = ctx.args.length === 0 ? [] : ctx.args.split(/\s+/);
  return template
    .replace(/\$ARGS\b/g, ctx.args)
    .replace(/\$WORKSPACE\b/g, ctx.workspaceRoot)
    .replace(/\$([1-9])\b/g, (_m, d: string) => {
      const idx = Number(d) - 1;
      return parts[idx] ?? "";
    });
}

// ---------------------------------------------------------------------------
// formatCommandList — render a /commands listing.
// ---------------------------------------------------------------------------

export function formatCommandList(
  commands: Map<string, CustomCommand>,
): string {
  if (commands.size === 0) {
    return "no custom commands. drop *.md files into .axon/commands/ to add them.";
  }
  const rows: string[] = [];
  for (const cmd of commands.values()) {
    const usage = cmd.argsHint ? ` ${cmd.argsHint}` : "";
    rows.push(`  /${cmd.name}${usage}\n      ${cmd.description}`);
  }
  return `custom commands:\n${rows.join("\n")}`;
}

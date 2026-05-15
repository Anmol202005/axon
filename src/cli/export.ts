import { promises as fs } from "node:fs";
import path from "node:path";
import type { SessionSnapshot } from "./persistence.js";

// ===========================================================================
// export — write a session transcript to markdown or JSON.
//
// Default destination is <workspace>/.axon/exports/<session-id>.<ext>, but
// callers can pass an explicit path (absolute or workspace-relative). We
// refuse to overwrite an existing file unless `overwrite: true` is passed,
// so the user doesn't lose an earlier export by accident.
// ===========================================================================

export type ExportFormat = "md" | "json";

export interface ExportOptions {
  snapshot: SessionSnapshot;
  format: ExportFormat;
  workspaceRoot: string;
  // Either an absolute path or workspace-relative. If omitted we pick a
  // sensible default under .axon/exports/.
  destPath?: string;
  overwrite?: boolean;
}

export interface ExportResult {
  path: string;
  bytes: number;
  format: ExportFormat;
}

export async function exportSession(
  opts: ExportOptions,
): Promise<ExportResult> {
  const { snapshot, format, workspaceRoot, overwrite } = opts;
  const dest = resolveDest(opts);
  const data = format === "md" ? toMarkdown(snapshot) : toJson(snapshot);

  await fs.mkdir(path.dirname(dest), { recursive: true });

  // Refuse to clobber unless asked. Cheap stat-then-write is racy in theory
  // but we're only protecting against the user's own foot — not adversarial
  // concurrent writers.
  if (!overwrite) {
    try {
      await fs.access(dest);
      throw new Error(
        `refuse to overwrite ${path.relative(workspaceRoot, dest) || dest}. pass an explicit path or delete the existing file.`,
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  await fs.writeFile(dest, data, "utf8");
  return {
    path: dest,
    bytes: Buffer.byteLength(data, "utf8"),
    format,
  };
}

function resolveDest(opts: ExportOptions): string {
  const { snapshot, format, workspaceRoot, destPath } = opts;
  if (destPath) {
    const expanded = expandHome(destPath);
    return path.isAbsolute(expanded)
      ? expanded
      : path.resolve(workspaceRoot, expanded);
  }
  return path.join(
    workspaceRoot,
    ".axon",
    "exports",
    `${snapshot.id}.${format}`,
  );
}

function expandHome(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    const home = process.env.HOME || process.env.USERPROFILE;
    if (home) return path.join(home, p.slice(1));
  }
  return p;
}

// ---------------------------------------------------------------------------
// formatters
// ---------------------------------------------------------------------------

function toJson(snap: SessionSnapshot): string {
  // Re-emit the snapshot with a richer wrapper so it's self-describing.
  // Anyone consuming this externally only needs to look at `v` to know
  // they got the structure they expect.
  const payload = {
    v: 1,
    kind: "axon.session.transcript",
    exportedAt: new Date().toISOString(),
    session: snap,
  };
  return JSON.stringify(payload, null, 2) + "\n";
}

function toMarkdown(snap: SessionSnapshot): string {
  const header: string[] = [
    `# ${snap.title || `axon session ${snap.id}`}`,
    "",
    `- **id**: \`${snap.id}\``,
    `- **workspace**: \`${snap.workspaceRoot}\``,
    `- **created**: ${snap.createdAt}`,
    `- **updated**: ${snap.updatedAt}`,
    `- **turns**: ${snap.items.filter((i) => i.role !== "system").length}`,
    `- **usage**: ${snap.sessionUsage.input}↑ ${snap.sessionUsage.output}↓`,
  ];
  if (snap.alwaysAllowed.length > 0) {
    header.push(`- **always-allowed**: ${snap.alwaysAllowed.join(", ")}`);
  }
  if (snap.summary) {
    header.push("", "## Compacted prior context", "", snap.summary);
  }
  header.push("", "---", "");

  const body: string[] = [];
  for (const item of snap.items) {
    if (item.role === "user") {
      body.push("### User", "", item.content, "");
    } else if (item.role === "assistant") {
      body.push("### Assistant", "", item.content, "");
    } else {
      // System messages are session markers (resume, plan-mode flips,
      // compaction notes). Emit them as blockquotes so they stand apart
      // from the conversation proper.
      body.push("> _" + escapeBlockquote(item.content) + "_", "");
    }
  }

  return header.concat(body).join("\n").trimEnd() + "\n";
}

function escapeBlockquote(text: string): string {
  return text.replace(/\n/g, " ").replace(/_/g, "\\_");
}

// ---------------------------------------------------------------------------
// parseFormat — accept `md`, `markdown`, `json`. Returns undefined for the
// caller to report `usage:`.
// ---------------------------------------------------------------------------

export function parseFormat(input?: string): ExportFormat | undefined {
  if (!input) return undefined;
  const v = input.toLowerCase();
  if (v === "md" || v === "markdown") return "md";
  if (v === "json") return "json";
  return undefined;
}

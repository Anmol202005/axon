import { promises as fs } from "node:fs";
import path from "node:path";
import { tool } from "langchain";
import { z } from "zod";
import type { FileChangeFn, Logger } from "../types.js";

// ===========================================================================
// file tools (local filesystem, rooted at workspaceRoot)
// ===========================================================================

export function safeJoin(workspaceRoot: string, relative: string): string {
  const root = path.resolve(workspaceRoot);
  const resolved = path.resolve(root, relative);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Path '${relative}' escapes workspace root`);
  }
  return resolved;
}

export function createFileTools(
  workspaceRoot: string,
  log: Logger | undefined,
  onFileChange: FileChangeFn | undefined,
  indent: string,
) {
  // Tracks workspace-relative paths the agent has observed in this session
  // (via read_file, or by having just written them). write_file refuses to
  // overwrite an existing file that isn't in this set unless the caller
  // explicitly passes overwrite=true — this stops a "create hello.txt"
  // request from clobbering a pre-existing hello.txt the agent never read.
  const observedFiles = new Set<string>();
  const markObserved = (relPath: string) =>
    observedFiles.add(path.normalize(relPath));
  const hasObserved = (relPath: string) =>
    observedFiles.has(path.normalize(relPath));

  const writeFile = tool(
    async ({ path: relPath, content, overwrite }) => {
      const absolute = safeJoin(workspaceRoot, relPath);
      let exists = false;
      try {
        await fs.access(absolute);
        exists = true;
      } catch {
        // file doesn't exist — safe to create
      }
      if (exists && !overwrite && !hasObserved(relPath)) {
        const suggestion = await suggestFreePath(workspaceRoot, relPath);
        log?.(
          "warn",
          `${indent}✗ write ${relPath} refused — exists; suggest ${suggestion}`,
        );
        return `Refused to write ${relPath}: a file already exists at that path and you have not read it in this session. If the user asked you to CREATE a new file, write to a non-colliding path like '${suggestion}' instead — do not silently overwrite the existing file. If the user asked you to MODIFY this file, call read_file first to see its current contents, then call write_file again (or pass overwrite=true if you are certain the existing contents should be discarded).`;
      }
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await fs.writeFile(absolute, content, "utf8");
      markObserved(relPath);
      onFileChange?.(relPath, "write");
      log?.("info", `${indent}✎ write ${relPath} (${content.length} bytes)`);
      return `Wrote ${relPath} (${content.length} bytes).`;
    },
    {
      name: "write_file",
      description:
        "Write a file at the given path inside the project workspace, creating directories as needed. Refuses to overwrite an existing file unless you have read it first in this session, or pass overwrite=true. When a 'create new file' request collides with an existing path, pick a non-colliding path (e.g. 'hello-1.txt') instead of overwriting. Path is relative to the workspace root (e.g. 'src/index.ts').",
      schema: z.object({
        path: z
          .string()
          .describe("Workspace-relative path, e.g. 'src/index.ts'."),
        content: z.string().describe("Full file contents to write."),
        overwrite: z
          .boolean()
          .optional()
          .describe(
            "Set to true to overwrite an existing file without reading it first. Use only when you are certain the existing contents should be discarded.",
          ),
      }),
    },
  );

  const readFile = tool(
    async ({ path: relPath }) => {
      const absolute = safeJoin(workspaceRoot, relPath);
      try {
        const text = await fs.readFile(absolute, "utf8");
        markObserved(relPath);
        log?.("info", `${indent}⇆ read ${relPath}`);
        return text;
      } catch (err) {
        const message = err instanceof Error ? err.message : "read failed";
        return `Error reading ${relPath}: ${message}`;
      }
    },
    {
      name: "read_file",
      description:
        "Read a file at the given workspace-relative path and return its contents as text.",
      schema: z.object({
        path: z.string().describe("Workspace-relative path."),
      }),
    },
  );

  const listFiles = tool(
    async ({ dir }) => {
      const target = dir || ".";
      const absolute = safeJoin(workspaceRoot, target);
      try {
        const entries = await fs.readdir(absolute, { withFileTypes: true });
        const lines = entries
          .filter(
            (e) => !["node_modules", ".next", ".git", "dist"].includes(e.name),
          )
          .map((e) => `${e.isDirectory() ? "[d] " : "    "}${e.name}`)
          .sort();
        log?.(
          "info",
          `${indent}⇆ list ${target} → ${lines.length} entries`,
        );
        return lines.length ? lines.join("\n") : "(empty)";
      } catch (err) {
        const message = err instanceof Error ? err.message : "list failed";
        return `Error listing ${target}: ${message}`;
      }
    },
    {
      name: "list_files",
      description:
        "List files and directories at the given workspace-relative directory. Use '.' for workspace root.",
      schema: z.object({
        dir: z
          .string()
          .default(".")
          .describe("Workspace-relative directory path. '.' for root."),
      }),
    },
  );

  const deleteFile = tool(
    async ({ path: relPath }) => {
      const absolute = safeJoin(workspaceRoot, relPath);
      try {
        await fs.unlink(absolute);
        observedFiles.delete(path.normalize(relPath));
        onFileChange?.(relPath, "delete");
        log?.("warn", `${indent}✗ delete ${relPath}`);
        return `Deleted ${relPath}.`;
      } catch (err) {
        const message = err instanceof Error ? err.message : "delete failed";
        return `Error deleting ${relPath}: ${message}`;
      }
    },
    {
      name: "delete_file",
      description:
        "Delete a file at the given workspace-relative path. Use sparingly.",
      schema: z.object({
        path: z.string().describe("Workspace-relative path."),
      }),
    },
  );

  return [writeFile, readFile, listFiles, deleteFile];
}

// suggestFreePath — given a workspace-relative path whose target already
// exists, returns the first '<stem>-<n><ext>' variant that doesn't collide
// (e.g. hello.txt → hello-1.txt → hello-2.txt). Returns the original path
// if every candidate up to N=99 is taken — the caller is just using this
// as a hint, not a guarantee.
async function suggestFreePath(
  workspaceRoot: string,
  relPath: string,
): Promise<string> {
  const dir = path.dirname(relPath);
  const ext = path.extname(relPath);
  const stem = path.basename(relPath, ext);
  for (let i = 1; i <= 99; i++) {
    const candidateRel =
      dir === "." ? `${stem}-${i}${ext}` : path.join(dir, `${stem}-${i}${ext}`);
    const candidateAbs = safeJoin(workspaceRoot, candidateRel);
    try {
      await fs.access(candidateAbs);
    } catch {
      return candidateRel;
    }
  }
  return relPath;
}

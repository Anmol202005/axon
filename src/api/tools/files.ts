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
  const writeFile = tool(
    async ({ path: relPath, content }) => {
      const absolute = safeJoin(workspaceRoot, relPath);
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await fs.writeFile(absolute, content, "utf8");
      onFileChange?.(relPath, "write");
      log?.("info", `${indent}✎ write ${relPath} (${content.length} bytes)`);
      return `Wrote ${relPath} (${content.length} bytes).`;
    },
    {
      name: "write_file",
      description:
        "Write a file at the given path inside the project workspace, creating directories as needed. Overwrites existing files. Path is relative to the workspace root (e.g. 'src/index.ts').",
      schema: z.object({
        path: z
          .string()
          .describe("Workspace-relative path, e.g. 'src/index.ts'."),
        content: z.string().describe("Full file contents to write."),
      }),
    },
  );

  const readFile = tool(
    async ({ path: relPath }) => {
      const absolute = safeJoin(workspaceRoot, relPath);
      try {
        const text = await fs.readFile(absolute, "utf8");
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

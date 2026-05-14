import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { tool } from "langchain";
import { z } from "zod";
import type {
  FileChangeFn,
  Logger,
  WriteApprover,
  WriteDecision,
  WriteRequest,
} from "../types.js";

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

async function readIfExists(absolute: string): Promise<string | undefined> {
  try {
    return await fs.readFile(absolute, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

async function approve(
  approver: WriteApprover | undefined,
  req: WriteRequest,
): Promise<WriteDecision> {
  if (!approver) return { kind: "apply" };
  return approver(req);
}

export function createFileTools(
  workspaceRoot: string,
  log: Logger | undefined,
  onFileChange: FileChangeFn | undefined,
  indent: string,
  approver?: WriteApprover,
) {
  const writeFile = tool(
    async ({ path: relPath, content }) => {
      const absolute = safeJoin(workspaceRoot, relPath);
      const oldContent = await readIfExists(absolute);
      const decision = await approve(approver, {
        id: randomUUID(),
        path: relPath,
        action: "write",
        oldContent,
        newContent: content,
      });
      if (decision.kind === "reject") {
        const reason = decision.reason?.trim() || "no reason given";
        log?.("warn", `${indent}⏵ write ${relPath} rejected by user (${reason})`);
        return `User rejected write to ${relPath}: ${reason}. Do not retry the same write — ask the user what they want changed.`;
      }
      const finalContent =
        decision.kind === "apply" && typeof decision.content === "string"
          ? decision.content
          : content;
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await fs.writeFile(absolute, finalContent, "utf8");
      onFileChange?.(relPath, "write");
      const edited = finalContent !== content ? " (edited by user)" : "";
      log?.(
        "info",
        `${indent}✎ write ${relPath} (${finalContent.length} bytes)${edited}`,
      );
      return `Wrote ${relPath} (${finalContent.length} bytes)${edited}.`;
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
      const oldContent = await readIfExists(absolute);
      if (oldContent === undefined) {
        return `Error deleting ${relPath}: file does not exist.`;
      }
      const decision = await approve(approver, {
        id: randomUUID(),
        path: relPath,
        action: "delete",
        oldContent,
        newContent: undefined,
      });
      if (decision.kind === "reject") {
        const reason = decision.reason?.trim() || "no reason given";
        log?.("warn", `${indent}⏵ delete ${relPath} rejected by user (${reason})`);
        return `User rejected delete of ${relPath}: ${reason}. Do not retry — ask the user how to proceed.`;
      }
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

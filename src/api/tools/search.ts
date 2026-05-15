import { spawn } from "node:child_process";
import { tool } from "langchain";
import { z } from "zod";
import type { Logger } from "../types.js";

// ===========================================================================
// search tool — ripgrep-backed workspace search with regex and globbing
// ===========================================================================

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_MATCHES = 200;
const HARD_MAX_MATCHES = 2000;
const MAX_OUTPUT_CHARS = 16_000;

export function createSearchTool(
  workspaceRoot: string,
  log: Logger | undefined,
  indent: string,
  abortSignal?: AbortSignal,
) {
  return tool(
    async ({
      pattern,
      glob,
      path: pathFilter,
      caseSensitive,
      multiline,
      filesOnly,
      maxResults,
      timeoutMs,
    }) => {
      const timeout = clampTimeout(timeoutMs);
      const max = clampMax(maxResults);

      const args: string[] = [
        "--no-heading",
        "--color",
        "never",
        "--hidden",
        "--glob",
        "!.git",
      ];

      if (filesOnly) {
        args.push("--files-with-matches");
      } else {
        args.push("--line-number", "--column");
      }

      if (caseSensitive) args.push("--case-sensitive");
      else args.push("--smart-case");

      if (multiline) args.push("--multiline", "--multiline-dotall");

      for (const g of toGlobArray(glob)) {
        args.push("--glob", g);
      }

      args.push("--max-count", String(Math.max(1, Math.floor(max / 4))));
      args.push("--regexp", pattern);
      if (pathFilter) args.push(pathFilter);

      log?.(
        "info",
        `${indent}⌕ rg ${truncateOneLine(pattern, 80)}${
          glob ? ` · glob=${toGlobArray(glob).join(",")}` : ""
        }${pathFilter ? ` · path=${pathFilter}` : ""}`,
      );

      const result = await runRipgrep(
        args,
        workspaceRoot,
        timeout,
        abortSignal,
      );

      if (result.spawnError) {
        return (
          `Error: could not run ripgrep (${result.spawnError}). ` +
          `Install ripgrep (\`rg\`) and try again, or fall back to \`run_command\` with grep.`
        );
      }

      // rg exits 1 when there are no matches; that is not an error for us.
      if (result.code === 1 && !result.stdout && !result.stderr) {
        return "(no matches)";
      }

      if (result.timedOut) {
        return `Error: search timed out after ${timeout}ms. Narrow the pattern or scope.`;
      }

      if (result.code !== 0 && result.code !== 1) {
        const stderr = clampOutput(result.stderr, MAX_OUTPUT_CHARS) || "(no stderr)";
        return `rg exited ${result.code}\n--- stderr ---\n${stderr}`;
      }

      const { text, matchCount, truncated } = limitMatches(result.stdout, max);
      const header = filesOnly
        ? `${matchCount} file(s) matched${truncated ? " (truncated)" : ""}`
        : `${matchCount} match(es)${truncated ? " (truncated)" : ""}`;

      log?.(
        "info",
        `${indent}⌕ rg → ${matchCount}${truncated ? "+" : ""} ${
          filesOnly ? "files" : "matches"
        }`,
      );

      return text ? `${header}\n${text}` : header;
    },
    {
      name: "search",
      description:
        "Search the workspace for a regex pattern using ripgrep. Returns matching lines with file paths and line numbers, or just file paths when `filesOnly` is true. Use `glob` to limit by filename (e.g. '*.ts', '!*.test.ts') and `path` to limit by directory. Much faster than reading files or piping grep through `run_command`. Honors .gitignore. Use this instead of `run_command rg ...` whenever you can.",
      schema: z.object({
        pattern: z
          .string()
          .describe(
            "Regex pattern to search for. Defaults to smart-case (case-insensitive unless the pattern has uppercase).",
          ),
        glob: z
          .string()
          .optional()
          .describe(
            "Comma-separated glob filters to scope the search. Negate with a leading '!'. Example: '*.ts,!*.test.ts'.",
          ),
        path: z
          .string()
          .optional()
          .describe(
            "Workspace-relative directory or file to restrict the search to. Defaults to the entire workspace.",
          ),
        caseSensitive: z
          .boolean()
          .optional()
          .describe(
            "Force case-sensitive matching. Default is smart-case (uppercase in the pattern triggers case sensitivity).",
          ),
        multiline: z
          .boolean()
          .optional()
          .describe(
            "Enable multi-line matching where '.' matches newlines. Use for patterns that span lines.",
          ),
        filesOnly: z
          .boolean()
          .optional()
          .describe(
            "Return only the file paths that match instead of the matching lines.",
          ),
        maxResults: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            `Maximum match lines (or files when filesOnly) to return. Defaults to ${DEFAULT_MAX_MATCHES}, max ${HARD_MAX_MATCHES}.`,
          ),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            `Hard timeout in milliseconds. Default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}.`,
          ),
      }),
    },
  );
}

interface RipgrepResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: string;
}

function runRipgrep(
  args: string[],
  cwd: string,
  timeoutMs: number,
  abortSignal?: AbortSignal,
): Promise<RipgrepResult> {
  return new Promise((resolve) => {
    if (abortSignal?.aborted) {
      resolve({
        code: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        spawnError: "cancelled by user before spawn",
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    let child;
    try {
      child = spawn("rg", args, { cwd, env: process.env });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      resolve({
        code: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        spawnError: message,
      });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    const onAbort = () => {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 500);
    };
    abortSignal?.addEventListener("abort", onAbort, { once: true });

    const settle = (result: RipgrepResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      // Hard cap to keep memory bounded; we'll trim again when formatting.
      if (stdout.length > MAX_OUTPUT_CHARS * 4) {
        stdout = stdout.slice(0, MAX_OUTPUT_CHARS * 4);
        child.kill("SIGTERM");
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > MAX_OUTPUT_CHARS) {
        stderr = stderr.slice(-MAX_OUTPUT_CHARS);
      }
    });
    child.on("error", (err) => {
      const message = err.message;
      // ENOENT means rg is not installed.
      const spawnError = /ENOENT/.test(message)
        ? "ripgrep (rg) is not installed or not on PATH"
        : message;
      settle({
        code: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        spawnError,
      });
    });
    child.on("close", (code) => {
      settle({ code, stdout, stderr, timedOut });
    });
  });
}

function toGlobArray(glob: string | undefined): string[] {
  if (!glob) return [];
  return glob
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function clampTimeout(requested?: number): number {
  if (!requested || !Number.isFinite(requested) || requested <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(requested, MAX_TIMEOUT_MS);
}

function clampMax(requested?: number): number {
  if (!requested || !Number.isFinite(requested) || requested <= 0) {
    return DEFAULT_MAX_MATCHES;
  }
  return Math.min(requested, HARD_MAX_MATCHES);
}

function limitMatches(
  stdout: string,
  max: number,
): { text: string; matchCount: number; truncated: boolean } {
  if (!stdout) return { text: "", matchCount: 0, truncated: false };
  const lines = stdout.split("\n");
  // Drop a trailing empty line caused by the final newline.
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const truncated = lines.length > max;
  const kept = truncated ? lines.slice(0, max) : lines;
  let text = kept.join("\n");
  if (text.length > MAX_OUTPUT_CHARS) {
    text = text.slice(0, MAX_OUTPUT_CHARS) + "\n... [output truncated] ...";
  }
  return { text, matchCount: kept.length, truncated };
}

function clampOutput(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n... [${text.length - max} chars truncated] ...`;
}

function truncateOneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

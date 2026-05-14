import { spawn } from "node:child_process";
import { tool } from "langchain";
import { z } from "zod";
import type { Logger } from "../types.js";

// ===========================================================================
// shell tool — run terminal commands rooted at the workspace
// ===========================================================================

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 600_000; // 10 minutes
const MAX_STREAM_CHARS = 32_000; // per stream, before head/tail clamp
const MAX_OUTPUT_CHARS = 16_000; // per stream returned to the model

export function createShellTool(
  workspaceRoot: string,
  log: Logger | undefined,
  indent: string,
  abortSignal?: AbortSignal,
) {
  return tool(
    async ({ command, timeoutMs }) => {
      const timeout = clampTimeout(timeoutMs);
      log?.("info", `${indent}$ ${truncateOneLine(command, 120)}`);
      const result = await execCommand(
        command,
        workspaceRoot,
        timeout,
        abortSignal,
      );
      const suffix = result.timedOut
        ? ` (timed out after ${timeout}ms)`
        : "";
      log?.(
        result.code === 0 ? "info" : "warn",
        `${indent}↳ exit ${result.code ?? "(killed)"}${suffix}`,
      );
      return formatResult(result);
    },
    {
      name: "run_command",
      description:
        "Run a shell command from the workspace root using the system shell. " +
        "Returns the exit code plus stdout and stderr. Use this for tasks like " +
        "running tests ('npm test'), builds, linters, git operations, or quick " +
        "inspections (e.g. 'ls', 'rg foo'). The command executes against the " +
        "user's real filesystem and processes — be careful with destructive " +
        "operations. Prefer non-interactive flags (e.g. --yes, --no-pager). " +
        "Interactive or long-running commands are killed by the timeout.",
      schema: z.object({
        command: z
          .string()
          .describe(
            "Shell command to execute, e.g. 'npm test' or 'git status --porcelain'.",
          ),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Hard timeout in milliseconds. Defaults to 60000 (60s). Max 600000 (10min).",
          ),
      }),
    },
  );
}

interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: string;
}

function execCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  abortSignal?: AbortSignal,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let cancelled = false;
    let settled = false;

    if (abortSignal?.aborted) {
      resolve({
        code: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        error: "cancelled by user before spawn",
      });
      return;
    }

    let child;
    try {
      child = spawn(command, {
        cwd,
        shell: true,
        env: process.env,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      resolve({
        code: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        error: `failed to spawn: ${message}`,
      });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    const onAbort = () => {
      cancelled = true;
      child.kill("SIGTERM");
      // Give it a moment; if it's still around, SIGKILL.
      setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 500);
    };
    abortSignal?.addEventListener("abort", onAbort, { once: true });

    const settle = (result: ExecResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", onAbort);
      if (cancelled) result = { ...result, error: "cancelled by user" };
      resolve(result);
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > MAX_STREAM_CHARS) {
        stdout = stdout.slice(-MAX_STREAM_CHARS);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > MAX_STREAM_CHARS) {
        stderr = stderr.slice(-MAX_STREAM_CHARS);
      }
    });
    child.on("error", (err) => {
      settle({
        code: null,
        stdout,
        stderr,
        timedOut,
        error: err.message,
      });
    });
    child.on("close", (code) => {
      settle({ code, stdout, stderr, timedOut });
    });
  });
}

function clampTimeout(requested?: number): number {
  if (!requested || !Number.isFinite(requested) || requested <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(requested, MAX_TIMEOUT_MS);
}

function truncateOneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

function clampOutput(text: string, max: number): string {
  if (text.length <= max) return text;
  const headLen = Math.floor(max * 0.3);
  const tailLen = max - headLen;
  return `${text.slice(0, headLen)}\n... [${text.length - max} chars truncated] ...\n${text.slice(-tailLen)}`;
}

function formatResult(r: ExecResult): string {
  const head: string[] = [];
  head.push(
    `exit ${r.code ?? "(killed)"}${r.timedOut ? " (timed out)" : ""}`,
  );
  if (r.error) head.push(`spawn error: ${r.error}`);

  const stdout = clampOutput(r.stdout, MAX_OUTPUT_CHARS);
  const stderr = clampOutput(r.stderr, MAX_OUTPUT_CHARS);

  const parts: string[] = [head.join(" · ")];
  if (stdout) parts.push(`--- stdout ---\n${stdout}`);
  if (stderr) parts.push(`--- stderr ---\n${stderr}`);
  if (!stdout && !stderr) parts.push("(no output)");
  return parts.join("\n");
}

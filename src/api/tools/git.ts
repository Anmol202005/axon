import { spawn } from "node:child_process";
import { tool } from "langchain";
import { z } from "zod";
import type { Logger } from "../types.js";

// ===========================================================================
// git tools — focused wrappers around git CLI for the most common ops
// ===========================================================================

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 16_000;
const DEFAULT_LOG_COUNT = 20;
const MAX_LOG_COUNT = 200;

export function createGitTools(
  workspaceRoot: string,
  log: Logger | undefined,
  indent: string,
  abortSignal?: AbortSignal,
) {
  const status = tool(
    async () => {
      const r = await runGit(
        ["status", "--short", "--branch"],
        workspaceRoot,
        abortSignal,
      );
      logRun(log, indent, "status", r);
      return formatResult(r);
    },
    {
      name: "git_status",
      description:
        "Show the working tree status (short format, with branch). Read-only.",
      schema: z.object({}),
    },
  );

  const diff = tool(
    async ({ staged, path: pathFilter, ref }) => {
      const args = ["--no-pager", "diff", "--no-color"];
      if (staged) args.push("--staged");
      if (ref) args.push(ref);
      if (pathFilter) args.push("--", pathFilter);
      const r = await runGit(args, workspaceRoot, abortSignal);
      logRun(log, indent, `diff${staged ? " --staged" : ""}`, r);
      return formatResult(r);
    },
    {
      name: "git_diff",
      description:
        "Show a unified diff of changes. By default, shows unstaged changes. Set `staged: true` for staged changes, `ref` for a specific commit/range (e.g. 'HEAD~1', 'main..HEAD'), and `path` to limit to a file or directory.",
      schema: z.object({
        staged: z
          .boolean()
          .optional()
          .describe("Show staged changes instead of unstaged."),
        path: z
          .string()
          .optional()
          .describe("Workspace-relative file or directory to limit the diff to."),
        ref: z
          .string()
          .optional()
          .describe(
            "Optional ref or revision range (e.g. 'HEAD~1', 'main..HEAD').",
          ),
      }),
    },
  );

  const blame = tool(
    async ({ path: filePath, lineStart, lineEnd }) => {
      if (!filePath) return "Error: 'path' is required for git_blame.";
      const args = ["--no-pager", "blame", "--date=short"];
      if (typeof lineStart === "number") {
        const end = typeof lineEnd === "number" ? lineEnd : lineStart;
        args.push("-L", `${lineStart},${end}`);
      }
      args.push("--", filePath);
      const r = await runGit(args, workspaceRoot, abortSignal);
      logRun(log, indent, `blame ${filePath}`, r);
      return formatResult(r);
    },
    {
      name: "git_blame",
      description:
        "Show line-by-line authorship for a file. Use `lineStart` and `lineEnd` to limit to a range when the file is large.",
      schema: z.object({
        path: z
          .string()
          .describe("Workspace-relative path of the file to blame."),
        lineStart: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Optional starting line (1-indexed)."),
        lineEnd: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Optional ending line (1-indexed). Defaults to lineStart for a single line.",
          ),
      }),
    },
  );

  const gitLog = tool(
    async ({ count, path: pathFilter, ref, oneline }) => {
      const args = ["--no-pager", "log"];
      args.push(`-n`, String(clampLogCount(count)));
      args.push(oneline === false ? "--pretty=medium" : "--oneline");
      if (ref) args.push(ref);
      if (pathFilter) args.push("--", pathFilter);
      const r = await runGit(args, workspaceRoot, abortSignal);
      logRun(log, indent, `log -n ${clampLogCount(count)}`, r);
      return formatResult(r);
    },
    {
      name: "git_log",
      description:
        "Show recent commits. Defaults to a one-line summary of the latest 20 commits on the current branch. Use `count` to change the limit, `ref` for a specific branch/range, and `path` to limit to a file.",
      schema: z.object({
        count: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            `How many commits to show. Default ${DEFAULT_LOG_COUNT}, max ${MAX_LOG_COUNT}.`,
          ),
        path: z
          .string()
          .optional()
          .describe("Workspace-relative file or directory to filter history."),
        ref: z
          .string()
          .optional()
          .describe("Branch, tag, or revision range to log."),
        oneline: z
          .boolean()
          .optional()
          .describe(
            "If false, show the medium format (full author + date + body). Default true (--oneline).",
          ),
      }),
    },
  );

  const commit = tool(
    async ({ message, addAll, paths, amend }) => {
      if (!message && !amend) {
        return "Error: 'message' is required (unless 'amend' is true).";
      }
      if (addAll) {
        const addR = await runGit(["add", "-A"], workspaceRoot, abortSignal);
        if (addR.code !== 0) {
          logRun(log, indent, "add -A", addR);
          return `git add -A failed:\n${formatResult(addR)}`;
        }
      } else if (paths && paths.length > 0) {
        const addR = await runGit(
          ["add", "--", ...paths],
          workspaceRoot,
          abortSignal,
        );
        if (addR.code !== 0) {
          logRun(log, indent, `add ${paths.join(" ")}`, addR);
          return `git add failed:\n${formatResult(addR)}`;
        }
      }
      const args = ["commit"];
      if (amend) args.push("--amend");
      if (message) args.push("-m", message);
      else if (amend) args.push("--no-edit");
      const r = await runGit(args, workspaceRoot, abortSignal);
      logRun(log, indent, `commit${amend ? " --amend" : ""}`, r);
      return formatResult(r);
    },
    {
      name: "git_commit",
      description:
        "Create a git commit. Pass `message` for the commit message. Set `addAll: true` to stage all changes first, or pass `paths` to stage specific files. Set `amend: true` to amend the previous commit (omit `message` to keep it). Will refuse to commit empty staging unless you explicitly stage something.",
      schema: z.object({
        message: z
          .string()
          .optional()
          .describe(
            "Commit message. Required unless amend is true and you want to keep the existing message.",
          ),
        addAll: z
          .boolean()
          .optional()
          .describe(
            "Run `git add -A` before committing. Mutually exclusive with `paths`.",
          ),
        paths: z
          .array(z.string())
          .optional()
          .describe(
            "Specific workspace-relative paths to stage before committing.",
          ),
        amend: z
          .boolean()
          .optional()
          .describe("Amend the previous commit instead of creating a new one."),
      }),
    },
  );

  const branch = tool(
    async ({ action, name, ref, force }) => {
      const a = action ?? "list";
      if (a === "list") {
        const r = await runGit(
          ["--no-pager", "branch", "--list", "--all"],
          workspaceRoot,
          abortSignal,
        );
        logRun(log, indent, "branch --list", r);
        return formatResult(r);
      }
      if (!name) {
        return `Error: 'name' is required for action='${a}'.`;
      }
      if (a === "create") {
        const args = ["branch", name];
        if (ref) args.push(ref);
        const r = await runGit(args, workspaceRoot, abortSignal);
        logRun(log, indent, `branch ${name}`, r);
        return formatResult(r);
      }
      if (a === "delete") {
        const args = ["branch", force ? "-D" : "-d", name];
        const r = await runGit(args, workspaceRoot, abortSignal);
        logRun(log, indent, `branch ${force ? "-D" : "-d"} ${name}`, r);
        return formatResult(r);
      }
      return `Error: unknown action '${a}'. Expected list, create, or delete.`;
    },
    {
      name: "git_branch",
      description:
        "List, create, or delete branches. action='list' (default) shows local + remote branches. action='create' makes a new branch at `name` (optionally based on `ref`). action='delete' removes `name` (set `force: true` to force-delete an unmerged branch).",
      schema: z.object({
        action: z
          .enum(["list", "create", "delete"])
          .optional()
          .describe("What to do. Defaults to 'list'."),
        name: z
          .string()
          .optional()
          .describe("Branch name. Required for create/delete."),
        ref: z
          .string()
          .optional()
          .describe("Starting ref for create (e.g. 'main', 'HEAD~1')."),
        force: z
          .boolean()
          .optional()
          .describe("Force delete an unmerged branch."),
      }),
    },
  );

  const checkout = tool(
    async ({ ref, create, paths }) => {
      if (paths && paths.length > 0) {
        const args = ["checkout", "--"].concat(paths);
        const r = await runGit(args, workspaceRoot, abortSignal);
        logRun(log, indent, `checkout -- ${paths.join(" ")}`, r);
        return formatResult(r);
      }
      if (!ref) {
        return "Error: 'ref' or 'paths' is required for git_checkout.";
      }
      const args = ["checkout"];
      if (create) args.push("-b");
      args.push(ref);
      const r = await runGit(args, workspaceRoot, abortSignal);
      logRun(log, indent, `checkout${create ? " -b" : ""} ${ref}`, r);
      return formatResult(r);
    },
    {
      name: "git_checkout",
      description:
        "Switch branches or restore files. Pass `ref` to switch to an existing branch/commit. Set `create: true` to create and switch to a new branch named `ref`. Pass `paths` (without `ref`) to discard local changes to those files — destructive, ask before using.",
      schema: z.object({
        ref: z
          .string()
          .optional()
          .describe("Branch, tag, or commit to switch to."),
        create: z
          .boolean()
          .optional()
          .describe(
            "Create a new branch named `ref` and switch to it (-b).",
          ),
        paths: z
          .array(z.string())
          .optional()
          .describe(
            "Workspace-relative paths to restore from HEAD. Destructive — discards uncommitted changes.",
          ),
      }),
    },
  );

  return [status, diff, blame, gitLog, commit, branch, checkout];
}

interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
  spawnError?: string;
}

function runGit(
  args: string[],
  cwd: string,
  abortSignal?: AbortSignal,
): Promise<GitResult> {
  return new Promise((resolve) => {
    if (abortSignal?.aborted) {
      resolve({
        code: null,
        stdout: "",
        stderr: "",
        spawnError: "cancelled by user before spawn",
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;

    let child;
    try {
      child = spawn("git", args, {
        cwd,
        env: { ...process.env, GIT_PAGER: "cat", PAGER: "cat" },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      resolve({
        code: null,
        stdout: "",
        stderr: "",
        spawnError: message,
      });
      return;
    }

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, DEFAULT_TIMEOUT_MS);

    const onAbort = () => {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 500);
    };
    abortSignal?.addEventListener("abort", onAbort, { once: true });

    const settle = (result: GitResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > MAX_OUTPUT_CHARS * 4) {
        stdout = stdout.slice(0, MAX_OUTPUT_CHARS * 4);
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
      const spawnError = /ENOENT/.test(message)
        ? "git is not installed or not on PATH"
        : message;
      settle({ code: null, stdout: "", stderr: "", spawnError });
    });
    child.on("close", (code) => {
      settle({ code, stdout, stderr });
    });
  });
}

function logRun(
  log: Logger | undefined,
  indent: string,
  cmd: string,
  r: GitResult,
) {
  const level: "info" | "warn" = r.code === 0 ? "info" : "warn";
  const status = r.spawnError
    ? `spawn error: ${r.spawnError}`
    : `exit ${r.code ?? "(killed)"}`;
  log?.(level, `${indent}⎇ git ${cmd} · ${status}`);
}

function formatResult(r: GitResult): string {
  if (r.spawnError) return `git: ${r.spawnError}`;
  const head = `exit ${r.code ?? "(killed)"}`;
  const stdout = clampOutput(r.stdout, MAX_OUTPUT_CHARS);
  const stderr = clampOutput(r.stderr, MAX_OUTPUT_CHARS);
  const parts: string[] = [head];
  if (stdout) parts.push(`--- stdout ---\n${stdout}`);
  if (stderr) parts.push(`--- stderr ---\n${stderr}`);
  if (!stdout && !stderr) parts.push("(no output)");
  return parts.join("\n");
}

function clampOutput(text: string, max: number): string {
  if (!text) return "";
  if (text.length <= max) return text;
  const headLen = Math.floor(max * 0.3);
  const tailLen = max - headLen;
  return `${text.slice(0, headLen)}\n... [${text.length - max} chars truncated] ...\n${text.slice(-tailLen)}`;
}

function clampLogCount(requested?: number): number {
  if (!requested || !Number.isFinite(requested) || requested <= 0) {
    return DEFAULT_LOG_COUNT;
  }
  return Math.min(Math.floor(requested), MAX_LOG_COUNT);
}

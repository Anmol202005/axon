import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { tool } from "langchain";
import { z } from "zod";
import type { Logger } from "../types.js";

// ===========================================================================
// checks tool — run build/test/lint/typecheck and pipe parsed errors back
// ===========================================================================

const DEFAULT_TIMEOUT_MS = 180_000; // 3 min
const MAX_TIMEOUT_MS = 600_000; // 10 min
const MAX_OUTPUT_CHARS = 16_000;
const MAX_DIAGNOSTICS = 50;

type CheckKind = "build" | "test" | "lint" | "typecheck";

interface ResolvedCommand {
  command: string;
  args: string[];
  source: string; // explanation of how we picked it
}

export function createChecksTool(
  workspaceRoot: string,
  log: Logger | undefined,
  indent: string,
  abortSignal?: AbortSignal,
) {
  return tool(
    async ({ kind, command, timeoutMs }) => {
      const timeout = clampTimeout(timeoutMs);

      let resolved: ResolvedCommand;
      if (command) {
        resolved = { command, args: [], source: "explicit command argument" };
      } else {
        const detected = await resolveCommand(workspaceRoot, kind);
        if (!detected) {
          return (
            `Error: could not detect a ${kind} command for this project. ` +
            `Pass an explicit \`command\` (e.g. command: "npm run typecheck"), or add a script to package.json / Makefile.`
          );
        }
        resolved = detected;
      }

      log?.(
        "info",
        `${indent}✓ ${kind} via ${truncateOneLine(
          [resolved.command, ...resolved.args].join(" "),
          100,
        )} (${resolved.source})`,
      );

      const result = await execChecks(
        resolved,
        workspaceRoot,
        timeout,
        abortSignal,
      );

      if (result.spawnError) {
        return `Failed to start ${kind}: ${result.spawnError}`;
      }

      const diagnostics = parseDiagnostics(
        kind,
        result.stdout,
        result.stderr,
      );

      return formatCheckResult({
        kind,
        commandLine: [resolved.command, ...resolved.args].join(" "),
        source: resolved.source,
        result,
        diagnostics,
        timeoutMs: timeout,
      });
    },
    {
      name: "run_checks",
      description:
        "Run the project's build / test / lint / typecheck command and return parsed diagnostics. Auto-detects the right command from package.json scripts, tsconfig, Makefile, Cargo.toml, pyproject.toml, or go.mod. Pass an explicit `command` to override detection. Prefer this over `run_command` for inner-loop feedback — output is parsed into file:line:col diagnostics the agent can act on directly.",
      schema: z.object({
        kind: z
          .enum(["build", "test", "lint", "typecheck"])
          .describe(
            "Which check to run: 'build' compiles the project, 'test' runs the test suite, 'lint' runs the linter, 'typecheck' runs the type checker.",
          ),
        command: z
          .string()
          .optional()
          .describe(
            "Optional explicit shell command to run instead of the auto-detected one (e.g. 'npm run typecheck', 'cargo clippy -- -D warnings').",
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

// ---------------------------------------------------------------------------
// command resolution — figure out what to run for a given check kind based
// on the files present in the workspace. We look at package.json scripts
// first (most projects we'll see have them), then fall back to language
// defaults (cargo, pytest, go test, etc.).
// ---------------------------------------------------------------------------

async function resolveCommand(
  root: string,
  kind: CheckKind,
): Promise<ResolvedCommand | undefined> {
  const pkg = await readJson(path.join(root, "package.json"));
  if (pkg && typeof pkg === "object") {
    const scripts: Record<string, string> =
      (pkg as { scripts?: Record<string, string> }).scripts ?? {};
    const scriptName = pickScript(scripts, kind);
    if (scriptName) {
      const runner = await detectNodeRunner(root);
      return {
        command: runner,
        args: ["run", scriptName],
        source: `package.json script "${scriptName}" via ${runner}`,
      };
    }
    // Fall-backs for node projects without an explicit script.
    if (kind === "typecheck") {
      if (await exists(path.join(root, "tsconfig.json"))) {
        const runner = await detectNodeRunner(root);
        return {
          command: runner === "npm" ? "npx" : runner,
          args:
            runner === "npm"
              ? ["--no-install", "tsc", "--noEmit"]
              : ["exec", "tsc", "--", "--noEmit"],
          source: "tsc --noEmit (tsconfig.json present)",
        };
      }
    }
    if (kind === "test") {
      // Last resort: `npm test` works even without an explicit script
      // (npm will print "no test specified" and exit 1, but that's still
      // useful signal for the agent).
      return {
        command: "npm",
        args: ["test"],
        source: "npm test fallback",
      };
    }
  }

  if (await exists(path.join(root, "Cargo.toml"))) {
    if (kind === "build")
      return { command: "cargo", args: ["build"], source: "Cargo.toml" };
    if (kind === "test")
      return { command: "cargo", args: ["test"], source: "Cargo.toml" };
    if (kind === "lint")
      return {
        command: "cargo",
        args: ["clippy", "--", "-D", "warnings"],
        source: "Cargo.toml",
      };
    if (kind === "typecheck")
      return {
        command: "cargo",
        args: ["check"],
        source: "Cargo.toml",
      };
  }

  if (await exists(path.join(root, "go.mod"))) {
    if (kind === "build")
      return { command: "go", args: ["build", "./..."], source: "go.mod" };
    if (kind === "test")
      return { command: "go", args: ["test", "./..."], source: "go.mod" };
    if (kind === "lint")
      return { command: "go", args: ["vet", "./..."], source: "go.mod" };
    if (kind === "typecheck")
      return { command: "go", args: ["build", "./..."], source: "go.mod" };
  }

  const hasPyproject = await exists(path.join(root, "pyproject.toml"));
  const hasSetupPy = await exists(path.join(root, "setup.py"));
  if (hasPyproject || hasSetupPy) {
    if (kind === "test")
      return {
        command: "pytest",
        args: [],
        source: hasPyproject ? "pyproject.toml" : "setup.py",
      };
    if (kind === "lint")
      return {
        command: "ruff",
        args: ["check", "."],
        source: "ruff (python project)",
      };
    if (kind === "typecheck")
      return {
        command: "mypy",
        args: ["."],
        source: "mypy (python project)",
      };
    if (kind === "build")
      return {
        command: "python",
        args: ["-m", "build"],
        source: "python -m build",
      };
  }

  if (await exists(path.join(root, "Makefile"))) {
    const target = makeTargetFor(kind);
    return {
      command: "make",
      args: [target],
      source: `Makefile target '${target}'`,
    };
  }

  return undefined;
}

function pickScript(
  scripts: Record<string, string>,
  kind: CheckKind,
): string | undefined {
  const candidates = SCRIPT_CANDIDATES[kind];
  for (const name of candidates) {
    if (scripts[name]) return name;
  }
  return undefined;
}

const SCRIPT_CANDIDATES: Record<CheckKind, string[]> = {
  build: ["build", "compile"],
  test: ["test", "tests", "test:unit"],
  lint: ["lint", "lint:check", "eslint"],
  typecheck: ["typecheck", "type-check", "tsc", "check-types"],
};

function makeTargetFor(kind: CheckKind): string {
  switch (kind) {
    case "build":
      return "build";
    case "test":
      return "test";
    case "lint":
      return "lint";
    case "typecheck":
      return "typecheck";
  }
}

async function detectNodeRunner(root: string): Promise<string> {
  if (await exists(path.join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (await exists(path.join(root, "yarn.lock"))) return "yarn";
  if (await exists(path.join(root, "bun.lockb"))) return "bun";
  return "npm";
}

async function readJson(p: string): Promise<unknown | undefined> {
  try {
    const text = await fs.readFile(p, "utf8");
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------

interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: string;
  durationMs: number;
}

function execChecks(
  resolved: ResolvedCommand,
  cwd: string,
  timeoutMs: number,
  abortSignal?: AbortSignal,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    if (abortSignal?.aborted) {
      resolve({
        code: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        spawnError: "cancelled by user before spawn",
        durationMs: 0,
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    // If the caller passed a full shell command via `command`, run it through
    // the shell so we honor pipes, env vars, etc. Otherwise spawn directly.
    const useShell = resolved.args.length === 0;

    let child;
    try {
      child = useShell
        ? spawn(resolved.command, { cwd, shell: true, env: process.env })
        : spawn(resolved.command, resolved.args, {
            cwd,
            env: process.env,
          });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      resolve({
        code: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        spawnError: message,
        durationMs: Date.now() - start,
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

    const settle = (r: ExecResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", onAbort);
      resolve(r);
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > MAX_OUTPUT_CHARS * 4) {
        stdout = stdout.slice(-MAX_OUTPUT_CHARS * 4);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > MAX_OUTPUT_CHARS * 4) {
        stderr = stderr.slice(-MAX_OUTPUT_CHARS * 4);
      }
    });
    child.on("error", (err) => {
      const message = err.message;
      const spawnError = /ENOENT/.test(message)
        ? `${resolved.command} is not installed or not on PATH`
        : message;
      settle({
        code: null,
        stdout,
        stderr,
        timedOut,
        spawnError,
        durationMs: Date.now() - start,
      });
    });
    child.on("close", (code) => {
      settle({
        code,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - start,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// diagnostic parsing — pull file:line:col error lines out of the output so
// the agent can act on them without re-reading the raw stream. We use a
// few heuristic regexes that cover the most common toolchains (tsc, eslint
// stylish, rustc, go, pytest, ruff, gcc/clang, generic file:line:col).
// ---------------------------------------------------------------------------

export interface Diagnostic {
  file: string;
  line: number;
  column?: number;
  severity: "error" | "warning" | "info";
  message: string;
  rule?: string;
}

const PATTERNS: { re: RegExp; build: (m: RegExpMatchArray) => Diagnostic }[] = [
  // tsc:  src/foo.ts(12,3): error TS2322: Type 'string' is not assignable...
  {
    re: /^(.+?)\((\d+),(\d+)\):\s+(error|warning|info)\s+([A-Z]+\d+):\s+(.*)$/,
    build: (m) => ({
      file: m[1],
      line: Number(m[2]),
      column: Number(m[3]),
      severity: m[4] as Diagnostic["severity"],
      rule: m[5],
      message: m[6],
    }),
  },
  // Generic file:line:col: severity: message  (eslint --format=compact, gcc, clang, rustc short)
  {
    re: /^(.+?):(\d+):(\d+):?\s+(error|warning|note|info)[:\s]+(.*)$/i,
    build: (m) => ({
      file: m[1],
      line: Number(m[2]),
      column: Number(m[3]),
      severity: normalizeSeverity(m[4]),
      message: m[5],
    }),
  },
  // pytest:  FAILED tests/test_foo.py::test_bar - AssertionError: ...
  {
    re: /^FAILED\s+(.+?)::([^\s]+)\s*-\s*(.*)$/,
    build: (m) => ({
      file: m[1],
      line: 0,
      severity: "error",
      message: `${m[2]}: ${m[3]}`,
    }),
  },
  // go:  ./foo.go:12:3: undefined: bar
  {
    re: /^(\.\/[^\s:]+):(\d+):(\d+):\s+(.*)$/,
    build: (m) => ({
      file: m[1],
      line: Number(m[2]),
      column: Number(m[3]),
      severity: "error",
      message: m[4],
    }),
  },
  // ruff:  foo.py:12:5: F401 `os` imported but unused
  {
    re: /^(.+?):(\d+):(\d+):\s+([A-Z]+\d+)\s+(.*)$/,
    build: (m) => ({
      file: m[1],
      line: Number(m[2]),
      column: Number(m[3]),
      severity: "warning",
      rule: m[4],
      message: m[5],
    }),
  },
];

function normalizeSeverity(s: string): Diagnostic["severity"] {
  const lower = s.toLowerCase();
  if (lower.startsWith("err")) return "error";
  if (lower.startsWith("warn")) return "warning";
  return "info";
}

function parseDiagnostics(
  kind: CheckKind,
  stdout: string,
  stderr: string,
): Diagnostic[] {
  const lines = `${stdout}\n${stderr}`.split("\n");
  const seen = new Set<string>();
  const out: Diagnostic[] = [];
  for (const raw of lines) {
    const line = raw.replace(/\[[0-9;]*m/g, "").trim();
    if (!line) continue;
    for (const { re, build } of PATTERNS) {
      const m = line.match(re);
      if (!m) continue;
      let d: Diagnostic;
      try {
        d = build(m);
      } catch {
        continue;
      }
      if (!d.file || !Number.isFinite(d.line)) continue;
      const key = `${d.file}:${d.line}:${d.column ?? ""}:${d.message}`;
      if (seen.has(key)) break;
      seen.add(key);
      out.push(d);
      if (out.length >= MAX_DIAGNOSTICS) return out;
      break;
    }
  }
  // Mute kind-specific noise: typecheck tools rarely produce non-error
  // diagnostics; lint output is the opposite. We don't filter here — the
  // agent benefits from seeing the full picture either way.
  void kind;
  return out;
}

// ---------------------------------------------------------------------------
// output formatting
// ---------------------------------------------------------------------------

interface FormatArgs {
  kind: CheckKind;
  commandLine: string;
  source: string;
  result: ExecResult;
  diagnostics: Diagnostic[];
  timeoutMs: number;
}

function formatCheckResult(a: FormatArgs): string {
  const { kind, commandLine, source, result, diagnostics, timeoutMs } = a;
  const status =
    result.code === 0
      ? "passed"
      : result.timedOut
        ? `timed out after ${timeoutMs}ms`
        : `failed (exit ${result.code ?? "killed"})`;
  const errorCount = diagnostics.filter((d) => d.severity === "error").length;
  const warnCount = diagnostics.filter((d) => d.severity === "warning").length;

  const header = [
    `${kind} ${status} · ${formatDuration(result.durationMs)}`,
    `command: ${commandLine}`,
    `picked via: ${source}`,
    diagnostics.length
      ? `diagnostics: ${diagnostics.length} (${errorCount} error, ${warnCount} warn)`
      : "diagnostics: none parsed",
  ].join("\n");

  const parts: string[] = [header];

  if (diagnostics.length > 0) {
    const rendered = diagnostics
      .slice(0, MAX_DIAGNOSTICS)
      .map((d) => {
        const loc =
          d.column !== undefined ? `${d.line}:${d.column}` : `${d.line}`;
        const rule = d.rule ? ` [${d.rule}]` : "";
        return `${d.severity.toUpperCase()} ${d.file}:${loc}${rule} — ${d.message}`;
      })
      .join("\n");
    parts.push(`--- diagnostics ---\n${rendered}`);
  }

  const stdout = clampOutput(result.stdout, MAX_OUTPUT_CHARS);
  const stderr = clampOutput(result.stderr, MAX_OUTPUT_CHARS);
  if (stdout) parts.push(`--- stdout ---\n${stdout}`);
  if (stderr) parts.push(`--- stderr ---\n${stderr}`);
  if (!stdout && !stderr) parts.push("(no output)");
  if (result.spawnError) parts.push(`spawn error: ${result.spawnError}`);
  return parts.join("\n");
}

function clampOutput(text: string, max: number): string {
  if (!text) return "";
  if (text.length <= max) return text;
  const headLen = Math.floor(max * 0.3);
  const tailLen = max - headLen;
  return `${text.slice(0, headLen)}\n... [${text.length - max} chars truncated] ...\n${text.slice(-tailLen)}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const r = Math.round(s - m * 60);
  return `${m}m${r}s`;
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

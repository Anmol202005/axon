import { promises as fs } from "node:fs";
import path from "node:path";

// ===========================================================================
// projectType — detect node/python/rust/go projects from manifest files and
// return tuned defaults the orchestrator can quote to the model.
//
// Detection is intentionally cheap (a handful of fs.access calls + a single
// package.json read on Node projects). We never recurse into subdirectories
// — a monorepo's top-level manifest is what counts; sub-packages keep their
// own surfaces through `run_command` / `run_checks`.
// ===========================================================================

export type ProjectKind =
  | "node"
  | "python"
  | "rust"
  | "go"
  | "unknown";

export type NodePackageManager = "npm" | "pnpm" | "yarn" | "bun";

export interface ProjectDefaults {
  build?: string;
  test?: string;
  lint?: string;
  typecheck?: string;
  run?: string;
  install?: string;
}

export interface ProjectInfo {
  kind: ProjectKind;
  // Short, human-readable summary suitable for an agent prompt line.
  // e.g. "Node.js (TypeScript) project · uses pnpm".
  summary: string;
  // Files we noticed during detection — useful for the agent's mental model
  // and for surfacing to the user in the welcome banner.
  evidence: string[];
  defaults: ProjectDefaults;
  // Sub-flags individual surfaces can use to make tighter decisions.
  hasTypeScript?: boolean;
  packageManager?: NodePackageManager;
}

export async function detectProjectType(
  workspaceRoot: string,
): Promise<ProjectInfo> {
  const has = (rel: string) => fileExists(path.join(workspaceRoot, rel));

  if (await has("package.json")) return detectNode(workspaceRoot);
  if (await has("Cargo.toml")) return detectRust(workspaceRoot);
  if (await has("go.mod")) return detectGo(workspaceRoot);
  if (
    (await has("pyproject.toml")) ||
    (await has("setup.py")) ||
    (await has("requirements.txt")) ||
    (await has("Pipfile"))
  ) {
    return detectPython(workspaceRoot);
  }
  return {
    kind: "unknown",
    summary: "Unrecognized project (no language manifest found)",
    evidence: [],
    defaults: {},
  };
}

async function detectNode(root: string): Promise<ProjectInfo> {
  const evidence: string[] = ["package.json"];
  const pkg = (await readJson(path.join(root, "package.json"))) as
    | { scripts?: Record<string, string> }
    | undefined;
  const scripts = pkg?.scripts ?? {};

  const pm = await detectNodeRunner(root);
  if (pm !== "npm") evidence.push(lockfileFor(pm));

  const hasTs = await fileExists(path.join(root, "tsconfig.json"));
  if (hasTs) evidence.push("tsconfig.json");

  const runScript = (name: string) =>
    pm === "npm" ? `npm run ${name}` : `${pm} ${name}`;

  const defaults: ProjectDefaults = {
    install: pm === "npm" ? "npm install" : `${pm} install`,
  };
  if (scripts.build) defaults.build = runScript("build");
  if (scripts.test || scripts.tests) {
    defaults.test = runScript(scripts.test ? "test" : "tests");
  } else {
    defaults.test = `${pm} test`;
  }
  if (scripts.lint) defaults.lint = runScript("lint");
  if (scripts.typecheck || scripts["type-check"]) {
    defaults.typecheck = runScript(
      scripts.typecheck ? "typecheck" : "type-check",
    );
  } else if (hasTs) {
    defaults.typecheck = pm === "npm" ? "npx tsc --noEmit" : `${pm} exec tsc -- --noEmit`;
  }
  if (scripts.dev) defaults.run = runScript("dev");
  else if (scripts.start) defaults.run = runScript("start");

  const flavour = hasTs ? "TypeScript" : "JavaScript";
  return {
    kind: "node",
    summary: `Node.js (${flavour}) project · uses ${pm}`,
    evidence,
    defaults,
    hasTypeScript: hasTs,
    packageManager: pm,
  };
}

async function detectRust(root: string): Promise<ProjectInfo> {
  const evidence = ["Cargo.toml"];
  if (await fileExists(path.join(root, "Cargo.lock"))) evidence.push("Cargo.lock");
  return {
    kind: "rust",
    summary: "Rust project · uses cargo",
    evidence,
    defaults: {
      build: "cargo build",
      test: "cargo test",
      lint: "cargo clippy -- -D warnings",
      typecheck: "cargo check",
      run: "cargo run",
    },
  };
}

async function detectGo(root: string): Promise<ProjectInfo> {
  const evidence = ["go.mod"];
  if (await fileExists(path.join(root, "go.sum"))) evidence.push("go.sum");
  return {
    kind: "go",
    summary: "Go project · uses go modules",
    evidence,
    defaults: {
      build: "go build ./...",
      test: "go test ./...",
      lint: "go vet ./...",
      typecheck: "go build ./...",
    },
  };
}

async function detectPython(root: string): Promise<ProjectInfo> {
  const evidence: string[] = [];
  for (const name of [
    "pyproject.toml",
    "setup.py",
    "requirements.txt",
    "Pipfile",
    "poetry.lock",
  ]) {
    if (await fileExists(path.join(root, name))) evidence.push(name);
  }
  const usesPoetry = evidence.includes("poetry.lock");
  const usesPipenv = evidence.includes("Pipfile");
  const runner = usesPoetry ? "poetry run " : usesPipenv ? "pipenv run " : "";
  return {
    kind: "python",
    summary: `Python project${usesPoetry ? " · uses poetry" : usesPipenv ? " · uses pipenv" : ""}`,
    evidence,
    defaults: {
      test: `${runner}pytest`,
      lint: `${runner}ruff check .`,
      typecheck: `${runner}mypy .`,
      install: usesPoetry
        ? "poetry install"
        : usesPipenv
          ? "pipenv install"
          : "pip install -r requirements.txt",
    },
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readJson(p: string): Promise<unknown | undefined> {
  try {
    const text = await fs.readFile(p, "utf8");
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function detectNodeRunner(root: string): Promise<NodePackageManager> {
  if (await fileExists(path.join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (await fileExists(path.join(root, "yarn.lock"))) return "yarn";
  if (await fileExists(path.join(root, "bun.lockb"))) return "bun";
  return "npm";
}

function lockfileFor(pm: NodePackageManager): string {
  switch (pm) {
    case "pnpm":
      return "pnpm-lock.yaml";
    case "yarn":
      return "yarn.lock";
    case "bun":
      return "bun.lockb";
    case "npm":
      return "package-lock.json";
  }
}

// ---------------------------------------------------------------------------
// formatProjectContext — render the detected project type as a system-prompt
// block. Returned undefined when we couldn't detect anything; callers should
// just omit the section.
// ---------------------------------------------------------------------------

export function formatProjectContext(info: ProjectInfo): string | undefined {
  if (info.kind === "unknown") return undefined;
  const lines: string[] = [];
  lines.push(`Detected: ${info.summary}.`);
  if (info.evidence.length > 0) {
    lines.push(`Evidence: ${info.evidence.join(", ")}.`);
  }
  const d = info.defaults;
  const cmds: string[] = [];
  if (d.install) cmds.push(`install: \`${d.install}\``);
  if (d.build) cmds.push(`build: \`${d.build}\``);
  if (d.test) cmds.push(`test: \`${d.test}\``);
  if (d.lint) cmds.push(`lint: \`${d.lint}\``);
  if (d.typecheck) cmds.push(`typecheck: \`${d.typecheck}\``);
  if (d.run) cmds.push(`run: \`${d.run}\``);
  if (cmds.length > 0) {
    lines.push(`Tuned defaults — ${cmds.join(", ")}.`);
  }
  lines.push(
    "Prefer the project's own toolchain. `run_checks` already knows these — use it for inner-loop feedback.",
  );
  return lines.join("\n");
}

import { spawn, spawnSync } from "node:child_process";

// ===========================================================================
// openInEditor — best-effort "show this file in the user's editor".
//
// Resolution order:
//   1. AXON_NO_EDITOR=1                 → disabled.
//   2. AXON_EDITOR_CMD="code -r"        → use it (split on whitespace).
//   3. `code` on PATH                   → `code -r <file>` (reuses window).
//   4. otherwise                        → no-op.
//
// We never auto-launch terminal editors (vi/vim/nano/...) — they'd hijack
// the TUI. The spawned child is detached and unref'd so the TUI keeps
// going and exiting axon doesn't tear the editor down.
// ===========================================================================

let cached: string[] | null | undefined = undefined;

function detect(): string[] | null {
  if (process.env.AXON_NO_EDITOR) return null;
  const override = process.env.AXON_EDITOR_CMD?.trim();
  if (override) {
    const parts = override.split(/\s+/).filter(Boolean);
    return parts.length ? parts : null;
  }
  if (onPath("code")) return ["code", "-r"];
  return null;
}

function onPath(bin: string): boolean {
  try {
    const which = process.platform === "win32" ? "where" : "which";
    const r = spawnSync(which, [bin], { stdio: "ignore" });
    return r.status === 0;
  } catch {
    return false;
  }
}

export function openInEditor(absPath: string): void {
  if (cached === undefined) cached = detect();
  if (!cached) return;
  try {
    const child = spawn(cached[0], [...cached.slice(1), absPath], {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", () => {
      /* swallow — editor isn't available or refused to start */
    });
    child.unref();
  } catch {
    /* ignore */
  }
}

export function editorAvailable(): boolean {
  if (cached === undefined) cached = detect();
  return cached !== null;
}

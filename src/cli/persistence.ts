import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

// ===========================================================================
// persistence — session snapshots saved under <workspace>/.axon/sessions/
//
// Snapshot is the minimum state the TUI needs to feel like the same
// conversation after a restart: chat transcript, context-start pointer,
// any auto-compaction summary, the "always-allowed" tool list, and
// cumulative token usage.
//
// We deliberately keep the schema small and versioned so we can migrate
// without losing user data. Reads of newer schema versions fail soft —
// the user gets a clear error rather than a silently broken resume.
// ===========================================================================

export const SESSIONS_DIR = ".axon/sessions";
export const SCHEMA_VERSION = 1;

export interface SnapshotItem {
  id: number;
  role: "user" | "assistant" | "system";
  content: string;
}

export interface SessionSnapshot {
  v: number;
  id: string;
  workspaceRoot: string;
  createdAt: string;
  updatedAt: string;
  // First-line preview of the first user message, used in /sessions
  // listings. Updated on first save and never again.
  title: string;
  items: SnapshotItem[];
  contextStart: number;
  summary: string | null;
  alwaysAllowed: string[];
  sessionUsage: { input: number; output: number };
}

export function newSessionId(): string {
  const date = new Date().toISOString().slice(0, 10);
  const rand = randomBytes(3).toString("hex");
  return `${date}-${rand}`;
}

function sessionsRoot(workspaceRoot: string): string {
  return path.join(workspaceRoot, SESSIONS_DIR);
}

function sessionPath(workspaceRoot: string, id: string): string {
  // Be paranoid: refuse anything that could escape the sessions directory.
  if (!/^[A-Za-z0-9._-]+$/.test(id)) {
    throw new Error(`invalid session id: ${id}`);
  }
  return path.join(sessionsRoot(workspaceRoot), `${id}.json`);
}

export async function saveSession(
  snapshot: SessionSnapshot,
): Promise<void> {
  const dir = sessionsRoot(snapshot.workspaceRoot);
  await fs.mkdir(dir, { recursive: true });
  const full = sessionPath(snapshot.workspaceRoot, snapshot.id);
  const data = JSON.stringify({ ...snapshot, v: SCHEMA_VERSION }, null, 2);
  // Atomic-ish: write to a sibling tmp then rename.
  const tmp = `${full}.${process.pid}.tmp`;
  await fs.writeFile(tmp, data, "utf8");
  await fs.rename(tmp, full);
}

export async function loadSession(
  workspaceRoot: string,
  id: string,
): Promise<SessionSnapshot> {
  const full = sessionPath(workspaceRoot, id);
  const raw = await fs.readFile(full, "utf8");
  const parsed = JSON.parse(raw) as Partial<SessionSnapshot>;
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`session ${id} is corrupted (not an object)`);
  }
  if ((parsed.v ?? 0) > SCHEMA_VERSION) {
    throw new Error(
      `session ${id} was written by a newer axon (schema v${parsed.v}); please upgrade`,
    );
  }
  // Defensive defaults for forward-compatibility.
  return {
    v: SCHEMA_VERSION,
    id: parsed.id ?? id,
    workspaceRoot: parsed.workspaceRoot ?? workspaceRoot,
    createdAt: parsed.createdAt ?? new Date().toISOString(),
    updatedAt: parsed.updatedAt ?? new Date().toISOString(),
    title: parsed.title ?? "(untitled session)",
    items: parsed.items ?? [],
    contextStart: parsed.contextStart ?? 0,
    summary: parsed.summary ?? null,
    alwaysAllowed: parsed.alwaysAllowed ?? [],
    sessionUsage: parsed.sessionUsage ?? { input: 0, output: 0 },
  };
}

export interface SessionListEntry {
  id: string;
  title: string;
  updatedAt: string;
  turns: number;
}

export async function listSessions(
  workspaceRoot: string,
): Promise<SessionListEntry[]> {
  const dir = sessionsRoot(workspaceRoot);
  let names: string[] = [];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: SessionListEntry[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -5);
    try {
      const snap = await loadSession(workspaceRoot, id);
      out.push({
        id: snap.id,
        title: snap.title,
        updatedAt: snap.updatedAt,
        turns: snap.items.filter((i) => i.role !== "system").length,
      });
    } catch {
      /* skip corrupt entries */
    }
  }
  out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return out;
}

export async function latestSessionId(
  workspaceRoot: string,
): Promise<string | undefined> {
  const entries = await listSessions(workspaceRoot);
  return entries[0]?.id;
}

export async function deleteSession(
  workspaceRoot: string,
  id: string,
): Promise<void> {
  const full = sessionPath(workspaceRoot, id);
  try {
    await fs.unlink(full);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

export function titleFromItems(items: SnapshotItem[]): string {
  const firstUser = items.find((i) => i.role === "user");
  if (!firstUser) return "(empty session)";
  const firstLine = firstUser.content.split("\n", 1)[0] ?? "";
  return firstLine.length > 80
    ? `${firstLine.slice(0, 77)}…`
    : firstLine;
}

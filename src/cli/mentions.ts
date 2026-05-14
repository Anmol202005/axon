import { promises as fs } from "node:fs";
import path from "node:path";

// ===========================================================================
// mentions — expand @file references in a user message into <file> blocks
// the model can read.
//
// Forms accepted:
//   @path/to/file               whole file
//   @path/to/file:42            single line
//   @path/to/file:10-20         line range (inclusive, 1-indexed)
//
// Rules:
//   • Path is workspace-relative and must resolve inside workspaceRoot.
//   • Mentions that don't resolve to a real file are left in the text
//     verbatim (no expansion, no error) — typos shouldn't crash the turn.
//   • The original user message is preserved unchanged; expanded file
//     blocks are appended at the end so the transcript still reads as the
//     user wrote it.
//   • Per-file cap (MAX_FILE_CHARS) and per-message cap (MAX_TOTAL_CHARS)
//     keep a wildly large file from blowing the context window.
// ===========================================================================

const MAX_FILE_CHARS = 64_000;
const MAX_TOTAL_CHARS = 200_000;
const MAX_MENTIONS = 16;

// Path chars: alnum / _ / - / . / / and trailing :N or :N-N optional.
// Anchored on a word boundary so we don't catch email-style @ in the middle
// of identifiers. Avoid trailing punctuation by not allowing it in the path.
const MENTION_RE =
  /(^|[\s(\[{,;])@([A-Za-z0-9._\-/]+(?::\d+(?:-\d+)?)?)/g;

export interface ParsedMention {
  // The full matched text (without the leading separator), e.g. "@src/foo.ts:10-20".
  raw: string;
  // Workspace-relative path the user referenced.
  filePath: string;
  // 1-indexed line range, if specified.
  start?: number;
  end?: number;
}

export function parseMentions(text: string): ParsedMention[] {
  const out: ParsedMention[] = [];
  for (const m of text.matchAll(MENTION_RE)) {
    const body = m[2];
    const colon = body.indexOf(":");
    let filePath = body;
    let start: number | undefined;
    let end: number | undefined;
    if (colon !== -1) {
      filePath = body.slice(0, colon);
      const range = body.slice(colon + 1);
      const dash = range.indexOf("-");
      if (dash === -1) {
        start = end = Number(range);
      } else {
        start = Number(range.slice(0, dash));
        end = Number(range.slice(dash + 1));
      }
      if (!Number.isFinite(start) || !Number.isFinite(end)) {
        start = end = undefined;
      }
    }
    out.push({ raw: `@${body}`, filePath, start, end });
    if (out.length >= MAX_MENTIONS) break;
  }
  return out;
}

export interface ExpansionResult {
  // The full message to send to the agent (original text + appended blocks).
  expanded: string;
  // Bookkeeping for diagnostics / UI (which mentions resolved, which didn't).
  resolved: string[];
  skipped: string[];
}

export async function expandMentions(
  text: string,
  workspaceRoot: string,
): Promise<ExpansionResult> {
  const mentions = parseMentions(text);
  if (mentions.length === 0) {
    return { expanded: text, resolved: [], skipped: [] };
  }

  const root = path.resolve(workspaceRoot);
  const blocks: string[] = [];
  const resolved: string[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  let total = 0;

  for (const m of mentions) {
    // De-duplicate identical mentions (same path + same range).
    const key = `${m.filePath}:${m.start ?? ""}-${m.end ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // Resolve safely inside workspaceRoot.
    const abs = path.resolve(root, m.filePath);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      skipped.push(m.raw);
      continue;
    }

    let content: string;
    try {
      content = await fs.readFile(abs, "utf8");
    } catch {
      skipped.push(m.raw);
      continue;
    }

    let slice = content;
    let rangeNote = "";
    if (m.start != null && m.end != null) {
      const lines = content.split("\n");
      const lo = Math.max(1, Math.min(m.start, m.end));
      const hi = Math.min(lines.length, Math.max(m.start, m.end));
      slice = lines.slice(lo - 1, hi).join("\n");
      rangeNote = ` lines="${lo}-${hi}"`;
    }
    if (slice.length > MAX_FILE_CHARS) {
      slice =
        slice.slice(0, MAX_FILE_CHARS) +
        `\n… [truncated; full file is ${content.length} chars]`;
    }
    if (total + slice.length > MAX_TOTAL_CHARS) {
      skipped.push(m.raw);
      continue;
    }
    total += slice.length;
    blocks.push(`<file path="${m.filePath}"${rangeNote}>\n${slice}\n</file>`);
    resolved.push(m.raw);
  }

  if (blocks.length === 0) {
    return { expanded: text, resolved, skipped };
  }
  const expanded = `${text}\n\n${blocks.join("\n\n")}`;
  return { expanded, resolved, skipped };
}

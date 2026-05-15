// ===========================================================================
// tokens — coarse context-window accounting for the TUI.
//
// We deliberately avoid a real tokenizer here: shipping one would mean
// either a model-specific dependency (tiktoken / @anthropic-ai/tokenizer)
// that drifts when the model changes, or a heavy WASM blob. A 4-chars
// ≈ 1-token heuristic is wrong by ~10-20% on code and prose, which is
// fine for a UI indicator and a "compact at 80%" trigger. The agent
// itself doesn't act on these numbers — only the user-facing readout and
// the auto-compaction decision does.
// ===========================================================================

const DEFAULT_LIMIT = 200_000;
const COMPACT_FRACTION = 0.8;

export function contextLimit(): number {
  const raw = process.env.AXON_CTX_LIMIT;
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return DEFAULT_LIMIT;
}

export function compactThreshold(): number {
  return Math.floor(contextLimit() * COMPACT_FRACTION);
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export function estimateMessagesTokens(
  messages: { content: string }[],
): number {
  let total = 0;
  for (const m of messages) total += estimateTokens(m.content);
  // Small per-message overhead for role markers / formatting.
  total += messages.length * 4;
  return total;
}

export interface ContextUsage {
  used: number;
  limit: number;
  pct: number;
  // "green" < 50, "yellow" 50-80, "red" >= 80.
  level: "green" | "yellow" | "red";
}

export function contextUsage(used: number): ContextUsage {
  const limit = contextLimit();
  const pct = Math.min(100, Math.round((used / limit) * 100));
  const level: ContextUsage["level"] =
    pct < 50 ? "green" : pct < 80 ? "yellow" : "red";
  return { used, limit, pct, level };
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

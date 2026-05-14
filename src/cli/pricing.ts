// ===========================================================================
// pricing — convert token counts into a dollar estimate for the UI meter.
//
// Per-million-token rates can be supplied via env so we don't hardcode
// public prices that drift. If both env vars are set we use them; otherwise
// we fall through to a small lookup keyed by common model substrings.
//
//   AXON_PRICE_INPUT  — USD per 1M input tokens
//   AXON_PRICE_OUTPUT — USD per 1M output tokens
//
// All numbers here are estimates intended for a footer readout, not an
// invoice — model providers publish authoritative pricing on their sites.
// ===========================================================================

const FALLBACK_TABLE: Array<{ match: RegExp; input: number; output: number }> = [
  // Anthropic — list prices as of late 2025 (USD / 1M tokens)
  { match: /claude.*opus/i, input: 15, output: 75 },
  { match: /claude.*sonnet/i, input: 3, output: 15 },
  { match: /claude.*haiku/i, input: 0.8, output: 4 },
  // OpenAI
  { match: /gpt-4o-mini|4o-mini/i, input: 0.15, output: 0.6 },
  { match: /gpt-4o|4o\b/i, input: 2.5, output: 10 },
  { match: /gpt-4\.1/i, input: 2, output: 8 },
  { match: /o1-mini/i, input: 1.1, output: 4.4 },
  { match: /o1\b/i, input: 15, output: 60 },
];

export interface PriceRate {
  input: number;
  output: number;
  source: "env" | "table" | "unknown";
}

export function priceRate(modelName?: string): PriceRate {
  const envIn = Number(process.env.AXON_PRICE_INPUT);
  const envOut = Number(process.env.AXON_PRICE_OUTPUT);
  if (Number.isFinite(envIn) && Number.isFinite(envOut)) {
    return { input: envIn, output: envOut, source: "env" };
  }
  if (modelName) {
    for (const row of FALLBACK_TABLE) {
      if (row.match.test(modelName)) {
        return { input: row.input, output: row.output, source: "table" };
      }
    }
  }
  return { input: 0, output: 0, source: "unknown" };
}

export function computeCost(
  input: number,
  output: number,
  rate: PriceRate,
): number {
  return (input * rate.input + output * rate.output) / 1_000_000;
}

export function formatCost(usd: number): string {
  if (usd <= 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

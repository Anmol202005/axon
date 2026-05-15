import { tool } from "langchain";
import { z } from "zod";
import type { Logger } from "../types.js";

// ===========================================================================
// web tools — search and URL fetch for live information
// ===========================================================================

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_BYTES = 2_000_000; // 2 MB
const MAX_OUTPUT_CHARS = 12_000;
const DEFAULT_SEARCH_RESULTS = 6;
const MAX_SEARCH_RESULTS = 15;

const USER_AGENT =
  "axon-cli/1.0 (+https://github.com/Anmol202005/axon)";

export function createWebTools(
  log: Logger | undefined,
  indent: string,
  abortSignal?: AbortSignal,
) {
  const fetchTool = tool(
    async ({ url, timeoutMs }) => {
      const timeout = clampTimeout(timeoutMs);
      const parsed = parseUrl(url);
      if (!parsed) return `Error: '${url}' is not a valid http(s) URL.`;

      log?.("info", `${indent}↗ fetch ${truncateOneLine(url, 100)}`);

      const result = await fetchUrl(url, timeout, abortSignal);
      if (result.error) {
        log?.("warn", `${indent}↗ fetch failed: ${result.error}`);
        return `Error fetching ${url}: ${result.error}`;
      }

      const { status, contentType, text } = result;
      const isHtml = /text\/html|application\/xhtml\+xml/i.test(
        contentType ?? "",
      );
      const body = isHtml ? htmlToText(text) : text;
      const truncated =
        body.length > MAX_OUTPUT_CHARS
          ? body.slice(0, MAX_OUTPUT_CHARS) +
            `\n... [${body.length - MAX_OUTPUT_CHARS} chars truncated] ...`
          : body;

      log?.(
        "info",
        `${indent}↗ fetch ok · ${status} · ${body.length} chars${isHtml ? " (html→text)" : ""}`,
      );

      const header = `${status} · ${contentType ?? "unknown content-type"} · ${body.length} chars${
        isHtml ? " (html stripped)" : ""
      }`;
      return `${header}\n\n${truncated}`;
    },
    {
      name: "web_fetch",
      description:
        "Fetch a URL and return its text content. HTML pages are converted to readable text (script/style stripped). Use for documentation pages, RFCs, READMEs, changelogs, or anything where you need the actual content of a known link. For exploratory queries, use `web_search` first.",
      schema: z.object({
        url: z.string().describe("Absolute http(s) URL to fetch."),
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

  const searchTool = tool(
    async ({ query, maxResults, timeoutMs }) => {
      const timeout = clampTimeout(timeoutMs);
      const limit = Math.min(
        Math.max(1, Math.floor(maxResults ?? DEFAULT_SEARCH_RESULTS)),
        MAX_SEARCH_RESULTS,
      );

      const apiKey = process.env.SERPER_API_KEY?.trim();
      if (!apiKey) {
        return (
          "Error: SERPER_API_KEY is not set. " +
          "web_search uses serper.dev (Google results). " +
          "Sign up at https://serper.dev for a free key (2,500 queries) and " +
          "export SERPER_API_KEY=<key> in your shell, then retry."
        );
      }

      log?.("info", `${indent}⌕ web "${truncateOneLine(query, 80)}"`);

      const result = await serperSearch(query, limit, apiKey, timeout, abortSignal);
      if (result.error) {
        return `Error running web search: ${result.error}`;
      }
      if (result.results.length === 0) {
        return "(no results — serper returned an empty result set; try different terms)";
      }
      log?.("info", `${indent}⌕ web → ${result.results.length} result(s)`);

      const lines = result.results.map(
        (r, i) =>
          `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`,
      );
      const header = result.answer
        ? `Answer: ${result.answer}\n\n`
        : "";
      return header + lines.join("\n\n");
    },
    {
      name: "web_search",
      description:
        "Search the web (Google, via serper.dev) for a query and return a list of result titles, URLs, and snippets, plus an instant-answer when Google has one. Use this to find documentation, GitHub issues, blog posts, or recent answers when you don't already have a URL. Follow up with `web_fetch` to read a specific result. Requires the SERPER_API_KEY environment variable.",
      schema: z.object({
        query: z.string().describe("Search query string."),
        maxResults: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            `How many results to return. Default ${DEFAULT_SEARCH_RESULTS}, max ${MAX_SEARCH_RESULTS}.`,
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

  return [searchTool, fetchTool];
}

interface FetchResult {
  status: number;
  contentType?: string;
  text: string;
  error?: string;
}

async function fetchUrl(
  url: string,
  timeoutMs: number,
  abortSignal?: AbortSignal,
): Promise<FetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onParentAbort = () => controller.abort();
  abortSignal?.addEventListener("abort", onParentAbort, { once: true });

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": USER_AGENT,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    const contentType =
      res.headers.get("content-type")?.split(";")[0]?.trim() ?? undefined;

    if (!res.body) {
      return { status: res.status, contentType, text: "" };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: false });
    let text = "";
    let bytes = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
      if (bytes > MAX_BYTES) {
        text += `\n... [response exceeded ${MAX_BYTES} bytes; truncated] ...`;
        try {
          await reader.cancel();
        } catch {
          // ignore
        }
        break;
      }
    }
    text += decoder.decode();
    return { status: res.status, contentType, text };
  } catch (err) {
    const aborted =
      abortSignal?.aborted ||
      (err instanceof Error && /aborted/i.test(err.message));
    const message = aborted
      ? abortSignal?.aborted
        ? "cancelled by user"
        : `timeout after ${timeoutMs}ms`
      : err instanceof Error
        ? err.message
        : String(err);
    return { status: 0, text: "", error: message };
  } finally {
    clearTimeout(timer);
    abortSignal?.removeEventListener("abort", onParentAbort);
  }
}

function parseUrl(url: string): URL | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// htmlToText — keep the visible text of an HTML document. Drops script/style,
// converts a few block-level tags to newlines, and decodes basic entities.
// Good enough for the model to read docs, READMEs, blog posts, etc.
// ---------------------------------------------------------------------------
function htmlToText(html: string): string {
  let s = html;
  s = s.replace(/<script[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<\s*(br|hr)\s*\/?>/gi, "\n");
  s = s.replace(
    /<\s*\/\s*(p|div|li|tr|h[1-6]|section|article|header|footer|nav|ul|ol|pre|blockquote)\s*>/gi,
    "\n",
  );
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  s = s.replace(/[ \t\f\v]+/g, " ");
  s = s.replace(/\n[ \t]+/g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => {
      const code = parseInt(n, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    });
}

interface SearchResultRow {
  title: string;
  url: string;
  snippet: string;
}

interface SerperResponse {
  results: SearchResultRow[];
  answer?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// serperSearch — call serper.dev's /search endpoint and normalize the
// response. Serper proxies Google and returns a JSON envelope with
// `organic[]` for regular results plus optional `answerBox` / `knowledgeGraph`
// blocks. We flatten the answer box into a single string and surface the
// organic results as titled snippets.
// ---------------------------------------------------------------------------
async function serperSearch(
  query: string,
  limit: number,
  apiKey: string,
  timeoutMs: number,
  abortSignal?: AbortSignal,
): Promise<SerperResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onParentAbort = () => controller.abort();
  abortSignal?.addEventListener("abort", onParentAbort, { once: true });

  try {
    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "X-API-KEY": apiKey,
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify({ q: query, num: limit }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const detail = body ? `: ${truncateOneLine(body, 200)}` : "";
      return {
        results: [],
        error: `serper.dev returned HTTP ${res.status}${detail}`,
      };
    }

    const json = (await res.json()) as Record<string, unknown>;
    const organic = Array.isArray(json.organic)
      ? (json.organic as Record<string, unknown>[])
      : [];
    const results: SearchResultRow[] = organic
      .map((row) => ({
        title: typeof row.title === "string" ? row.title : "",
        url: typeof row.link === "string" ? row.link : "",
        snippet: typeof row.snippet === "string" ? row.snippet : "",
      }))
      .filter((r) => r.title && r.url)
      .slice(0, limit);

    const answer = extractAnswer(json);
    return { results, answer };
  } catch (err) {
    const aborted =
      abortSignal?.aborted ||
      (err instanceof Error && /aborted/i.test(err.message));
    const message = aborted
      ? abortSignal?.aborted
        ? "cancelled by user"
        : `timeout after ${timeoutMs}ms`
      : err instanceof Error
        ? err.message
        : String(err);
    return { results: [], error: message };
  } finally {
    clearTimeout(timer);
    abortSignal?.removeEventListener("abort", onParentAbort);
  }
}

function extractAnswer(json: Record<string, unknown>): string | undefined {
  const answerBox = json.answerBox as Record<string, unknown> | undefined;
  if (answerBox) {
    const fields = ["answer", "snippet", "title"] as const;
    for (const f of fields) {
      const v = answerBox[f];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  const kg = json.knowledgeGraph as Record<string, unknown> | undefined;
  if (kg && typeof kg.description === "string" && kg.description.trim()) {
    return kg.description.trim();
  }
  return undefined;
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

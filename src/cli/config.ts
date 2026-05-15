import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// ===========================================================================
// config — user-level BYOK config at ~/.axon/config.json
//
// Stores the model provider, API key, and optional web-search key so the
// user only goes through onboarding once. The file is chmod 0600 because
// it contains secrets; treat any read failure as "no config" rather than
// crashing the CLI.
//
// Env vars (AI_PROVIDER, AI_MODEL, AI_API_KEY, AI_ENDPOINT, SERPER_API_KEY)
// still win when present so .env files and CI shells can override the
// saved config without rewriting it.
// ===========================================================================

export type Provider = "anthropic" | "openai";

export interface AxonConfig {
  v: 1;
  provider: Provider;
  model: string;
  apiKey: string;
  // OpenAI-compatible base URL. Anthropic ignores this (uses SDK default).
  endpoint?: string;
  // Optional — gates the `web_search` tool. Missing key disables search.
  serperApiKey?: string;
}

const SCHEMA_VERSION = 1 as const;

export function configDir(): string {
  return path.join(os.homedir(), ".axon");
}

export function configPath(): string {
  return path.join(configDir(), "config.json");
}

export async function loadConfig(): Promise<AxonConfig | null> {
  try {
    const raw = await fs.readFile(configPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<AxonConfig>;
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.provider !== "anthropic" && parsed.provider !== "openai") {
      return null;
    }
    if (typeof parsed.apiKey !== "string" || !parsed.apiKey) return null;
    if (typeof parsed.model !== "string" || !parsed.model) return null;
    return {
      v: SCHEMA_VERSION,
      provider: parsed.provider,
      model: parsed.model,
      apiKey: parsed.apiKey,
      endpoint:
        typeof parsed.endpoint === "string" && parsed.endpoint
          ? parsed.endpoint
          : undefined,
      serperApiKey:
        typeof parsed.serperApiKey === "string" && parsed.serperApiKey
          ? parsed.serperApiKey
          : undefined,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

export async function saveConfig(cfg: AxonConfig): Promise<void> {
  const dir = configDir();
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const full = configPath();
  const data = JSON.stringify({ ...cfg, v: SCHEMA_VERSION }, null, 2);
  const tmp = `${full}.${process.pid}.tmp`;
  await fs.writeFile(tmp, data, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, full);
  // chmod again in case rename preserved an older mode.
  try {
    await fs.chmod(full, 0o600);
  } catch {
    /* best effort */
  }
}

// ---------------------------------------------------------------------------
// Active-config holder. The CLI loads config once at boot (or after
// onboarding) and stashes it here so the rest of the codebase can ask for
// it synchronously without re-reading the file or threading it through
// every call site. /setup updates it in-place.
// ---------------------------------------------------------------------------
let activeConfig: AxonConfig | null = null;

export function getActiveConfig(): AxonConfig | null {
  return activeConfig;
}

// Throwing accessor — use from code paths that can't proceed without a
// config (model factory, web_search tool). Should never fire in practice
// because boot blocks on onboarding when the file is missing.
export function requireActiveConfig(): AxonConfig {
  if (!activeConfig) {
    throw new Error(
      "axon: no active config — run `axon` once and complete onboarding (or `axon --setup`).",
    );
  }
  return activeConfig;
}

export function setActiveConfig(cfg: AxonConfig): void {
  activeConfig = cfg;
}

import React, { useState, useCallback } from "react";
import { Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import Spinner from "ink-spinner";
import { Logo } from "./Logo.js";
import { Theme } from "./theme.js";
import {
  saveConfig,
  type AxonConfig,
  type Provider,
} from "./config.js";

// ===========================================================================
// Onboarding — first-run BYOK setup. Multi-step Ink form that collects:
//   provider → (endpoint, only for openai-compat) → api key → model
//   → optional serper key → save.
//
// On completion we hand the saved config back to the host via onComplete so
// it can apply it to process.env and mount the main App. The component
// itself never touches process.env directly — that's the host's job.
// ===========================================================================

type Step =
  | "provider"
  | "endpoint"
  | "apiKey"
  | "model"
  | "serper"
  | "saving"
  | "error";

const DEFAULT_OPENAI_ENDPOINT = "https://api.openai.com/v1";
const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-5";
const DEFAULT_OPENAI_MODEL = "gpt-4o";

const PROVIDER_OPTIONS: Array<{
  value: Provider;
  label: string;
  blurb: string;
}> = [
  {
    value: "anthropic",
    label: "Anthropic (Claude)",
    blurb:
      "native SDK — prompt caching + extended thinking. Needs an sk-ant-… key from console.anthropic.com.",
  },
  {
    value: "openai",
    label: "OpenAI-compatible",
    blurb:
      "any endpoint that speaks OpenAI's API — OpenAI, OpenRouter, Groq, Together, DeepSeek, Ollama, LM Studio…",
  },
];

export interface OnboardingProps {
  onComplete: (cfg: AxonConfig) => void;
  initial?: Partial<AxonConfig>;
  // Shown above the form. "first run" on cold boot, "/setup" when re-running.
  reason?: string;
  // When set, esc dismisses the form via this callback instead of quitting
  // the process. Used by the in-session /setup flow.
  onCancel?: () => void;
  // Hides the big logo. Useful when re-running inside an active session
  // where the chat history is already on screen.
  compact?: boolean;
}

export function Onboarding({
  onComplete,
  initial,
  reason,
  onCancel,
  compact,
}: OnboardingProps) {
  const { exit } = useApp();
  // Always start at the provider step so /setup and --setup let the user
  // change anything, not just the fields after their current provider.
  const [step, setStep] = useState<Step>("provider");
  const [provider, setProvider] = useState<Provider>(
    initial?.provider ?? "anthropic",
  );
  const [providerIndex, setProviderIndex] = useState<number>(
    initial?.provider === "openai" ? 1 : 0,
  );
  const [endpoint, setEndpoint] = useState<string>(
    initial?.endpoint ?? DEFAULT_OPENAI_ENDPOINT,
  );
  const [apiKey, setApiKey] = useState<string>(initial?.apiKey ?? "");
  const [model, setModel] = useState<string>(initial?.model ?? "");
  const [serper, setSerper] = useState<string>(initial?.serperApiKey ?? "");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useInput(
    (_input, key) => {
      if (key.escape) {
        if (onCancel) onCancel();
        else exit();
        return;
      }
      if (step !== "provider") return;
      if (key.upArrow) {
        setProviderIndex((i) =>
          (i - 1 + PROVIDER_OPTIONS.length) % PROVIDER_OPTIONS.length,
        );
      } else if (key.downArrow) {
        setProviderIndex((i) => (i + 1) % PROVIDER_OPTIONS.length);
      } else if (key.return) {
        const picked = PROVIDER_OPTIONS[providerIndex].value;
        setProvider(picked);
        // Endpoint step only makes sense for openai-compatible providers.
        setStep(picked === "anthropic" ? "apiKey" : "endpoint");
      }
    },
    { isActive: step === "provider" || step === "error" },
  );

  const persist = useCallback(
    async (cfg: AxonConfig) => {
      setStep("saving");
      try {
        await saveConfig(cfg);
        onComplete(cfg);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setErrorMsg(`could not save config: ${msg}`);
        setStep("error");
      }
    },
    [onComplete],
  );

  const handleEndpointSubmit = useCallback((value: string) => {
    const trimmed = value.trim() || DEFAULT_OPENAI_ENDPOINT;
    setEndpoint(trimmed);
    setStep("apiKey");
  }, []);

  const handleApiKeySubmit = useCallback(
    (value: string) => {
      const trimmed = value.trim();
      if (!trimmed) {
        setErrorMsg("API key cannot be empty.");
        return;
      }
      // The field is masked, so a wrong-clipboard paste is invisible. Catch
      // the most common one (the endpoint URL) before it lands in the saved
      // config and produces a confusing 401 later.
      if (/^https?:\/\//i.test(trimmed)) {
        setErrorMsg(
          "That looks like a URL, not an API key. Clear the field and paste the key.",
        );
        return;
      }
      if (trimmed.length < 16) {
        setErrorMsg(
          `That's only ${trimmed.length} chars — API keys are usually 30+. Double-check the paste.`,
        );
        return;
      }
      setErrorMsg(null);
      setApiKey(trimmed);
      setStep("model");
    },
    [],
  );

  const handleModelSubmit = useCallback(
    (value: string) => {
      const fallback =
        provider === "anthropic"
          ? DEFAULT_ANTHROPIC_MODEL
          : DEFAULT_OPENAI_MODEL;
      const trimmed = value.trim() || fallback;
      setModel(trimmed);
      setStep("serper");
    },
    [provider],
  );

  const handleSerperSubmit = useCallback(
    (value: string) => {
      const trimmed = value.trim();
      void persist({
        v: 1,
        provider,
        model:
          model ||
          (provider === "anthropic"
            ? DEFAULT_ANTHROPIC_MODEL
            : DEFAULT_OPENAI_MODEL),
        apiKey,
        endpoint: provider === "openai" ? endpoint : undefined,
        serperApiKey: trimmed || undefined,
      });
    },
    [persist, provider, model, apiKey, endpoint],
  );

  const stepNumber = STEP_ORDER[step] ?? 0;
  const totalSteps = provider === "anthropic" ? 4 : 5;

  const cancelHint = onCancel ? "  ·  esc cancel" : "  ·  esc quit";

  return (
    <Box flexDirection="column" paddingY={1}>
      {!compact && <Logo />}
      <Box marginTop={compact ? 0 : 1} marginBottom={1}>
        <Text color={Theme.muted}>
          {reason ?? "first-run setup — bring your own keys. stored in "}
        </Text>
        <Text>~/.axon/config.json</Text>
      </Box>

      {step === "provider" && (
        <Box flexDirection="column">
          <StepHeader n={1} total={totalSteps} title="pick a provider" />
          <Box flexDirection="column" marginTop={1}>
            {PROVIDER_OPTIONS.map((opt, i) => {
              const active = i === providerIndex;
              return (
                <Box key={opt.value} flexDirection="column" marginBottom={1}>
                  <Box>
                    <Text bold={active}>{active ? "▶ " : "  "}</Text>
                    <Text bold={active}>{opt.label}</Text>
                  </Box>
                  <Box paddingLeft={4}>
                    <Text color={Theme.muted}>{opt.blurb}</Text>
                  </Box>
                </Box>
              );
            })}
          </Box>
          <Hint text={`↑/↓ select  ·  ↵ continue${cancelHint}`} />
        </Box>
      )}

      {step === "endpoint" && (
        <Box flexDirection="column">
          <StepHeader n={2} total={totalSteps} title="API endpoint" />
          <Description text={`OpenAI-compatible base URL. Press ↵ to use the default (${DEFAULT_OPENAI_ENDPOINT}). Examples: https://openrouter.ai/api/v1, https://api.groq.com/openai/v1, http://localhost:11434/v1 for Ollama.`} />
          <InputRow>
            <TextInput
              value={endpoint}
              onChange={setEndpoint}
              onSubmit={handleEndpointSubmit}
              placeholder={DEFAULT_OPENAI_ENDPOINT}
            />
          </InputRow>
          <Hint text={`↵ continue${cancelHint}`} />
        </Box>
      )}

      {step === "apiKey" && (
        <Box flexDirection="column">
          <StepHeader
            n={provider === "anthropic" ? 2 : 3}
            total={totalSteps}
            title="API key"
          />
          <Description
            text={
              provider === "anthropic"
                ? "Anthropic API key (sk-ant-…). Get one at console.anthropic.com."
                : "API key for the endpoint above. Get an OpenAI key at platform.openai.com, OpenRouter at openrouter.ai/keys, etc."
            }
          />
          <InputRow>
            <TextInput
              value={apiKey}
              onChange={(v) => {
                setApiKey(v);
                if (errorMsg) setErrorMsg(null);
              }}
              onSubmit={handleApiKeySubmit}
              mask="•"
              placeholder="paste your key and press ↵"
            />
          </InputRow>
          {apiKey.length > 0 && (
            <Box marginTop={1}>
              <Text color={Theme.muted}>
                {`${apiKey.length} chars`}
                {apiKey.length >= 4 ? `  ·  ends in …${apiKey.slice(-4)}` : ""}
              </Text>
            </Box>
          )}
          {errorMsg && (
            <Box marginTop={1}>
              <Text color={Theme.error}>✗ {errorMsg}</Text>
            </Box>
          )}
          <Hint text={`↵ continue  ·  input is masked${cancelHint}`} />
        </Box>
      )}

      {step === "model" && (
        <Box flexDirection="column">
          <StepHeader
            n={provider === "anthropic" ? 3 : 4}
            total={totalSteps}
            title="model"
          />
          <Description
            text={
              provider === "anthropic"
                ? `Anthropic model id. Default ${DEFAULT_ANTHROPIC_MODEL}. Other options: claude-opus-4, claude-haiku-3-5.`
                : `Model id for this endpoint. Default ${DEFAULT_OPENAI_MODEL}. For OpenRouter use ids like anthropic/claude-sonnet-4 or meta-llama/llama-3.3-70b-instruct.`
            }
          />
          <InputRow>
            <TextInput
              value={model}
              onChange={setModel}
              onSubmit={handleModelSubmit}
              placeholder={
                provider === "anthropic"
                  ? DEFAULT_ANTHROPIC_MODEL
                  : DEFAULT_OPENAI_MODEL
              }
            />
          </InputRow>
          <Hint text={`↵ continue (blank uses default)${cancelHint}`} />
        </Box>
      )}

      {step === "serper" && (
        <Box flexDirection="column">
          <StepHeader
            n={provider === "anthropic" ? 4 : 5}
            total={totalSteps}
            title="web search key (optional)"
          />
          <Description text="The web_search tool uses serper.dev (Google results, 2,500 free queries on signup). Paste a key to enable it, or press ↵ to skip — you can add this later by re-running /setup." />
          <InputRow>
            <TextInput
              value={serper}
              onChange={setSerper}
              onSubmit={handleSerperSubmit}
              mask="•"
              placeholder="leave blank to skip"
            />
          </InputRow>
          <Hint text={`↵ finish  ·  blank to skip${cancelHint}`} />
        </Box>
      )}

      {step === "saving" && (
        <Box marginTop={1}>
          <Text>
            <Spinner type="dots" />
          </Text>
          <Text>{"  saving config to ~/.axon/config.json…"}</Text>
        </Box>
      )}

      {step === "error" && (
        <Box flexDirection="column" marginTop={1}>
          <Box>
            <Text color={Theme.error}>✗ {errorMsg ?? "unknown error"}</Text>
          </Box>
          <Box marginTop={1}>
            <Text dimColor>press esc to quit and retry</Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}

const STEP_ORDER: Record<Step, number> = {
  provider: 1,
  endpoint: 2,
  apiKey: 3,
  model: 4,
  serper: 5,
  saving: 6,
  error: 6,
};

function StepHeader({
  n,
  total,
  title,
}: {
  n: number;
  total: number;
  title: string;
}) {
  return (
    <Box>
      <Text color={Theme.muted}>{`step ${n}/${total}  ·  `}</Text>
      <Text bold>{title}</Text>
    </Box>
  );
}

function Description({ text }: { text: string }) {
  return (
    <Box marginTop={1} marginBottom={1}>
      <Text color={Theme.muted}>{text}</Text>
    </Box>
  );
}

function InputRow({ children }: { children: React.ReactNode }) {
  return (
    <Box
      borderStyle="round"
      borderColor={Theme.border}
      paddingX={1}
      width="100%"
    >
      <Text bold>{"› "}</Text>
      <Box flexGrow={1}>{children}</Box>
    </Box>
  );
}

function Hint({ text }: { text: string }) {
  return (
    <Box marginTop={1}>
      <Text dimColor>{text}</Text>
    </Box>
  );
}

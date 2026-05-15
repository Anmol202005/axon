import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import type { Callbacks } from "@langchain/core/callbacks/manager";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { requireActiveConfig } from "../cli/config.js";

// ===========================================================================
// model — provider-aware factory. Reads the active BYOK config (loaded at
// boot from ~/.axon/config.json) and returns the appropriate chat model.
//
//   provider="anthropic"  → ChatAnthropic (native — prompt caching & thinking)
//   provider="openai"     → ChatOpenAI against config.endpoint (works with
//                           OpenAI itself, OpenRouter, Groq, Together,
//                           GitHub Models, Ollama, LM Studio, etc.)
// ===========================================================================

export interface BuildModelOptions {
  callbacks?: Callbacks;
  streaming?: boolean;
  // Override the model NAME only (provider, API key, endpoint still come
  // from the active BYOK config). Used by the delegation pipeline so
  // sub-agents can run on a cheaper/faster model than the orchestrator.
  modelName?: string;
}

export function buildModel(opts: BuildModelOptions = {}): BaseChatModel {
  const cfg = requireActiveConfig();
  const streaming = opts.streaming ?? false;
  const model = opts.modelName?.trim() || cfg.model;

  if (cfg.provider === "anthropic") {
    return new ChatAnthropic({
      model,
      apiKey: cfg.apiKey,
      streaming,
      callbacks: opts.callbacks,
    });
  }

  return new ChatOpenAI({
    model,
    configuration: { baseURL: cfg.endpoint },
    apiKey: cfg.apiKey,
    streaming,
    callbacks: opts.callbacks,
  });
}

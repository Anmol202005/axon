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
}

export function buildModel(opts: BuildModelOptions = {}): BaseChatModel {
  const cfg = requireActiveConfig();
  const streaming = opts.streaming ?? false;

  if (cfg.provider === "anthropic") {
    return new ChatAnthropic({
      model: cfg.model,
      apiKey: cfg.apiKey,
      streaming,
      callbacks: opts.callbacks,
    });
  }

  return new ChatOpenAI({
    model: cfg.model,
    configuration: { baseURL: cfg.endpoint },
    apiKey: cfg.apiKey,
    streaming,
    callbacks: opts.callbacks,
  });
}

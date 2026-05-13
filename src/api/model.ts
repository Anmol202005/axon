import { ChatOpenAI } from "@langchain/openai";
import type { Callbacks } from "@langchain/core/callbacks/manager";

// ===========================================================================
// model
// ===========================================================================

export interface BuildModelOptions {
  callbacks?: Callbacks;
  streaming?: boolean;
}

export function buildModel(opts: BuildModelOptions = {}) {
  return new ChatOpenAI({
    model: process.env.AI_MODEL,
    configuration: { baseURL: process.env.AI_ENDPOINT },
    apiKey: process.env.AI_API_KEY,
    streaming: opts.streaming ?? false,
    callbacks: opts.callbacks,
  });
}

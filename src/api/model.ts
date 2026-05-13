import { ChatOpenAI } from "@langchain/openai";

// ===========================================================================
// model
// ===========================================================================

export function buildModel() {
  return new ChatOpenAI({
    model: process.env.AI_MODEL,
    configuration: { baseURL: process.env.AI_ENDPOINT },
    apiKey: process.env.AI_API_KEY,
  });
}

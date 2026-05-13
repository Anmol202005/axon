// ===========================================================================
// agent — public barrel
// ===========================================================================
// The agent is split across focused modules — this file re-exports the public
// surface so consumers can import from one place.

export * from "./types.js";
export * from "./messages.js";
export * from "./prompts.js";
export * from "./model.js";
export * from "./builder.js";
export * from "./runner.js";
export { createFileTools, safeJoin } from "./tools/files.js";
export { createCallAgentTool } from "./tools/delegate.js";
export {
  createSummarizeTool,
  summarizeMessages,
  type SummarizeOptions,
  type SummarizerModel,
} from "./tools/summarize.js";
export * from "./mcp/index.js";

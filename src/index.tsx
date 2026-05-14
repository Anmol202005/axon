#!/usr/bin/env node
import "dotenv/config";
import path from "node:path";
import { render } from "ink";
import { Command } from "commander";
import { App } from "./cli/App.js";
import { latestSessionId, loadSession } from "./cli/persistence.js";

// ===========================================================================
// CLI entry — minimal arg parsing so the TUI can resume a saved session.
// ===========================================================================

const program = new Command()
  .name("axon")
  .description("axon — a multi-agent CLI coding agent")
  .option("-r, --resume <id>", "resume a saved session by id")
  .option("-l, --last", "resume the most recently updated session")
  .option(
    "-w, --workspace <path>",
    "workspace root (defaults to current directory)",
  );

program.parse(process.argv);
const opts = program.opts<{
  resume?: string;
  last?: boolean;
  workspace?: string;
}>();

const workspaceRoot = opts.workspace
  ? path.resolve(opts.workspace)
  : process.cwd();

async function main() {
  let initialSessionId: string | undefined;
  if (opts.resume) initialSessionId = opts.resume;
  else if (opts.last) initialSessionId = await latestSessionId(workspaceRoot);

  let initialSnapshot;
  if (initialSessionId) {
    try {
      initialSnapshot = await loadSession(workspaceRoot, initialSessionId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `axon: could not resume "${initialSessionId}": ${msg}\n`,
      );
      process.exit(1);
    }
  }

  render(
    <App
      workspaceRoot={workspaceRoot}
      initialSnapshot={initialSnapshot}
    />,
  );
}

main().catch((err) => {
  process.stderr.write(`axon: ${err?.message ?? err}\n`);
  process.exit(1);
});

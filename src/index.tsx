#!/usr/bin/env node
import path from "node:path";
import React, { useState } from "react";
import { render } from "ink";
import { Command } from "commander";
import { App } from "./cli/App.js";
import { latestSessionId, loadSession } from "./cli/persistence.js";
import {
  loadConfig,
  setActiveConfig,
  type AxonConfig,
} from "./cli/config.js";
import { Onboarding } from "./cli/Onboarding.js";

// ===========================================================================
// CLI entry — loads BYOK config (or runs onboarding), then mounts the TUI.
// Config lives at ~/.axon/config.json; env vars are not consulted.
// ===========================================================================

const program = new Command()
  .name("axon")
  .description("axon — a multi-agent CLI coding agent")
  .option("-r, --resume <id>", "resume a saved session by id")
  .option("-l, --last", "resume the most recently updated session")
  .option(
    "-w, --workspace <path>",
    "workspace root (defaults to current directory)",
  )
  .option("--setup", "re-run BYOK onboarding (overwrites ~/.axon/config.json)");

program.parse(process.argv);
const opts = program.opts<{
  resume?: string;
  last?: boolean;
  workspace?: string;
  setup?: boolean;
}>();

const workspaceRoot = opts.workspace
  ? path.resolve(opts.workspace)
  : process.cwd();

// ---------------------------------------------------------------------------
// Root — switches between Onboarding and App so first-run setup happens
// inline before we mount the chat UI. Once the user finishes onboarding (or
// when a saved config is found) we transition straight to App.
// ---------------------------------------------------------------------------
function Root({
  forceOnboarding,
  existingConfig,
  initialSnapshot,
}: {
  forceOnboarding: boolean;
  existingConfig: AxonConfig | null;
  initialSnapshot?: Awaited<ReturnType<typeof loadSession>>;
}) {
  const [phase, setPhase] = useState<"onboarding" | "ready">(
    forceOnboarding ? "onboarding" : "ready",
  );

  if (phase === "onboarding") {
    return (
      <Onboarding
        initial={existingConfig ?? undefined}
        reason={
          existingConfig
            ? "re-running setup — saving overwrites "
            : "first-run setup — bring your own keys. stored in "
        }
        onComplete={(cfg) => {
          setActiveConfig(cfg);
          setPhase("ready");
        }}
      />
    );
  }

  return (
    <App workspaceRoot={workspaceRoot} initialSnapshot={initialSnapshot} />
  );
}

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

  const existingConfig = await loadConfig();
  if (existingConfig && !opts.setup) {
    setActiveConfig(existingConfig);
  }

  const needsOnboarding = opts.setup || !existingConfig;

  render(
    <Root
      forceOnboarding={needsOnboarding}
      existingConfig={existingConfig}
      initialSnapshot={initialSnapshot}
    />,
  );
}

main().catch((err) => {
  process.stderr.write(`axon: ${err?.message ?? err}\n`);
  process.exit(1);
});

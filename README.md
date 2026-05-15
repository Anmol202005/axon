```
  ██████╗ ██╗  ██╗ ██████╗ ███╗   ██╗
  ██╔═██╗ ╚██╗██╔╝██╔═══██╗████╗  ██║
  ██████╔╝ ╚███╔╝ ██║   ██║██╔██╗ ██║
  ██╔═██╗  ██╔██╗ ██║   ██║██║╚██╗██║
  ██║ ██║ ██╔╝ ██╗╚██████╔╝██║ ╚████║
  ╚═╝ ╚═╝ ╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═══╝

  multi-agent CLI coding agent
  one orchestrator plans · specialists execute
```

**A multi-agent CLI coding agent. One orchestrator plans. Specialists execute.**

<p align="center">
  <a href="https://www.npmjs.com/package/axon-cli">
    <img src="https://img.shields.io/npm/v/axon-cli?color=black&label=npm" />
  </a>
  <img src="https://img.shields.io/badge/license-ISC-black" />
</p>

Run it in your terminal. It reads your codebase, makes real changes to real files, and handles hard tasks by delegating to focused sub-agents — a researcher, an implementer, a reviewer, a tester — all coordinated by a single orchestrator that plans and synthesizes.

```bash
npm install -g axon-cli
```

> **No paid API key required.** Works free with GitHub Models — [see setup →](#free-setup-github-models)

---

## Why axon

Most coding agents run one model doing everything sequentially. That works for small edits.

For hard tasks — refactors across many files, adding a feature with tests, debugging something deep — a single agent either loses context or produces shallow work.

axon uses a delegation model: the orchestrator plans the task, breaks it into independent slices, dispatches each slice to a specialist agent, and synthesizes the results. Specialists are narrow and focused — they do one thing well and return a compact report.

```
           your prompt
                │
                ▼
       ┌────────────────┐
       │  Orchestrator  │  plans · synthesizes
       └───────┬────────┘
               │ call_agent({ role, prompt })
    ┌──────────┼──────────┐
    ▼          ▼          ▼
researcher  implementer  reviewer
read-only   writes code  critique
```

The result is better work on hard problems — and it's fully configurable per project.

---

## Install

```bash
npm install -g axon-cli
```

**Requirements:** Node.js 18+

Then run it inside any project:

```bash
cd ~/your-project
axon
```

On first run, a wizard asks for your provider, model, and API key. Stored at `~/.axon/config.json` (chmod 0600). Run once — re-run `axon --setup` anytime to change.

---

## Free setup — GitHub Models

You don't need a paid API key to use axon. GitHub Models gives free access to frontier models using a GitHub Personal Access Token.

**1. Create a token**

Go to [github.com/settings/tokens](https://github.com/settings/tokens) → Generate new token (classic). No scopes needed. Copy the `ghp_…` value.

**2. Run the wizard**

```bash
axon --setup
```

```
? Provider   ›  OpenAI-compatible
? Endpoint   ›  https://models.github.ai/inference
? Model      ›  openai/gpt-4o
? API key    ›  ghp_xxxxxxxxxxxxxxxxxxxx
```

That's it. Free, no credit card.

**Other supported providers:** Anthropic, OpenAI, OpenRouter, Groq, Together, Ollama, LM Studio — anything OpenAI-compatible.

---

## How it works

### The orchestration model

The orchestrator follows this flow on every non-trivial task:

1. **Evaluate** — is this simple or complex?
2. **Simple tasks** are solved directly. Spawning a sub-agent for a one-file edit costs more than it saves.
3. **Complex tasks** get planned first. The orchestrator lists independent slices and what each should produce.
4. **Fan out.** One `call_agent` per slice, dispatched to the right specialist role.
5. **Synthesize.** Results from all specialists are combined into the final answer.
6. **Iterate.** If wave 1 surfaces gaps, a second wave runs — informed by what wave 1 found.

### Three budget layers

axon never runs away:

| Layer | Default | Role |
|---|---|---|
| `maxDepth` | 1 | Hard cap on delegation depth. Depth 1 = orchestrator → leaf specialists only. |
| `softCap` | 10 | Advisory budget surfaced in the orchestrator's prompt. |
| `hardCap` | 25 | Silent ceiling enforced in code. Never shown to the model. |

All configurable in `.axon/architecture.json`.

---

## Five built-in roles

| Role | Does | Writes? |
|---|---|---|
| `researcher` | Explore the codebase, gather context, report findings | No |
| `implementer` | Write code for a specific, scoped task | Yes |
| `reviewer` | Critique for correctness, conventions, cross-file consistency | No |
| `tester` | Write and run tests for a given scope | Yes |
| `debugger` | Reproduce a failure, trace it, identify root cause | Small probes only |

Every role enforces a structured return format (≤25 lines, no narration) to keep the orchestrator's context tight during synthesis.

**Add your own roles** by dropping a markdown file in `.axon/roles/<name>.md`:

```markdown
---
description: pentest the changed code
---
You are a SECURITY-AUDITOR specialist...
```

---

## Configuration

Everything lives in `.axon/` at your project root. Nothing breaks if files are missing — axon falls back to sensible defaults.

| File | Controls |
|---|---|
| `~/.axon/config.json` | Provider, model, API key |
| `.axon/architecture.json` | Depth, fan-out caps, sub-agent model |
| `.axon/roles/*.md` | Custom or override role prompts |
| `.axon/commands/*.md` | Custom slash commands |
| `.axon/permissions.json` | Tool allow/deny lists |
| `AXON.md` | Project memory — appended to every system prompt |
| `.forge/mcp.json` | MCP server registrations |

### Cost-optimized setup

Run the orchestrator on a strong model, leaves on something cheap:

```json
{
  "v": 1,
  "subAgentModel": "claude-haiku-4-5-20251001"
}
```

### Strict delegation

Allow subcontracting but cap the tree tightly:

```json
{
  "v": 1,
  "maxDepth": 2,
  "softCap": 8,
  "hardCap": 30,
  "maxCallsPerAgent": 4,
  "maxCallsAtDepth": { "1": 8, "2": 6 },
  "requireRole": true
}
```

---

## Project memory

Drop `AXON.md` at your workspace root. Its contents get appended to every system prompt, every sub-agent, every turn:

```markdown
This project uses pnpm, not npm.
Tests live in __tests__/ next to the source.
Don't touch src/legacy/ — it's deprecated and frozen.
Run `pnpm tc` for typecheck.
```

The agent treats this as standing instructions — it never forgets them mid-session.

---

## Plan mode

Before any edits land, review the plan:

```
/plan
```

In plan mode, all mutating tools are disabled. The agent inspects the codebase, then surfaces a markdown plan for your approval. Once you approve, execution proceeds normally.

---

## MCP support

Register any [Model Context Protocol](https://modelcontextprotocol.io) server in `.forge/mcp.json`:

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "ghp_..." }
    }
  }
}
```

The MCP tool surface merges into axon's available tools automatically. Per-project or per-user — workspace wins on collision.

---

## Sessions

Every turn is snapshotted. Resume where you left off:

```bash
axon --last                    # resume most recent session
axon --resume <id>             # resume by id
```

From inside the TUI:

```
/sessions                      # list all sessions
/resume <id>                   # resume a session
/export md                     # export transcript to markdown
```

---

## Slash commands

```
/plan [on|off]                 toggle plan mode
/arch                          show architecture config
/roles                         list registered roles
/roles show <name>             print a role's full prompt
/permissions allow <tool>      bypass approval for a tool
/permissions deny <tool>       block a tool for this project
/sessions                      list saved sessions
/setup                         re-run BYOK onboarding
/export md                     export session transcript
/help                          full command list
```

**Custom commands** — drop a `.md` file in `.axon/commands/`:

```markdown
---
description: Review the current branch diff
args: focus area
---
Review the diff on the current branch versus main. Focus on: $1
```

Type `/review correctness` and the agent gets the full prompt.

---

## Tools

All tools are workspace-rooted. Every mutating tool is gated by an approval prompt — with a diff preview for file writes — unless allow-listed.

**Filesystem:** `read_file`, `write_file` (read-before-write enforced), `list_files`, `delete_file`, `search` (ripgrep-backed)

**Git:** `git_status`, `git_diff`, `git_blame`, `git_log` (read-only) · `git_commit`, `git_branch`, `git_checkout` (gated)

**Web:** `web_search` (Google via serper.dev, optional) · `web_fetch` (any URL, no key needed)

**Project-aware:** `run_checks` (auto-detects build/test/lint commands, parses `file:line:col` diagnostics) · `run_command` (last-resort shell access)

**Meta:** `call_agent` (delegation) · `summarize_conversation` (context compaction) · `exit_plan_mode`

---

## CLI flags

```bash
axon                          # start in cwd
axon --setup                  # re-run onboarding
axon --last                   # resume most recent session
axon --resume <id>            # resume a specific session
axon --workspace <path>       # use a different workspace root
```

---

## Documentation

Full docs at **[axon.theanmolsharma.com/docs](https://axon.theanmolsharma.com/docs)**

Covers: free GitHub Models setup · architecture config · custom roles · slash commands · permissions · MCP · troubleshooting.

---

## License

ISC
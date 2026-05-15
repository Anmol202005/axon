# axon — architecture & user guide

axon is a multi-agent CLI coding agent. You run it in a terminal, it works
inside a single project directory, and it makes real changes to your real
filesystem. What sets it apart from a one-shot agent is the **delegation
model**: a single orchestrator at the top decomposes hard tasks into
focused sub-agents ("roles"), dispatches them, and synthesizes their
outputs. Almost every aspect of that pipeline — depth, fan-out caps,
roles, models — is configurable per project via plain files in `.axon/`.

This document covers everything: how the agent runs, every config file,
every slash command, every tool, and a recipes section at the end.

---

## 1. Quick start

```bash
# build
npm install
npm run build

# run inside any project
cd ~/your-project
axon
```

On first run you'll get an onboarding wizard that asks for:
- **Provider** — Anthropic or OpenAI-compatible (works with OpenAI, OpenRouter,
  Groq, Together, GitHub Models, Ollama, LM Studio — anything that speaks
  the OpenAI API).
- **Model** — e.g. `claude-opus-4-7`, `gpt-4o`, `llama-3.3-70b-versatile`.
- **API key** — stored at `~/.axon/config.json` with mode `0600`.
- **Endpoint** (OpenAI-compatible only) — base URL of the API.
- **Serper key** (optional) — gates the `web_search` tool.

You only do this once. Re-run with `axon --setup` (or `/setup` from inside
the TUI) to change provider / model / keys without restarting.

### CLI flags

| flag | purpose |
|---|---|
| `-r, --resume <id>` | resume a saved session by id |
| `-l, --last` | resume the most recently updated session in this workspace |
| `-w, --workspace <path>` | use a different workspace root (defaults to `cwd`) |
| `--setup` | force re-running BYOK onboarding |

---

## 2. The orchestration model

axon is built around one core idea: **a hard task is easier to solve when
one agent plans it and many specialist agents execute it**. The default
shape is:

```
                user prompt
                     │
                     ▼
            ┌────────────────────┐
            │    Orchestrator    │  (heavy model — plans + synthesizes)
            └────────┬───────────┘
                     │ call_agent({role, prompt})
       ┌─────────────┼─────────────┐
       ▼             ▼             ▼
  researcher    implementer    reviewer       ← leaves (depth = 1)
  (read-only)   (writes code)  (critique)
       │             │             │
       └─────────────┼─────────────┘
                     ▼
            synthesized answer
```

### The default flow

The orchestrator's system prompt instructs it to follow this pattern on
non-trivial tasks:

1. **Evaluate** — simple or complex?
2. **Solve simple tasks directly.** A one-file edit is the orchestrator's
   own job — spawning a sub-agent costs more than it saves.
3. **Plan complex tasks first.** List independent slices and what each
   produces. The plan is a structuring step, not a deliverable.
4. **Fan out.** One `call_agent` per slice. Use a predefined role when one
   fits; pass a custom `systemPrompt` only if none does.
5. **Synthesize.** Combine the compact reports into the answer the user
   asked for. Don't relay raw sub-agent output.
6. **Iterate if needed.** If wave 1 surfaces gaps, run a SECOND WAVE
   informed by what wave 1 found. Better than over-planning up front.

### The three budgets

axon uses three layers of budget control:

| layer | default | role |
|---|---|---|
| **maxDepth** | 1 | hard cap on delegation depth. With 1, sub-agents are leaves; they can't delegate further. |
| **softCap** | 10 | advisory budget surfaced in the orchestrator's system prompt. Tells the planner "spend ~10 specialists per task, run a 2nd wave if you need more." Not enforced. |
| **hardCap** (`maxCalls`) | 25 | silent runaway-loop rail enforced in code. Never shown to the model — it shouldn't plan against it. If the agent hits this, the task was over-decomposed. |

Plus two optional finer-grained caps (off by default):

| optional | role |
|---|---|
| **maxCallsPerAgent** | per-parent fan-out cap — each individual agent can spawn at most N children. Only meaningful when `maxDepth > 1`. |
| **maxCallsAtDepth** | per-depth fan-out cap — total spawns at each depth level across all branches. E.g. `{"1": 10, "2": 6}`. |

All five live in `.axon/architecture.json` (see §4).

### Why depth=1 by default

Past depth-2, each level adds summarization loss (parent reads a
summary of a summary), wall-clock latency, and decomposition risk (a
sub-agent's idea of "subcontract this" tends to be worse than the
orchestrator's). For ~95% of coding tasks, **one planner with many
specialists** beats deeper trees. axon makes deeper trees opt-in via
`maxDepth: 2` (or more), and gives you per-depth caps so you don't
explode the budget.

---

## 3. Configuration files at a glance

axon reads several files; nothing breaks if they're missing (it falls
back to defaults). Everything project-specific lives under `.axon/` so
you can commit it (or `.gitignore` it) per team policy.

| file | scope | what it controls |
|---|---|---|
| `~/.axon/config.json` | user | provider, model, API key, optional serper key |
| `.axon/architecture.json` | project | depth, fan-out caps, sub-agent model, requireRole |
| `.axon/roles/*.md` | project | per-role system prompts (override built-ins, add custom) |
| `~/.axon/roles/*.md` | user | personal cross-project roles (workspace wins on collision) |
| `.axon/commands/*.md` | project | custom slash commands |
| `~/.axon/commands/*.md` | user | personal slash commands |
| `.axon/permissions.json` | project | tool allow / deny lists |
| `AXON.md` | project | project memory — standing instructions for the agent |
| `.forge/mcp.json` | project | MCP server registrations |
| `~/.forge/mcp.json` | user | personal MCP servers |
| `.axon/sessions/*.json` | project | persisted chat sessions |
| `.axon/exports/*.{md,json}` | project | exported transcripts |

The next sections cover each in detail.

---

## 4. `.axon/architecture.json` — the agent shape

Controls the delegation tree. Every field is optional. Missing or
invalid file → defaults; the default architecture matches the **depth=1,
softCap=10, hardCap=25** model described above.

### Schema

```json
{
  "v": 1,
  "maxDepth": 1,
  "softCap": 10,
  "hardCap": 25,
  "maxCallsPerAgent": null,
  "maxCallsAtDepth": null,
  "subAgentModel": null,
  "requireRole": false
}
```

| field | type | default | meaning |
|---|---|---|---|
| `maxDepth` | int ≥ 0 | 1 | max delegation depth. `0` = no delegation. `1` = orchestrator → leaves. `2`+ = sub-agents can subcontract. |
| `softCap` | int ≥ 0 | 10 | advisory budget surfaced in the orchestrator's prompt. |
| `hardCap` | int ≥ 0 | 25 | silent ceiling. Auto-raised to `softCap` if you set `hardCap < softCap` (sanity). |
| `maxCallsPerAgent` | int > 0 or null | null | per-parent fan-out cap. Each individual agent can spawn at most N children. |
| `maxCallsAtDepth` | `{ "1": n, ... }` or null | null | per-depth fan-out caps. Keys are depth integers (as strings in JSON). |
| `subAgentModel` | string or null | null | model name override for sub-agents only. Same provider as orchestrator. |
| `requireRole` | bool | false | when true, `call_agent` rejects calls without a registered `role`. No custom systemPrompts. |

### Commands

```
/architecture              # print active config + file path
/architecture init         # write a starter file with every knob present
/architecture reload       # re-read the file after editing
/architecture path         # print the file path
```

Aliases: `/arch` works everywhere `/architecture` does.

### Three example configurations

**Default (no file needed):** depth=1, soft=10, hard=25.

**Cost-optimized:** keep the orchestrator on a strong model, run leaves on
something cheap and fast.

```json
{
  "v": 1,
  "subAgentModel": "claude-haiku-4-5-20251001"
}
```

**Strict delegation (large-task workflow):** allow one level of
subcontracting but cap the tree shape tightly, and force the orchestrator
to use registered roles only.

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

### Refusal semantics

Each cap returns a distinct refusal message to the agent so the model
knows why it was rejected and can adapt:

- **hardCap reached** → "synthesize what you have and solve the rest directly."
- **maxCallsPerAgent reached** → "this agent has spawned its limit; synthesize or run a second wave from a higher-level plan."
- **maxCallsAtDepth reached** → "this depth's budget is used; solve the rest directly."
- **requireRole + no/invalid role** → lists the registered role names; tells the model to pick one and retry.

---

## 5. `.axon/roles/` — the role registry

A role is a pre-baked system prompt + a one-line description, identified
by a lowercase name. The orchestrator calls a sub-agent by role:

```
call_agent({ role: "researcher", prompt: "..." })
```

instead of having to write a full systemPrompt each time. Roles also
define the leaf's behavior, return format, and what it's allowed to do.

### The five built-in roles

| role | purpose | writes? |
|---|---|---|
| `researcher` | explore the codebase, gather context, report findings | no |
| `implementer` | write code for a specific scope | yes |
| `reviewer` | critique code (correctness, conventions, cross-file consistency) | no |
| `tester` | write/run tests for a scope | yes |
| `debugger` | reproduce a failure, trace, identify root cause | small probes only |

Each role's full prompt is hardcoded in `src/api/prompts.ts`
(`BUILTIN_ROLE_PROMPTS`). You can see them via `/roles show <name>`.

Every role enforces a **structured return format** (≤25 lines, no
narration). This is what keeps the orchestrator's context light during
synthesis.

### Overriding a built-in or adding a custom role

Drop a markdown file into `.axon/roles/<name>.md`:

```markdown
---
description: pentest the changed code
---
You are a SECURITY-AUDITOR specialist. You look for OWASP top-10 issues
in the code the orchestrator hands you.

Rules:
- Read-only. Do NOT modify files.
- Focus on the scope the orchestrator gave you.
- Every issue must cite file:line and an OWASP category.

Return format (≤25 lines, no narration):
- Issues: `file:line · category · description`
- Severity summary: blocker / high / med / low counts.
```

- Filename (minus `.md`) becomes the role identifier. Must be lowercase
  `[a-z][a-z0-9_-]*`.
- Frontmatter is optional. Only `description:` is read.
- Body is the system prompt verbatim.
- A workspace file overrides a personal file (`~/.axon/roles/`) which
  overrides a built-in with the same name.
- New names extend the registry — they become valid values for
  `call_agent({role: ...})` automatically.

### Commands

```
/roles                     # list all registered roles (builtin/override/custom)
/roles show <name>         # print one role's full prompt
/roles init                # scaffold the five built-in role prompts into .axon/roles/
/roles reload              # re-read the directory after editing
/roles path                # print the .axon/roles/ directory path
```

Aliases: `/role` works everywhere `/roles` does.

The init flow is the easiest way to learn the format: run `/roles init`,
edit any of the scaffolded files, run `/roles reload`. The init step is
idempotent — it never clobbers a file that already exists.

### Personal roles for cross-project use

Anything in `~/.axon/roles/*.md` applies to every project unless
overridden by a workspace file of the same name. Good for personal
specialists you reuse: `release-notes-writer`, `commit-message-style`,
`changelog-curator`.

---

## 6. `.axon/commands/` — custom slash commands

Drop a markdown file there and it becomes a slash command. Useful for
canned prompts you re-use.

```markdown
---
description: Review the working tree
args: focus area (optional)
---
You're reviewing the current working tree. $ARGS

Focus on: $1
Workspace: $WORKSPACE
```

- Filename → command name (`./review.md` → `/review`).
- Substitutions: `$ARGS` (everything after the verb), `$1..$9` (whitespace
  args), `$WORKSPACE` (workspace root).
- Built-in commands (`/help`, `/clear`, etc.) take precedence — you can't
  shadow them.
- Workspace files override personal ones in `~/.axon/commands/`.

### Commands

```
/commands     # list registered custom commands
/reload       # re-read .axon/commands/ after editing
```

---

## 7. `.axon/permissions.json` — tool allow / deny lists

Project-scoped per-tool permissions. The TUI's "Always allow" choice on
an approval prompt writes here.

```json
{
  "v": 1,
  "allowed": ["search", "read_file"],
  "denied": ["run_command"]
}
```

- Allowed tools bypass the approval prompt entirely.
- Denied tools are auto-rejected with a stock reason that tells the
  agent not to retry.

### Commands

```
/permissions                          # print allowed + denied
/permissions allow <tool>             # add to allowed
/permissions deny <tool>              # add to denied
/permissions remove <tool>            # remove from both lists
/permissions reset                    # clear everything
```

Alias: `/perms`.

---

## 8. `AXON.md` — project memory

Drop `AXON.md` (or `axon.md`) at the workspace root and its contents are
appended to every system prompt as standing instructions:

```markdown
This project uses pnpm, not npm.
Tests live in __tests__/ next to the source.
Don't touch src/legacy/ — it's deprecated and frozen.
Run `pnpm tc` for typecheck.
```

The agent treats this as user-authored context (it's wrapped in a
`<project_memory>` block). It applies to every turn, every sub-agent.

---

## 9. `~/.axon/config.json` — BYOK config

```json
{
  "v": 1,
  "provider": "anthropic",
  "model": "claude-opus-4-7",
  "apiKey": "sk-ant-...",
  "endpoint": null,
  "serperApiKey": "..."
}
```

Stored chmod `0600`. Created by the onboarding wizard; re-run anytime
with `axon --setup` or `/setup` inside the TUI. Env vars are NOT
consulted (intentional — config goes through the wizard so the user
always knows where their keys live).

### Commands

```
/config        # show current provider / model / endpoint / file path
/setup         # re-run BYOK onboarding inline (no restart)
```

---

## 10. MCP support — `.forge/mcp.json`

Standard [Model Context Protocol](https://modelcontextprotocol.io)
servers can be registered per project (`.forge/mcp.json`) or personally
(`~/.forge/mcp.json`). Workspace wins. The MCP tool surface is merged
into the agent's available tools automatically.

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "ghp_..." }
    }
  }
}
```

No bundled defaults — populate the file or it just stays empty.

---

## 11. Tools the agent uses

All tools are workspace-rooted (paths are relative to the workspace
root; `..` traversal beyond it is rejected). Every mutating tool is
gated by the approval prompt unless allow-listed via `/permissions`.

### Filesystem

| tool | what it does |
|---|---|
| `read_file` | read a file; marks the path as "observed" this session |
| `write_file` | write a file. **Refuses to overwrite an existing file unless you read it first this session (or pass `overwrite: true`).** Creates parent directories. |
| `list_files` | list a directory |
| `delete_file` | delete a file (sparingly) |
| `search` | ripgrep-backed regex search with glob filters |

The read-before-write rule is the key safety: when you say "create
hello.txt" and `hello.txt` already exists, the agent gets a refusal that
says "this exists and you haven't read it — pick `hello-1.txt`, or read
it first if you meant to modify it." This prevents silent overwrites.

### Git (read-only by default)

| tool | what it does |
|---|---|
| `git_status` | working-tree status |
| `git_diff` | diffs (worktree, staged, between refs) |
| `git_blame` | line-level authorship |
| `git_log` | commit history |
| `git_commit` | create a commit (gated) |
| `git_branch` | create/switch branches (gated) |
| `git_checkout` | checkout (gated) |

### Web

| tool | what it does |
|---|---|
| `web_search` | Google via serper.dev (requires `SERPER_API_KEY`) |
| `web_fetch` | fetch a URL; HTML stripped to text |

### Project-aware

| tool | what it does |
|---|---|
| `run_checks` | auto-detect build/test/lint/typecheck command and run with parsed `file:line:col` diagnostics. Reads `package.json`, `tsconfig`, `Cargo.toml`, `go.mod`, `pyproject.toml`, `Makefile`. |
| `run_command` | run any shell command from the workspace root. Last-resort tool. |

### Meta

| tool | what it does |
|---|---|
| `call_agent` | delegate a subtask to a sub-agent (see §2) |
| `summarize_conversation` | produce a compact recap. Useful between waves of delegation or when context is getting tight. |
| `exit_plan_mode` | (plan mode only) surface a plan for approval |

### Approval flow

Every gated tool call goes through an interactive approval menu unless
allow-listed:

- **allow once** — this call only.
- **always allow** — bypass approval for this tool name for the rest of
  the session.
- **always allow + project** — also persist to `.axon/permissions.json`.
- **deny + feedback** — reject with a reason the agent sees.

For `write_file`, the menu shows a **diff** of the proposed change before
you decide.

---

## 12. Plan mode

A read-only run mode where the agent can only inspect, not modify. It
must finish by calling `exit_plan_mode` with a markdown plan for your
approval. Once you approve, plan mode flips off and execution proceeds
under the normal approval flow.

```
/plan          # toggle
/plan on       # explicit on
/plan off      # explicit off
```

Useful for hard tasks where you want to see the plan before any edits
land. The plan-mode block in the system prompt forbids every mutating
tool (`write_file`, `delete_file`, `run_command`, `run_checks`, git
mutations) — they auto-deny while plan mode is active.

---

## 13. Sessions

Every turn is snapshotted to `.axon/sessions/<id>.json`. You can resume,
list, or delete them.

```
/sessions               # list saved sessions in this workspace
/resume <id>            # resume a saved session
/forget <id>            # delete a saved session
```

Or from the shell:

```bash
axon --resume <id>      # resume a specific session at launch
axon --last             # resume the most recently updated session
```

A session snapshot contains items (turns), the auto-compaction summary
(if any), the always-allowed tool set, and accumulated token usage. The
`/clear` command resets the context within a running session but keeps
the snapshot file.

### Export

```
/export md              # write transcript to .axon/exports/<id>.md
/export json            # write structured snapshot to .axon/exports/<id>.json
/export md ./somewhere.md   # custom path
```

---

## 14. Context management

The TUI shows a coarse context-usage percentage next to the input bar
(`ctx 23%`), driven by a 4-chars-≈-1-token heuristic. When projected
context for the next turn crosses the soft compaction threshold (80% of
limit by default), axon auto-summarizes prior turns and reverts the
visible context to a compact summary + the new turn.

You can also force this manually — the `summarize_conversation` tool is
exposed to the agent so the orchestrator can compact its own history
between waves of delegation.

Limit defaults to 200k tokens; override with `AXON_CTX_LIMIT=<n>`.

---

## 15. Mentions and substitutions

In your prompt:

- `@path/to/file` — the file's contents are appended to the message
  the agent sees (in a `<file>` block). The transcript still shows just
  `@path/to/file`.
- For custom slash commands: `$ARGS`, `$1..$9`, `$WORKSPACE` (see §6).

Mentions are best-effort — unresolved paths are mentioned in the
activity line and the message goes through unchanged.

---

## 16. UI conventions

```
> ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
>   your message here
░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░

● axon
  rendered markdown reply…

[input box]                                ctx 23%  ·  12.3k↑ 4.1k↓
```

- **Esc** — cancel the running turn (sub-agents and shell children are
  killed cleanly).
- **Ctrl-C** — quit.
- **↵** — send.
- **\\↵** (backslash + enter), **Alt-↵**, **Ctrl-J** — insert a newline.
- **Shift-↵** — newline on terminals that report it.
- **↑ / ↓** — move cursor across lines; browse prompt history at the
  top/bottom edges.
- **Ctrl-A / Ctrl-E** — start / end of line.
- **Ctrl-U / Ctrl-K** — delete to start / end of line.

The bottom-right token meter shows `<input>↑ <output>↓` tokens for the
session.

---

## 17. Full slash-command reference

| command | aliases | purpose |
|---|---|---|
| `/help` | | this list (in-TUI) |
| `/clear` | | reset context in this session (snapshot kept) |
| `/sessions` | | list saved sessions |
| `/resume <id>` | | resume a saved session |
| `/forget <id>` | | delete a saved session |
| `/plan [on|off]` | | toggle plan mode |
| `/permissions ...` | `/perms` | list / allow / deny / remove / reset |
| `/commands` | | list custom slash commands |
| `/reload` | | re-read `.axon/commands/` |
| `/config` | | print BYOK config summary |
| `/setup` | | re-run BYOK onboarding inline |
| `/architecture ...` | `/arch` | show / init / reload `.axon/architecture.json` |
| `/roles ...` | `/role` | list / show / init / reload `.axon/roles/` |
| `/export <md|json> [path]` | | export the session transcript |
| `/exit` | `/quit` | quit |

Plus any custom commands from `.axon/commands/*.md`.

---

## 18. Recipes

### Cheap leaves, smart orchestrator

For most projects, the orchestrator does the high-level reasoning and
sub-agents do narrow, well-scoped work. The cheap-model-on-leaves trick
costs almost nothing to set up and is a 3–10× cost win:

```bash
/architecture init
# edit .axon/architecture.json:
#   "subAgentModel": "claude-haiku-4-5-20251001"
/architecture reload
```

### A hard refactor across many files

Bump depth to 2 to let an `implementer` subcontract focused researchers,
keep the global cap modest, and force role discipline:

```json
{
  "v": 1,
  "maxDepth": 2,
  "softCap": 12,
  "hardCap": 40,
  "maxCallsPerAgent": 4,
  "maxCallsAtDepth": { "1": 8, "2": 6 },
  "requireRole": true
}
```

Then add a custom role for the refactor's specific shape — e.g. a
`migration-codemod` role with rules about which patterns to rewrite.

### A security-review workflow

```bash
/roles init                                  # scaffold the five built-ins
# add .axon/roles/security-auditor.md as shown in §5
/roles reload
```

Now the orchestrator can call `security-auditor` directly. Combine with
plan mode if you want a review-before-fix workflow.

### Sandboxing a noisy tool

`run_command` is gated by default but the agent might still try it
repeatedly when other tools would do. Add it to the deny-list:

```
/permissions deny run_command
```

The agent gets a stock rejection that tells it to use a more specific
tool.

### Repeatable prompts

Drop `.axon/commands/review-pr.md`:

```markdown
---
description: Review the diff on the current branch
args: focus area
---
Review the diff on the current branch versus main. Focus on: $1.

Use git_diff to see the changes. Use the `reviewer` role to call a
sub-agent if the diff is large. Return: blockers, nits, and questions.
```

Type `/review-pr correctness` and the agent gets the full prompt.

### Resuming after a context blow-up

If a session blew past the compaction threshold and the auto-summary
isn't quite right, `/clear` resets the context entirely (the snapshot
file stays, so you can still `/resume` if you change your mind on
another launch).

---

## 19. Source-of-truth map

For when you want to read the code, not the docs:

| concern | file |
|---|---|
| CLI entry / flags | `src/index.tsx` |
| TUI / slash commands | `src/cli/App.tsx` |
| Onboarding wizard | `src/cli/Onboarding.tsx` |
| BYOK config | `src/cli/config.ts` |
| Architecture config | `src/cli/architecture.ts` |
| Role registry | `src/cli/roles.ts` |
| Custom commands | `src/cli/commands.ts` |
| Permissions | `src/cli/permissions.ts` |
| Sessions / persistence | `src/cli/persistence.ts` |
| Export | `src/cli/export.ts` |
| Mentions | `src/cli/mentions.ts` |
| Context-usage estimator | `src/cli/tokens.ts` |
| Markdown rendering | `src/cli/markdown.ts` |
| Diff-approval UI | `src/cli/DiffApproval.tsx` |
| Agent orchestrator runner | `src/api/runner.ts` |
| Agent builder | `src/api/builder.ts` |
| System prompts + roles | `src/api/prompts.ts` |
| Delegation tool | `src/api/tools/delegate.ts` |
| File tools | `src/api/tools/files.ts` |
| Shell tool | `src/api/tools/shell.ts` |
| Search tool | `src/api/tools/search.ts` |
| Git tools | `src/api/tools/git.ts` |
| Web tools | `src/api/tools/web.ts` |
| Checks tool | `src/api/tools/checks.ts` |
| Plan-mode tool | `src/api/tools/plan.ts` |
| Summarize tool | `src/api/tools/summarize.ts` |
| Model factory | `src/api/model.ts` |
| Project-type detection | `src/api/projectType.ts` |
| MCP integration | `src/api/mcp/` |

---

## 20. Mental model in one paragraph

axon is a CLI agent that, by default, runs a single planner with a flat
fan-out of leaf specialists. The planner has a written advisory budget
(softCap=10) and a silent ceiling (hardCap=25); leaf specialists are
typed by **role**, each role is a system prompt + a structured return
format, and the role registry is per-project (`.axon/roles/`) with five
built-ins available out of the box. Project shape is configured via
`.axon/architecture.json` — depth, per-parent fan-out, per-depth fan-out,
a cheaper leaf model, and a `requireRole` toggle — and absolutely
nothing changes for users who don't write that file. The CLI on top is
a TUI with multi-line input, diff-preview approvals, per-tool
allow/deny, plan mode, session persistence, custom slash commands,
mentions, and MCP support. Most of the surface is opt-in: defaults give
you a competent single-orchestrator agent, and every escape valve is one
slash command away.

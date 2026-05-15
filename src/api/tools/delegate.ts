import { HumanMessage } from "@langchain/core/messages";
import { tool } from "langchain";
import { z } from "zod";
import type {
  AgentRunState,
  FileChangeFn,
  Logger,
  ToolApprover,
} from "../types.js";
import { DEFAULT_SOFT_CAP } from "../types.js";
import { extractText } from "../messages.js";
import {
  defaultRoleMap,
  resolveSubAgentSystemPrompt,
  shortRole,
  subAgentPrompt,
  truncate,
  type RoleMap,
} from "../prompts.js";
import { buildAgent } from "../builder.js";

// ===========================================================================
// delegation tool
// ===========================================================================

export interface CallAgentToolOptions {
  depth: number;
  state: AgentRunState;
  log: Logger | undefined;
  indent: string;
  workspaceRoot: string;
  onFileChange: FileChangeFn | undefined;
  extraTools?: unknown[];
  planMode?: boolean;
  approver?: ToolApprover;
  abortSignal?: AbortSignal;
  onModelUsage?: (usage: { input: number; output: number }) => void;
  // Advisory soft cap passed through to sub-agents that can themselves
  // delegate (only relevant when maxDepth > 1).
  softCap?: number;
  // Model name override for sub-agents this tool spawns. When set,
  // sub-agents are built with this model instead of the orchestrator's.
  subAgentModel?: string;
  // When true, calls that don't pass one of the role names from `roles`
  // are rejected — the orchestrator must use a known role.
  requireRole?: boolean;
  // Active role registry (built-ins + custom roles from .axon/roles/).
  // Defines the schema enum for `call_agent({role: ...})` and the prompt
  // looked up when resolving a role name.
  roles?: RoleMap;
}

export function createCallAgentTool(opts: CallAgentToolOptions) {
  const {
    depth,
    state,
    log,
    indent,
    workspaceRoot,
    onFileChange,
    extraTools = [],
    planMode = false,
    approver,
    abortSignal,
    onModelUsage,
    softCap = DEFAULT_SOFT_CAP,
    subAgentModel,
    requireRole = false,
    roles = defaultRoleMap(),
  } = opts;

  // Snapshot the role-name list at tool-build time. The Zod enum is
  // immutable once constructed; a later /roles reload won't update an
  // in-flight tool, only future agent invocations.
  const roleNames = Array.from(roles.keys());

  // Per-parent fan-out counter. Each delegate-tool instance belongs to one
  // agent (the parent at `depth`), so this closure tracks how many
  // children that specific agent has spawned. The cap value is read from
  // state so configuration flows through one place.
  let ownChildCount = 0;

  // Build the role schema. If there are NO roles registered (shouldn't
  // normally happen — built-ins always seed the map), fall back to a
  // plain string so we don't crash z.enum on an empty list.
  const roleSchema =
    roleNames.length > 0
      ? z
          .enum(roleNames as [string, ...string[]])
          .optional()
          .describe(
            `One of the registered roles: ${roleNames.join(", ")}. Each role has a system prompt with scope rules and a structured return format. Prefer this over writing a custom systemPrompt unless none fits.`,
          )
      : z
          .string()
          .optional()
          .describe(
            "Role name. No roles are registered for this run — pass a systemPrompt instead.",
          );

  return tool(
    async ({ role, systemPrompt: subSystemPrompt, prompt }) => {
      // requireRole policy — reject custom systemPrompts entirely.
      if (requireRole && (!role || !roles.has(role))) {
        log?.(
          "warn",
          `${indent}✗ delegation refused · requireRole=true, no valid role given`,
        );
        return `Delegation refused: this project requires every call_agent invocation to pass one of the registered roles: ${roleNames.join(", ")}. Custom systemPrompts are not allowed. Pick the role that best fits the subtask and re-call.`;
      }

      const resolved = resolveSubAgentSystemPrompt({
        role,
        systemPrompt: subSystemPrompt,
        roles,
      });
      const displayRole =
        resolved.resolvedRole === "custom"
          ? shortRole(resolved.systemPrompt)
          : resolved.resolvedRole;

      // Global hard cap — runaway-loop rail.
      if (state.callCount >= state.maxCalls) {
        log?.(
          "warn",
          `${indent}✗ delegation refused · hard cap ${state.maxCalls} reached · role="${displayRole}"`,
        );
        return `Delegation refused: hard sub-agent call ceiling (${state.maxCalls}) reached for this request. The task was likely over-decomposed — synthesize what you have and solve the rest directly.`;
      }

      // Per-parent fan-out cap.
      if (
        typeof state.maxCallsPerAgent === "number" &&
        ownChildCount >= state.maxCallsPerAgent
      ) {
        log?.(
          "warn",
          `${indent}✗ delegation refused · per-parent cap ${state.maxCallsPerAgent} reached at depth ${depth} · role="${displayRole}"`,
        );
        return `Delegation refused: this agent has already spawned ${state.maxCallsPerAgent} sub-agents (its per-parent fan-out cap). Synthesize the results you have, then either solve the rest directly or run a second wave from a higher-level plan.`;
      }

      // Per-depth fan-out cap. The cap applies to the CHILD's depth.
      const childDepth = depth + 1;
      const perDepthCap = state.maxCallsAtDepth?.[childDepth];
      const usedAtDepth = state.callsAtDepth[childDepth] ?? 0;
      if (typeof perDepthCap === "number" && usedAtDepth >= perDepthCap) {
        log?.(
          "warn",
          `${indent}✗ delegation refused · depth-${childDepth} cap ${perDepthCap} reached · role="${displayRole}"`,
        );
        return `Delegation refused: the per-depth cap for depth ${childDepth} (${perDepthCap}) is already used up across all branches in this run. Either solve this subtask directly or wait for an earlier sibling to free budget by finishing (it won't — caps are run-scoped, not concurrent).`;
      }

      // All checks passed — increment counters and spawn.
      state.callCount++;
      ownChildCount++;
      state.callsAtDepth[childDepth] = usedAtDepth + 1;
      const callIndex = state.callCount;

      const childCanDelegate = childDepth < state.maxDepth;
      log?.(
        "info",
        `${indent}↳ spawn sub-agent #${callIndex} · depth ${childDepth}/${state.maxDepth} · role="${displayRole}" · task="${truncate(prompt)}"`,
      );
      const subAgent = buildAgent({
        systemPrompt: subAgentPrompt(
          resolved.systemPrompt,
          childCanDelegate,
          softCap,
          roles,
        ),
        log,
        depth: childDepth,
        state,
        workspaceRoot,
        onFileChange,
        extraTools,
        planMode,
        approver,
        abortSignal,
        onModelUsage,
        softCap,
        modelName: subAgentModel,
        subAgentModel,
        requireRole,
        roles,
      });
      const result = await subAgent.invoke(
        { messages: [new HumanMessage(prompt)] },
        abortSignal ? { signal: abortSignal } : undefined,
      );
      const text = extractText(result.messages.at(-1)) || "";
      log?.(
        "info",
        `${indent}✓ sub-agent #${callIndex} done · role="${displayRole}" · ${text.length} chars returned`,
      );
      return text;
    },
    {
      name: "call_agent",
      description:
        `Delegate a focused subtask to a leaf specialist sub-agent. Returns the sub-agent's final compact report as a string. ` +
        `You assign the role either by passing one of the registered role names${roleNames.length ? ` (${roleNames.map((r) => `'${r}'`).join(", ")})` : ""} in 'role', OR by writing a custom 'systemPrompt'. ` +
        `The sub-agent does not see this conversation, so 'prompt' must be self-contained: state the scope, what to produce, and what NOT to touch.`,
      schema: z.object({
        role: roleSchema,
        systemPrompt: z
          .string()
          .optional()
          .describe(
            "Custom role/persona prompt for the sub-agent. Use this only when no registered role fits. Ignored if 'role' is provided.",
          ),
        prompt: z
          .string()
          .describe(
            "The self-contained task for the sub-agent. Include any context the sub-agent needs since it cannot see this conversation. State the scope explicitly (e.g. 'you may only touch files under src/api/tools/') and what NOT to cover so the sub-agent does not drift.",
          ),
      }),
    },
  );
}

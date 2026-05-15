import { tool } from "langchain";
import { z } from "zod";

// ===========================================================================
// exit_plan_mode tool — only registered while plan mode is active
// ===========================================================================
//
// The CLI gates this through the approver just like any other tool. The
// approver presents the plan to the user, who either approves it (the tool
// returns a "go ahead" message and the CLI flips plan mode off so subsequent
// mutating tools are no longer auto-denied) or rejects it with feedback
// (returned to the agent so it can revise).
//
// Keeping the tool itself thin — the actual approval UX lives in the CLI;
// the tool just shapes the request so the approver can recognize it.

export const EXIT_PLAN_MODE_TOOL_NAME = "exit_plan_mode";

// Tool names the agent may invoke while plan mode is active. Anything not on
// this list is auto-denied by the approver with a "call exit_plan_mode first"
// message. Read-only inspection, search, git reads, web reads, sub-agent
// delegation, and the plan-exit tool itself are all fine. Mutations (writes,
// deletes, commits, command execution, build runs) are not.
export const PLAN_MODE_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
  "list_files",
  "search",
  "git_status",
  "git_diff",
  "git_blame",
  "git_log",
  "web_search",
  "web_fetch",
  "call_agent",
  "summarize_conversation",
  EXIT_PLAN_MODE_TOOL_NAME,
]);

export function createExitPlanModeTool() {
  return tool(
    async ({ plan }) => {
      // If this returns at all (rather than the approver short-circuiting
      // with deny), the user approved the plan. The CLI also flips its
      // planMode state to false so further mutating tools go through normal
      // approval instead of being auto-denied.
      return (
        "Plan approved by the user. You are no longer in plan mode — proceed " +
        "with the changes described in the plan. Stay within scope: do not " +
        "expand beyond what the plan covers without asking."
      );
    },
    {
      name: EXIT_PLAN_MODE_TOOL_NAME,
      description:
        "Present your finalized plan to the user for approval and exit plan mode. Call this once you have explored the codebase enough to write a concrete plan. Pass the full plan as markdown in the `plan` argument — describe what you'll change, in which files, and in what order. If the user approves, you may proceed with edits. If they reject, refine the plan based on their feedback and call this tool again.",
      schema: z.object({
        plan: z
          .string()
          .describe(
            "The full plan to present to the user, as markdown. Cover: what you'll change, in which files, in what order, and any tradeoffs the user should be aware of. Keep it concrete and reviewable.",
          ),
      }),
    },
  );
}

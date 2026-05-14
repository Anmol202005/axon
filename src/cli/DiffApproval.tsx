import { useState, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import type {
  ToolApprovalDecision,
  ToolApprovalRequest,
} from "../api/types.js";
import { MultilineInput } from "./MultilineInput.js";

// ===========================================================================
// ToolApproval — captures the user's decision for a pending tool call.
// Three options, Claude Code style:
//   1. Allow once
//   2. Always allow `<tool>` this session
//   3. Deny, and tell axon what to do (esc)
// ===========================================================================

export interface DecisionMeta {
  // When true, the caller should auto-approve all subsequent calls of the
  // SAME tool for the remainder of the session.
  rememberSession?: boolean;
}

interface ToolApprovalProps {
  request: ToolApprovalRequest;
  onDecide: (decision: ToolApprovalDecision, meta?: DecisionMeta) => void;
}

type Mode = "menu" | "feedback";

export function DiffApproval({ request, onDecide }: ToolApprovalProps) {
  const [mode, setMode] = useState<Mode>("menu");
  const [selected, setSelected] = useState(0);
  const [feedback, setFeedback] = useState("");

  const options = [
    "Allow once",
    `Always allow \`${request.toolName}\` this session`,
    "Deny, and tell axon what to do (esc)",
  ];

  const pick = useCallback(
    (idx: number) => {
      if (idx === 0) onDecide({ kind: "allow_once" });
      else if (idx === 1) onDecide({ kind: "always_allow" });
      else if (idx === 2) setMode("feedback");
    },
    [onDecide],
  );

  // Menu navigation.
  useInput(
    (input, key) => {
      if (key.upArrow) {
        setSelected((s) => (s + options.length - 1) % options.length);
      } else if (key.downArrow) {
        setSelected((s) => (s + 1) % options.length);
      } else if (key.return) {
        pick(selected);
      } else if (key.escape) {
        pick(2);
      } else if (input === "1") pick(0);
      else if (input === "2") pick(1);
      else if (input === "3") pick(2);
    },
    { isActive: mode === "menu" },
  );

  // Feedback mode: esc cancels back to the menu. MultilineInput handles
  // text editing and submit via its own useInput; both hooks coexist.
  useInput(
    (_input, key) => {
      if (key.escape) {
        setFeedback("");
        setMode("menu");
      }
    },
    { isActive: mode === "feedback" },
  );

  const handleFeedbackSubmit = useCallback(
    (val: string) => {
      const reason = val.trim() || "no reason given";
      onDecide({ kind: "deny", reason });
    },
    [onDecide],
  );

  const summary = humanizeToolCall(request.toolName, request.args);

  return (
    <Box flexDirection="column" marginY={1}>
      <Box>
        <Text color="yellow" bold>{"⚠ "}</Text>
        <Text bold>{"axon wants to run "}</Text>
        <Text color="cyan" bold>{request.toolName}</Text>
      </Box>
      <Box paddingLeft={2}>
        <Text dimColor>{summary}</Text>
      </Box>

      <Box marginTop={1}>
        {mode === "menu" ? (
          <Box flexDirection="column">
            <Box marginBottom={1}>
              <Text>{"Allow this tool call?"}</Text>
            </Box>
            {options.map((opt, i) => {
              const active = i === selected;
              return (
                <Box key={i}>
                  <Text color={active ? "cyan" : undefined} bold={active}>
                    {active ? "❯ " : "  "}
                    {i + 1}. {opt}
                  </Text>
                </Box>
              );
            })}
            <Box marginTop={1}>
              <Text dimColor>
                ↑/↓ move · ↵ select · 1/2/3 shortcut · esc = deny
              </Text>
            </Box>
          </Box>
        ) : (
          <Box flexDirection="column">
            <Box marginBottom={1}>
              <Text>Tell axon what to do differently:</Text>
            </Box>
            <Box borderStyle="round" borderColor="cyan" paddingX={1}>
              <Text color="cyan" bold>{"› "}</Text>
              <Box flexGrow={1}>
                <MultilineInput
                  value={feedback}
                  onChange={setFeedback}
                  onSubmit={handleFeedbackSubmit}
                  placeholder="describe what to do instead…"
                />
              </Box>
            </Box>
            <Box paddingX={1}>
              <Text dimColor>↵ submit · esc cancel</Text>
            </Box>
          </Box>
        )}
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// humanizeToolCall — short one-line summary of what the tool is about to do.
// We special-case the built-in tools we know; everything else (MCP, future
// additions) falls back to a truncated JSON of args.
// ---------------------------------------------------------------------------

function humanizeToolCall(
  name: string,
  args: Record<string, unknown>,
): string {
  const str = (v: unknown): string =>
    typeof v === "string" ? v : JSON.stringify(v ?? "");
  switch (name) {
    case "write_file":
      return `write ${str(args.path)} (${(str(args.content) ?? "").length} bytes)`;
    case "delete_file":
      return `delete ${str(args.path)}`;
    case "run_command":
      return `$ ${truncate(str(args.command), 100)}`;
    case "call_agent": {
      const role = truncate(str(args.systemPrompt), 40);
      const task = truncate(str(args.prompt), 60);
      return `delegate → ${role} :: ${task}`;
    }
    case "summarize_conversation":
      return "summarize conversation so far";
    default: {
      try {
        return truncate(JSON.stringify(args), 120);
      } catch {
        return "(unprintable args)";
      }
    }
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

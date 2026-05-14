import React, { useState, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import type { WriteDecision, WriteRequest } from "../api/types.js";
import { MultilineInput } from "./MultilineInput.js";

// ===========================================================================
// DiffApproval — captures the user's decision for a pending write. Three
// options, Claude Code style:
//   1. Yes
//   2. Yes, and don't ask again this session
//   3. No, and tell axon what to do (esc)
//
// The actual diff body is intentionally not rendered here — visual diffing
// will come back through a proper IDE integration later. For now we only
// announce what the agent wants to do and let the user accept or push back.
// ===========================================================================

const OPTIONS = [
  "Yes",
  "Yes, and don't ask again this session",
  "No, and tell axon what to do (esc)",
];

export interface DecisionMeta {
  // When true, the caller should auto-approve subsequent writes for the
  // remainder of the session without showing this UI.
  rememberSession?: boolean;
}

interface DiffApprovalProps {
  request: WriteRequest;
  onDecide: (decision: WriteDecision, meta?: DecisionMeta) => void;
}

type Mode = "menu" | "feedback";

export function DiffApproval({ request, onDecide }: DiffApprovalProps) {
  const [mode, setMode] = useState<Mode>("menu");
  const [selected, setSelected] = useState(0);
  const [feedback, setFeedback] = useState("");

  const pick = useCallback(
    (idx: number) => {
      if (idx === 0) onDecide({ kind: "apply" });
      else if (idx === 1) onDecide({ kind: "apply" }, { rememberSession: true });
      else if (idx === 2) setMode("feedback");
    },
    [onDecide],
  );

  // Menu navigation.
  useInput(
    (input, key) => {
      if (key.upArrow) {
        setSelected((s) => (s + OPTIONS.length - 1) % OPTIONS.length);
      } else if (key.downArrow) {
        setSelected((s) => (s + 1) % OPTIONS.length);
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
      onDecide({ kind: "reject", reason });
    },
    [onDecide],
  );

  const isNewFile =
    request.action === "write" && request.oldContent === undefined;
  const isDelete = request.action === "delete";
  const headerLabel = isDelete
    ? "delete"
    : isNewFile
      ? "create"
      : "edit";

  return (
    <Box flexDirection="column" marginY={1}>
      <Box>
        <Text color="yellow" bold>{`⚠ ${headerLabel} `}</Text>
        <Text color="cyan" bold>{request.path}</Text>
      </Box>

      <Box marginTop={1}>
        {mode === "menu" ? (
          <Box flexDirection="column">
            <Box marginBottom={1}>
              <Text>{"Do you want to "}</Text>
              <Text bold>{headerLabel}</Text>
              <Text>{" "}</Text>
              <Text color="cyan" bold>{request.path}</Text>
              <Text>{"?"}</Text>
            </Box>
            {OPTIONS.map((opt, i) => {
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
                ↑/↓ move · ↵ select · 1/2/3 shortcut · esc = no
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
                  placeholder="describe what to change…"
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

import React, { useState, useCallback, useRef } from "react";
import { Box, Text, Static, useApp } from "ink";
import TextInput from "ink-text-input";
import Spinner from "ink-spinner";
import { runAgent } from "../api/agent.js";
import type { ChatMessage } from "../api/agent.js";

// ===========================================================================
// axon — terminal chat UI
// ===========================================================================

type Role = "user" | "assistant" | "system";

interface Item {
  id: number;
  role: Role;
  content: string;
}

type StaticEntry = { kind: "header" } | { kind: "msg"; item: Item };

function Header() {
  const cwd = process.cwd();
  const model = process.env.AI_MODEL || "(default)";
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      marginBottom={1}
    >
      <Text color="cyan" bold>
        ● axon
      </Text>
      <Text color="gray">terminal coding agent · model {model}</Text>
      <Text color="gray">cwd: {cwd}</Text>
      <Text color="gray">type /help for commands · /exit to quit</Text>
    </Box>
  );
}

function Message({ item }: { item: Item }) {
  if (item.role === "user") {
    return (
      <Box marginBottom={1}>
        <Text color="cyan" bold>
          {"› "}
        </Text>
        <Text>{item.content}</Text>
      </Box>
    );
  }
  if (item.role === "assistant") {
    return (
      <Box marginBottom={1} flexDirection="column">
        <Text color="green" bold>
          ● axon
        </Text>
        <Text>{item.content}</Text>
      </Box>
    );
  }
  return (
    <Box marginBottom={1}>
      <Text color="yellow" dimColor>
        {item.content}
      </Text>
    </Box>
  );
}

export function App() {
  const { exit } = useApp();
  const [items, setItems] = useState<Item[]>([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [activity, setActivity] = useState("");
  const [error, setError] = useState<string | null>(null);
  const idRef = useRef(0);

  const append = useCallback((role: Role, content: string) => {
    idRef.current += 1;
    const id = idRef.current;
    setItems((prev) => [...prev, { id, role, content }]);
  }, []);

  const handleSubmit = useCallback(
    async (value: string) => {
      const trimmed = value.trim();
      if (!trimmed || running) return;
      setInput("");

      if (trimmed.startsWith("/")) {
        const cmd = trimmed.slice(1).toLowerCase();
        if (cmd === "exit" || cmd === "quit") {
          exit();
          return;
        }
        if (cmd === "clear") {
          setItems([]);
          setError(null);
          append(
            "system",
            "Conversation cleared. Starting a fresh context.",
          );
          return;
        }
        if (cmd === "help") {
          append(
            "system",
            "Commands:\n  /help    show this help\n  /clear   reset the conversation\n  /exit    quit axon\n\nType a question or describe a task to begin.",
          );
          return;
        }
        append("system", `Unknown command: /${cmd}`);
        return;
      }

      append("user", trimmed);

      setRunning(true);
      setError(null);
      setActivity("Thinking…");

      const history: ChatMessage[] = [
        ...items
          .filter((i) => i.role !== "system")
          .map<ChatMessage>((i) => ({
            role: i.role === "user" ? "user" : "assistant",
            content: i.content,
          })),
        { role: "user", content: trimmed },
      ];

      try {
        const result = await runAgent({
          messages: history,
          onEvent: (ev) => {
            if (ev.type === "log") setActivity(ev.entry.msg);
            else if (ev.type === "file_changed")
              setActivity(`${ev.action} ${ev.path}`);
            else if (ev.type === "error") setError(ev.message);
          },
        });
        append("assistant", result.text || "(no output)");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        append("system", `Error: ${msg}`);
      } finally {
        setRunning(false);
        setActivity("");
      }
    },
    [running, items, exit, append],
  );

  const staticEntries: StaticEntry[] = [
    { kind: "header" },
    ...items.map<StaticEntry>((item) => ({ kind: "msg", item })),
  ];

  return (
    <Box flexDirection="column">
      <Static items={staticEntries}>
        {(entry) =>
          entry.kind === "header" ? (
            <Header key="header" />
          ) : (
            <Message key={`m-${entry.item.id}`} item={entry.item} />
          )
        }
      </Static>
      {running ? (
        <Box flexDirection="column">
          <Box>
            <Text color="cyan">
              <Spinner type="dots" />
            </Text>
            <Text color="gray"> {activity || "Working…"}</Text>
          </Box>
          <Box>
            <Text dimColor>(Ctrl+C to stop)</Text>
          </Box>
        </Box>
      ) : (
        <Box flexDirection="column">
          {error && (
            <Box marginBottom={1}>
              <Text color="red">{error}</Text>
            </Box>
          )}
          <Box>
            <Text color="cyan" bold>
              {"› "}
            </Text>
            <TextInput
              value={input}
              onChange={setInput}
              onSubmit={handleSubmit}
              placeholder="Ask axon anything…"
            />
          </Box>
        </Box>
      )}
    </Box>
  );
}

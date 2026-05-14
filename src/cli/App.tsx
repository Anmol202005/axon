import React, { useState, useCallback, useRef } from "react";
import { Box, Text, Static, useApp, useStdout } from "ink";
import Spinner from "ink-spinner";
import { runAgent } from "../api/agent.js";
import type {
  ChatMessage,
  WriteDecision,
  WriteRequest,
} from "../api/agent.js";
import { Welcome } from "./Logo.js";
import { MultilineInput } from "./MultilineInput.js";
import { renderMarkdown } from "./markdown.js";
import { DiffApproval, type DecisionMeta } from "./DiffApproval.js";

// ===========================================================================
// axon — terminal chat UI
// ===========================================================================

type Role = "user" | "assistant" | "system";

interface Item {
  id: number;
  role: Role;
  content: string;
}

type StaticEntry =
  | { kind: "welcome" }
  | { kind: "msg"; item: Item };

function Message({ item }: { item: Item }) {
  const { stdout } = useStdout();
  const termWidth = stdout?.columns ?? 80;

  if (item.role === "user") {
    // One <Text> per line so the grey background fills each row cleanly —
    // an embedded \n inside a single <Text> breaks the bg fill.
    const lines = item.content.split("\n");
    return (
      <Box marginBottom={1} flexDirection="column">
        {lines.map((line, i) => {
          const prefix = i === 0 ? "> " : "  ";
          const body = prefix + line;
          const padded =
            body.length < termWidth
              ? body + " ".repeat(termWidth - body.length)
              : body;
          return (
            <Text key={i} backgroundColor="gray">
              {padded}
            </Text>
          );
        })}
      </Box>
    );
  }
  if (item.role === "assistant") {
    const rendered = renderMarkdown(item.content);
    return (
      <Box marginBottom={1} flexDirection="column">
        <Box>
          <Text color="green" bold>
            ●
          </Text>
          <Text color="green" bold>
            {" axon"}
          </Text>
        </Box>
        <Box paddingLeft={2}>
          <Text>{rendered}</Text>
        </Box>
      </Box>
    );
  }
  // system
  return (
    <Box marginBottom={1} paddingLeft={2}>
      <Text color="yellow" dimColor>
        {item.content}
      </Text>
    </Box>
  );
}

function Working({
  activity,
  liveText,
}: {
  activity: string;
  liveText: string;
}) {
  return (
    <Box flexDirection="column" marginY={1}>
      <Box>
        <Text color="cyan">
          <Spinner type="dots" />
        </Text>
        <Text color="cyan" bold>
          {"  axon is working…"}
        </Text>
      </Box>
      {activity ? (
        <Box paddingLeft={4}>
          <Text dimColor>· {activity}</Text>
        </Box>
      ) : null}
      {liveText ? (
        <Box flexDirection="column" marginTop={1}>
          <Box>
            <Text color="green" bold>
              ●
            </Text>
            <Text color="green" bold>
              {" axon"}
            </Text>
            <Text dimColor>  (streaming…)</Text>
          </Box>
          <Box paddingLeft={2}>
            <Text>{liveText}</Text>
          </Box>
        </Box>
      ) : null}
      <Box paddingLeft={4} marginTop={liveText ? 1 : 0}>
        <Text dimColor>press ctrl-c to stop</Text>
      </Box>
    </Box>
  );
}

function InputBar({
  input,
  onChange,
  onSubmit,
  onHistoryUp,
  onHistoryDown,
}: {
  input: string;
  onChange: (s: string) => void;
  onSubmit: (s: string) => void;
  onHistoryUp: () => void;
  onHistoryDown: () => void;
}) {
  return (
    <Box flexDirection="column">
      <Box
        borderStyle="round"
        borderColor="cyan"
        paddingX={1}
        width="100%"
      >
        <Text color="cyan" bold>
          {"› "}
        </Text>
        <Box flexGrow={1}>
          <MultilineInput
            value={input}
            onChange={onChange}
            onSubmit={onSubmit}
            onHistoryUp={onHistoryUp}
            onHistoryDown={onHistoryDown}
            placeholder="type a message or / for commands…"
          />
        </Box>
      </Box>
      <Box paddingX={1}>
        <Text dimColor>↵ </Text>
        <Text dimColor>send  ·  </Text>
        <Text dimColor>\↵ newline  ·  </Text>
        <Text dimColor>↓/↑ history  ·  </Text>
        <Text dimColor>ctrl-c to exit</Text>
      </Box>
    </Box>
  );
}

export function App() {
  const { exit } = useApp();
  const [items, setItems] = useState<Item[]>([]);
  const [contextStart, setContextStart] = useState(0);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [activity, setActivity] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [draft, setDraft] = useState("");
  const [liveText, setLiveText] = useState("");
  const liveTextRef = useRef("");
  const idRef = useRef(0);
  const [pendingWrite, setPendingWrite] = useState<WriteRequest | null>(null);
  // Resolver for the currently-pending approval promise. We stash it in a
  // ref so the DiffApproval component (and any later state transitions) can
  // resolve it without re-creating the promise.
  const writeResolverRef = useRef<((d: WriteDecision) => void) | null>(null);
  // "Yes, and don't ask again this session" — session-scoped auto-approve.
  // Held in a ref because the onWriteRequest callback below is memoized and
  // we want to read the latest value at request time.
  const autoApproveRef = useRef(false);
  const [autoApprove, setAutoApprove] = useState(false);

  const onWriteRequest = useCallback(
    (req: WriteRequest): Promise<WriteDecision> => {
      if (autoApproveRef.current) {
        return Promise.resolve<WriteDecision>({ kind: "apply" });
      }
      return new Promise<WriteDecision>((resolve) => {
        writeResolverRef.current = resolve;
        setPendingWrite(req);
      });
    },
    [],
  );

  const handleDecision = useCallback(
    (decision: WriteDecision, meta?: DecisionMeta) => {
      if (meta?.rememberSession) {
        autoApproveRef.current = true;
        setAutoApprove(true);
      }
      const resolve = writeResolverRef.current;
      writeResolverRef.current = null;
      setPendingWrite(null);
      resolve?.(decision);
    },
    [],
  );

  const append = useCallback((role: Role, content: string) => {
    idRef.current += 1;
    const id = idRef.current;
    setItems((prev) => [...prev, { id, role, content }]);
  }, []);

  // ↓ on the bottom line of the input → previous (older) prompt
  const handleHistoryDown = useCallback(() => {
    if (running) return;
    if (history.length === 0) return;
    if (historyIndex === -1) {
      setDraft(input);
      const next = history.length - 1;
      setHistoryIndex(next);
      setInput(history[next]);
    } else if (historyIndex > 0) {
      const next = historyIndex - 1;
      setHistoryIndex(next);
      setInput(history[next]);
    }
  }, [running, history, historyIndex, input]);

  // ↑ on the top line of the input → later (newer) prompt; restores draft at end
  const handleHistoryUp = useCallback(() => {
    if (running) return;
    if (historyIndex === -1) return;
    if (historyIndex < history.length - 1) {
      const next = historyIndex + 1;
      setHistoryIndex(next);
      setInput(history[next]);
    } else {
      setHistoryIndex(-1);
      setInput(draft);
    }
  }, [running, history, historyIndex, draft]);

  const handleInputChange = useCallback(
    (value: string) => {
      setInput(value);
      if (historyIndex !== -1) {
        setHistoryIndex(-1);
        setDraft("");
      }
    },
    [historyIndex],
  );

  const recordHistory = useCallback((text: string) => {
    setHistory((prev) =>
      prev[prev.length - 1] === text ? prev : [...prev, text],
    );
    setHistoryIndex(-1);
    setDraft("");
  }, []);

  const handleSubmit = useCallback(
    async (value: string) => {
      const trimmed = value.trim();
      if (!trimmed || running) return;
      setInput("");
      recordHistory(trimmed);

      if (trimmed.startsWith("/")) {
        const cmd = trimmed.slice(1).toLowerCase();
        if (cmd === "exit" || cmd === "quit") {
          exit();
          return;
        }
        if (cmd === "clear") {
          idRef.current += 1;
          const marker: Item = {
            id: idRef.current,
            role: "system",
            content: "── conversation reset · context cleared ──",
          };
          setItems((prev) => {
            const next = [...prev, marker];
            setContextStart(next.length);
            return next;
          });
          setError(null);
          autoApproveRef.current = false;
          setAutoApprove(false);
          return;
        }
        if (cmd === "help") {
          append(
            "system",
            "commands\n  /help    show this help\n  /clear   reset the conversation context\n  /exit    quit axon\n\nshortcuts\n  ↵            send the current message\n  \\↵           insert a newline (backslash + enter)\n  alt+↵ / ctrl+j  also insert a newline\n  shift+↵       newline on terminals that report it\n  ↑ / ↓        move cursor across lines (or browse prompt history at the edges)\n  ctrl+a / ctrl+e  jump to start / end of the current line\n  ctrl+u / ctrl+k  delete to start / end of the current line\n  ctrl-c        quit at any time",
          );
          return;
        }
        append("system", `unknown command: /${cmd}  (try /help)`);
        return;
      }

      append("user", trimmed);
      setRunning(true);
      setError(null);
      setActivity("");
      liveTextRef.current = "";
      setLiveText("");

      const history: ChatMessage[] = [
        ...items
          .slice(contextStart)
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
          onWriteRequest,
          onEvent: (ev) => {
            if (ev.type === "token") {
              liveTextRef.current += ev.content;
              setLiveText(liveTextRef.current);
            } else if (ev.type === "token_reset") {
              liveTextRef.current = "";
              setLiveText("");
            } else if (ev.type === "log") setActivity(ev.entry.msg);
            else if (ev.type === "file_changed")
              setActivity(`${ev.action} ${ev.path}`);
            else if (ev.type === "error") setError(ev.message);
          },
        });
        append(
          "assistant",
          result.text || liveTextRef.current || "(no output)",
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        append("system", `error: ${msg}`);
      } finally {
        setRunning(false);
        setActivity("");
        liveTextRef.current = "";
        setLiveText("");
      }
    },
    [running, items, contextStart, exit, append, recordHistory, onWriteRequest],
  );

  const staticEntries: StaticEntry[] = [
    { kind: "welcome" },
    ...items.map<StaticEntry>((item) => ({ kind: "msg", item })),
  ];

  return (
    <Box flexDirection="column" width="100%">
      <Static items={staticEntries}>
        {(entry) =>
          entry.kind === "welcome" ? (
            <Welcome key="welcome" />
          ) : (
            <Message key={`m-${entry.item.id}`} item={entry.item} />
          )
        }
      </Static>
      {pendingWrite ? (
        <DiffApproval request={pendingWrite} onDecide={handleDecision} />
      ) : running ? (
        <Working activity={activity} liveText={liveText} />
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {error && (
            <Box marginBottom={1}>
              <Text color="red">✗ </Text>
              <Text color="red">{error}</Text>
            </Box>
          )}
          {autoApprove && (
            <Box marginBottom={1}>
              <Text color="yellow">
                ⚡ auto-approving writes this session · /clear to reset
              </Text>
            </Box>
          )}
          <InputBar
            input={input}
            onChange={handleInputChange}
            onSubmit={handleSubmit}
            onHistoryUp={handleHistoryUp}
            onHistoryDown={handleHistoryDown}
          />
        </Box>
      )}
    </Box>
  );
}

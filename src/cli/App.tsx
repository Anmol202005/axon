import { useState, useCallback, useRef, useMemo } from "react";
import { Box, Text, Static, useApp, useStdout } from "ink";
import Spinner from "ink-spinner";
import { runAgent, buildModel, summarizeMessages } from "../api/agent.js";
import type {
  ChatMessage,
  ToolApprovalDecision,
  ToolApprovalRequest,
} from "../api/agent.js";
import { Welcome } from "./Logo.js";
import { MultilineInput } from "./MultilineInput.js";
import { renderMarkdown } from "./markdown.js";
import { DiffApproval, type DecisionMeta } from "./DiffApproval.js";
import { expandMentions } from "./mentions.js";
import {
  compactThreshold,
  contextUsage,
  estimateMessagesTokens,
} from "./tokens.js";

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
  usage,
}: {
  input: string;
  onChange: (s: string) => void;
  onSubmit: (s: string) => void;
  onHistoryUp: () => void;
  onHistoryDown: () => void;
  usage: { pct: number; level: "green" | "yellow" | "red" };
}) {
  const usageColor =
    usage.level === "red"
      ? "red"
      : usage.level === "yellow"
        ? "yellow"
        : "green";
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
            placeholder="type a message, @path to attach, or / for commands…"
          />
        </Box>
      </Box>
      <Box paddingX={1}>
        <Text dimColor>↵ </Text>
        <Text dimColor>send  ·  </Text>
        <Text dimColor>\↵ newline  ·  </Text>
        <Text dimColor>↓/↑ history  ·  </Text>
        <Text dimColor>ctrl-c to exit  ·  </Text>
        <Text color={usageColor}>ctx {usage.pct}%</Text>
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
  const [pendingTool, setPendingTool] = useState<ToolApprovalRequest | null>(
    null,
  );
  // Resolver for the currently-pending approval promise. We stash it in a
  // ref so the DiffApproval component (and any later state transitions) can
  // resolve it without re-creating the promise.
  const toolResolverRef = useRef<
    ((d: ToolApprovalDecision) => void) | null
  >(null);
  // Tools the user has chosen "Always allow" for during this session.
  // Stored in a ref so the memoized onToolApprovalRequest reads the latest
  // value; mirrored to state for the always-allowed banner.
  const alwaysAllowedRef = useRef<Set<string>>(new Set());
  const [alwaysAllowed, setAlwaysAllowed] = useState<string[]>([]);
  // Auto-compacted summary of older turns. When set, it's prepended (as a
  // system message) to every history sent to the agent, and items before
  // contextStart are dropped from the conversation. Reset on /clear.
  const [summary, setSummary] = useState<string | null>(null);

  // Coarse context-window usage shown next to the input. Recalculated when
  // the active context slice or the carried summary changes.
  const usage = useMemo(() => {
    const messages = items
      .slice(contextStart)
      .filter((i) => i.role !== "system")
      .map((i) => ({ content: i.content }));
    if (summary) messages.unshift({ content: summary });
    return contextUsage(estimateMessagesTokens(messages));
  }, [items, contextStart, summary]);

  const onToolApprovalRequest = useCallback(
    (req: ToolApprovalRequest): Promise<ToolApprovalDecision> => {
      if (alwaysAllowedRef.current.has(req.toolName)) {
        return Promise.resolve<ToolApprovalDecision>({ kind: "allow_once" });
      }
      return new Promise<ToolApprovalDecision>((resolve) => {
        toolResolverRef.current = resolve;
        setPendingTool(req);
      });
    },
    [],
  );

  const handleDecision = useCallback(
    (decision: ToolApprovalDecision, _meta?: DecisionMeta) => {
      if (decision.kind === "always_allow" && pendingTool) {
        const name = pendingTool.toolName;
        alwaysAllowedRef.current.add(name);
        setAlwaysAllowed((prev) =>
          prev.includes(name) ? prev : [...prev, name],
        );
      }
      const resolve = toolResolverRef.current;
      toolResolverRef.current = null;
      setPendingTool(null);
      // Sub-agents expect a normal allow when always_allow is chosen — the
      // wrapper itself doesn't differentiate; the UI does, via the Set above.
      resolve?.(
        decision.kind === "always_allow"
          ? { kind: "allow_once" }
          : decision,
      );
    },
    [pendingTool],
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
          alwaysAllowedRef.current = new Set();
          setAlwaysAllowed([]);
          setSummary(null);
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

      // Expand @-mentions for the agent. Display still shows the original
      // text the user typed; only the message sent to the model gets the
      // <file> blocks appended.
      let userForAgent = trimmed;
      try {
        const expanded = await expandMentions(trimmed, process.cwd());
        userForAgent = expanded.expanded;
        if (expanded.skipped.length) {
          setActivity(
            `mentions not found: ${expanded.skipped.slice(0, 3).join(" ")}` +
              (expanded.skipped.length > 3
                ? ` +${expanded.skipped.length - 3} more`
                : ""),
          );
        }
      } catch {
        /* mention expansion is best-effort; fall back to raw text */
      }

      append("user", trimmed);
      setRunning(true);
      setError(null);
      setActivity("");
      liveTextRef.current = "";
      setLiveText("");

      // Prior turns from items[] (the just-appended user message is NOT in
      // this closure's `items` snapshot — it's only in the React state).
      let priorMessages: ChatMessage[] = items
        .slice(contextStart)
        .filter((i) => i.role !== "system")
        .map<ChatMessage>((i) => ({
          role: i.role === "user" ? "user" : "assistant",
          content: i.content,
        }));
      let carriedSummary = summary;
      const sentToModel: ChatMessage[] = carriedSummary
        ? [{ role: "system", content: carriedSummary }, ...priorMessages]
        : priorMessages;

      // Auto-compact once prior history crosses the soft threshold. We
      // include the user's just-typed message in the estimate so we don't
      // overshoot on a single huge turn.
      const projected =
        estimateMessagesTokens(sentToModel) +
        estimateMessagesTokens([{ content: userForAgent }]);
      if (projected >= compactThreshold()) {
        setActivity("compacting prior context…");
        try {
          const newSummary = await summarizeMessages(sentToModel, buildModel());
          carriedSummary = newSummary;
          setSummary(newSummary);
          priorMessages = [];
          // Display marker + advance contextStart so future turns also
          // skip the older items.
          idRef.current += 1;
          const marker: Item = {
            id: idRef.current,
            role: "system",
            content: `── auto-compacted prior context ──\n\n${newSummary}`,
          };
          setItems((prev) => {
            const next = [...prev, marker];
            setContextStart(next.length);
            return next;
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          setActivity(`compaction failed (${msg}) — sending full history`);
        }
      }

      const history: ChatMessage[] = [
        ...(carriedSummary
          ? [{ role: "system" as const, content: carriedSummary }]
          : []),
        ...priorMessages,
        { role: "user", content: userForAgent },
      ];

      try {
        const result = await runAgent({
          messages: history,
          onToolApprovalRequest,
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
    [
      running,
      items,
      contextStart,
      summary,
      exit,
      append,
      recordHistory,
      onToolApprovalRequest,
    ],
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
      {pendingTool ? (
        <DiffApproval request={pendingTool} onDecide={handleDecision} />
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
          {alwaysAllowed.length > 0 && (
            <Box marginBottom={1}>
              <Text color="grey" dimColor>
                always-allowed this session: {alwaysAllowed.join(", ")} ·
                /clear to reset
              </Text>
            </Box>
          )}
          <InputBar
            input={input}
            onChange={handleInputChange}
            onSubmit={handleSubmit}
            onHistoryUp={handleHistoryUp}
            onHistoryDown={handleHistoryDown}
            usage={usage}
          />
        </Box>
      )}
    </Box>
  );
}

import { useState, useCallback, useRef, useMemo } from "react";
import { Box, Text, Static, useApp, useInput, useStdout } from "ink";
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
import {
  computeCost,
  formatCost,
  formatTokens,
  priceRate,
} from "./pricing.js";
import {
  deleteSession,
  listSessions,
  loadSession,
  newSessionId,
  saveSession,
  titleFromItems,
  type SessionSnapshot,
} from "./persistence.js";

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
  turnInput,
  turnOutput,
  turnCost,
  knownPricing,
}: {
  activity: string;
  liveText: string;
  turnInput: number;
  turnOutput: number;
  turnCost: number;
  knownPricing: boolean;
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
        <Text dimColor>{`esc to cancel · ctrl-c to quit · this turn ${formatTokens(turnInput)}↑ ${formatTokens(turnOutput)}↓`}</Text>
        {knownPricing && (
          <Text dimColor>{` · ${formatCost(turnCost)}`}</Text>
        )}
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
  meter,
}: {
  input: string;
  onChange: (s: string) => void;
  onSubmit: (s: string) => void;
  onHistoryUp: () => void;
  onHistoryDown: () => void;
  usage: { pct: number; level: "green" | "yellow" | "red" };
  meter: {
    sessionInput: number;
    sessionOutput: number;
    sessionCost: number;
    knownPricing: boolean;
  };
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
        <Text dimColor>↵ send  ·  \↵ newline  ·  ↓/↑ history  ·  ctrl-c quit  ·  </Text>
        <Text color={usageColor}>ctx {usage.pct}%</Text>
        <Text dimColor>
          {`  ·  ${formatTokens(meter.sessionInput)}↑ ${formatTokens(meter.sessionOutput)}↓`}
        </Text>
        {meter.knownPricing && (
          <Text dimColor>{`  ·  ${formatCost(meter.sessionCost)}`}</Text>
        )}
      </Box>
    </Box>
  );
}

export interface AppProps {
  workspaceRoot?: string;
  initialSnapshot?: SessionSnapshot;
}

export function App({ workspaceRoot, initialSnapshot }: AppProps = {}) {
  const root = workspaceRoot ?? process.cwd();
  const { exit } = useApp();
  const sessionIdRef = useRef<string>(
    initialSnapshot?.id ?? newSessionId(),
  );
  // Items / context-pointer / summary / always-allowed seeded from the
  // resumed snapshot when one is provided; otherwise empty.
  const [items, setItems] = useState<Item[]>(
    initialSnapshot?.items.map((i) => ({ ...i })) ?? [],
  );
  const [contextStart, setContextStart] = useState(
    initialSnapshot?.contextStart ?? 0,
  );
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [activity, setActivity] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [draft, setDraft] = useState("");
  const [liveText, setLiveText] = useState("");
  const liveTextRef = useRef("");
  // Seed idRef so newly appended items get unique ids that don't collide
  // with whatever the snapshot already contained.
  const idRef = useRef(
    initialSnapshot
      ? initialSnapshot.items.reduce((m, i) => Math.max(m, i.id), 0)
      : 0,
  );
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
  const alwaysAllowedRef = useRef<Set<string>>(
    new Set(initialSnapshot?.alwaysAllowed ?? []),
  );
  const [alwaysAllowed, setAlwaysAllowed] = useState<string[]>(
    initialSnapshot?.alwaysAllowed ?? [],
  );
  // Auto-compacted summary of older turns. When set, it's prepended (as a
  // system message) to every history sent to the agent, and items before
  // contextStart are dropped from the conversation. Reset on /clear.
  const [summary, setSummary] = useState<string | null>(
    initialSnapshot?.summary ?? null,
  );

  // Live token/cost meter. We keep two scopes: a per-turn counter that
  // updates as model calls stream in, and a session total accumulated
  // across turns. Both reset on /clear; turn resets at the start of each
  // submit.
  const [turnUsage, setTurnUsage] = useState({ input: 0, output: 0 });
  const turnUsageRef = useRef({ input: 0, output: 0 });
  const [sessionUsage, setSessionUsage] = useState(
    initialSnapshot?.sessionUsage ?? { input: 0, output: 0 },
  );
  const rate = useMemo(() => priceRate(process.env.AI_MODEL), []);
  const sessionCost = useMemo(
    () => computeCost(sessionUsage.input, sessionUsage.output, rate),
    [sessionUsage, rate],
  );
  const turnCost = useMemo(
    () => computeCost(turnUsage.input, turnUsage.output, rate),
    [turnUsage, rate],
  );

  // AbortController for the in-flight agent run. Esc aborts it.
  const abortRef = useRef<AbortController | null>(null);

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

  // Snapshot helper — called at end of each turn. Best-effort: persistence
  // failures are surfaced in the activity line but never block the UI.
  const persist = useCallback(
    async (override?: {
      items?: Item[];
      contextStart?: number;
      summary?: string | null;
      sessionUsage?: { input: number; output: number };
    }) => {
      const itemsOut = override?.items ?? items;
      if (itemsOut.length === 0) return;
      const snap: SessionSnapshot = {
        v: 1,
        id: sessionIdRef.current,
        workspaceRoot: root,
        createdAt: initialSnapshot?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        title: initialSnapshot?.title || titleFromItems(itemsOut),
        items: itemsOut.map((i) => ({
          id: i.id,
          role: i.role,
          content: i.content,
        })),
        contextStart: override?.contextStart ?? contextStart,
        summary: override?.summary !== undefined ? override.summary : summary,
        alwaysAllowed: Array.from(alwaysAllowedRef.current),
        sessionUsage: override?.sessionUsage ?? sessionUsage,
      };
      try {
        await saveSession(snap);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setActivity(`could not save session: ${msg}`);
      }
    },
    [items, contextStart, summary, sessionUsage, root, initialSnapshot],
  );

  // Global Esc handler — abort the running turn. Disabled while the
  // approval menu / feedback input is up so those can handle Esc locally.
  useInput(
    (_input, key) => {
      if (key.escape && running && !pendingTool) {
        abortRef.current?.abort();
      }
    },
    { isActive: running && !pendingTool },
  );

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
        const [verb, ...rest] = trimmed.slice(1).split(/\s+/);
        const cmd = verb.toLowerCase();
        if (cmd === "exit" || cmd === "quit") {
          exit();
          return;
        }
        if (cmd === "sessions") {
          try {
            const entries = await listSessions(root);
            if (entries.length === 0) {
              append("system", "no saved sessions in this workspace.");
            } else {
              const here = sessionIdRef.current;
              const lines = entries
                .map((e) => {
                  const mark = e.id === here ? " (current)" : "";
                  return `  ${e.id}${mark}\n    ${e.title}\n    ${e.turns} turns · ${e.updatedAt.slice(0, 19).replace("T", " ")}`;
                })
                .join("\n");
              append("system", `sessions in this workspace:\n${lines}`);
            }
          } catch (err) {
            append(
              "system",
              `error listing sessions: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          return;
        }
        if (cmd === "resume") {
          const id = rest[0];
          if (!id) {
            append("system", "usage: /resume <session-id>  (see /sessions)");
            return;
          }
          try {
            const snap = await loadSession(root, id);
            sessionIdRef.current = snap.id;
            setItems(snap.items.map((i) => ({ ...i })));
            setContextStart(snap.contextStart);
            setSummary(snap.summary ?? null);
            setSessionUsage(snap.sessionUsage);
            alwaysAllowedRef.current = new Set(snap.alwaysAllowed);
            setAlwaysAllowed(snap.alwaysAllowed);
            idRef.current = snap.items.reduce(
              (m, i) => Math.max(m, i.id),
              0,
            );
            append("system", `── resumed session ${snap.id} ──`);
          } catch (err) {
            append(
              "system",
              `could not resume ${id}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          return;
        }
        if (cmd === "forget") {
          const id = rest[0];
          if (!id) {
            append("system", "usage: /forget <session-id>");
            return;
          }
          if (id === sessionIdRef.current) {
            append("system", "refuse: that's the current session.");
            return;
          }
          try {
            await deleteSession(root, id);
            append("system", `deleted session ${id}.`);
          } catch (err) {
            append(
              "system",
              `error deleting ${id}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
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
          setSessionUsage({ input: 0, output: 0 });
          setTurnUsage({ input: 0, output: 0 });
          turnUsageRef.current = { input: 0, output: 0 };
          return;
        }
        if (cmd === "help") {
          append(
            "system",
            "commands\n  /help              show this help\n  /clear             reset the conversation context\n  /sessions          list saved sessions in this workspace\n  /resume <id>       resume a saved session by id\n  /forget <id>       delete a saved session\n  /exit              quit axon\n\nshortcuts\n  ↵            send the current message\n  \\↵           insert a newline (backslash + enter)\n  alt+↵ / ctrl+j  also insert a newline\n  shift+↵       newline on terminals that report it\n  ↑ / ↓        move cursor across lines (or browse prompt history at the edges)\n  ctrl+a / ctrl+e  jump to start / end of the current line\n  ctrl+u / ctrl+k  delete to start / end of the current line\n  esc           cancel the running turn\n  ctrl-c        quit at any time",
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
      turnUsageRef.current = { input: 0, output: 0 };
      setTurnUsage({ input: 0, output: 0 });
      const controller = new AbortController();
      abortRef.current = controller;

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

      let cancelled = false;
      try {
        const result = await runAgent({
          messages: history,
          onToolApprovalRequest,
          signal: controller.signal,
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
            else if (ev.type === "usage") {
              turnUsageRef.current = {
                input: turnUsageRef.current.input + ev.usage.input,
                output: turnUsageRef.current.output + ev.usage.output,
              };
              setTurnUsage(turnUsageRef.current);
              setSessionUsage((prev) => ({
                input: prev.input + ev.usage.input,
                output: prev.output + ev.usage.output,
              }));
            } else if (ev.type === "cancelled") {
              cancelled = true;
            } else if (ev.type === "error") setError(ev.message);
          },
        });
        if (cancelled) {
          append("system", "── cancelled by user (esc) ──");
        } else {
          append(
            "assistant",
            result.text || liveTextRef.current || "(no output)",
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (controller.signal.aborted) {
          append("system", "── cancelled by user (esc) ──");
        } else {
          setError(msg);
          append("system", `error: ${msg}`);
        }
      } finally {
        setRunning(false);
        setActivity("");
        liveTextRef.current = "";
        setLiveText("");
        abortRef.current = null;
        // Best-effort snapshot after every turn.
        void persist();
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
      persist,
      root,
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
        <Working
          activity={activity}
          liveText={liveText}
          turnInput={turnUsage.input}
          turnOutput={turnUsage.output}
          turnCost={turnCost}
          knownPricing={rate.source !== "unknown"}
        />
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
            meter={{
              sessionInput: sessionUsage.input,
              sessionOutput: sessionUsage.output,
              sessionCost,
              knownPricing: rate.source !== "unknown",
            }}
          />
        </Box>
      )}
    </Box>
  );
}

import {
  type SessionDisplayActivity,
  type SessionDisplayNode,
  SessionDisplayPatchSchema,
  type SessionDisplaySnapshot,
  SessionDisplaySnapshotSchema,
  type SessionQuestion,
  applySessionDisplayPatch,
  sessionDisplaySnapshotPage,
} from "@yep-anywhere/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client";
import { extractCodexTurnContextUsage } from "../lib/codexMessageContext";
import type { Message, Session } from "../types";
import type {
  AgentContentMap,
  UseSessionMessagesOptions,
  UseSessionMessagesResult,
} from "./useLegacySessionMessages";
import { contextUsageFromStatus } from "./useLegacySessionMessages";

const snapshots = new Map<string, SessionDisplaySnapshot>();
const MAX_CACHE_BYTES = 32 * 1024 * 1024;
function cache(key: string, snapshot: SessionDisplaySnapshot): void {
  snapshots.delete(key);
  snapshots.set(key, snapshot);
  let bytes = 0;
  for (const value of snapshots.values())
    bytes += JSON.stringify(value).length * 2;
  while (snapshots.size > 5 || bytes > MAX_CACHE_BYTES) {
    const first = snapshots.entries().next().value;
    if (!first) break;
    bytes -= JSON.stringify(first[1]).length * 2;
    snapshots.delete(first[0]);
  }
}
export function resetDisplaySnapshotCacheForTests(): void {
  snapshots.clear();
}

function questionsIn(nodes: SessionDisplayNode[]): SessionQuestion[] {
  return nodes.flatMap((node) =>
    node.type === "question"
      ? [
          {
            id: node.question.messageId,
            turnId: node.turnId,
            text:
              typeof node.question.content === "string"
                ? node.question.content
                : node.question.content
                    .flatMap((b) => (b.type === "text" ? [b.text] : []))
                    .join("\n"),
            ...(node.question.timestamp
              ? { timestamp: node.question.timestamp }
              : {}),
            ...(node.question.clientUserMessageId
              ? { clientUserMessageId: node.question.clientUserMessageId }
              : {}),
            ...(node.question.codexCorrelationKey
              ? { codexCorrelationKey: node.question.codexCorrelationKey }
              : {}),
          },
        ]
      : [],
  );
}

/** One display store. It never pairs historical tool results with live raw messages. */
export function useProjectedSessionMessages(
  options: UseSessionMessagesOptions,
): UseSessionMessagesResult & {
  handleDisplayEvent(type: string, data: unknown): void;
  displayActivity: SessionDisplayActivity | undefined;
} {
  const { projectId, sessionId, branchId, enabled = true } = options;
  const key = `${projectId}\0${sessionId}\0${branchId ?? "active"}`;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const keyRef = useRef(key);
  keyRef.current = key;
  const generation = useRef(0);
  const [snapshot, setSnapshot] = useState<SessionDisplaySnapshot | null>(() =>
    enabled ? (snapshots.get(key) ?? null) : null,
  );
  const snapshotRef = useRef(snapshot);
  const [olderNodes, setOlderNodes] = useState<SessionDisplayNode[]>([]);
  const [olderCursor, setOlderCursor] = useState<string | undefined>();
  const [session, setSession] = useState<Session | null>(null);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const configuration = useRef<
    Partial<
      Pick<Session, "provider" | "model" | "reasoningEffort" | "serviceTier">
    >
  >({});
  const [messages, setMessages] = useState<Message[]>([]);
  const [agentContent, setAgentContent] = useState<AgentContentMap>({});
  const [toolUseToAgent, setToolUseToAgent] = useState<Map<string, string>>(
    () => new Map(),
  );
  const [toolUseToAgentIds, setToolUseToAgentIds] = useState<
    Map<string, string[]>
  >(() => new Map());
  const [loading, setLoading] = useState(() => enabled && !snapshots.has(key));
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadingTargetMessage, setLoadingTargetMessage] = useState(false);
  const [indexedQuestions, setIndexedQuestions] = useState<SessionQuestion[]>(
    [],
  );
  const [coverage, setCoverage] = useState<
    "complete" | "partial" | "unavailable"
  >("unavailable");
  const refreshing = useRef<Promise<Session | null> | null>(null);
  const queuedPatches = useRef<unknown[]>([]);

  const install = useCallback(
    (next: SessionDisplaySnapshot) => {
      if (
        next.view.sessionId !== sessionId ||
        next.view.branchScopeId !== (branchId ?? "active")
      )
        return;
      const previous = snapshotRef.current;
      if (previous?.view.epoch === next.view.epoch && next.seq < previous.seq)
        return;
      if (previous && previous.view.epoch !== next.view.epoch) {
        setOlderNodes([]);
        setOlderCursor(undefined);
      }
      snapshotRef.current = next;
      setSnapshot(next);
      setLoading(false);
      cache(key, next);
      setMessages((current) =>
        current.filter(
          (message) =>
            !next.nodes.some(
              (node) =>
                node.type === "question" &&
                (node.question.messageId === (message.uuid ?? message.id) ||
                  (message.clientUserMessageId &&
                    message.clientUserMessageId ===
                      node.question.clientUserMessageId)),
            ),
        ),
      );
    },
    [key, sessionId, branchId],
  );

  const fetchSessionMetadata = useCallback(async () => {
    const expected = keyRef.current;
    const data = await api.getSessionMetadata(projectId, sessionId);
    if (keyRef.current !== expected) return;
    const current = sessionRef.current;
    const next = { ...current, ...data.session, ...configuration.current };
    for (const name of [
      "model",
      "reasoningEffort",
      "serviceTier",
      "contextUsage",
    ] as const) {
      if (next[name] === undefined && current?.[name] !== undefined)
        Object.assign(next, { [name]: current[name] });
    }
    sessionRef.current = next;
    setSession(next);
    optionsRef.current.onLoadComplete?.({
      ...data,
      session: next,
      status: data.ownership,
    });
    if (!next.contextUsage)
      void api
        .getContextStatus(projectId, sessionId)
        .then((status) => {
          if (keyRef.current !== expected) return;
          const contextUsage = contextUsageFromStatus(status);
          if (contextUsage)
            setSession((current) =>
              current && !current.contextUsage
                ? { ...current, contextUsage }
                : current,
            );
        })
        .catch(() => {});
  }, [projectId, sessionId]);

  const refreshSessionMessages = useCallback<
    UseSessionMessagesResult["refreshSessionMessages"]
  >(
    async (refreshOptions) => {
      if (refreshing.current) return refreshing.current;
      const expected = keyRef.current;
      const expectedEpoch = snapshotRef.current?.view.epoch;
      const task = (async () => {
        await fetchSessionMetadata();
        if (keyRef.current !== expected) return null;
        const targetBranch =
          refreshOptions?.branchId === null
            ? undefined
            : (refreshOptions?.branchId ?? branchId);
        const next = SessionDisplaySnapshotSchema.parse(
          await api.getSessionDisplayView(projectId, sessionId, {
            branchId: targetBranch,
            reset: refreshOptions?.replaceMessages,
          }),
        );
        if (keyRef.current !== expected) return null;
        if (
          snapshotRef.current?.view.epoch !== expectedEpoch &&
          snapshotRef.current?.view.epoch !== next.view.epoch
        )
          return null;
        const promptMessages: Message[] = next.nodes.flatMap((node) =>
          node.type === "question"
            ? [
                {
                  uuid: node.question.messageId,
                  type: "user",
                  role: "user",
                  message: {
                    role: "user",
                    content: node.question.content as Message["content"],
                  },
                  clientUserMessageId: node.question.clientUserMessageId,
                },
              ]
            : [],
        );
        if (
          refreshOptions?.acceptSnapshot &&
          sessionRef.current &&
          !refreshOptions.acceptSnapshot({
            session: sessionRef.current,
            messages: promptMessages,
          })
        )
          return null;
        install(next);
        for (const queued of queuedPatches.current.splice(0)) {
          const patch = SessionDisplayPatchSchema.safeParse(queued);
          if (patch.success && snapshotRef.current) {
            const applied = applySessionDisplayPatch(
              snapshotRef.current,
              patch.data,
            );
            if (applied) install(applied);
          }
        }
        return sessionRef.current;
      })();
      refreshing.current = task;
      try {
        return await task;
      } finally {
        if (refreshing.current === task) refreshing.current = null;
      }
    },
    [projectId, sessionId, branchId, fetchSessionMetadata, install],
  );

  const handleDisplayEvent = useCallback(
    (type: string, data: unknown) => {
      if (!enabled) return;
      if (type === "display-snapshot") {
        const parsed = SessionDisplaySnapshotSchema.safeParse(data);
        if (parsed.success) install(parsed.data);
      } else if (type === "display-patch") {
        const parsed = SessionDisplayPatchSchema.safeParse(data);
        if (
          !parsed.success ||
          parsed.data.view.sessionId !== sessionId ||
          parsed.data.view.branchScopeId !== (branchId ?? "active")
        )
          return;
        const current = snapshotRef.current;
        const next = current
          ? applySessionDisplayPatch(current, parsed.data)
          : null;
        if (next) install(next);
        else {
          queuedPatches.current.push(data);
          if (queuedPatches.current.length > 100) queuedPatches.current.shift();
          void refreshSessionMessages().catch(() => {});
        }
      }
    },
    [enabled, sessionId, branchId, install, refreshSessionMessages],
  );

  useEffect(() => {
    if (!enabled) return;
    const currentGeneration = ++generation.current;
    const cached = snapshots.get(key) ?? null;
    snapshotRef.current = cached;
    setSnapshot(cached);
    setLoading(!cached);
    setOlderNodes([]);
    setOlderCursor(undefined);
    setMessages([]);
    setIndexedQuestions([]);
    setCoverage("unavailable");
    configuration.current = {};
    queuedPatches.current = [];
    refreshing.current = null;
    let cancelled = false;
    void fetchSessionMetadata().catch((error) => {
      if (!cancelled) optionsRef.current.onLoadError?.(error);
    });
    // A cold HTTP snapshot also supports transport startup failures. The WS
    // snapshot establishes the same view/sequence, so older HTTP replies lose.
    void api
      .getSessionDisplayView(projectId, sessionId, { branchId })
      .then((next) => {
        if (
          !cancelled &&
          currentGeneration === generation.current &&
          (!snapshotRef.current ||
            snapshotRef.current.view.epoch === next.view.epoch)
        )
          install(SessionDisplaySnapshotSchema.parse(next));
      })
      .catch((error) => {
        if (!cancelled && !snapshotRef.current) {
          setLoading(false);
          optionsRef.current.onLoadError?.(error);
        }
      });
    void (async () => {
      let cursor: string | undefined;
      do {
        const page = await api.getSessionQuestions(projectId, sessionId, {
          branchId,
          cursor,
        });
        if (cancelled) return;
        setIndexedQuestions((current) => [
          ...page.questions.map((q) => ({
            id: q.messageId,
            turnId: q.turnId,
            text: q.preview,
            timestamp: q.timestamp,
            clientUserMessageId: q.clientUserMessageId,
            codexCorrelationKey: q.codexCorrelationKey,
          })),
          ...current,
        ]);
        setCoverage(page.coverage);
        cursor = page.nextCursor;
      } while (cursor);
    })().catch(() => {
      if (!cancelled) setCoverage("partial");
    });
    return () => {
      cancelled = true;
      generation.current++;
    };
  }, [
    enabled,
    key,
    projectId,
    sessionId,
    branchId,
    fetchSessionMetadata,
    install,
  ]);

  const loadOlderMessages = useCallback(async () => {
    const cursor = olderCursor ?? snapshotRef.current?.olderCursor;
    if (!cursor || loadingOlder) return;
    const expected = keyRef.current;
    setLoadingOlder(true);
    try {
      const page = await api.getSessionDisplayView(projectId, sessionId, {
        branchId,
        cursor,
      });
      if (
        keyRef.current !== expected ||
        page.view.epoch !== snapshotRef.current?.view.epoch
      )
        return;
      setOlderNodes((current) => {
        const map = new Map([...page.nodes, ...current].map((n) => [n.id, n]));
        return [...map.values()];
      });
      setOlderCursor(page.olderCursor ?? "");
    } catch {
      // Keep the readable page and rebase the live view; a retry uses its new
      // history anchor instead of mixing a rewritten branch into this one.
      if (keyRef.current === expected)
        await refreshSessionMessages().catch(() => null);
    } finally {
      if (keyRef.current === expected) setLoadingOlder(false);
    }
  }, [
    projectId,
    sessionId,
    branchId,
    olderCursor,
    loadingOlder,
    refreshSessionMessages,
  ]);

  const combined = useMemo(
    () =>
      snapshot
        ? {
            ...snapshot,
            nodes: [
              ...new Map(
                [...olderNodes, ...snapshot.nodes].map((n) => [n.id, n]),
              ).values(),
            ],
            olderCursor: olderCursor ?? snapshot.olderCursor,
          }
        : null,
    [snapshot, olderNodes, olderCursor],
  );
  const displayPage = useMemo(
    () => (combined ? sessionDisplaySnapshotPage(combined) : null),
    [combined],
  );
  const displayQuestions = useMemo(() => {
    const rows: SessionQuestion[] = [];
    const aliases = new Map<string, number>();
    for (const question of [
      ...indexedQuestions,
      ...questionsIn(combined?.nodes ?? []),
    ]) {
      const keys = [
        question.id,
        question.clientUserMessageId,
        question.codexCorrelationKey,
      ].filter((key): key is string => Boolean(key));
      const existing = keys
        .map((key) => aliases.get(key))
        .find((index) => index !== undefined);
      const index = existing ?? rows.length;
      rows[index] = question;
      for (const key of keys) aliases.set(key, index);
    }
    return rows;
  }, [indexedQuestions, combined]);
  const updateSessionConfiguration = useCallback<
    UseSessionMessagesResult["updateSessionConfiguration"]
  >((value) => {
    const supplied = Object.fromEntries(
      Object.entries(value).filter(
        ([, v]) => typeof v === "string" && v.trim(),
      ),
    );
    configuration.current = { ...configuration.current, ...supplied };
    setSession((current) => (current ? { ...current, ...supplied } : current));
  }, []);
  const loadTargetMessageWindow = useCallback<
    UseSessionMessagesResult["loadTargetMessageWindow"]
  >(
    async (target) => {
      if (
        combined?.nodes.some(
          (n) =>
            n.id === target ||
            (n.type === "question" && n.question.messageId === target),
        )
      )
        return true;
      setLoadingTargetMessage(true);
      const expected = keyRef.current;
      try {
        let cursor = olderCursor ?? snapshotRef.current?.olderCursor;
        const seen = new Set<string>();
        while (cursor && !seen.has(cursor) && seen.size < 1_000) {
          seen.add(cursor);
          const page = await api.getSessionDisplayView(projectId, sessionId, {
            branchId,
            cursor,
          });
          if (
            keyRef.current !== expected ||
            page.view.epoch !== snapshotRef.current?.view.epoch
          )
            return false;
          setOlderNodes((current) => [
            ...new Map(
              [...page.nodes, ...current].map((n) => [n.id, n]),
            ).values(),
          ]);
          cursor = page.olderCursor;
          setOlderCursor(cursor ?? "");
          if (
            page.nodes.some(
              (n) =>
                n.id === target ||
                (n.type === "question" && n.question.messageId === target),
            )
          )
            return true;
        }
        return false;
      } finally {
        if (keyRef.current === expected) setLoadingTargetMessage(false);
      }
    },
    [combined, olderCursor, projectId, sessionId, branchId],
  );

  return {
    messages,
    displayPage,
    displayQuestions,
    displayQuestionCoverage: coverage,
    displayActivity: snapshot?.activity,
    handleDisplayEvent,
    hydratedLiveTailDetailRef: null,
    agentContent,
    toolUseToAgent,
    toolUseToAgentIds,
    loading,
    session,
    setSession,
    setMessages,
    setAgentContent,
    setToolUseToAgent,
    setToolUseToAgentIds,
    handleStreamingUpdate: () => {},
    handleStreamingUpdates: () => {},
    handleStreamMessageEvent: (incoming) => {
      const usage = extractCodexTurnContextUsage(incoming, sessionRef.current);
      if (usage)
        setSession((current) =>
          current ? { ...current, contextUsage: usage } : current,
        );
      if (incoming.isOptimistic)
        setMessages((current) => [...current, incoming]);
    },
    handleStreamSubagentMessage: () => {},
    registerToolUseAgent: (tool, agent) => {
      setToolUseToAgent((current) => new Map(current).set(tool, agent));
    },
    truncateMessagesBefore: () => {
      void refreshSessionMessages().catch(() => {});
    },
    fetchNewMessages: async () => {
      await refreshSessionMessages();
    },
    refreshSessionMessages,
    fetchSessionMetadata,
    updateSessionConfiguration,
    pagination: undefined,
    loadingOlder,
    loadingNewer: false,
    loadingTargetMessage,
    loadOlderMessages,
    loadNewerMessages: async () => {},
    loadTargetMessageWindow,
    updateActiveWindowFollowingBottom: () => {},
    activeWindowTrimRevision: 0,
  };
}

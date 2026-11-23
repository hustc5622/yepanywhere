import {
  type ContextUsage,
  type SessionDisplayActivity,
  type SessionDisplayKnownView,
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
import { connectionManager } from "../lib/connection";
import {
  parseDisplaySnapshot,
  reportDisplaySchemaMismatch,
} from "../lib/displaySchemaMismatch";
import { DisplaySnapshotCache } from "../lib/displaySnapshotCache";
import { displayNodeContainsMessage } from "../lib/messageSearchTarget";
import { sessionLoadTracer } from "../lib/sessionLoadTiming";
import {
  takePrefetchedMetadata,
  takePrefetchedView,
} from "../lib/sessionPrefetch";
import type { Message, Session } from "../types";
import type {
  AgentContentMap,
  UseSessionMessagesOptions,
  UseSessionMessagesResult,
} from "./useLegacySessionMessages";
import { contextUsageFromStatus } from "./useLegacySessionMessages";

const snapshots = new DisplaySnapshotCache();
/**
 * With a connected socket, the WS subscription delivers the projection (or a
 * `display-current` marker for a cached one). The HTTP read only runs if the
 * WS answer has not arrived within this window, or when the socket is down.
 */
export const WS_SNAPSHOT_GRACE_MS = 1_500;
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
  /** Projection version to announce on the WS display subscription. */
  displayKnownView: SessionDisplayKnownView | undefined;
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
  const nativeContextUsageRef = useRef<{
    key: string;
    usage: ContextUsage;
  } | null>(null);
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
  /** Skips the deferred initial HTTP read once WS has delivered the view. */
  const skipDeferredView = useRef<(() => void) | null>(null);
  /**
   * Generation that has received a fresh WS snapshot or `display-current`
   * confirmation. Distinguishes a live WS view from a stale client cache hit
   * so HTTP fallback can still install a newer server epoch.
   */
  const liveViewGeneration = useRef(-1);

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
      snapshots.set(key, next);
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

  const loadSessionMetadata = useCallback(
    async (
      /** An already-started read (cold-start prefetch) to apply instead. */
      source?: ReturnType<typeof api.getSessionMetadata>,
    ) => {
      const expected = keyRef.current;
      const usageAtRequest = nativeContextUsageRef.current;
      const data = await (source ??
        api.getSessionMetadata(projectId, sessionId));
      if (keyRef.current !== expected) return;
      const current = sessionRef.current;
      const next = { ...current, ...data.session, ...configuration.current };
      const streamedUsage = nativeContextUsageRef.current;
      if (
        streamedUsage?.key === expected &&
        (streamedUsage !== usageAtRequest || !next.contextUsage)
      )
        next.contextUsage = streamedUsage.usage;
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
    },
    [projectId, sessionId],
  );
  // Public form takes no argument, so it is safe to pass as a callback.
  const fetchSessionMetadata = useCallback(
    () => loadSessionMetadata(),
    [loadSessionMetadata],
  );

  const refreshSessionMessages = useCallback<
    UseSessionMessagesResult["refreshSessionMessages"]
  >(
    async (refreshOptions) => {
      if (refreshing.current) return refreshing.current;
      const expected = keyRef.current;
      const expectedEpoch = snapshotRef.current?.view.epoch;
      const task = (async () => {
        const targetBranch =
          refreshOptions?.branchId === null
            ? undefined
            : (refreshOptions?.branchId ?? branchId);
        const [, display] = await Promise.all([
          fetchSessionMetadata(),
          api.getSessionDisplayView(projectId, sessionId, {
            branchId: targetBranch,
            reset: refreshOptions?.replaceMessages,
          }),
        ]);
        const next = parseDisplaySnapshot(display, "refresh view");
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
      if (type === "display-context-usage") {
        const update = data as {
          sessionId?: string;
          branchId?: string;
          contextUsage?: ContextUsage;
        } | null;
        const usage = update?.contextUsage;
        if (
          update?.sessionId !== sessionId ||
          update?.branchId !== branchId ||
          !usage ||
          !Number.isFinite(usage.inputTokens) ||
          usage.inputTokens < 0 ||
          !Number.isFinite(usage.percentage) ||
          !usage.contextWindow ||
          !Number.isFinite(usage.contextWindow) ||
          usage.contextWindow < 0
        )
          return;
        nativeContextUsageRef.current = { key: keyRef.current, usage };
        setSession((current) => {
          if (!current) return current;
          const next = { ...current, contextUsage: usage };
          sessionRef.current = next;
          return next;
        });
      } else if (type === "display-snapshot") {
        const parsed = SessionDisplaySnapshotSchema.safeParse(data);
        if (!parsed.success)
          reportDisplaySchemaMismatch(parsed.error, "ws snapshot");
        else {
          install(parsed.data);
          if (snapshotRef.current === parsed.data) {
            liveViewGeneration.current = generation.current;
            skipDeferredView.current?.();
            sessionLoadTracer.fresh(keyRef.current, "ws");
          }
        }
      } else if (type === "display-current") {
        const current = data as {
          view?: {
            sessionId?: unknown;
            branchScopeId?: unknown;
            epoch?: unknown;
          };
          seq?: unknown;
        } | null;
        const held = snapshotRef.current;
        if (
          current?.view?.sessionId !== sessionId ||
          current.view.branchScopeId !== (branchId ?? "active")
        )
          return;
        if (
          held &&
          held.view.epoch === current.view.epoch &&
          typeof current.seq === "number" &&
          held.seq >= current.seq
        ) {
          // The held (cached) projection is the server's current one.
          liveViewGeneration.current = generation.current;
          setLoading(false);
          skipDeferredView.current?.();
          sessionLoadTracer.fresh(keyRef.current, "ws-current");
        } else {
          // Raced with a newer local state change; fetch the real snapshot.
          void refreshSessionMessages().catch(() => {});
        }
      } else if (type === "display-patch") {
        const parsed = SessionDisplayPatchSchema.safeParse(data);
        if (!parsed.success) {
          reportDisplaySchemaMismatch(parsed.error, "ws patch");
          return;
        }
        if (
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
    sessionLoadTracer.begin(key, {
      cached: Boolean(cached),
      transport: connectionManager.state,
    });
    const prefetchedMetadata = takePrefetchedMetadata(
      projectId,
      sessionId,
      branchId,
    );
    const prefetchedView = takePrefetchedView(projectId, sessionId, branchId);
    void loadSessionMetadata(prefetchedMetadata)
      .catch((error) =>
        // A failed prefetch is retried once with a normal read.
        prefetchedMetadata ? loadSessionMetadata() : Promise.reject(error),
      )
      .then(() => sessionLoadTracer.metadata(key))
      .catch((error) => {
        if (!cancelled) optionsRef.current.onLoadError?.(error);
      });
    // A cold HTTP snapshot also supports transport startup failures. The WS
    // snapshot establishes the same view/sequence, so older HTTP replies lose.
    let lastViewResponse: { status?: number; serverTiming?: string | null } =
      {};
    const loadSnapshot = async () => {
      if (prefetchedView) {
        try {
          const prefetched = await prefetchedView;
          lastViewResponse = prefetched;
          return prefetched.snapshot;
        } catch {
          // Fall through to the normal read and its conflict retries.
        }
      }
      for (let attempt = 0; ; attempt++) {
        if (cancelled) return;
        try {
          return await api.getSessionDisplayView(projectId, sessionId, {
            branchId,
            onResponse: (info) => {
              lastViewResponse = info;
            },
          });
        } catch (error) {
          if (cancelled || liveViewGeneration.current === currentGeneration)
            return;
          const { status, code } = error as { status?: number; code?: string };
          if (
            status !== 409 ||
            (code !== "SESSION_DISPLAY_STALE" &&
              code !== "SESSION_DISPLAY_CHANGED") ||
            attempt >= 2
          )
            throw error;
          // A new cursor-free read can recover a changing source. Do not turn
          // a transient read conflict into a permanent whole-page error.
          await new Promise((resolve) =>
            setTimeout(resolve, 150 * (attempt + 1)),
          );
          if (liveViewGeneration.current === currentGeneration) return;
        }
      }
    };
    let viewStarted = false;
    let viewTimer: ReturnType<typeof setTimeout> | undefined;
    const startView = () => {
      if (viewStarted || cancelled) return;
      viewStarted = true;
      clearTimeout(viewTimer);
      skipDeferredView.current = null;
      void loadSnapshot()
        .then((next) => {
          if (!cancelled) sessionLoadTracer.view(key, lastViewResponse);
          // Only protect a fresh WS view from being replaced by a slower HTTP
          // read of a different epoch. A stale client cache hit from an earlier
          // visit must always yield to a fresh server epoch.
          const hasFreshLiveView =
            liveViewGeneration.current === currentGeneration;
          if (
            next &&
            !cancelled &&
            currentGeneration === generation.current &&
            (!hasFreshLiveView ||
              !snapshotRef.current ||
              snapshotRef.current.view.epoch === next.view.epoch)
          ) {
            install(parseDisplaySnapshot(next, "http view"));
            sessionLoadTracer.fresh(key, "http");
          }
        })
        .catch((error) => {
          if (!cancelled) sessionLoadTracer.view(key, lastViewResponse);
          if (!cancelled && !snapshotRef.current) {
            setLoading(false);
            optionsRef.current.onLoadError?.(error);
          }
        });
    };
    // A prefetched read is already in flight and costs nothing to await.
    if (!prefetchedView && connectionManager.state === "connected") {
      skipDeferredView.current = () => {
        if (viewStarted) return;
        viewStarted = true;
        clearTimeout(viewTimer);
        skipDeferredView.current = null;
        sessionLoadTracer.view(key, { skipped: true });
      };
      viewTimer = setTimeout(startView, WS_SNAPSHOT_GRACE_MS);
    } else startView();
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
      clearTimeout(viewTimer);
      skipDeferredView.current = null;
      generation.current++;
      sessionLoadTracer.abandon(key);
    };
  }, [
    enabled,
    key,
    projectId,
    sessionId,
    branchId,
    loadSessionMetadata,
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
  const knownEpoch = snapshot?.view.epoch;
  const knownSeq = snapshot?.seq;
  const displayKnownView = useMemo(
    () =>
      knownEpoch !== undefined && knownSeq !== undefined
        ? { epoch: knownEpoch, seq: knownSeq }
        : undefined,
    [knownEpoch, knownSeq],
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
      if (combined?.nodes.some((n) => displayNodeContainsMessage(n, target)))
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
          if (page.nodes.some((n) => displayNodeContainsMessage(n, target)))
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
    displayKnownView,
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

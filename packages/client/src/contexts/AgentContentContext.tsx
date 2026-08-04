import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { api } from "../api/client";
import type { AgentContent, AgentContentMap } from "../hooks/useSession";
import { getMessageId } from "../lib/mergeMessages";
import type { Message } from "../types";

interface AgentContentContextValue {
  /** Map of agentId → agent content (messages + status) */
  agentContent: AgentContentMap;
  /** Mapping from Task tool_use_id → agentId (for rendering during streaming) */
  toolUseToAgent: Map<string, string>;
  /**
   * Mapping from Task tool_use_id → all subagent ids it produced. A single
   * `Agent` call is 1:1; an `AgentSwarm` call fans out to N children that
   * share one tool_use_id. The renderer uses this to show the full fan-out.
   */
  toolUseToAgentIds: Map<string, string[]>;
  /** Load agent content from server (for lazy-loading completed tasks) */
  loadAgentContent: (
    projectId: string,
    sessionId: string,
    agentId: string,
    options?: { force?: boolean },
  ) => Promise<AgentContent>;
  /** Check if content is currently being loaded for an agent */
  isLoading: (agentId: string) => boolean;
  /** The current project ID */
  projectId: string;
}

export const AgentContentContext =
  createContext<AgentContentContextValue | null>(null);

interface AgentContentProviderProps {
  children: ReactNode;
  /** Live agentContent from useSession (for streaming updates) */
  agentContent: AgentContentMap;
  /** Update agentContent state (for merging loaded content) */
  setAgentContent: React.Dispatch<React.SetStateAction<AgentContentMap>>;
  /** Mapping from Task tool_use_id → agentId (for rendering during streaming) */
  toolUseToAgent: Map<string, string>;
  /** Mapping from Task tool_use_id → all subagent ids (AgentSwarm fan-out) */
  toolUseToAgentIds?: Map<string, string[]>;
  projectId: string;
  sessionId: string;
}

export function AgentContentProvider({
  children,
  agentContent,
  setAgentContent,
  toolUseToAgent,
  toolUseToAgentIds,
  projectId,
  sessionId,
}: AgentContentProviderProps) {
  const [loadingAgents, setLoadingAgents] = useState<Set<string>>(new Set());
  // Track which agents have had their JSONL loaded (separate from SSE content)
  const loadedAgentsRef = useRef<Set<string>>(new Set());
  const agentContentRef = useRef(agentContent);
  const loadingAgentsRef = useRef(loadingAgents);

  agentContentRef.current = agentContent;
  loadingAgentsRef.current = loadingAgents;

  const loadAgentContent = useCallback(
    async (
      loadProjectId: string,
      loadSessionId: string,
      agentId: string,
      options?: { force?: boolean },
    ): Promise<AgentContent> => {
      const force = options?.force === true;
      // Check if JSONL has already been loaded for this agent. A forced reload
      // (e.g. a still-running subagent whose wire.jsonl keeps growing) bypasses
      // the once-only cache so live metrics/transcript keep converging.
      if (!force && loadedAgentsRef.current.has(agentId)) {
        return (
          agentContentRef.current[agentId] ?? {
            messages: [],
            status: "pending",
          }
        );
      }

      // Share an in-flight read even for forced refreshes. `force` bypasses the
      // completed-result cache, not request deduplication; overlapping polls
      // could otherwise finish out of order and regress metrics or status.
      if (loadingAgentsRef.current.has(agentId)) {
        // Wait for existing load to complete
        return new Promise((resolve) => {
          const checkInterval = setInterval(() => {
            if (loadedAgentsRef.current.has(agentId)) {
              clearInterval(checkInterval);
              resolve(
                agentContentRef.current[agentId] ?? {
                  messages: [],
                  status: "pending",
                },
              );
            }
          }, 100);
          // Timeout after 30 seconds
          setTimeout(() => {
            clearInterval(checkInterval);
            resolve({ messages: [], status: "pending" });
          }, 30000);
        });
      }

      // Start loading
      setLoadingAgents((prev) => new Set(prev).add(agentId));

      try {
        const data = await api.getAgentSession(
          loadProjectId,
          loadSessionId,
          agentId,
        );

        // Mark as loaded before merging
        loadedAgentsRef.current.add(agentId);

        // Merge JSONL messages with any existing SSE content
        // SSE may have captured messages that arrived after page load
        setAgentContent((prev) => {
          const existing = prev[agentId];
          const existingMessages = existing?.messages ?? [];
          const jsonlMessages = data.messages;

          // Dedupe by message ID - prefer JSONL as canonical, add SSE-only messages
          const messageMap = new Map<string, Message>();
          for (const m of jsonlMessages) {
            messageMap.set(getMessageId(m), m);
          }
          // Add any SSE messages not in JSONL (e.g., arrived after JSONL was read)
          for (const m of existingMessages) {
            const id = getMessageId(m);
            if (!messageMap.has(id)) {
              messageMap.set(id, m);
            }
          }

          // Use status from server (inferred from JSONL) unless SSE shows running
          const status =
            existing?.status === "running" ? "running" : data.status;

          return {
            ...prev,
            [agentId]: {
              messages: Array.from(messageMap.values()),
              status,
              ...(data.agentType ? { agentType: data.agentType } : {}),
              ...(data.metrics ? { metrics: data.metrics } : {}),
              ...(data.descriptor ? { descriptor: data.descriptor } : {}),
            },
          };
        });

        return {
          messages: data.messages,
          status: data.status,
          ...(data.agentType ? { agentType: data.agentType } : {}),
          ...(data.metrics ? { metrics: data.metrics } : {}),
          ...(data.descriptor ? { descriptor: data.descriptor } : {}),
        };
      } catch (error) {
        console.error(`Failed to load agent content for ${agentId}:`, error);
        return { messages: [], status: "failed" };
      } finally {
        setLoadingAgents((prev) => {
          const next = new Set(prev);
          next.delete(agentId);
          return next;
        });
      }
    },
    [setAgentContent],
  );

  const isLoading = useCallback(
    (agentId: string) => loadingAgents.has(agentId),
    [loadingAgents],
  );

  const value = useMemo<AgentContentContextValue>(
    () => ({
      agentContent,
      toolUseToAgent,
      toolUseToAgentIds: toolUseToAgentIds ?? new Map(),
      loadAgentContent,
      isLoading,
      projectId,
    }),
    [
      agentContent,
      toolUseToAgent,
      toolUseToAgentIds,
      loadAgentContent,
      isLoading,
      projectId,
    ],
  );

  return (
    <AgentContentContext.Provider value={value}>
      {children}
    </AgentContentContext.Provider>
  );
}

/**
 * Hook to access agent content context.
 * Provides access to subagent messages and lazy-loading functionality.
 */
export function useAgentContent() {
  const context = useContext(AgentContentContext);
  if (!context) {
    throw new Error(
      "useAgentContent must be used within an AgentContentProvider",
    );
  }
  return context;
}

/**
 * Hook to get agent content for a specific agentId.
 * Returns null if context is not available (graceful degradation).
 */
export function useAgentContentOptional(agentId: string | undefined): {
  content: AgentContent | undefined;
  isLoading: boolean;
  load: () => Promise<void>;
} | null {
  const context = useContext(AgentContentContext);
  if (!context || !agentId) {
    return null;
  }

  return {
    content: context.agentContent[agentId],
    isLoading: context.isLoading(agentId),
    load: async () => {
      // Note: projectId and sessionId are captured from provider
      // This is a simplified interface for components
    },
  };
}

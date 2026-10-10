import type {
  SideConversationRequest,
  SideConversationResponse,
  SideConversationSnapshot,
} from "@yep-anywhere/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { generateUUID } from "../lib/uuid";

export function useSideConversation(
  sessionId: string,
  enabled: boolean,
  visible: boolean,
) {
  const [conversation, setConversation] = useState<SideConversationSnapshot>();
  const [supported, setSupported] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const state = useRef<SideConversationSnapshot | undefined>(undefined);
  const mounted = useRef(true);
  const revision = useRef(0);
  const mutating = useRef(false);
  const createId = useRef(generateUUID());
  const pendingSend = useRef<
    { id: string; text: string; requestId: string } | undefined
  >(undefined);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      revision.current++;
    };
  }, []);

  const accept = useCallback((response: SideConversationResponse) => {
    if (!mounted.current) return;
    setSupported(response.supported);
    if (!response.unchanged) {
      const next =
        response.conversation ??
        (state.current
          ? { ...state.current, status: "closed" as const, activity: undefined }
          : undefined);
      state.current = next;
      setConversation(next);
    }
    setError(response.error);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let probes = 0;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (mutating.current || document.hidden) {
        timer = setTimeout(poll, 1500);
        return;
      }
      const epoch = revision.current;
      try {
        const current = state.current;
        const result = await api.sideConversation(sessionId, {
          action: "get",
          id: current?.id,
          version: current?.version,
        });
        if (!cancelled && epoch === revision.current) accept(result);
      } catch (err) {
        if (!cancelled && epoch === revision.current)
          setError(err instanceof Error ? err.message : "Connection lost");
      }
      probes++;
      if (!cancelled && (visible || (!state.current && probes < 6)))
        timer = setTimeout(
          poll,
          state.current?.status === "running" ||
            state.current?.status === "stopping"
            ? 650
            : 3000,
        );
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [sessionId, enabled, visible, accept]);

  const request = useCallback(
    async (command: SideConversationRequest) => {
      if (mutating.current) return undefined;
      mutating.current = true;
      revision.current++;
      setBusy(true);
      setError(undefined);
      try {
        const result = await api.sideConversation(sessionId, command);
        accept(result);
        return result;
      } catch (err) {
        if (mounted.current)
          setError(
            err instanceof Error ? err.message : "Side conversation failed",
          );
        return undefined;
      } finally {
        mutating.current = false;
        revision.current++;
        if (mounted.current) setBusy(false);
      }
    },
    [sessionId, accept],
  );

  const send = useCallback(
    async (text: string, context: "snapshot" | "empty" = "snapshot") => {
      if (mutating.current) return false;
      let current = state.current;
      if (!current || current.status === "closed") {
        const result = await request({
          action: "create",
          requestId: createId.current,
          context,
        });
        current = result?.conversation;
        if (!current || current.status !== "idle") return false;
      }
      if (
        !pendingSend.current ||
        pendingSend.current.id !== current.id ||
        pendingSend.current.text !== text
      )
        pendingSend.current = {
          id: current.id,
          text,
          requestId: generateUUID(),
        };
      const result = await request({ action: "send", ...pendingSend.current });
      const accepted =
        !result?.error &&
        result?.conversation?.messages.some(
          (message) => message.id === pendingSend.current?.requestId,
        );
      if (accepted) pendingSend.current = undefined;
      return Boolean(accepted);
    },
    [request],
  );

  const close = useCallback(async () => {
    const current = state.current;
    if (current) await request({ action: "close", id: current.id });
    createId.current = generateUUID();
    pendingSend.current = undefined;
  }, [request]);
  const startNew = useCallback(
    async (context: "snapshot" | "empty" = "snapshot") => {
      createId.current = generateUUID();
      pendingSend.current = undefined;
      return request({
        action: "create",
        requestId: createId.current,
        context,
      });
    },
    [request],
  );

  return {
    conversation,
    supported,
    error,
    busy,
    send,
    close,
    startNew,
    interrupt: () =>
      state.current
        ? request({ action: "interrupt", id: state.current.id })
        : Promise.resolve(undefined),
  };
}

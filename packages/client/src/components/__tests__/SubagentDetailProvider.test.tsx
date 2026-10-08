import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { type ReactNode, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NestedRendererContext } from "../../contexts/NestedRendererContext";
import {
  SessionMetadataProvider,
  useOptionalSessionMetadata,
} from "../../contexts/SessionMetadataContext";
import { useSubagentDetail } from "../../contexts/SubagentDetailContext";
import { I18nProvider } from "../../i18n";
import type { AgentSession, Message } from "../../types";
import type { RenderItem } from "../../types/renderItems";
import { SubagentDetailProvider } from "../SubagentDetailProvider";
import { TranscriptRendererProvider } from "../TranscriptRendererProvider";
import { CodexNativeItemBlock } from "../blocks/codex/CodexNativeItemBlock";
import { CodexNativeSubAgentBlock } from "../blocks/codex/CodexNativeSubAgentBlock";

const { getAgentSessionInTree } = vi.hoisted(() => ({
  getAgentSessionInTree: vi.fn(),
}));

vi.mock("../../api/client", () => ({ api: { getAgentSessionInTree } }));

// Keep panel history/focus behavior outside these parent/child scope tests.
vi.mock("../ui/DetailPanel", () => ({
  DetailPanel: ({
    title,
    onClose,
    children,
  }: {
    title: string;
    onClose: () => void;
    children: ReactNode;
  }) => (
    <div role="dialog" aria-label={title}>
      <button type="button" onClick={onClose}>
        Close subagent details
      </button>
      {children}
    </div>
  ),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function assistant(
  id: string,
  text: string,
  phase: "commentary" | "final_answer" = "final_answer",
): Message {
  return {
    id,
    type: "assistant",
    content: text,
    codexMessagePhase: phase,
  };
}

function session(...messages: Message[]): AgentSession {
  return { messages, status: "completed" };
}

function StubRenderItem({ item }: { item: RenderItem }) {
  const metadata = useOptionalSessionMetadata();
  const detail = useSubagentDetail();
  if (item.type === "codex_native_item")
    return <CodexNativeItemBlock item={item} />;
  if (item.type !== "text") return <div>{item.type}</div>;
  return (
    <div>
      <p>{item.text}</p>
      <span aria-label="Nested session metadata">{metadata?.sessionId}</span>
      {item.text === "Child with a nested agent" && (
        <button
          type="button"
          onClick={() =>
            detail?.openAgent({
              agentId: "grandchild-agent",
              parentSessionId: metadata?.sessionId,
              name: "/root/child/grandchild",
            })
          }
        >
          Open nested agent
        </button>
      )}
    </div>
  );
}

const nestedRenderers = {
  RenderItem: StubRenderItem,
  ContentBlock: () => null,
};

function ParentConversation({
  onMount,
  onUnmount,
}: {
  onMount?: () => void;
  onUnmount?: () => void;
}) {
  const detail = useSubagentDetail();
  useEffect(() => {
    onMount?.();
    return () => onUnmount?.();
  }, [onMount, onUnmount]);
  return (
    <div>
      <p>Parent conversation stays here</p>
      <textarea aria-label="Parent draft" defaultValue="Unsent parent draft" />
      <button
        type="button"
        onClick={() =>
          detail?.openAgent({ agentId: "child-agent", name: "/root/child" })
        }
      >
        Open child
      </button>
      <button
        type="button"
        onClick={() =>
          detail?.openAgent({ agentId: "sibling-agent", name: "/root/sibling" })
        }
      >
        Open sibling
      </button>
      <output aria-label="Verified child status">
        {detail?.statuses["child-agent"] ?? "unopened"}
      </output>
    </div>
  );
}

function TestApp({
  sessionId = "parent-session",
  onMount,
  onUnmount,
  children,
}: {
  sessionId?: string;
  onMount?: () => void;
  onUnmount?: () => void;
  children?: ReactNode;
}) {
  return (
    <I18nProvider>
      <NestedRendererContext.Provider value={nestedRenderers}>
        <SubagentDetailProvider
          key={sessionId}
          projectId="project-1"
          projectPath="/workspace/project"
          sessionId={sessionId}
        >
          <ParentConversation onMount={onMount} onUnmount={onUnmount} />
          <SessionMetadataProvider
            projectId="project-1"
            projectPath={null}
            sessionId={sessionId}
          >
            {children}
          </SessionMetadataProvider>
        </SubagentDetailProvider>
      </NestedRendererContext.Provider>
    </I18nProvider>
  );
}

describe("SubagentDetailProvider", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("yep-anywhere-locale", "en");
    getAgentSessionInTree.mockReset();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("opens a persisted native grandchild activity using the real transcript renderers", async () => {
    getAgentSessionInTree.mockImplementation((_project, _root, agentId) =>
      Promise.resolve(
        agentId === "child-agent"
          ? session({
              id: "spawn-grandchild-call",
              type: "system",
              subtype: "codex_native_item",
              codexThreadItemLifecycle: "completed",
              codexThreadItem: {
                id: "spawn-grandchild-call",
                type: "subAgentActivity",
                kind: "started",
                agentThreadId: "grandchild-agent",
                agentPath: "/root/child/nested",
              },
            })
          : session(),
      ),
    );
    render(
      <I18nProvider>
        <TranscriptRendererProvider>
          <SubagentDetailProvider
            projectId="project-1"
            projectPath="/workspace/project"
            sessionId="parent-session"
          >
            <ParentConversation />
          </SubagentDetailProvider>
        </TranscriptRendererProvider>
      </I18nProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open child" }));
    fireEvent.click(
      await screen.findByRole("button", {
        name: "View details for /root/child/nested",
      }),
    );
    await waitFor(() =>
      expect(getAgentSessionInTree).toHaveBeenLastCalledWith(
        "project-1",
        "parent-session",
        "grandchild-agent",
      ),
    );
    expect(screen.getByRole("dialog", { name: "nested" })).toBeDefined();
    expect(
      screen.getByRole("button", { name: /Back one level/ }),
    ).toBeDefined();
  });

  it("opens the parent-scoped child without unmounting or replacing the parent draft DOM", async () => {
    getAgentSessionInTree.mockResolvedValue(
      session(assistant("child-answer", "Child answer")),
    );
    const onMount = vi.fn();
    const onUnmount = vi.fn();
    render(<TestApp onMount={onMount} onUnmount={onUnmount} />);
    const draft = screen.getByRole("textbox", {
      name: "Parent draft",
    }) as HTMLTextAreaElement;
    fireEvent.change(draft, {
      target: { value: "Still writing my next turn" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Open child" }));
    await screen.findByText("Child answer");

    expect(getAgentSessionInTree).toHaveBeenCalledWith(
      "project-1",
      "parent-session",
      "child-agent",
    );
    expect(screen.getByRole("dialog", { name: "child" })).toBeDefined();
    expect(screen.getByRole("textbox", { name: "Parent draft" })).toBe(draft);
    expect(draft.value).toBe("Still writing my next turn");
    expect(onMount).toHaveBeenCalledTimes(1);
    expect(onUnmount).not.toHaveBeenCalled();
    expect(screen.getByText("Parent conversation stays here")).toBeDefined();
    await waitFor(() => {
      expect(screen.getByLabelText("Verified child status").textContent).toBe(
        "completed",
      );
    });

    fireEvent.click(
      screen.getByRole("button", { name: /Back to parent conversation/ }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("textbox", { name: "Parent draft" })).toBe(draft);
    expect(draft.value).toBe("Still writing my next turn");
    expect(onUnmount).not.toHaveBeenCalled();
  });

  it.each([
    {
      action: "Close subagent details",
      snapshot: "running",
      next: "completed",
    },
    {
      action: /Back to parent conversation/,
      snapshot: "running",
      next: "interrupted",
    },
    { action: "Open sibling", snapshot: "running", next: "completed" },
    {
      action: "Close subagent details",
      snapshot: "completed",
      next: "running",
    },
  ] as const)(
    "keeps historical card state separate from the $snapshot detail and releases it on $action",
    async ({ action, snapshot, next }) => {
      getAgentSessionInTree
        .mockResolvedValueOnce({ messages: [], status: snapshot })
        .mockReturnValueOnce(deferred<AgentSession>().promise);
      const card = (status: string) => (
        <CodexNativeSubAgentBlock
          tool="wait"
          lifecycle="completed"
          agentsStates={{ "child-agent": { status, message: null } }}
        />
      );
      const view = render(<TestApp>{card("running")}</TestApp>);
      fireEvent.click(screen.getByRole("button", { name: "Open child" }));
      await waitFor(() =>
        expect(screen.getByLabelText("Verified child status").textContent).toBe(
          snapshot,
        ),
      );
      expect(
        view.container.querySelector(".codex-native-subagent-state-status")
          ?.textContent,
      ).toBe("running");

      fireEvent.click(screen.getByRole("button", { name: action }));
      expect(screen.getByLabelText("Verified child status").textContent).toBe(
        "unopened",
      );
      view.rerender(<TestApp>{card(next)}</TestApp>);
      expect(
        view.container.querySelector(".codex-native-subagent-state-status")
          ?.textContent,
      ).toBe(next === "completed" ? "turn finished" : next);
    },
  );

  it("does not put a retired running badge on a later V2 completion activity", async () => {
    getAgentSessionInTree.mockResolvedValue({
      messages: [],
      status: "running",
    });
    const card = (kind: string) => (
      <CodexNativeSubAgentBlock
        kind={kind}
        agentPath="/root/child"
        agentThreadId="child-agent"
        lifecycle="completed"
      />
    );
    const view = render(<TestApp>{card("started")}</TestApp>);
    fireEvent.click(screen.getByRole("button", { name: "Open child" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Verified child status").textContent).toBe(
        "running",
      ),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Close subagent details" }),
    );
    view.rerender(<TestApp>{card("completed")}</TestApp>);
    expect(screen.getByText("Turn finished")).toBeDefined();
    expect(view.container.querySelector(".status-running")).toBeNull();
  });

  it("releases verified status when polling fails and restores it after retry", async () => {
    getAgentSessionInTree
      .mockResolvedValueOnce({ messages: [], status: "running" })
      .mockRejectedValueOnce(new Error("Connection lost"))
      .mockResolvedValueOnce({ messages: [], status: "completed" });
    render(<TestApp />);
    fireEvent.click(screen.getByRole("button", { name: "Open child" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Verified child status").textContent).toBe(
        "running",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByRole("alert");
    await waitFor(() =>
      expect(screen.getByLabelText("Verified child status").textContent).toBe(
        "unopened",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Verified child status").textContent).toBe(
        "completed",
      ),
    );
  });

  it("releases the status override while hidden and reads fresh status on return", async () => {
    getAgentSessionInTree
      .mockResolvedValueOnce({ messages: [], status: "running" })
      .mockResolvedValueOnce({ messages: [], status: "completed" });
    render(<TestApp />);
    fireEvent.click(screen.getByRole("button", { name: "Open child" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Verified child status").textContent).toBe(
        "running",
      ),
    );

    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    fireEvent(document, new Event("visibilitychange"));
    expect(screen.getByLabelText("Verified child status").textContent).toBe(
      "unopened",
    );
    expect(getAgentSessionInTree).toHaveBeenCalledTimes(1);

    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() =>
      expect(screen.getByLabelText("Verified child status").textContent).toBe(
        "completed",
      ),
    );
    expect(getAgentSessionInTree).toHaveBeenCalledTimes(2);
  });

  it("keeps child metadata for nested links while reading the same root tree and returning one level", async () => {
    getAgentSessionInTree.mockImplementation(
      (_project: string, _parent: string, agentId: string) =>
        Promise.resolve(
          agentId === "grandchild-agent"
            ? session(assistant("grandchild-answer", "Grandchild answer"))
            : session(assistant("child-nested", "Child with a nested agent")),
        ),
    );
    render(<TestApp />);
    const draft = screen.getByRole("textbox", { name: "Parent draft" });
    fireEvent.click(screen.getByRole("button", { name: "Open child" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Open nested agent" }),
    );
    await screen.findByText("Grandchild answer");

    expect(getAgentSessionInTree).toHaveBeenNthCalledWith(
      2,
      "project-1",
      "parent-session",
      "grandchild-agent",
    );
    expect(screen.getByRole("dialog", { name: "grandchild" })).toBeDefined();
    expect(screen.getByLabelText("Nested session metadata").textContent).toBe(
      "grandchild-agent",
    );
    expect(screen.getByRole("textbox", { name: "Parent draft" })).toBe(draft);

    fireEvent.click(screen.getByRole("button", { name: /Back one level/ }));
    await screen.findByText("Child with a nested agent");
    expect(screen.getByLabelText("Nested session metadata").textContent).toBe(
      "child-agent",
    );
    expect(screen.queryByText("Grandchild answer")).toBeNull();
    expect(screen.getByRole("dialog", { name: "child" })).toBeDefined();
    expect(getAgentSessionInTree).toHaveBeenLastCalledWith(
      "project-1",
      "parent-session",
      "child-agent",
    );
    expect(
      screen.getByRole("button", { name: /Back to parent conversation/ }),
    ).toBeDefined();
  });

  it("clears the open detail and verified status when the root provider key changes", async () => {
    const retired = deferred<AgentSession>();
    getAgentSessionInTree
      .mockResolvedValueOnce(
        session(assistant("old-answer", "Old root answer")),
      )
      .mockReturnValueOnce(retired.promise)
      .mockResolvedValueOnce(
        session(assistant("new-answer", "New root answer")),
      );
    const { rerender } = render(<TestApp />);
    fireEvent.click(screen.getByRole("button", { name: "Open child" }));
    await screen.findByText("Old root answer");
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    rerender(<TestApp sessionId="different-parent" />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("Old root answer")).toBeNull();
    expect(screen.getByLabelText("Verified child status").textContent).toBe(
      "unopened",
    );
    fireEvent.click(screen.getByRole("button", { name: "Open child" }));
    await screen.findByText("New root answer");
    expect(getAgentSessionInTree).toHaveBeenLastCalledWith(
      "project-1",
      "different-parent",
      "child-agent",
    );
    await act(async () => {
      retired.resolve(session(assistant("late-answer", "Retired root answer")));
    });
    expect(screen.queryByText("Retired root answer")).toBeNull();
    expect(screen.getByText("New root answer")).toBeDefined();
  });

  it("keeps a missing-child error inside the panel and offers retry and return", async () => {
    getAgentSessionInTree
      .mockRejectedValueOnce(
        Object.assign(new Error("Session not found"), { status: 404 }),
      )
      .mockResolvedValueOnce(
        session(assistant("recovered", "Recovered child answer")),
      );
    render(<TestApp />);
    const draft = screen.getByRole("textbox", { name: "Parent draft" });
    fireEvent.click(screen.getByRole("button", { name: "Open child" }));
    const alert = await screen.findByRole("alert");
    const dialog = screen.getByRole("dialog");

    expect(within(dialog).getByRole("alert")).toBe(alert);
    expect(screen.getByText("Parent conversation stays here")).toBeDefined();
    expect(screen.getByRole("textbox", { name: "Parent draft" })).toBe(draft);
    expect(within(dialog).queryByText("Session not found")).toBeNull();
    expect(
      within(dialog).getByRole("button", {
        name: /Back to parent conversation/,
      }),
    ).toBeDefined();
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    await screen.findByText("Recovered child answer");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(getAgentSessionInTree).toHaveBeenCalledTimes(2);

    fireEvent.click(
      screen.getByRole("button", { name: /Back to parent conversation/ }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("textbox", { name: "Parent draft" })).toBe(draft);
  });

  it("shows only the latest final answer in the result tab, even after newer commentary", async () => {
    getAgentSessionInTree.mockResolvedValue(
      session(
        assistant("progress-before", "Checking the code", "commentary"),
        assistant("old-final", "First completed answer"),
        assistant("progress-between", "Checking one more detail", "commentary"),
        assistant("new-final", "Latest completed answer"),
        assistant("progress-after", "Starting a follow-up", "commentary"),
      ),
    );
    render(<TestApp />);
    fireEvent.click(screen.getByRole("button", { name: "Open child" }));
    await screen.findByText("Starting a follow-up");
    fireEvent.click(screen.getByRole("tab", { name: "Latest result" }));

    const result = screen.getByRole("tabpanel", { name: "Latest result" });
    expect(within(result).getByText("Latest completed answer")).toBeDefined();
    for (const text of [
      "First completed answer",
      "Checking the code",
      "Checking one more detail",
      "Starting a follow-up",
    ]) {
      expect(within(result).queryByText(text)).toBeNull();
    }
    fireEvent.click(screen.getByRole("tab", { name: "Conversation" }));
    expect(screen.getByText("Starting a follow-up")).toBeDefined();
    expect(screen.getByText("First completed answer")).toBeDefined();
  });

  it("does not present commentary as a result when no final answer exists", async () => {
    getAgentSessionInTree.mockResolvedValue(
      session(
        assistant("progress-only", "Still checking the code", "commentary"),
      ),
    );
    render(<TestApp />);
    fireEvent.click(screen.getByRole("button", { name: "Open child" }));
    await screen.findByText("Still checking the code");
    fireEvent.click(screen.getByRole("tab", { name: "Latest result" }));

    const result = screen.getByRole("tabpanel", { name: "Latest result" });
    expect(within(result).queryByText("Still checking the code")).toBeNull();
    expect(
      within(result).getByText(
        "No final reply yet. Check the conversation for progress.",
      ),
    ).toBeDefined();
  });

  it("keeps outgoing delegation separate from this agent's task and folds repeated result text into a delivery receipt", async () => {
    const communication = (
      id: string,
      kind: string,
      sender: string,
      recipient: string,
      text: string,
    ): Message => ({
      id,
      type: "system",
      subtype: "codex_native_item",
      codexThreadItem: {
        type: "interAgentMessage",
        id,
        kind,
        sender,
        recipient,
        text,
        encrypted: false,
      },
    });
    getAgentSessionInTree.mockResolvedValue(
      session(
        communication(
          "task",
          "task",
          "/root",
          "/root/child",
          "Review the parser.",
        ),
        assistant("own-final", "Parser review complete."),
        communication(
          "outgoing-task",
          "task",
          "/root/child",
          "/root/peer",
          "Check the renderer too.",
        ),
        communication(
          "outgoing-result",
          "result",
          "/root/child",
          "/root",
          "Parser review complete.",
        ),
      ),
    );
    render(<TestApp />);
    fireEvent.click(screen.getByRole("button", { name: "Open child" }));
    await screen.findByText("The result above was returned to the recipient.");
    expect(screen.getAllByText("Parser review complete.")).toHaveLength(1);
    expect(screen.getByText("Check the renderer too.")).toBeDefined();
    fireEvent.click(screen.getByRole("tab", { name: "Latest result" }));
    expect(screen.getByText("Parser review complete.")).toBeDefined();
    expect(screen.queryByText("Check the renderer too.")).toBeNull();
  });

  it("starts a fresh result scope when the same agent receives a follow-up task", async () => {
    const followup: Message = {
      id: "followup-task",
      type: "system",
      subtype: "codex_native_item",
      codexThreadItem: {
        type: "interAgentMessage",
        kind: "task",
        sender: "/root",
        recipient: "/root/child",
        encrypted: true,
      },
    };
    getAgentSessionInTree.mockResolvedValue({
      messages: [
        assistant("previous-result", "Only the previous task was checked"),
        followup,
        assistant("current-progress", "Checking the follow-up", "commentary"),
      ],
      status: "running",
    });
    render(<TestApp />);
    fireEvent.click(screen.getByRole("button", { name: "Open child" }));
    await screen.findByText("Checking the follow-up");
    expect(screen.getByRole("region", { name: "Assigned task" })).toBeDefined();
    fireEvent.click(screen.getByRole("tab", { name: "Latest result" }));
    const result = screen.getByRole("tabpanel", { name: "Latest result" });
    expect(
      within(result).queryByText("Only the previous task was checked"),
    ).toBeNull();
    expect(
      within(result).getByText(
        "No final reply yet. Check the conversation for progress.",
      ),
    ).toBeDefined();

    getAgentSessionInTree.mockResolvedValue(
      session(
        assistant("previous-result", "Only the previous task was checked"),
        followup,
        assistant("followup-result", "The follow-up has now been checked"),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByText("The follow-up has now been checked");
    expect(
      within(result).queryByText("Only the previous task was checked"),
    ).toBeNull();
  });

  it("places the assigned task before inherited background and preserves its disclosure across tabs", async () => {
    const base: AgentSession = {
      ...session(
        {
          id: "initial-task",
          type: "system",
          subtype: "codex_native_item",
          codexThreadItem: {
            type: "interAgentMessage",
            kind: "task",
            sender: "/root",
            recipient: "/root/child",
            text: "Check the documentation references.",
            encrypted: false,
          },
        },
        assistant("answer", "References checked"),
      ),
      hasInheritedContext: true,
    };
    getAgentSessionInTree.mockImplementation(
      (_project, _root, _agent, options) =>
        Promise.resolve({
          ...base,
          ...(options?.includeInheritedContext
            ? {
                inheritedMessages: [
                  assistant("inherited", "Earlier parent answer"),
                ],
              }
            : {}),
        }),
    );
    render(<TestApp />);
    fireEvent.click(screen.getByRole("button", { name: "Open child" }));
    const task = await screen.findByRole("region", { name: "Assigned task" });
    const context = screen.getByRole("button", { name: "Inherited context" });
    expect(
      task.compareDocumentPosition(context) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    fireEvent.click(context);
    await screen.findByText("Earlier parent answer");
    fireEvent.click(screen.getByRole("tab", { name: "Latest result" }));
    fireEvent.click(screen.getByRole("tab", { name: "Conversation" }));
    expect(screen.getByRole("button", { name: "Inherited context" })).toBe(
      context,
    );
    expect(context.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Earlier parent answer")).toBeDefined();
    expect(getAgentSessionInTree).toHaveBeenCalledTimes(2);
  });

  it("loads inherited context only on expansion and caches it across collapse and reopen", async () => {
    const own = assistant("own-answer", "Own child answer");
    const base: AgentSession = { ...session(own), hasInheritedContext: true };
    const expanded: AgentSession = {
      ...base,
      inheritedMessages: [
        assistant("parent-answer", "Inherited parent answer"),
      ],
    };
    getAgentSessionInTree.mockImplementation(
      (
        _project,
        _root,
        _agent,
        options?: { includeInheritedContext?: boolean },
      ) => Promise.resolve(options?.includeInheritedContext ? expanded : base),
    );
    render(<TestApp />);
    fireEvent.click(screen.getByRole("button", { name: "Open child" }));
    await screen.findByText("Own child answer");
    const toggle = screen.getByRole("button", { name: "Inherited context" });

    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Inherited parent answer")).toBeNull();
    expect(getAgentSessionInTree.mock.calls).toEqual([
      ["project-1", "parent-session", "child-agent"],
    ]);

    fireEvent.click(toggle);
    await screen.findByText("Inherited parent answer");
    expect(getAgentSessionInTree).toHaveBeenLastCalledWith(
      "project-1",
      "parent-session",
      "child-agent",
      { includeInheritedContext: true },
    );
    expect(
      screen.getByText(
        "Parent conversation provided as background, separate from the assigned task and the agent’s collaboration instructions.",
      ),
    ).toBeDefined();
    expect(screen.getAllByText("Own child answer")).toHaveLength(1);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Inherited parent answer")).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByText("Inherited parent answer")).toBeDefined();
    expect(getAgentSessionInTree).toHaveBeenCalledTimes(2);
    expect(screen.getAllByText("Own child answer")).toHaveLength(1);

    fireEvent.click(screen.getByRole("tab", { name: "Latest result" }));
    expect(screen.queryByText("Inherited parent answer")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Conversation" }));
    expect(screen.getByText("Inherited parent answer")).toBeDefined();
    expect(
      screen
        .getByRole("button", { name: "Inherited context" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    expect(getAgentSessionInTree).toHaveBeenCalledTimes(2);
  });

  it("preserves inherited expansion during ordinary polling and excludes parent finals from Latest result", async () => {
    vi.useFakeTimers();
    let currentOwn = assistant(
      "own-progress",
      "Original child progress",
      "commentary",
    );
    getAgentSessionInTree.mockImplementation(
      (
        _project,
        _root,
        _agent,
        options?: { includeInheritedContext?: boolean },
      ) =>
        Promise.resolve({
          ...session(currentOwn),
          hasInheritedContext: true,
          ...(options?.includeInheritedContext
            ? {
                inheritedMessages: [
                  assistant(
                    "parent-final",
                    "Parent final must never become child result",
                  ),
                ],
              }
            : {}),
        }),
    );
    render(<TestApp />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Open child" }));
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Inherited context" }),
      );
    });
    expect(
      screen.getByText("Parent final must never become child result"),
    ).toBeDefined();
    currentOwn = assistant(
      "own-progress-new",
      "Updated child progress",
      "commentary",
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(getAgentSessionInTree).toHaveBeenLastCalledWith(
      "project-1",
      "parent-session",
      "child-agent",
    );
    expect(
      screen
        .getByRole("button", { name: "Inherited context" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    expect(
      screen.getByText("Parent final must never become child result"),
    ).toBeDefined();
    expect(screen.getAllByText("Updated child progress")).toHaveLength(1);
    expect(screen.queryByText("Original child progress")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Inherited context" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(
      screen
        .getByRole("button", { name: "Inherited context" })
        .getAttribute("aria-expanded"),
    ).toBe("false");
    expect(
      screen.queryByText("Parent final must never become child result"),
    ).toBeNull();
    expect(
      getAgentSessionInTree.mock.calls.filter(
        (call) => call[3]?.includeInheritedContext,
      ),
    ).toHaveLength(1);

    fireEvent.click(screen.getByRole("tab", { name: "Latest result" }));
    const result = screen.getByRole("tabpanel", { name: "Latest result" });
    expect(
      within(result).queryByText("Parent final must never become child result"),
    ).toBeNull();
    expect(within(result).queryByText("Updated child progress")).toBeNull();
    expect(
      within(result).getByText(
        "No final reply yet. Check the conversation for progress.",
      ),
    ).toBeDefined();
    expect(
      screen.queryByRole("button", { name: "Inherited context" }),
    ).toBeNull();
  });

  it.each([undefined, false])(
    "does not offer inherited context when its marker is %s",
    async (hasInheritedContext) => {
      getAgentSessionInTree.mockResolvedValue({
        ...session(assistant("own-only", "Child without inherited context")),
        ...(hasInheritedContext === undefined ? {} : { hasInheritedContext }),
      });
      render(<TestApp />);
      fireEvent.click(screen.getByRole("button", { name: "Open child" }));
      await screen.findByText("Child without inherited context");

      expect(
        screen.queryByRole("button", { name: "Inherited context" }),
      ).toBeNull();
      expect(getAgentSessionInTree.mock.calls).toEqual([
        ["project-1", "parent-session", "child-agent"],
      ]);
    },
  );

  it("retries a failed inherited-context load locally while keeping the own transcript", async () => {
    const base: AgentSession = {
      ...session(assistant("own-stable", "Own answer remains visible")),
      hasInheritedContext: true,
    };
    let inheritedAttempts = 0;
    getAgentSessionInTree.mockImplementation(
      (
        _project,
        _root,
        _agent,
        options?: { includeInheritedContext?: boolean },
      ) => {
        if (!options?.includeInheritedContext) return Promise.resolve(base);
        inheritedAttempts += 1;
        return inheritedAttempts === 1
          ? Promise.reject(new Error("Inherited request failed"))
          : Promise.resolve({
              ...base,
              inheritedMessages: [
                assistant("parent-retry", "Parent context after retry"),
              ],
            });
      },
    );
    render(<TestApp />);
    fireEvent.click(screen.getByRole("button", { name: "Open child" }));
    const ownText = await screen.findByText("Own answer remains visible");
    fireEvent.click(screen.getByRole("button", { name: "Inherited context" }));
    const alert = await screen.findByRole("alert");

    expect(screen.getByText("Own answer remains visible")).toBe(ownText);
    expect(screen.getByRole("button", { name: "Refresh" })).toBeDefined();
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    await screen.findByText("Parent context after retry");

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getAllByText("Own answer remains visible")).toHaveLength(1);
    expect(inheritedAttempts).toBe(2);
    expect(
      getAgentSessionInTree.mock.calls.filter((call) => call.length === 3),
    ).toEqual([["project-1", "parent-session", "child-agent"]]);
  });

  it.each(["child", "root"])(
    "isolates a late inherited-context response after changing the %s",
    async (change) => {
      const retired = deferred<AgentSession>();
      getAgentSessionInTree.mockImplementation(
        (
          _project: string,
          root: string,
          agent: string,
          options?: { includeInheritedContext?: boolean },
        ) => {
          const data: AgentSession = {
            ...session(
              assistant(`own-${root}-${agent}`, `Own ${root}/${agent}`),
            ),
            hasInheritedContext: true,
          };
          if (!options?.includeInheritedContext) return Promise.resolve(data);
          if (root === "parent-session" && agent === "child-agent")
            return retired.promise;
          return Promise.resolve({
            ...data,
            inheritedMessages: [
              assistant(
                `parent-${root}-${agent}`,
                `Inherited ${root}/${agent}`,
              ),
            ],
          });
        },
      );
      const { rerender } = render(<TestApp />);
      fireEvent.click(screen.getByRole("button", { name: "Open child" }));
      await screen.findByText("Own parent-session/child-agent");
      fireEvent.click(
        screen.getByRole("button", { name: "Inherited context" }),
      );

      if (change === "child") {
        fireEvent.click(screen.getByRole("button", { name: "Open sibling" }));
      } else {
        rerender(<TestApp sessionId="different-parent" />);
        fireEvent.click(screen.getByRole("button", { name: "Open child" }));
      }
      const nextRoot =
        change === "root" ? "different-parent" : "parent-session";
      const nextAgent = change === "child" ? "sibling-agent" : "child-agent";
      await screen.findByText(`Own ${nextRoot}/${nextAgent}`);
      await act(async () => {
        retired.resolve({
          ...session(assistant("retired-own", "Retired own transcript")),
          hasInheritedContext: true,
          inheritedMessages: [
            assistant("retired-parent", "Retired parent context"),
          ],
        });
      });

      expect(screen.queryByText("Retired own transcript")).toBeNull();
      expect(screen.queryByText("Retired parent context")).toBeNull();
      const toggle = screen.getByRole("button", { name: "Inherited context" });
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      fireEvent.click(toggle);
      await screen.findByText(`Inherited ${nextRoot}/${nextAgent}`);
      expect(getAgentSessionInTree).toHaveBeenLastCalledWith(
        "project-1",
        nextRoot,
        nextAgent,
        { includeInheritedContext: true },
      );
      expect(screen.getAllByText(`Own ${nextRoot}/${nextAgent}`)).toHaveLength(
        1,
      );
    },
  );
});

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { SideConversationSnapshot } from "@yep-anywhere/shared";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { useSideConversation } from "../useSideConversation";

vi.mock("../../api/client", () => ({
  api: { sideConversation: vi.fn(), queueMessage: vi.fn() },
}));
const snapshot = (version = 1): SideConversationSnapshot => ({
  id: "child",
  parentSessionId: "parent",
  context: "snapshot",
  capturedAt: "2026-10-10T00:00:00Z",
  status: "idle",
  version,
  messages: [],
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("creates a snapshot once, sends through the side endpoint, and retries ambiguous sends with the same ID", async () => {
  let calls = 0;
  vi.mocked(api.sideConversation).mockImplementation(async (_id, request) => {
    if (request.action === "get") return { supported: true };
    if (request.action === "create")
      return { supported: true, conversation: snapshot() };
    if (request.action === "send") {
      calls++;
      if (calls === 1) throw new Error("Disconnected after admission");
      return {
        supported: true,
        conversation: {
          ...snapshot(2),
          status: "running",
          messages: [
            { id: request.requestId, role: "user", text: request.text },
          ],
        },
      };
    }
    return { supported: true };
  });
  const { result } = renderHook(() =>
    useSideConversation("parent", true, false),
  );
  await waitFor(() => expect(result.current.supported).toBe(true));
  await act(async () => {
    expect(await result.current.send("why?")).toBe(false);
  });
  await act(async () => {
    expect(await result.current.send("why?")).toBe(true);
  });
  const commands = vi
    .mocked(api.sideConversation)
    .mock.calls.map(([, request]) => request);
  expect(commands.filter((c) => c.action === "create")).toHaveLength(1);
  expect(commands.filter((c) => c.action === "create")[0]).toMatchObject({
    context: "snapshot",
  });
  const sends = commands.filter((c) => c.action === "send");
  expect(sends[0]).toEqual(sends[1]);
  expect(result.current.conversation?.status).toBe("running");
});

it("hiding or unmounting never aborts or closes the side conversation", async () => {
  vi.mocked(api.sideConversation).mockResolvedValue({
    supported: true,
    conversation: snapshot(),
  });
  const { result, rerender, unmount } = renderHook(
    ({ visible }) => useSideConversation("parent", true, visible),
    { initialProps: { visible: true } },
  );
  await waitFor(() => expect(result.current.conversation?.id).toBe("child"));
  rerender({ visible: false });
  unmount();
  expect(
    vi
      .mocked(api.sideConversation)
      .mock.calls.every(([, request]) => request.action === "get"),
  ).toBe(true);
});

it("ignores an older poll that finishes after a send", async () => {
  let finish!: (value: {
    supported: boolean;
    conversation: SideConversationSnapshot;
  }) => void;
  vi.mocked(api.sideConversation).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  vi.mocked(api.sideConversation).mockImplementation(async (_id, request) => {
    if (request.action === "create")
      return { supported: true, conversation: snapshot() };
    return {
      supported: true,
      conversation: {
        ...snapshot(3),
        status: "running",
        messages:
          request.action === "send"
            ? [{ id: request.requestId, role: "user", text: request.text }]
            : [],
      },
    };
  });
  const { result } = renderHook(() =>
    useSideConversation("parent", true, true),
  );
  await act(async () => {
    await result.current.send("why?");
  });
  await act(async () => {
    finish({ supported: true, conversation: snapshot(1) });
  });
  expect(result.current.conversation?.version).toBe(3);
});

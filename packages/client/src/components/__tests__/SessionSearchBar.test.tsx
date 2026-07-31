import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { UI_KEYS } from "../../lib/storageKeys";
import { SessionSearchBar } from "../SessionSearchBar";

const mocks = vi.hoisted(() => ({
  search: vi.fn(),
}));

vi.mock("../../api/client", () => ({
  api: {
    search: mocks.search,
  },
}));

function renderSearchBar(
  overrides: Partial<React.ComponentProps<typeof SessionSearchBar>> = {},
) {
  const props: React.ComponentProps<typeof SessionSearchBar> = {
    isOpen: true,
    projectId: "project-1",
    sessionId: "session-1",
    onOpen: vi.fn(),
    onClose: vi.fn(),
    onSelectMessage: vi.fn(),
    ...overrides,
  };

  render(
    <I18nProvider>
      <SessionSearchBar {...props} />
    </I18nProvider>,
  );
  return props;
}

describe("SessionSearchBar", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem(UI_KEYS.locale, "en");
    vi.useFakeTimers();
    mocks.search.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("searches only the current session and navigates between matches", async () => {
    mocks.search.mockResolvedValue({
      query: "needle",
      totalSessions: 1,
      totalMatches: 2,
      searchDurationMs: 3,
      results: [
        {
          sessionId: "session-1",
          projectId: "project-1",
          projectName: "project",
          provider: "claude",
          title: "Session",
          updatedAt: "2026-07-31T00:00:00.000Z",
          matchCount: 2,
          matches: [
            {
              messageId: "message-1",
              role: "user",
              snippet: "first needle",
              matchStart: 6,
              matchLength: 6,
            },
            {
              messageId: "message-2",
              role: "assistant",
              snippet: "second needle",
              matchStart: 7,
              matchLength: 6,
            },
          ],
        },
      ],
    });
    const props = renderSearchBar();

    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "needle" },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(mocks.search).toHaveBeenCalledWith({
      q: "needle",
      project: "project-1",
      session: "session-1",
      limit: 1,
    });
    expect(props.onSelectMessage).toHaveBeenCalledWith("message-1");
    expect(screen.getByRole("status").textContent).toBe("1 / 2");

    fireEvent.click(
      screen.getByRole("button", {
        name: "Next match",
      }),
    );

    expect(props.onSelectMessage).toHaveBeenLastCalledWith("message-2");
    expect(screen.getByRole("status").textContent).toBe("2 / 2");
  });

  it("opens with the standard find shortcut while collapsed", () => {
    const onOpen = vi.fn();
    renderSearchBar({ isOpen: false, onOpen });

    fireEvent.keyDown(document, {
      key: "f",
      ctrlKey: true,
    });

    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

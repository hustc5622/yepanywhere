import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../../../i18n";
import { UI_KEYS } from "../../../../lib/storageKeys";

// The card looks up the child session's live activity to decide whether the
// subagent currently needs approval. Drive it from a controllable mock.
const globalSessions = vi.hoisted(() => ({
  value: [] as Array<{ id: string; activity?: string }>,
}));

vi.mock("../../../../hooks/useGlobalSessions", () => ({
  useGlobalSessions: () => ({ sessions: globalSessions.value }),
}));

import { openCodeTaskRenderer } from "../OpenCodeTaskRenderer";

const renderContext = {
  isStreaming: false,
  theme: "dark" as const,
  provider: "opencode",
};

const taskInput = {
  description: "Explore open_platform_api_case project",
  subagent_type: "explore",
  opencodeMetadata: {
    sessionId: "ses_child",
    parentSessionId: "ses_parent",
  },
};

function renderInline(status: "pending" | "complete" | "error" | "aborted") {
  if (!openCodeTaskRenderer.renderInline) {
    throw new Error("OpenCode task renderer must provide inline rendering");
  }
  return render(
    <MemoryRouter>
      <I18nProvider>
        {openCodeTaskRenderer.renderInline(
          taskInput,
          undefined,
          false,
          status,
          renderContext,
        )}
      </I18nProvider>
    </MemoryRouter>,
  );
}

describe("OpenCodeTaskRenderer", () => {
  beforeEach(() => {
    window.localStorage.setItem(UI_KEYS.locale, "en");
    globalSessions.value = [];
  });

  afterEach(() => {
    cleanup();
    window.localStorage.removeItem(UI_KEYS.locale);
  });

  it("shows Running for a live subagent that is not blocked", () => {
    globalSessions.value = [{ id: "ses_child", activity: "in-turn" }];
    renderInline("pending");
    expect(screen.getByText("running")).toBeDefined();
    expect(screen.queryByText("Approval needed")).toBeNull();
  });

  it("shows Approval needed when the child session is waiting for input", () => {
    globalSessions.value = [{ id: "ses_child", activity: "waiting-input" }];
    renderInline("pending");
    expect(screen.getByText("Approval needed")).toBeDefined();
    expect(screen.queryByText("running")).toBeNull();
  });

  it("returns to completed once the subagent resolves", () => {
    globalSessions.value = [{ id: "ses_child", activity: "idle" }];
    renderInline("complete");
    expect(screen.getByText("completed")).toBeDefined();
    expect(screen.queryByText("Approval needed")).toBeNull();
  });
});

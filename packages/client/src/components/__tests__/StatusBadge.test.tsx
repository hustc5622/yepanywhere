import { cleanup, render } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../i18n";
import { SessionStatusBadge } from "../StatusBadge";

function renderBadge(ui: ReactElement) {
  return render(<I18nProvider>{ui}</I18nProvider>);
}

describe("SessionStatusBadge", () => {
  afterEach(() => {
    cleanup();
  });

  it("shows Thinking badge when activity is in-turn", () => {
    const { container } = renderBadge(
      <SessionStatusBadge
        status={{
          owner: "self",
          processId: "p1",
          permissionMode: "default",
          modeVersion: 0,
        }}
        activity="in-turn"
      />,
    );

    // ThinkingIndicator renders a pill with .thinking-indicator-pill class
    const badge = container.querySelector(".thinking-indicator-pill");
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe("Thinking");
  });

  it("shows nothing when owned but not in-turn", () => {
    const { container } = renderBadge(
      <SessionStatusBadge
        status={{
          owner: "self",
          processId: "p1",
          permissionMode: "default",
          modeVersion: 0,
        }}
      />,
    );

    // No indicator for owned sessions - "Thinking" badge shows when actually in-turn
    expect(container.querySelector(".status-badge")).toBeNull();
    expect(container.querySelector(".status-indicator")).toBeNull();
  });

  it("does not show an external badge from ownership alone", () => {
    const { container } = renderBadge(
      <SessionStatusBadge status={{ owner: "external" }} />,
    );

    expect(container.querySelector(".status-badge")).toBeNull();
    expect(container.querySelector(".status-indicator")).toBeNull();
  });

  it("shows nothing when unowned", () => {
    const { container } = renderBadge(
      <SessionStatusBadge status={{ owner: "none" }} />,
    );

    expect(container.querySelector(".status-badge")).toBeNull();
    expect(container.querySelector(".status-indicator")).toBeNull();
  });

  it("prioritizes needs-input over in-turn", () => {
    const { container } = renderBadge(
      <SessionStatusBadge
        status={{
          owner: "self",
          processId: "p1",
          permissionMode: "default",
          modeVersion: 0,
        }}
        activity="in-turn"
        pendingInputType="tool-approval"
      />,
    );

    const badge = container.querySelector(
      ".status-badge.notification-needs-input",
    );
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe("Approval Needed");

    const thinkingBadge = container.querySelector(".thinking-indicator-pill");
    expect(thinkingBadge).toBeNull();
  });

  it("shows Thinking badge even when hasUnread is true", () => {
    const { container } = renderBadge(
      <SessionStatusBadge
        status={{
          owner: "self",
          processId: "p1",
          permissionMode: "default",
          modeVersion: 0,
        }}
        activity="in-turn"
        hasUnread={true}
      />,
    );

    // ThinkingIndicator renders a pill with .thinking-indicator-pill class
    const thinkingBadge = container.querySelector(".thinking-indicator-pill");
    expect(thinkingBadge).not.toBeNull();
    expect(thinkingBadge?.textContent).toBe("Thinking");
  });

  it("shows nothing for unowned sessions (unread handled via CSS class)", () => {
    const { container } = renderBadge(
      <SessionStatusBadge status={{ owner: "none" }} hasUnread={true} />,
    );

    // No badge - unread is now handled via CSS class on parent element
    expect(container.querySelector(".status-badge")).toBeNull();
    expect(container.querySelector(".status-indicator")).toBeNull();
  });

  it("shows nothing for owned sessions with unread (unread handled via CSS class)", () => {
    const { container } = renderBadge(
      <SessionStatusBadge
        status={{
          owner: "self",
          processId: "p1",
          permissionMode: "default",
          modeVersion: 0,
        }}
        hasUnread={true}
      />,
    );

    // No badge or indicator - unread is handled via CSS class on parent
    expect(container.querySelector(".status-badge")).toBeNull();
    expect(container.querySelector(".status-indicator")).toBeNull();
  });

  it("shows a retrying badge instead of the thinking pulse while retrying", () => {
    const { container } = renderBadge(
      <SessionStatusBadge
        status={{ owner: "external" }}
        activity="in-turn"
        retryStatus={{ attempt: 3, message: "rate limited" }}
      />,
    );

    const badge = container.querySelector(".notification-continue");
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toContain("Retrying");
    expect(badge?.textContent).toContain("3");
    expect(badge?.getAttribute("title")).toBe("rate limited");
    expect(container.querySelector(".thinking-indicator-pill")).toBeNull();
  });

  it("shows a failed badge with the error as tooltip after a failed turn", () => {
    const { container } = renderBadge(
      <SessionStatusBadge
        status={{ owner: "none" }}
        lastTurnStatus="failed"
        lastErrorMessage="model exploded"
      />,
    );

    const badge = container.querySelector(".notification-failed");
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe("Failed");
    expect(badge?.getAttribute("title")).toBe("model exploded");
  });

  it("maps a bridge-reported interrupted turn to the continue badge", () => {
    const { container } = renderBadge(
      <SessionStatusBadge
        status={{ owner: "none" }}
        lastTurnStatus="interrupted"
      />,
    );

    const badge = container.querySelector(".notification-continue");
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe("Continue");
  });

  it("prioritizes needs-input over retrying", () => {
    const { container } = renderBadge(
      <SessionStatusBadge
        status={{ owner: "external" }}
        activity="waiting-input"
        pendingInputType="tool-approval"
        retryStatus={{ attempt: 1 }}
      />,
    );

    const badge = container.querySelector(".notification-needs-input");
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe("Approval Needed");
  });
});

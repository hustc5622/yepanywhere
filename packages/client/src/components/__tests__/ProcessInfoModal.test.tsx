import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProcessInfoModal } from "../ProcessInfoModal";

vi.mock("../../api/client", () => ({
  api: { getProcessInfo: vi.fn() },
}));

vi.mock("../../hooks/useActivityBusState", () => ({
  useActivityBusState: () => ({
    connected: false,
    connectionState: "disconnected",
  }),
}));

vi.mock("../../i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

describe("ProcessInfoModal", () => {
  it("does not render a non-string runtime session source", () => {
    const sessionSource = {
      subagent: { other: "guardian" },
    } as unknown as string;

    render(
      <ProcessInfoModal
        sessionId="session-1"
        provider="codex"
        status={{ owner: "none" }}
        processState="idle"
        sessionSource={sessionSource}
        sessionStreamConnected={false}
        onClose={vi.fn()}
      />,
    );

    expect(screen.queryByText("guardian")).toBeNull();
    expect(screen.getByText("processInfoTitle")).toBeTruthy();
  });
});

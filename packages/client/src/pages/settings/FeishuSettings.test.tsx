import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FeishuSettings } from "./FeishuSettings";

const mocks = vi.hoisted(() => ({
  connectFeishuAccount: vi.fn(),
  deleteFeishuAccount: vi.fn(),
  disconnectFeishuAccount: vi.fn(),
  getFeishuAccounts: vi.fn(),
  getFeishuDiagnostics: vi.fn(),
  getFeishuDoctor: vi.fn(),
  getFeishuPermissions: vi.fn(),
  getFeishuStatuses: vi.fn(),
  reconnectFeishuAccount: vi.fn(),
  saveFeishuAccount: vi.fn(),
  setFeishuSecret: vi.fn(),
  testFeishuAccount: vi.fn(),
}));

vi.mock("../../api/client", () => ({ api: mocks }));
vi.mock("../../i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

describe("FeishuSettings", () => {
  beforeEach(() => {
    mocks.getFeishuAccounts.mockResolvedValue({ accounts: [] });
    mocks.getFeishuStatuses.mockResolvedValue({ accounts: [] });
    mocks.getFeishuDoctor.mockResolvedValue({ ok: true, accounts: [] });
    mocks.getFeishuPermissions.mockResolvedValue({
      accountId: "fixture-account",
      capabilities: [],
      events: ["im.message.receive_v1"],
      callbacks: ["card.action.trigger"],
    });
    mocks.saveFeishuAccount.mockResolvedValue({ account: {} });
    mocks.setFeishuSecret.mockResolvedValue({ account: {} });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("stages an enabled account safely and sends credentials only to the write-only endpoint", async () => {
    render(<FeishuSettings />);
    await screen.findByText("feishuNoAccounts");
    fireEvent.click(screen.getByRole("button", { name: "feishuAddAccount" }));

    fireEvent.change(screen.getByLabelText("feishuAccountId"), {
      target: { value: "fixture-account" },
    });
    fireEvent.change(screen.getByLabelText("feishuAccountName"), {
      target: { value: "Fixture Bot" },
    });
    fireEvent.change(screen.getByLabelText("feishuAppId"), {
      target: { value: "fixture-app-id" },
    });
    fireEvent.change(screen.getByLabelText("feishuAppSecret"), {
      target: { value: "fixture-write-only-value" },
    });
    fireEvent.change(screen.getByLabelText("feishuWorkspaceRoots"), {
      target: { value: "/test-fixtures/repo\n/test-fixtures/repo" },
    });
    fireEvent.change(screen.getByLabelText("feishuAllowedUsers"), {
      target: { value: "fixture-user" },
    });
    fireEvent.change(screen.getByLabelText("feishuAllowedChats"), {
      target: { value: "fixture-chat" },
    });
    fireEvent.change(screen.getByLabelText("feishuDefaultModel"), {
      target: { value: "fixture-model" },
    });
    fireEvent.change(screen.getByLabelText("feishuDefaultReasoning"), {
      target: { value: "high" },
    });
    fireEvent.change(screen.getByLabelText("feishuDefaultMcpProfile"), {
      target: { value: "clear" },
    });
    fireEvent.click(screen.getByLabelText("feishuEnabled"));
    fireEvent.click(screen.getByRole("button", { name: "feishuSave" }));

    await waitFor(() => {
      expect(mocks.saveFeishuAccount).toHaveBeenCalledTimes(2);
      expect(mocks.setFeishuSecret).toHaveBeenCalledWith(
        "fixture-account",
        "fixture-write-only-value",
      );
    });
    expect(mocks.saveFeishuAccount.mock.calls[0]?.[0]).toMatchObject({
      id: "fixture-account",
      enabled: false,
      allowedWorkspaceRoots: ["/test-fixtures/repo"],
      allowedUsers: ["fixture-user"],
      allowedChats: ["fixture-chat"],
      defaultModel: "fixture-model",
      defaultReasoningEffort: "high",
      defaultCodexMcpMode: "clear",
      defaultPermissionMode: "default",
    });
    expect(mocks.saveFeishuAccount.mock.calls[1]?.[0]).toMatchObject({
      id: "fixture-account",
      enabled: true,
    });
    const configWrites = JSON.stringify(mocks.saveFeishuAccount.mock.calls);
    expect(configWrites).not.toContain("fixture-write-only-value");
    expect(configWrites).not.toContain("secretRef");
  });

  it("never renders the masked credential or offers bypassPermissions", async () => {
    mocks.getFeishuAccounts.mockResolvedValue({
      accounts: [
        {
          id: "fixture-account",
          name: "Fixture Bot",
          enabled: false,
          domain: "feishu",
          appId: "fixture-app-id",
          allowedWorkspaceRoots: ["/test-fixtures/repo"],
          allowedUsers: ["fixture-user"],
          adminUsers: [],
          allowedChats: ["fixture-chat"],
          requireMentionInGroup: true,
          groupSessionMode: "thread-when-available",
          defaultProvider: "codex",
          defaultCodexMcpMode: "standard",
          defaultPermissionMode: "default",
          replyMode: "card",
          secret: {
            configured: true,
            source: "store",
            masked: "masked-fixture-value",
          },
        },
      ],
    });

    render(<FeishuSettings />);
    await screen.findByText("Fixture Bot");
    expect(document.body.textContent).not.toContain("masked-fixture-value");
    fireEvent.click(screen.getByRole("button", { name: "feishuEdit" }));

    const credential = await screen.findByLabelText("feishuAppSecret");
    expect((credential as HTMLInputElement).value).toBe("");
    expect(
      screen.queryByRole("option", { name: "bypassPermissions" }),
    ).toBeNull();
  });

  it("explains the fail-closed allowlists for an enabled account", async () => {
    render(<FeishuSettings />);
    await screen.findByText("feishuNoAccounts");
    fireEvent.click(screen.getByRole("button", { name: "feishuAddAccount" }));
    fireEvent.click(screen.getByLabelText("feishuEnabled"));

    expect(screen.getByText("feishuNoUsersWarning")).toBeTruthy();
    expect(screen.getByText("feishuNoChatsWarning")).toBeTruthy();
  });

  it("keeps doctor evidence visible when mutable account routes fail closed", async () => {
    mocks.getFeishuAccounts.mockRejectedValue(
      new Error("feishu_channel_unavailable"),
    );
    mocks.getFeishuStatuses.mockRejectedValue(
      new Error("feishu_channel_unavailable"),
    );
    mocks.getFeishuDoctor.mockResolvedValue({
      ok: false,
      initializationErrorCode: "STORE_INITIALIZATION_FAILED",
      accounts: [],
    });

    render(<FeishuSettings />);

    expect(
      await screen.findByText("feishuDoctorStoreInitializationFailed"),
    ).toBeTruthy();
    expect(screen.getByText("feishu_channel_unavailable")).toBeTruthy();
    expect(mocks.connectFeishuAccount).not.toHaveBeenCalled();
    expect(mocks.saveFeishuAccount).not.toHaveBeenCalled();
  });
});

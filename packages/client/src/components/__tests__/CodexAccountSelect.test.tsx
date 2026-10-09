import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CodexAccountEntry, api } from "../../api/client";
import { I18nProvider } from "../../i18n";
import { getCodexAccountsStore } from "../../lib/codexAccounts";
import { updateNewSessionLayout } from "../../lib/newSessionLayout";
import { setCurrentInstallId } from "../../lib/storageKeys";
import { CodexAccountSelect } from "../CodexAccountSelect";
import { CodexUsageCard } from "../CodexUsageCard";

function makeEntry(entry: Partial<CodexAccountEntry>): CodexAccountEntry {
  return {
    id: "default",
    label: null,
    codexHome: "/home/.codex",
    isDefault: true,
    isActive: true,
    account: { type: "chatgpt", email: "a@example.com", planType: "pro" },
    usage: null,
    error: null,
    login: null,
    ...entry,
  };
}

function renderSelect(
  accounts: CodexAccountEntry[],
  onChange = vi.fn(),
  value: string | null = null,
) {
  vi.spyOn(api, "getCodexAccounts").mockResolvedValue({
    accounts,
    error: null,
  });
  render(
    <I18nProvider>
      <CodexAccountSelect value={value} onChange={onChange} />
    </I18nProvider>,
  );
  return onChange;
}

let testScope = 0;
beforeEach(() => {
  setCurrentInstallId(`codex-account-select-${++testScope}`);
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("CodexAccountSelect", () => {
  it("stays hidden when only the machine account exists", async () => {
    renderSelect([makeEntry({})]);
    await waitFor(() => {
      expect(api.getCodexAccounts).toHaveBeenCalled();
    });
    expect(screen.queryByText("Codex account")).toBeNull();
  });

  it("lists accounts and disables the ones without credentials", async () => {
    renderSelect([
      makeEntry({}),
      makeEntry({
        id: "acct-2",
        isDefault: false,
        isActive: false,
        account: null,
        error: "not-signed-in",
        label: "second",
      }),
    ]);

    expect(await screen.findByText("a@example.com")).toBeTruthy();
    const signedOut = await screen.findByText("second");
    expect(
      (signedOut.closest("button") as HTMLButtonElement | null)?.disabled,
    ).toBe(true);
  });

  it("falls back to the machine account when the selection is gone", async () => {
    const onChange = renderSelect(
      [
        makeEntry({}),
        makeEntry({ id: "acct-2", isDefault: false, account: null }),
      ],
      vi.fn(),
      "acct-removed",
    );
    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith(null);
    });
  });

  it("renders an active saved profile once without resetting its session selection", async () => {
    const onChange = renderSelect(
      [
        makeEntry({}),
        makeEntry({ id: "acct-active", isDefault: false }),
        makeEntry({
          id: "acct-other",
          isDefault: false,
          isActive: false,
          account: { type: "chatgpt", email: "b@example.com", planType: "pro" },
        }),
      ],
      vi.fn(),
      "acct-active",
    );
    const name = await screen.findByText("a@example.com");
    expect(screen.getAllByText("a@example.com")).toHaveLength(1);
    expect(name.closest("button")?.getAttribute("aria-pressed")).toBe("true");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("updates the picker after switching in the usage card and keeps both accounts visible", async () => {
    const a = makeEntry({});
    const b = makeEntry({
      id: "acct-b",
      isDefault: false,
      isActive: false,
      account: { type: "chatgpt", email: "b@example.com", planType: "pro" },
    });
    vi.spyOn(api, "getCodexAccounts").mockResolvedValue({
      accounts: [a, b],
      error: null,
    });
    vi.spyOn(api, "activateCodexAccount").mockImplementation(async () => {
      vi.mocked(api.getCodexAccounts).mockResolvedValue({
        accounts: [
          { ...a, account: b.account },
          { ...b, isActive: true },
          { ...a, id: "acct-a", isDefault: false, isActive: false },
        ],
        error: null,
      });
      return { ok: true };
    });
    render(
      <I18nProvider>
        <CodexAccountSelect value={null} onChange={vi.fn()} />
        <CodexUsageCard />
      </I18nProvider>,
    );
    const disclosure = screen.getByRole("button", {
      name: "Codex usage & accounts Expand",
      expanded: false,
    });
    await waitFor(() => {
      expect(screen.getAllByText("b@example.com")).toHaveLength(2);
    });
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    expect(
      screen.queryByRole("button", { name: "Use for sessions" }),
    ).toBeNull();
    fireEvent.click(disclosure);
    fireEvent.click(
      await screen.findByRole("button", { name: "Use for sessions" }),
    );
    await waitFor(() => {
      expect(api.activateCodexAccount).toHaveBeenCalledWith("acct-b");
      expect(screen.getAllByText("a@example.com")).toHaveLength(2);
      expect(screen.getAllByText("b@example.com")).toHaveLength(2);
      const selected = screen
        .getAllByText("b@example.com")
        .find((node) => node.closest("button"));
      expect(selected?.closest("button")?.getAttribute("aria-pressed")).toBe(
        "true",
      );
    });
    fireEvent.click(disclosure);
    expect(
      screen.queryByRole("button", { name: "Use for sessions" }),
    ).toBeNull();
    fireEvent.click(disclosure);
    expect(
      screen.getByRole("button", { name: "Use for sessions" }),
    ).toBeTruthy();
  });

  it("ignores an old picker response after an account update", async () => {
    let resolveLoad!: (
      response: Awaited<ReturnType<typeof api.getCodexAccounts>>,
    ) => void;
    vi.spyOn(api, "getCodexAccounts").mockReturnValue(
      new Promise((resolve) => {
        resolveLoad = resolve;
      }),
    );
    render(
      <I18nProvider>
        <CodexAccountSelect value={null} onChange={vi.fn()} />
      </I18nProvider>,
    );
    const updated = [
      makeEntry({}),
      makeEntry({
        id: "acct-b",
        isDefault: false,
        isActive: false,
        account: { type: "chatgpt", email: "b@example.com", planType: "pro" },
      }),
    ];
    vi.mocked(api.getCodexAccounts).mockResolvedValue({
      accounts: updated,
      error: null,
    });
    await act(async () => {
      await getCodexAccountsStore().refresh();
    });
    await act(async () => {
      resolveLoad({ accounts: [makeEntry({})], error: null });
    });
    expect(screen.getByText("b@example.com")).toBeTruthy();
  });

  it("reserves the known account count while a shared initial read is pending", async () => {
    updateNewSessionLayout({ codexAccountCount: 3 });
    let resolveLoad!: (
      response: Awaited<ReturnType<typeof api.getCodexAccounts>>,
    ) => void;
    vi.spyOn(api, "getCodexAccounts").mockReturnValue(
      new Promise((resolve) => {
        resolveLoad = resolve;
      }),
    );
    const { container } = render(
      <I18nProvider>
        <CodexAccountSelect value={null} onChange={vi.fn()} />
        <CodexUsageCard />
      </I18nProvider>,
    );
    expect(
      container.querySelectorAll(".new-session-account-skeleton"),
    ).toHaveLength(3);
    expect(
      screen.getByRole("status", { name: "Loading session options…" }),
    ).toBeTruthy();
    expect(api.getCodexAccounts).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveLoad({ accounts: [makeEntry({})], error: null });
    });
    expect(
      container.querySelectorAll(".new-session-account-skeleton"),
    ).toHaveLength(0);
  });

  it("keeps cached accounts during a failed revalidation without resetting selection", async () => {
    const accounts = [
      makeEntry({}),
      makeEntry({
        id: "acct-b",
        isDefault: false,
        isActive: false,
        account: { type: "chatgpt", email: "b@example.com", planType: "pro" },
      }),
    ];
    renderSelect(accounts);
    await screen.findByText("b@example.com");
    cleanup();
    let rejectLoad!: (error: Error) => void;
    vi.mocked(api.getCodexAccounts).mockReturnValue(
      new Promise((_, reject) => {
        rejectLoad = reject;
      }),
    );
    const onChange = vi.fn();
    const { container } = render(
      <I18nProvider>
        <CodexAccountSelect value="acct-b" onChange={onChange} />
      </I18nProvider>,
    );
    expect(screen.getByText("b@example.com")).toBeTruthy();
    expect(
      container.querySelectorAll(".new-session-account-skeleton"),
    ).toHaveLength(0);
    await act(async () => {
      rejectLoad(new Error("Offline"));
    });
    expect(screen.getByText("b@example.com")).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("isolates live snapshots and layout hints when switching servers", async () => {
    renderSelect([
      makeEntry({}),
      makeEntry({ id: "acct-b", isDefault: false, isActive: false }),
    ]);
    await waitFor(() =>
      expect(screen.getAllByText("a@example.com")).toHaveLength(2),
    );
    cleanup();
    setCurrentInstallId("other-codex-server");
    vi.mocked(api.getCodexAccounts).mockReturnValue(new Promise(() => {}));
    render(
      <I18nProvider>
        <CodexAccountSelect value={null} onChange={vi.fn()} />
      </I18nProvider>,
    );
    expect(screen.queryByText("a@example.com")).toBeNull();
    expect(
      screen.getByRole("status", { name: "Loading session options…" }),
    ).toBeTruthy();
  });
});

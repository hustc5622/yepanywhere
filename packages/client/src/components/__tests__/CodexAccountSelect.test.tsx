import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CodexAccountEntry, api } from "../../api/client";
import { I18nProvider } from "../../i18n";
import { CODEX_ACCOUNTS_UPDATED } from "../../lib/codexAccounts";
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
    act(() => {
      window.dispatchEvent(
        new CustomEvent(CODEX_ACCOUNTS_UPDATED, { detail: updated }),
      );
    });
    await act(async () => {
      resolveLoad({ accounts: [makeEntry({})], error: null });
    });
    expect(screen.getByText("b@example.com")).toBeTruthy();
  });
});

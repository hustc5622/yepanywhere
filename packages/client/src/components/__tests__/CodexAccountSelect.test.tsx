import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CodexAccountEntry, api } from "../../api/client";
import { I18nProvider } from "../../i18n";
import { CodexAccountSelect } from "../CodexAccountSelect";

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
});

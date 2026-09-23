import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CodexAccountEntry,
  type CodexUsageResetCredit,
  api,
} from "../../api/client";
import { I18nProvider } from "../../i18n";
import { CodexResetCredits } from "../CodexResetCredits";

const credit: CodexUsageResetCredit = {
  id: "credit-1",
  status: "available",
  resetType: "codexRateLimits",
  expiresAt: 4_000_000_000,
  title: "Full reset",
  description: "Gift",
};

function show(credits: CodexUsageResetCredit[] | null = [credit], count = 1) {
  const onRefresh = vi.fn().mockResolvedValue(undefined);
  const entry: CodexAccountEntry = {
    id: "acct-2",
    label: null,
    codexHome: "/test/account",
    isDefault: false,
    isActive: false,
    account: { type: "chatgpt", email: "second@example.com", planType: "pro" },
    error: null,
    login: null,
    usage: {
      primary: null,
      secondary: null,
      planType: "pro",
      additionalBuckets: [],
      updatedAt: "",
      resetCredits: { availableCount: count, credits },
    },
  };
  render(
    <I18nProvider>
      <CodexResetCredits
        entry={entry}
        busy={false}
        onBusyChange={vi.fn()}
        onRefresh={onRefresh}
      />
    </I18nProvider>,
  );
  return { onRefresh };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("CodexResetCredits", () => {
  it("shows an expiry date and never consumes a credit when opening or cancelling", () => {
    const reset = vi.spyOn(api, "resetCodexAccountUsage");
    show();
    expect(screen.getByText(/Expires .*2096/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reset usage" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/second@example.com/)).toBeTruthy();
    expect(reset).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(reset).not.toHaveBeenCalled();
  });

  it("sends only after confirmation, blocks double clicks, and refreshes after success", async () => {
    let finish!: (value: { outcome: "reset" }) => void;
    const reset = vi.spyOn(api, "resetCodexAccountUsage").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { onRefresh } = show();
    fireEvent.click(screen.getByRole("button", { name: "Reset usage" }));
    const confirm = screen.getByRole("button", { name: "Use 1 reset credit" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(reset).toHaveBeenCalledTimes(1);
    expect(reset).toHaveBeenCalledWith("acct-2", {
      confirmed: true,
      creditId: "credit-1",
      idempotencyKey: expect.any(String),
    });
    finish({ outcome: "reset" });
    await waitFor(() => expect(onRefresh).toHaveBeenCalledOnce());
    expect(screen.getByText("Usage limits reset.")).toBeTruthy();
  });

  it("reuses the idempotency key after an uncertain failure and reopening", async () => {
    const reset = vi
      .spyOn(api, "resetCodexAccountUsage")
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce({ outcome: "alreadyRedeemed" });
    show();
    fireEvent.click(screen.getByRole("button", { name: "Reset usage" }));
    fireEvent.click(screen.getByRole("button", { name: "Use 1 reset credit" }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset usage" }));
    fireEvent.click(screen.getByRole("button", { name: "Use 1 reset credit" }));
    await screen.findByText(/This request already completed/);
    expect(reset.mock.calls[1]).toEqual(reset.mock.calls[0]);
  });

  it("distinguishes missing details from a non-expiring credit", () => {
    show(null);
    expect(screen.getByText("Expiration unavailable")).toBeTruthy();
    expect(screen.queryByText("Does not expire")).toBeNull();
    cleanup();
    show([{ ...credit, expiresAt: null }]);
    expect(screen.getByText(/Does not expire/)).toBeTruthy();
  });

  it("orders by expiry, filters redeemed credits, and disables expired credits", () => {
    show(
      [
        { ...credit, id: "forever", title: "Forever", expiresAt: null },
        { ...credit, id: "used", title: "Used", status: "redeemed" },
        { ...credit, id: "expired", title: "Old", expiresAt: 1 },
      ],
      2,
    );
    const options = screen.getAllByRole("option") as HTMLOptionElement[];
    expect(options.map((option) => option.value)).toEqual([
      "expired",
      "forever",
    ]);
    expect(options[0]?.disabled).toBe(true);
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe(
      "forever",
    );
    expect(
      (screen.getByRole("button", { name: "Reset usage" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(screen.queryByText(/Used/)).toBeNull();
  });

  it("confirms and resets the selected credit without consuming it on selection", async () => {
    const reset = vi
      .spyOn(api, "resetCodexAccountUsage")
      .mockResolvedValue({ outcome: "reset" });
    show(
      [
        credit,
        { ...credit, id: "later", expiresAt: null, title: "Later reset" },
      ],
      2,
    );
    const select = screen.getByRole("combobox", {
      name: "Reset credit to use",
    });
    expect((select as HTMLSelectElement).value).toBe("credit-1");
    expect(screen.getAllByRole("button", { name: "Reset usage" })).toHaveLength(
      1,
    );
    fireEvent.change(select, { target: { value: "later" } });
    expect(reset).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Reset usage" }));
    expect(
      within(screen.getByRole("dialog")).getByText("Does not expire"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Use 1 reset credit" }));
    await screen.findByText("Usage limits reset.");
    expect(reset).toHaveBeenCalledWith("acct-2", {
      confirmed: true,
      creditId: "later",
      idempotencyKey: expect.any(String),
    });
  });

  it("disables reset when every credit is expired", () => {
    show([{ ...credit, expiresAt: 1 }]);
    expect(
      (screen.getByRole("button", { name: "Reset usage" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("has no reset action when there are no credits", () => {
    show([], 0);
    expect(screen.queryByRole("button", { name: "Reset usage" })).toBeNull();
  });
});

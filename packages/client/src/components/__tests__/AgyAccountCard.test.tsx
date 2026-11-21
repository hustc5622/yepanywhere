import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { I18nProvider } from "../../i18n";
import { AgyAccountCard } from "../AgyAccountCard";

const AUTH_URL = "https://accounts.google.com/o/oauth2/auth?client_id=x";
const pending = {
  status: "pending" as const,
  authUrl: AUTH_URL,
  error: null,
  startedAt: "2026-11-21T10:00:00Z",
};

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(api, "getAgyAccount").mockResolvedValue({
    installed: true,
    authenticated: false,
    agyPath: "/h/.local/bin/agy",
    login: null,
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const renderCard = (onRefresh = vi.fn()) => {
  render(
    <I18nProvider>
      <AgyAccountCard onRefresh={onRefresh} />
    </I18nProvider>,
  );
  return onRefresh;
};

describe("AgyAccountCard", () => {
  it("walks through link → code → signed in", async () => {
    vi.spyOn(api, "startAgyLogin").mockResolvedValue({
      login: pending,
      error: null,
    });
    const submit = vi.spyOn(api, "submitAgyLoginCode").mockResolvedValue({
      login: { ...pending, status: "completed", authUrl: null },
      error: null,
    });
    const onRefresh = renderCard();

    await screen.findByText("Not signed in");
    fireEvent.click(
      screen.getByRole("button", { name: "Sign in with Google" }),
    );

    const link = await screen.findByRole("link", {
      name: "Open Google sign-in",
    });
    expect(link.getAttribute("href")).toBe(AUTH_URL);

    fireEvent.change(
      screen.getByPlaceholderText("Authorization code or page URL"),
      { target: { value: "  4/0Abc  " } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await screen.findByText(
      "Signed in. New Antigravity sessions use this account.",
    );
    expect(submit).toHaveBeenCalledWith("4/0Abc");
    await waitFor(() => expect(onRefresh).toHaveBeenCalled());
  });

  it("shows agy's error and lets the user retry", async () => {
    vi.spyOn(api, "startAgyLogin").mockResolvedValue({
      login: pending,
      error: null,
    });
    vi.spyOn(api, "submitAgyLoginCode").mockResolvedValue({
      login: {
        ...pending,
        status: "failed",
        authUrl: null,
        error: "couldn't log in: Malformed auth code.",
      },
      error: null,
    });
    renderCard();
    fireEvent.click(
      await screen.findByRole("button", { name: "Sign in with Google" }),
    );
    fireEvent.change(
      await screen.findByPlaceholderText("Authorization code or page URL"),
      { target: { value: "bad" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await screen.findByText(
      "Sign-in failed: couldn't log in: Malformed auth code.",
    );
    expect(
      screen.getByRole("button", { name: "Sign in with Google" }),
    ).toBeTruthy();
  });

  it("offers sign-out only when signed in and asks first", async () => {
    vi.mocked(api.getAgyAccount).mockResolvedValue({
      installed: true,
      authenticated: true,
      agyPath: "/h/.local/bin/agy",
      login: null,
    });
    const logout = vi.spyOn(api, "logoutAgy").mockResolvedValue({ ok: true });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    expect(confirm).toHaveBeenCalled();
    expect(logout).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Sign in again" })).toBeTruthy();
  });

  it("explains how to install a missing CLI", async () => {
    vi.mocked(api.getAgyAccount).mockResolvedValue({
      installed: false,
      authenticated: false,
      agyPath: null,
      login: null,
    });
    renderCard();
    await screen.findByText(
      "curl -fsSL https://antigravity.google/cli/install.sh | bash",
    );
    expect(screen.queryByRole("button", { name: "Sign in with Google" })).toBe(
      null,
    );
  });
});

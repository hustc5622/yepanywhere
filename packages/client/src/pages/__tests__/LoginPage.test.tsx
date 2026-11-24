import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import {
  LoginPage,
  resolvePostLoginRedirect,
  sanitizeExternalRedirect,
} from "../LoginPage";

const { loginMock } = vi.hoisted(() => ({ loginMock: vi.fn() }));

vi.mock("../../contexts/AuthContext", () => ({
  useAuth: () => ({
    isSetupMode: false,
    login: loginMock,
    redeemPairing: vi.fn(),
    setupAccount: vi.fn(),
    isLoading: false,
    authEnabled: true,
    authDisabledByEnv: false,
    isAuthenticated: false,
  }),
}));

vi.mock("../../hooks/useHideSplashOnReady", () => ({
  useHideSplashOnReady: () => {},
}));

vi.mock("../../components/YepAnywhereLogo", () => ({
  YepAnywhereLogo: () => null,
}));

/** Mirrors the ApiError shape the API client throws for 401/429. */
function authError(fields: Record<string, unknown>): Error {
  return Object.assign(new Error("auth failed"), fields);
}

function renderLogin() {
  render(
    <I18nProvider>
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>
    </I18nProvider>,
  );
}

async function submitPassword(password: string) {
  fireEvent.change(screen.getByLabelText("Password"), {
    target: { value: password },
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /login|locked/i }));
  });
}

describe("LoginPage rate limit feedback", () => {
  afterEach(() => {
    loginMock.mockReset();
    vi.useRealTimers();
  });

  it("says how many attempts are left and what the next lockout costs", async () => {
    loginMock.mockRejectedValue(
      authError({
        status: 401,
        attemptsRemaining: 2,
        nextLockoutSec: 60,
        nextTier: "soft",
      }),
    );

    renderLogin();
    await submitPassword("wrong-password");

    expect(screen.getByText("Invalid password")).toBeTruthy();
    expect(
      screen.getByText("2 more failed attempts will lock sign-in for 1 min."),
    ).toBeTruthy();
  });

  it("uses the singular wording on the last attempt", async () => {
    loginMock.mockRejectedValue(
      authError({
        status: 401,
        attemptsRemaining: 1,
        nextLockoutSec: 60,
        nextTier: "soft",
      }),
    );

    renderLogin();
    await submitPassword("wrong-password");

    expect(
      screen.getByText("1 more failed attempt will lock sign-in for 1 min."),
    ).toBeTruthy();
  });

  it("states the lockout duration and disables the form while locked", async () => {
    loginMock.mockRejectedValue(
      authError({
        status: 429,
        retryAfterSec: 45,
        lockoutSec: 900,
        tier: "hard",
      }),
    );

    renderLogin();
    await submitPassword("wrong-password");

    expect(screen.getByText("Sign-in temporarily locked")).toBeTruthy();
    expect(
      screen.getByText(
        "Too many failed attempts, so sign-in is locked for 15 min. You can try again in 0:45.",
      ),
    ).toBeTruthy();

    const submit = screen.getByRole("button", { name: "Locked · 0:45" });
    expect(submit).toHaveProperty("disabled", true);
    expect(screen.getByLabelText("Password")).toHaveProperty("disabled", true);
  });

  it("counts the lockout down and unlocks when it expires", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    loginMock.mockRejectedValue(
      authError({
        status: 429,
        retryAfterSec: 2,
        lockoutSec: 2,
        tier: "soft",
      }),
    );

    renderLogin();
    await submitPassword("wrong-password");

    expect(screen.getByRole("button", { name: "Locked · 0:02" })).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByRole("button", { name: "Locked · 0:01" })).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(1500);
    });
    expect(screen.queryByText("Sign-in temporarily locked")).toBeNull();
    expect(screen.getByRole("button", { name: "Login" })).toHaveProperty(
      "disabled",
      false,
    );
  });
});

describe("LoginPage external redirect resolution", () => {
  it("accepts safe same-origin paths and rejects protocol-relative or external URLs", () => {
    expect(sanitizeExternalRedirect("/")).toBe("/");
    expect(sanitizeExternalRedirect("/?from=gate")).toBe("/?from=gate");
    expect(sanitizeExternalRedirect("//evil.example")).toBeNull();
    expect(sanitizeExternalRedirect("https://evil.example")).toBeNull();
    expect(sanitizeExternalRedirect("/\\evil.example")).toBeNull();
  });

  it("uses full navigation when redirect target is outside APP_BASE", () => {
    expect(resolvePostLoginRedirect("/", "/yep", "/projects")).toEqual({
      mode: "full",
      target: "/",
    });
    expect(
      resolvePostLoginRedirect("/yep/sessions", "/yep", "/projects"),
    ).toEqual({
      mode: "spa",
      target: "/sessions",
    });
    expect(resolvePostLoginRedirect("/yep", "/yep", "/projects")).toEqual({
      mode: "spa",
      target: "/projects",
    });
    expect(resolvePostLoginRedirect(null, "/yep", "/sessions/123")).toEqual({
      mode: "spa",
      target: "/sessions/123",
    });
  });
});

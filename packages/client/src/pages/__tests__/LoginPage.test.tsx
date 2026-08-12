import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LoginPage } from "../LoginPage";

const { auth, navigate } = vi.hoisted(() => ({
  auth: {
    isLoading: false,
    authEnabled: true,
    localManagementAllowed: false,
    login: vi.fn(),
  },
  navigate: vi.fn(),
}));

const strings: Record<string, string> = {
  loginSubtitle: "Enter your password to continue",
  loginPasswordLabel: "Password",
  loginPasswordPlaceholder: "Enter password",
  loginSubmitPending: "Please wait...",
  loginSubmit: "Login",
  loginErrorPasswordRequired: "Password is required",
  loginErrorAuthFailed: "Authentication failed",
  loginErrorInvalidPassword: "Login password is incorrect.",
  loginErrorInvalidPasswordOrAdmin:
    "Login or administrator password is incorrect.",
  loginAdminRecoveryHint:
    "Forgot the login password? On the server computer, use the administrator password to sign in and change it in Local Access settings.",
};

function containingForm(element: HTMLElement): HTMLFormElement {
  const form = element.closest("form");
  expect(form).not.toBeNull();
  return form as HTMLFormElement;
}

vi.mock("../../contexts/AuthContext", () => ({ useAuth: () => auth }));
vi.mock("../../i18n", () => ({
  useI18n: () => ({ t: (key: string) => strings[key] ?? key }),
}));
vi.mock("../../hooks/useHideSplashOnReady", () => ({
  useHideSplashOnReady: vi.fn(),
}));
vi.mock("../../components/YepAnywhereLogo", () => ({
  YepAnywhereLogo: () => <div aria-label="Yep Anywhere" />,
}));
vi.mock("react-router-dom", async (importOriginal) => {
  const original = await importOriginal<typeof import("react-router-dom")>();
  return {
    ...original,
    useNavigate: () => navigate,
    useLocation: () => ({ pathname: "/login", state: null }),
  };
});

describe("LoginPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.isLoading = false;
    auth.authEnabled = true;
    auth.localManagementAllowed = false;
    auth.login.mockResolvedValue(undefined);
  });

  it("renders one ordinary-password form remotely with no setup mode", () => {
    render(<LoginPage />);

    expect(screen.getAllByLabelText("Password")).toHaveLength(1);
    expect(screen.queryByText(/confirm/i)).toBeNull();
    expect(screen.queryByText(/administrator password/i)).toBeNull();
    expect(screen.getByText("Enter your password to continue")).toBeDefined();
  });

  it("shows the administrator recovery hint only for local management", () => {
    auth.localManagementAllowed = true;

    render(<LoginPage />);

    expect(
      screen.getByText(strings.loginAdminRecoveryHint ?? "missing translation"),
    ).toBeDefined();
  });

  it.each([
    [false, "Login password is incorrect."],
    [true, "Login or administrator password is incorrect."],
  ])("maps AUTH_LOGIN_INVALID safely when local=%s", async (local, message) => {
    auth.localManagementAllowed = local;
    auth.login.mockRejectedValue(
      Object.assign(new Error("unsafe backend text"), {
        code: "AUTH_LOGIN_INVALID",
      }),
    );
    render(<LoginPage />);
    const input = screen.getByLabelText("Password") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "submitted-secret" } });
    fireEvent.submit(containingForm(input));

    await waitFor(() => expect(screen.getByText(message)).toBeDefined());
    expect(input.value).toBe("");
    expect(screen.queryByText("unsafe backend text")).toBeNull();
  });

  it("uses a stable safe fallback for unknown login errors", async () => {
    auth.login.mockRejectedValue(new Error("unsafe backend text"));
    render(<LoginPage />);
    const input = screen.getByLabelText("Password") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "submitted-secret" } });
    fireEvent.submit(containingForm(input));

    await waitFor(() =>
      expect(screen.getByText("Authentication failed")).toBeDefined(),
    );
    expect(input.value).toBe("");
    expect(screen.queryByText("unsafe backend text")).toBeNull();
  });

  it("clears the password after successful login", async () => {
    render(<LoginPage />);
    const input = screen.getByLabelText("Password") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "submitted-secret" } });
    fireEvent.submit(containingForm(input));

    await waitFor(() =>
      expect(auth.login).toHaveBeenCalledWith("submitted-secret"),
    );
    expect(input.value).toBe("");
  });
});

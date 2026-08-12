import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContextValue } from "../../../contexts/AuthContext";
import { LocalAccessAuthCard } from "../LocalAccessAuthCard";
import { LocalAccessSettings } from "../LocalAccessSettings";

const mocks = vi.hoisted(() => ({
  updateBinding: vi.fn(),
  updateServerSettings: vi.fn(),
  setLocalhostOpen: vi.fn(),
  enableAuth: vi.fn(),
  changePassword: vi.fn(),
  disableAuth: vi.fn(),
  auth: null as unknown as AuthContextValue,
}));

const strings: Record<string, string> = {
  settingsLocalAccessTitle: "Local Access",
  localAccessDescription: "Control local network access.",
  localAccessStatusTitle: "Status",
  localAccessListeningOn: "Listening on",
  localAccessUnableToFetch: "Unable to fetch server info",
  localAccessListeningPortTitle: "Listening Port",
  localAccessListeningPortDescription: "Port used for access",
  localAccessNetworkTitle: "Local Network Access",
  localAccessNetworkDescription: "Allow network access",
  localAccessAllowedHostsTitle: "Allowed Hostnames",
  localAccessAllowedHostsDescription: "Allowed hosts",
  localAccessModeCustom: "Custom Hostnames",
  localAccessModeCustomDescription: "Only listed hosts",
  localAccessModeAllowAll: "Allow All Hostnames",
  localAccessModeAllowAllDescription: "Any hostname",
  localAccessLocalhostOpenTitle: "Allow Localhost Access",
  localAccessLocalhostOpenDescription: "Allow local browser access",
  localAccessApply: "Apply Changes",
  localAccessApplying: "Applying...",
  localAccessPasswordManagementTitle: "Password login",
  localAccessPasswordManagementLocalOnly:
    "Password management is available only from localhost on the server computer.",
  localAccessRequirePasswordDescription:
    "Require a password to access this server",
  localAccessAdminPasswordLabel: "Administrator password",
  localAccessEnablePassword: "Enable password login",
  localAccessChangePassword: "Change login password",
  localAccessDisablePassword: "Disable password login",
  localAccessPasswordTitle: "Password",
  localAccessPasswordNewPlaceholder: "New password",
  localAccessConfirmPasswordTitle: "Confirm Password",
  localAccessErrorPasswordMismatch: "Passwords do not match",
  authErrorAdminNotConfigured:
    "Set the administrator password first with: pnpm yep setup-admin-password",
  authErrorAdminInvalid: "Administrator password is incorrect.",
  authErrorLoginInvalid: "Login password is incorrect.",
  authErrorLocalRequired:
    "This operation is available only from localhost on the server computer.",
  authErrorPasswordInvalid: "Passwords must contain at least 6 characters.",
  authErrorConfig:
    "Authentication configuration could not be read or saved safely.",
};

function containingForm(element: HTMLElement): HTMLFormElement {
  const form = element.closest("form");
  expect(form).not.toBeNull();
  return form as HTMLFormElement;
}

vi.mock("../../../i18n", () => ({
  useI18n: () => ({ t: (key: string) => strings[key] ?? key }),
}));
vi.mock("../../../contexts/AuthContext", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../../contexts/AuthContext")>();
  return { ...original, useOptionalAuth: () => mocks.auth };
});
vi.mock("../../../hooks/useServerInfo", () => ({
  useServerInfo: () => ({
    serverInfo: { host: "127.0.0.1", port: 8022, localhostOnly: true },
    loading: false,
  }),
}));
vi.mock("../../../hooks/useNetworkBinding", () => ({
  useNetworkBinding: () => ({
    binding: {
      localhost: { port: 8022, overriddenByCli: false },
      network: { enabled: false, host: undefined, overriddenByCli: false },
      interfaces: [],
    },
    loading: false,
    error: null,
    applying: false,
    updateBinding: mocks.updateBinding,
  }),
}));
vi.mock("../../../hooks/useServerSettings", () => ({
  useServerSettings: () => ({
    settings: { allowedHosts: "" },
    isLoading: false,
  }),
}));
vi.mock("../../../hooks/useMobileShellChannel", () => ({
  MOBILE_SHELL_NODES: [],
  formatMobileShellNodeLabel: vi.fn(),
  formatMobileShellNodeOrigin: vi.fn(),
  useMobileShellChannel: () => ({ isMobileShell: false }),
}));
vi.mock("../../../api/client", () => ({
  api: { updateServerSettings: mocks.updateServerSettings },
}));
vi.mock("../../../components/AllowedHostsManager", () => ({
  AllowedHostsManager: () => <div />,
}));
vi.mock("../../../components/FilterDropdown", () => ({
  FilterDropdown: () => <div />,
}));

function makeAuth(overrides: Partial<AuthContextValue> = {}): AuthContextValue {
  return {
    isAuthenticated: true,
    isLoading: false,
    authEnabled: false,
    hasDesktopToken: false,
    localhostOpen: false,
    localManagementAllowed: true,
    login: vi.fn(),
    logout: vi.fn(),
    enableAuth: mocks.enableAuth,
    disableAuth: mocks.disableAuth,
    changePassword: mocks.changePassword,
    setLocalhostOpen: mocks.setLocalhostOpen,
    checkAuth: vi.fn(),
    ...overrides,
  };
}

describe("LocalAccessAuthCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.enableAuth.mockResolvedValue(undefined);
    mocks.changePassword.mockResolvedValue(undefined);
    mocks.disableAuth.mockResolvedValue(undefined);
  });

  afterEach(() => vi.clearAllMocks());

  it("shows status and no administrator input for remote mode", () => {
    render(
      <LocalAccessAuthCard
        auth={makeAuth({ localManagementAllowed: false, authEnabled: true })}
      />,
    );

    expect(screen.getByText("Password login")).toBeDefined();
    expect(
      screen.getByText(
        strings.localAccessPasswordManagementLocalOnly ?? "missing translation",
      ),
    ).toBeDefined();
    const status = screen.getByRole("checkbox", {
      name: "Require a password to access this server",
    }) as HTMLInputElement;
    expect(status.checked).toBe(true);
    expect(status.disabled).toBe(true);
    expect(screen.queryByLabelText("Administrator password")).toBeNull();
  });

  it("shows the disabled password status remotely", () => {
    render(
      <LocalAccessAuthCard
        auth={makeAuth({ localManagementAllowed: false, authEnabled: false })}
      />,
    );

    const status = screen.getByRole("checkbox", {
      name: "Require a password to access this server",
    }) as HTMLInputElement;
    expect(status.checked).toBe(false);
    expect(status.disabled).toBe(true);
  });

  it("enables login with only admin, new, and confirmation fields", async () => {
    render(<LocalAccessAuthCard auth={makeAuth()} />);

    const admin = screen.getByLabelText(
      "Administrator password",
    ) as HTMLInputElement;
    const password = screen.getByLabelText("Password") as HTMLInputElement;
    const confirmation = screen.getByLabelText(
      "Confirm Password",
    ) as HTMLInputElement;
    expect([admin.type, password.type, confirmation.type]).toEqual([
      "password",
      "password",
      "password",
    ]);

    fireEvent.change(admin, { target: { value: "admin-password" } });
    fireEvent.change(password, { target: { value: "login-password" } });
    fireEvent.change(confirmation, { target: { value: "different-password" } });
    fireEvent.submit(containingForm(admin));
    expect(screen.getByText("Passwords do not match")).toBeDefined();
    expect(mocks.enableAuth).not.toHaveBeenCalled();
    expect(admin.value).toBe("");
    expect(password.value).toBe("");
    expect(confirmation.value).toBe("");

    fireEvent.change(admin, { target: { value: "admin-password" } });
    fireEvent.change(password, { target: { value: "login-password" } });
    fireEvent.change(confirmation, { target: { value: "login-password" } });
    fireEvent.submit(containingForm(admin));
    await waitFor(() =>
      expect(mocks.enableAuth).toHaveBeenCalledWith(
        "admin-password",
        "login-password",
      ),
    );
    expect(admin.value).toBe("");
    expect(password.value).toBe("");
    expect(confirmation.value).toBe("");
  });

  it("renders separate change and disable controls and clears rejected secrets", async () => {
    mocks.changePassword.mockRejectedValue(
      Object.assign(new Error("unsafe"), { code: "AUTH_ADMIN_NOT_CONFIGURED" }),
    );
    render(<LocalAccessAuthCard auth={makeAuth({ authEnabled: true })} />);

    expect(
      screen.getByRole("button", { name: "Change login password" }),
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Disable password login" }),
    ).toBeDefined();
    fireEvent.click(
      screen.getByRole("button", { name: "Change login password" }),
    );
    const admin = screen.getByLabelText(
      "Administrator password",
    ) as HTMLInputElement;
    const password = screen.getByLabelText("Password") as HTMLInputElement;
    const confirmation = screen.getByLabelText(
      "Confirm Password",
    ) as HTMLInputElement;
    fireEvent.change(admin, { target: { value: "admin-password" } });
    fireEvent.change(password, { target: { value: "next-password" } });
    fireEvent.change(confirmation, { target: { value: "next-password" } });
    fireEvent.submit(containingForm(admin));

    await waitFor(() =>
      expect(
        screen.getByText(
          strings.authErrorAdminNotConfigured ?? "missing translation",
        ),
      ).toBeDefined(),
    );
    expect(admin.value).toBe("");
    expect(password.value).toBe("");
    expect(confirmation.value).toBe("");
  });

  it("disables sensitive inputs while submitting and clears them on cancel", async () => {
    let resolveChange: (() => void) | undefined;
    mocks.changePassword.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveChange = resolve;
        }),
    );
    render(<LocalAccessAuthCard auth={makeAuth({ authEnabled: true })} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Change login password" }),
    );
    const admin = screen.getByLabelText(
      "Administrator password",
    ) as HTMLInputElement;
    const password = screen.getByLabelText("Password") as HTMLInputElement;
    const confirmation = screen.getByLabelText(
      "Confirm Password",
    ) as HTMLInputElement;
    fireEvent.change(admin, { target: { value: "admin-password" } });
    fireEvent.change(password, { target: { value: "next-password" } });
    fireEvent.change(confirmation, { target: { value: "next-password" } });
    fireEvent.submit(containingForm(admin));

    await waitFor(() => expect(admin.disabled).toBe(true));
    expect(password.disabled).toBe(true);
    expect(confirmation.disabled).toBe(true);
    resolveChange?.();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Change login password" }),
      ).toBeDefined(),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Change login password" }),
    );
    const nextAdmin = screen.getByLabelText(
      "Administrator password",
    ) as HTMLInputElement;
    fireEvent.change(nextAdmin, { target: { value: "cancelled-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "actionCancel" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Change login password" }),
    );
    expect(
      (screen.getByLabelText("Administrator password") as HTMLInputElement)
        .value,
    ).toBe("");
  });

  it("disables password login with only the administrator password", async () => {
    render(<LocalAccessAuthCard auth={makeAuth({ authEnabled: true })} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Disable password login" }),
    );
    const admin = screen.getByLabelText(
      "Administrator password",
    ) as HTMLInputElement;
    expect(screen.queryByLabelText("Password")).toBeNull();
    fireEvent.change(admin, { target: { value: "admin-password" } });
    fireEvent.submit(containingForm(admin));

    await waitFor(() =>
      expect(mocks.disableAuth).toHaveBeenCalledWith("admin-password"),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Disable password login" }),
    );
    expect(
      (screen.getByLabelText("Administrator password") as HTMLInputElement)
        .value,
    ).toBe("");
  });

  it.each([
    ["AUTH_ADMIN_INVALID", "Administrator password is incorrect."],
    ["AUTH_LOGIN_INVALID", "Login password is incorrect."],
    [
      "AUTH_LOCAL_REQUIRED",
      "This operation is available only from localhost on the server computer.",
    ],
    ["AUTH_PASSWORD_INVALID", "Passwords must contain at least 6 characters."],
    [
      "AUTH_CONFIG_ERROR",
      "Authentication configuration could not be read or saved safely.",
    ],
  ])("maps %s to a stable safe message", async (code, message) => {
    mocks.enableAuth.mockRejectedValue(
      Object.assign(new Error("unsafe"), { code }),
    );
    render(<LocalAccessAuthCard auth={makeAuth()} />);
    const admin = screen.getByLabelText("Administrator password");
    fireEvent.change(admin, { target: { value: "admin-password" } });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "login-password" },
    });
    fireEvent.change(screen.getByLabelText("Confirm Password"), {
      target: { value: "login-password" },
    });
    fireEvent.submit(containingForm(admin));

    await waitFor(() => expect(screen.getByText(message)).toBeDefined());
    expect(screen.queryByText("unsafe")).toBeNull();
  });

  it("uses a stable safe fallback for unknown password errors", async () => {
    mocks.enableAuth.mockRejectedValue(new Error("unsafe backend text"));
    render(<LocalAccessAuthCard auth={makeAuth()} />);
    const admin = screen.getByLabelText("Administrator password");
    fireEvent.change(admin, { target: { value: "admin-password" } });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "login-password" },
    });
    fireEvent.change(screen.getByLabelText("Confirm Password"), {
      target: { value: "login-password" },
    });
    fireEvent.submit(containingForm(admin));

    await waitFor(() =>
      expect(
        screen.getByText(
          strings.authErrorConfig ?? "missing authentication error",
        ),
      ).toBeDefined(),
    );
    expect(screen.queryByText("unsafe backend text")).toBeNull();
  });
});

describe("LocalAccessSettings integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth = makeAuth();
    mocks.updateBinding.mockResolvedValue({});
    mocks.updateServerSettings.mockResolvedValue({ settings: {} });
  });

  it("renders password management inside the existing Local Access page", () => {
    render(<LocalAccessSettings />);

    expect(screen.getByRole("heading", { name: "Local Access" })).toBeDefined();
    expect(screen.getByText("Password login")).toBeDefined();
  });

  it("never includes password fields in network, host, or localhost saves", async () => {
    render(<LocalAccessSettings />);
    fireEvent.change(screen.getByRole("spinbutton"), {
      target: { value: "8023" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply Changes" }));

    await waitFor(() => expect(mocks.updateBinding).toHaveBeenCalled());
    const saves = JSON.stringify({
      binding: mocks.updateBinding.mock.calls,
      settings: mocks.updateServerSettings.mock.calls,
      localhost: mocks.setLocalhostOpen.mock.calls,
    });
    expect(saves).not.toMatch(
      /adminPassword|newPassword|confirmPassword|login-password/,
    );
  });
});

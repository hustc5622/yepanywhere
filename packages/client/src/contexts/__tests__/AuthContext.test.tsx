import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "../AuthContext";

const {
  getAuthStatus,
  enableAuth,
  changePassword,
  disableAuth,
  login,
  logout,
  setLocalhostAccess,
} = vi.hoisted(() => ({
  getAuthStatus: vi.fn(),
  enableAuth: vi.fn(),
  changePassword: vi.fn(),
  disableAuth: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  setLocalhostAccess: vi.fn(),
}));

vi.mock("../../api/client", () => ({
  api: {
    getAuthStatus,
    enableAuth,
    changePassword,
    disableAuth,
    login,
    logout,
    setLocalhostAccess,
  },
}));

vi.mock("../../lib/authEvents", () => ({
  authEvents: {
    onLoginRequired: vi.fn(() => () => undefined),
    clearLoginRequired: vi.fn(),
  },
}));

let latestContext: ReturnType<typeof useAuth>;

function Consumer() {
  latestContext = useAuth();
  const location = useLocation();
  return (
    <pre data-testid="state">
      {JSON.stringify({
        path: location.pathname,
        authenticated: latestContext.isAuthenticated,
        enabled: latestContext.authEnabled,
        localManagementAllowed: latestContext.localManagementAllowed,
        keys: Object.keys(latestContext).sort(),
      })}
    </pre>
  );
}

describe("AuthProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAuthStatus.mockResolvedValue({
      enabled: false,
      authenticated: true,
      hasDesktopToken: true,
      localhostOpen: false,
      localManagementAllowed: true,
    });
    enableAuth.mockResolvedValue({ success: true });
    changePassword.mockResolvedValue({ success: true });
    disableAuth.mockResolvedValue({ success: true });
  });

  function mount() {
    return render(
      <MemoryRouter initialEntries={["/settings/local-access"]}>
        <AuthProvider>
          <Consumer />
        </AuthProvider>
      </MemoryRouter>,
    );
  }

  it("propagates only the approved status and context surface", async () => {
    mount();

    await waitFor(() =>
      expect(
        JSON.parse(screen.getByTestId("state").textContent ?? "{}"),
      ).toMatchObject({
        authenticated: true,
        enabled: false,
        localManagementAllowed: true,
      }),
    );
    const state = JSON.parse(screen.getByTestId("state").textContent ?? "{}");
    expect(state.keys).not.toEqual(
      expect.arrayContaining([
        ["is", "Setup", "Mode"].join(""),
        ["auth", "Disabled", "ByEnv"].join(""),
        "authFilePath",
        ["setup", "Account"].join(""),
      ]),
    );
  });

  it.each([
    [
      "enable",
      () => latestContext.enableAuth("admin-password", "login-password"),
      enableAuth,
    ],
    [
      "change",
      () => latestContext.changePassword("admin-password", "next-password"),
      changePassword,
    ],
  ])("redirects to login after %s", async (_label, invoke, apiMethod) => {
    mount();
    await waitFor(() => expect(getAuthStatus).toHaveBeenCalled());

    await act(invoke);

    await waitFor(() =>
      expect(
        JSON.parse(screen.getByTestId("state").textContent ?? "{}").path,
      ).toBe("/login"),
    );
    expect(apiMethod).toHaveBeenCalledWith(
      "admin-password",
      expect.any(String),
    );
  });

  it("keeps the app authenticated after disable", async () => {
    mount();
    await waitFor(() => expect(getAuthStatus).toHaveBeenCalled());

    await act(() => latestContext.disableAuth("admin-password"));

    expect(disableAuth).toHaveBeenCalledWith("admin-password");
    expect(
      JSON.parse(screen.getByTestId("state").textContent ?? "{}"),
    ).toMatchObject({
      authenticated: true,
      enabled: false,
      path: "/settings/local-access",
    });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, fetchJSON } from "./client";

describe("api.updateServerSettings", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        settings: {
          serviceWorkerEnabled: true,
        },
      }),
    } as Response);

    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", "/");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("serializes undefined setting values as null so clears reach the server", async () => {
    await api.updateServerSettings({
      globalInstructions: undefined,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, request] = fetchMock.mock.calls[0] ?? [];
    expect(request?.body).toBe(JSON.stringify({ globalInstructions: null }));
  });
});

describe("fetchJSON errors", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", "/");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it("preserves structured archive block details", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      statusText: "Conflict",
      headers: new Headers(),
      json: async () => ({
        error: "This session is waiting for input.",
        code: "waiting_input",
        runtime: {
          ownership: { owner: "self", processId: "proc-1" },
          activity: "waiting-input",
          isBusy: true,
          hasResidentWorker: false,
          canArchive: false,
          archiveBlockCode: "waiting_input",
          archiveBlockReason: "This session is waiting for input.",
        },
      }),
    } as Response);

    await expect(
      fetchJSON("/sessions/session-1/metadata"),
    ).rejects.toMatchObject({
      message: "This session is waiting for input.",
      status: 409,
      code: "waiting_input",
      runtime: {
        canArchive: false,
        activity: "waiting-input",
      },
    });
  });

  it("does not read or attach the removed setup-required header", async () => {
    const removedHeader = ["X", "Setup", "Required"].join("-");
    const removedProperty = ["setup", "Required"].join("");
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      headers: new Headers({ [removedHeader]: "true" }),
      json: async () => ({ error: "Authentication required" }),
    } as Response);

    const error = await fetchJSON("/auth/login").catch((cause) => cause);

    expect(error).toMatchObject({ status: 401 });
    expect(error).not.toHaveProperty(removedProperty);
  });
});

describe("authentication API", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    } as Response);
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", "/");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it.each([
    [
      () => api.enableAuth("admin-password", "login-password"),
      "/auth/enable",
      { adminPassword: "admin-password", newPassword: "login-password" },
    ],
    [
      () => api.changePassword("admin-password", "next-password"),
      "/auth/change-password",
      { adminPassword: "admin-password", newPassword: "next-password" },
    ],
    [
      () => api.disableAuth("admin-password"),
      "/auth/disable",
      { adminPassword: "admin-password" },
    ],
  ])(
    "sends only approved password fields to %s",
    async (invoke, routePath, body) => {
      await invoke();

      const [url, options] = fetchMock.mock.calls[0] ?? [];
      expect(String(url)).toContain(routePath);
      expect(JSON.parse(String(options?.body))).toEqual(body);
    },
  );
});

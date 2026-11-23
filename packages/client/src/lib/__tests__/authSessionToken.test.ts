import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TOKEN = "f".repeat(64);
const STORAGE_KEY = "yep-anywhere-auth-session-token";

async function loadModule() {
  vi.resetModules();
  vi.stubEnv("BASE_URL", "/yep/");
  return import("../authSessionToken");
}

describe("auth session token transport", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    delete document.documentElement.dataset.mobileShell;
    window.localStorage.clear();
  });

  it("adds nothing while no token is held", async () => {
    const mod = await loadModule();
    expect(mod.getAuthSessionToken()).toBeNull();
    expect(mod.authSessionHeaders()).toEqual({});
    expect(mod.withAuthSessionQuery("/yep/api/fs/raw?path=%2Fa")).toBe(
      "/yep/api/fs/raw?path=%2Fa",
    );
  });

  it("persists the token and presents it as a bearer header", async () => {
    const mod = await loadModule();
    mod.setAuthSessionToken(TOKEN);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(TOKEN);
    expect(mod.authSessionHeaders()).toEqual({
      Authorization: `Bearer ${TOKEN}`,
    });

    // A fresh page load reads it back from storage.
    const reloaded = await loadModule();
    expect(reloaded.getAuthSessionToken()).toBe(TOKEN);

    reloaded.setAuthSessionToken(null);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(reloaded.authSessionHeaders()).toEqual({});
  });

  it("appends the query token only to same-origin API URLs", async () => {
    const mod = await loadModule();
    mod.setAuthSessionToken(TOKEN);

    expect(mod.withAuthSessionQuery("/yep/api/fs/raw?path=%2Fa")).toBe(
      `/yep/api/fs/raw?path=%2Fa&yep_auth=${TOKEN}`,
    );
    expect(
      mod.withAuthSessionQuery(`${window.location.origin}/yep/api/x#frag`),
    ).toBe(`${window.location.origin}/yep/api/x?yep_auth=${TOKEN}#frag`);

    const wsBase = `ws://${window.location.host}/yep/api/ws`;
    expect(mod.withAuthSessionQuery(wsBase)).toBe(
      `${wsBase}?yep_auth=${TOKEN}`,
    );

    for (const untouched of [
      "https://example.com/yep/api/fs/raw",
      "/yep/projects",
      "data:image/png;base64,AAAA",
      "blob:http://localhost/1234",
    ]) {
      expect(mod.withAuthSessionQuery(untouched)).toBe(untouched);
    }
  });

  it("redacts the token in log lines", async () => {
    const mod = await loadModule();
    expect(
      mod.redactAuthSessionQuery(
        `ws://h/yep/api/ws?compression=gzip&yep_auth=${TOKEN}`,
      ),
    ).toBe("ws://h/yep/api/ws?compression=gzip&yep_auth=[redacted]");
  });

  it("hands the token to the Android shell with explicit target origins", async () => {
    const mod = await loadModule();
    document.documentElement.dataset.mobileShell = "true";
    const postMessage = vi.fn();
    vi.spyOn(window, "parent", "get").mockReturnValue({
      postMessage,
    } as unknown as Window);

    mod.setAuthSessionToken(TOKEN);

    expect(postMessage).toHaveBeenCalledWith(
      { type: mod.MOBILE_SHELL_SESSION_TOKEN_MESSAGE, token: TOKEN },
      "https://tauri.localhost",
    );
    expect(postMessage).toHaveBeenCalledWith(
      { type: mod.MOBILE_SHELL_SESSION_TOKEN_MESSAGE, token: TOKEN },
      "tauri://localhost",
    );
    expect(postMessage).not.toHaveBeenCalledWith(expect.anything(), "*");
  });
});

import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgyLoginService,
  agyLoginErrorText,
  normalizeAgyLoginCode,
  parseAgyLoginUrl,
} from "../../../src/sdk/providers/agy-login.js";

// Mirrors `agy acp --login` 1.5.13 (references/antigravity/README.md).
const FAKE_AGY = `#!/bin/sh
[ "$1" = "acp" ] && [ "$2" = "--login" ] || exit 9
echo "Open this link in a browser to log in with Google:"
echo ""
echo "  https://accounts.google.com/o/oauth2/auth?client_id=x&state=y"
echo ""
echo "Then paste the authorization code, or the full URL of the page you land on, and press Enter:"
read code
if [ "$code" = "good-code" ]; then echo "Logged in."; exit 0; fi
echo "couldn't log in: token exchange failed: oauth2: \\"invalid_grant\\" \\"Malformed auth code.\\"" >&2
exit 1
`;

describe("agy login helpers", () => {
  it("parses the sign-in URL and agy's error line", () => {
    expect(
      parseAgyLoginUrl("Open this:\n\n  https://accounts.google.com/a?b=c\n"),
    ).toBe("https://accounts.google.com/a?b=c");
    expect(parseAgyLoginUrl("no link")).toBeNull();
    expect(
      agyLoginErrorText(
        "\ncouldn't log in: token exchange failed\n",
        "Open this link...",
      ),
    ).toBe("couldn't log in: token exchange failed");
  });

  it("accepts exactly one pasted line", () => {
    expect(normalizeAgyLoginCode("  4/0Abc  ")).toBe("4/0Abc");
    expect(normalizeAgyLoginCode("a\nb")).toBeNull();
    expect(normalizeAgyLoginCode("")).toBeNull();
    expect(normalizeAgyLoginCode(42)).toBeNull();
  });
});

describe("AgyLoginService", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  async function service(authenticatedAfterLogin = true) {
    dir = await mkdtemp(join(tmpdir(), "agy-login-"));
    const agyPath = join(dir, "agy");
    await writeFile(agyPath, FAKE_AGY);
    await chmod(agyPath, 0o755);
    let refreshes = 0;
    const provider = {
      isInstalled: async () => true,
      getAuthStatus: async () => ({
        installed: true,
        authenticated: false,
        enabled: false,
      }),
      refreshAuthStatus: async () => {
        refreshes += 1;
        return authenticatedAfterLogin;
      },
    };
    const login = new AgyLoginService(provider, async () => agyPath);
    return { login, refreshes: () => refreshes };
  }

  it("completes after a good code and re-checks the sign-in", async () => {
    const { login, refreshes } = await service();
    const started = await login.startLogin();
    expect(started).toMatchObject({
      status: "pending",
      authUrl: "https://accounts.google.com/o/oauth2/auth?client_id=x&state=y",
    });
    const done = await login.submitCode("good-code");
    expect(done).toMatchObject({ status: "completed", error: null });
    expect(refreshes()).toBe(1);
    expect(login.getLoginState()?.status).toBe("completed");
  });

  it("reports agy's error for a bad code", async () => {
    const { login } = await service();
    await login.startLogin();
    const done = await login.submitCode("bad");
    expect(done.status).toBe("failed");
    expect(done.error).toContain("Malformed auth code");
  });

  it("fails when agy exits 0 but is still signed out", async () => {
    const { login } = await service(false);
    await login.startLogin();
    expect((await login.submitCode("good-code")).status).toBe("failed");
  });

  it("cancels a pending sign-in and rejects late codes", async () => {
    const { login } = await service();
    await login.startLogin();
    login.cancelLogin();
    expect(login.getLoginState()?.status).toBe("canceled");
    await expect(login.submitCode("good-code")).rejects.toThrow(
      /No Antigravity sign-in/,
    );
  });

  it("reports a missing CLI", async () => {
    const login = new AgyLoginService(
      {
        isInstalled: async () => false,
        getAuthStatus: async () => ({
          installed: false,
          authenticated: false,
          enabled: false,
        }),
        refreshAuthStatus: async () => false,
      },
      async () => null,
    );
    expect(await login.getAccount()).toMatchObject({
      installed: false,
      agyPath: null,
    });
    await expect(login.startLogin()).rejects.toThrow(/not installed/);
  });
});

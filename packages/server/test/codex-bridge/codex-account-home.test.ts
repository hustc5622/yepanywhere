import {
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ensureSharedCodexStorage,
  readCodexAccountProfiles,
  resolveCodexHomeForAccount,
} from "../../src/codex-bridge/codex-account-home.js";

describe("codex account homes", () => {
  let root: string;
  let dataDir: string;
  let defaultHome: string;

  beforeEach(() => {
    root = join(tmpdir(), `yep-codex-account-${Date.now()}-${Math.random()}`);
    dataDir = join(root, "data");
    defaultHome = join(root, "codex");
    mkdirSync(join(defaultHome, "sessions"), { recursive: true });
    writeFileSync(join(defaultHome, "session_index.jsonl"), "");
    mkdirSync(dataDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("links shared session storage and leaves auth private", () => {
    const altHome = join(root, "alt");
    ensureSharedCodexStorage(altHome, defaultHome);

    expect(lstatSync(join(altHome, "sessions")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(altHome, "sessions"))).toBe(
      join(defaultHome, "sessions"),
    );
    expect(
      lstatSync(join(altHome, "session_index.jsonl")).isSymbolicLink(),
    ).toBe(true);
    // auth.json is never linked: that is the whole point of a separate home.
    expect(existsSync(join(altHome, "auth.json"))).toBe(false);
  });

  it("is idempotent", () => {
    const altHome = join(root, "alt");
    ensureSharedCodexStorage(altHome, defaultHome);
    expect(() => ensureSharedCodexStorage(altHome, defaultHome)).not.toThrow();
    expect(lstatSync(join(altHome, "sessions")).isSymbolicLink()).toBe(true);
  });

  it("resolves registered accounts and ignores the default/unknown ids", () => {
    const altHome = join(root, "homes", "acct-1");
    writeFileSync(
      join(dataDir, "codex-accounts.json"),
      JSON.stringify({
        accounts: [{ id: "acct-1", codexHome: altHome, label: "second" }],
      }),
    );

    expect(readCodexAccountProfiles(dataDir)).toHaveLength(1);
    expect(
      resolveCodexHomeForAccount("acct-1", {
        dataDir,
        defaultCodexHome: defaultHome,
      }),
    ).toBe(altHome);
    // Resolving also provisions the shared storage links.
    expect(lstatSync(join(altHome, "sessions")).isSymbolicLink()).toBe(true);

    for (const id of [undefined, "", "default", "missing"]) {
      expect(
        resolveCodexHomeForAccount(id, {
          dataDir,
          defaultCodexHome: defaultHome,
        }),
      ).toBeNull();
    }
  });
});

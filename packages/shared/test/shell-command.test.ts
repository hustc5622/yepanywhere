import { describe, expect, it } from "vitest";
import {
  extractBashCommandFromInput,
  getShellLauncherPrefixLength,
  isShellLauncherWrappedCommand,
  tokenizeShellCommand,
  unwrapShellLauncherCommand,
} from "../src/shell-command.js";

describe("tokenizeShellCommand", () => {
  it("splits on unquoted whitespace", () => {
    expect(tokenizeShellCommand("npm run lint")).toEqual([
      "npm",
      "run",
      "lint",
    ]);
    expect(tokenizeShellCommand("bash\t-lc\t'echo tab'")).toEqual([
      "bash",
      "-lc",
      "echo tab",
    ]);
  });

  it("keeps quoted runs together and drops the quotes", () => {
    expect(tokenizeShellCommand(`echo 'a b' "c d"`)).toEqual([
      "echo",
      "a b",
      "c d",
    ]);
  });

  it("honours backslash escapes", () => {
    expect(tokenizeShellCommand("echo a\\ b")).toEqual(["echo", "a b"]);
    expect(tokenizeShellCommand(`echo \\"quoted\\"`)).toEqual([
      "echo",
      '"quoted"',
    ]);
  });

  it("returns what it has for unterminated quotes instead of throwing", () => {
    expect(tokenizeShellCommand("bash -lc 'unterminated")).toEqual([
      "bash",
      "-lc",
      "unterminated",
    ]);
  });

  it("returns no tokens for empty and whitespace-only input", () => {
    expect(tokenizeShellCommand("")).toEqual([]);
    expect(tokenizeShellCommand("   \t\n ")).toEqual([]);
  });
});

describe("getShellLauncherPrefixLength", () => {
  it("recognizes a two-token shell prefix", () => {
    expect(getShellLauncherPrefixLength(["bash", "-lc", "x"])).toBe(2);
    expect(getShellLauncherPrefixLength(["/bin/zsh", "-lc", "x"])).toBe(2);
  });

  it("recognizes a three-token env prefix", () => {
    expect(
      getShellLauncherPrefixLength(["/usr/bin/env", "bash", "-lc", "x"]),
    ).toBe(3);
  });

  it("rejects anything that is not a login shell invocation", () => {
    expect(getShellLauncherPrefixLength(["bash", "-c", "x"])).toBe(0);
    expect(getShellLauncherPrefixLength(["python", "-lc", "x"])).toBe(0);
    expect(getShellLauncherPrefixLength(["env", "python", "-lc", "x"])).toBe(0);
    expect(getShellLauncherPrefixLength(["env", "-lc", "x"])).toBe(0);
    expect(getShellLauncherPrefixLength(["bash", "-lc"])).toBe(0);
  });
});

describe("unwrapShellLauncherCommand", () => {
  it("unwraps a plain shell launcher", () => {
    expect(
      unwrapShellLauncherCommand("/opt/homebrew/bin/bash -lc 'npm run lint'"),
    ).toBe("npm run lint");
    expect(
      unwrapShellLauncherCommand(
        '/bin/bash -lc "cat packages/server/package.json"',
      ),
    ).toBe("cat packages/server/package.json");
  });

  it("unwraps an env + shell launcher", () => {
    expect(
      unwrapShellLauncherCommand(
        '/usr/bin/env bash -lc "rg --files packages/client/src"',
      ),
    ).toBe("rg --files packages/client/src");
  });

  it("accepts every supported shell, case-insensitively", () => {
    for (const shell of ["bash", "sh", "zsh", "dash", "BASH", "/BIN/BASH"]) {
      expect(unwrapShellLauncherCommand(`${shell} -lc 'echo hi'`)).toBe(
        "echo hi",
      );
    }
  });

  it("resolves the executable basename from any path shape", () => {
    expect(unwrapShellLauncherCommand("./bash -lc 'relative'")).toBe(
      "relative",
    );
    expect(unwrapShellLauncherCommand("../../bin/bash -lc 'up'")).toBe("up");
    expect(
      unwrapShellLauncherCommand("C:\\\\Windows\\\\bash -lc 'echo win'"),
    ).toBe("echo win");
  });

  it("peels nested launchers", () => {
    expect(
      unwrapShellLauncherCommand('bash -lc "env bash -lc \\"echo nested\\""'),
    ).toBe("echo nested");
  });

  it("leaves non-launcher commands untouched", () => {
    // Not re-joined from tokens: when no launcher is found the input is
    // returned as-is, so original quoting survives.
    expect(unwrapShellLauncherCommand("npm run lint")).toBe("npm run lint");
    expect(unwrapShellLauncherCommand("bash -c 'echo hi'")).toBe(
      "bash -c 'echo hi'",
    );
    expect(unwrapShellLauncherCommand("python -lc 'not a shell'")).toBe(
      "python -lc 'not a shell'",
    );
  });

  it("handles launchers with nothing left to run", () => {
    expect(unwrapShellLauncherCommand("bash -lc")).toBe("bash -lc");
    // An empty payload tokenizes away entirely, leaving a bare prefix that is
    // no longer recognized as a wrapper, so the input survives verbatim.
    expect(unwrapShellLauncherCommand("bash -lc ''")).toBe("bash -lc ''");
    expect(unwrapShellLauncherCommand("bash")).toBe("bash");
  });

  it("trims surrounding whitespace and empty input", () => {
    expect(unwrapShellLauncherCommand("  bash -lc 'echo pad'  ")).toBe(
      "echo pad",
    );
    expect(unwrapShellLauncherCommand("")).toBe("");
    expect(unwrapShellLauncherCommand("  \t\n ")).toBe("");
  });

  it("preserves operators and non-ASCII content in the payload", () => {
    expect(
      unwrapShellLauncherCommand("bash -lc 'echo a && echo b | grep c'"),
    ).toBe("echo a && echo b | grep c");
    expect(unwrapShellLauncherCommand("bash -lc 'echo 中文 emoji 🎉'")).toBe(
      "echo 中文 emoji 🎉",
    );
  });
});

describe("isShellLauncherWrappedCommand", () => {
  it("detects wrapped commands", () => {
    expect(
      isShellLauncherWrappedCommand(
        "/opt/homebrew/bin/bash -lc 'npm run lint'",
      ),
    ).toBe(true);
    expect(
      isShellLauncherWrappedCommand(
        '/usr/bin/env bash -lc "rg --files packages/client/src"',
      ),
    ).toBe(true);
  });

  it("rejects bare commands, launchers with no payload and empty input", () => {
    expect(isShellLauncherWrappedCommand("npm run lint")).toBe(false);
    expect(isShellLauncherWrappedCommand("bash -lc")).toBe(false);
    expect(isShellLauncherWrappedCommand("")).toBe(false);
    expect(isShellLauncherWrappedCommand("   ")).toBe(false);
  });
});

describe("extractBashCommandFromInput", () => {
  it("prefers command over cmd", () => {
    expect(extractBashCommandFromInput({ command: "a", cmd: "b" })).toBe("a");
    expect(extractBashCommandFromInput({ cmd: "pnpm typecheck" })).toBe(
      "pnpm typecheck",
    );
  });

  it("trims and skips blank or non-string fields", () => {
    expect(extractBashCommandFromInput({ command: "  x  " })).toBe("x");
    expect(extractBashCommandFromInput({ command: "   ", cmd: "y" })).toBe("y");
    expect(extractBashCommandFromInput({ command: 42, cmd: "y" })).toBe("y");
  });

  it("returns an empty string for anything unusable", () => {
    expect(extractBashCommandFromInput(null)).toBe("");
    expect(extractBashCommandFromInput(undefined)).toBe("");
    expect(extractBashCommandFromInput("bash -lc 'x'")).toBe("");
    expect(extractBashCommandFromInput({})).toBe("");
  });
});

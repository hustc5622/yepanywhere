import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminPasswordService } from "../../src/auth/AdminPasswordService.js";
import { AUTH_ERROR_CODES } from "../../src/auth/authErrors.js";
import {
  type PasswordPrompt,
  createBase64StdinPasswordPrompt,
  createTerminalPasswordPrompt,
} from "../../src/cli-password-prompt.js";
import { setupAdminPassword } from "../../src/cli-setup.js";

type CommandResult = { code: number; stdout: string; stderr: string };

function runCli(args: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        path.resolve(
          import.meta.dirname,
          "../../../../node_modules/tsx/dist/cli.mjs",
        ),
        "--conditions",
        "source",
        "src/cli.ts",
        ...args,
      ],
      {
        cwd: path.resolve(import.meta.dirname, "../.."),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

describe("setupAdminPassword", () => {
  let testDir: string;
  let adminPasswordService: AdminPasswordService;
  let log: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-admin-test-"));
    adminPasswordService = new AdminPasswordService({
      filePath: path.join(testDir, "admin.json"),
    });
    log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("reads and confirms a hidden password without echoing it", async () => {
    const prompt: PasswordPrompt = {
      readHidden: vi
        .fn()
        .mockResolvedValueOnce("admin-password")
        .mockResolvedValueOnce("admin-password"),
    };

    await setupAdminPassword({ prompt, adminPasswordService });

    await expect(
      adminPasswordService.verifyPassword("admin-password"),
    ).resolves.toBe(true);
    expect(prompt.readHidden).toHaveBeenCalledTimes(2);
    const output = log.mock.calls.flat().join(" ");
    expect(output).toContain(adminPasswordService.getFilePath());
    expect(output).toContain("不保存可找回的明文密码");
    expect(output).not.toContain("admin-password");
  });

  it("rejects mismatched confirmation without changing the administrator file", async () => {
    const prompt: PasswordPrompt = {
      readHidden: vi
        .fn()
        .mockResolvedValueOnce("admin-password")
        .mockResolvedValueOnce("different-password"),
    };

    await expect(
      setupAdminPassword({ prompt, adminPasswordService }),
    ).rejects.toThrow("两次输入的管理员密码不一致");
    await expect(adminPasswordService.isConfigured()).resolves.toBe(false);
  });

  it("warns before replacing an existing shared administrator password", async () => {
    await adminPasswordService.setPassword("old-admin-password");
    const prompt: PasswordPrompt = {
      readHidden: vi
        .fn()
        .mockResolvedValueOnce("new-admin-password")
        .mockResolvedValueOnce("new-admin-password"),
    };

    await setupAdminPassword({ prompt, adminPasswordService });

    expect(log.mock.calls.flat().join(" ")).toContain(
      "重置整个项目共用的管理员密码",
    );
    await expect(
      adminPasswordService.verifyPassword("old-admin-password"),
    ).resolves.toBe(false);
  });

  it("rejects a short password without echoing either input", async () => {
    const shortPassword = "short";
    const prompt: PasswordPrompt = {
      readHidden: vi
        .fn()
        .mockResolvedValueOnce(shortPassword)
        .mockResolvedValueOnce(shortPassword),
    };

    const error = await setupAdminPassword({
      prompt,
      adminPasswordService,
    }).catch((cause) => cause);

    expect(error).toMatchObject({ code: AUTH_ERROR_CODES.passwordInvalid });
    expect(`${String(error)} ${log.mock.calls.flat().join(" ")}`).not.toContain(
      shortPassword,
    );
  });

  it("rejects non-TTY input before reading a password", async () => {
    const prompt = createTerminalPasswordPrompt({
      input: { isTTY: false } as NodeJS.ReadStream,
      output: { isTTY: true } as NodeJS.WriteStream,
    });

    await expect(prompt.readHidden("密码：")).rejects.toThrow(
      "必须在交互式终端中输入密码",
    );
  });

  it("decodes exactly two PowerShell-provided passwords from stdin", async () => {
    const input = Readable.from(
      ["first-password", "second-password"]
        .map((password) => Buffer.from(password, "utf8").toString("base64"))
        .join("\r\n"),
    ) as NodeJS.ReadStream;
    const prompt = createBase64StdinPasswordPrompt(input);

    await expect(prompt.readHidden("ignored")).resolves.toBe("first-password");
    await expect(prompt.readHidden("ignored")).resolves.toBe("second-password");
    await expect(prompt.readHidden("ignored")).rejects.toThrow(
      "管理员密码输入格式无效",
    );
  });

  it("rejects malformed PowerShell password input without exposing it", async () => {
    const malformedInput = "not-base64";
    const prompt = createBase64StdinPasswordPrompt(
      Readable.from(`${malformedInput}\n`) as NodeJS.ReadStream,
    );

    const error = await prompt.readHidden("ignored").catch((cause) => cause);

    expect(String(error)).toContain("管理员密码输入格式无效");
    expect(String(error)).not.toContain(malformedInput);
  });

  it("rejects Base64 input that is not valid UTF-8", async () => {
    const invalidUtf8 = "/w==";
    const prompt = createBase64StdinPasswordPrompt(
      Readable.from(`${invalidUtf8}\n${invalidUtf8}\n`) as NodeJS.ReadStream,
    );

    await expect(prompt.readHidden("ignored")).rejects.toThrow(
      "管理员密码输入格式无效",
    );
  });

  it("restores terminal mode when starting the hidden reader fails", async () => {
    const setRawMode = vi.fn();
    const input = {
      isTTY: true,
      isRaw: false,
      setRawMode,
      resume: vi.fn(),
      pause: vi.fn(),
      on: vi.fn(() => {
        throw new Error("listener failed");
      }),
      off: vi.fn(),
    } as unknown as NodeJS.ReadStream;
    const output = {
      isTTY: true,
      write: vi.fn(() => true),
    } as unknown as NodeJS.WriteStream;
    const prompt = createTerminalPasswordPrompt({ input, output });

    await expect(prompt.readHidden("密码：")).rejects.toThrow(
      "listener failed",
    );

    expect(setRawMode.mock.calls).toEqual([[true], [false]]);
    expect(input.pause).toHaveBeenCalledOnce();
  });

  it("exits without starting the server when terminal input is unavailable", async () => {
    const result = await runCli(["--setup-admin-password"]);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("必须在交互式终端中输入密码");
    expect(result.stdout).not.toContain("Starting Yep Anywhere");
  });

  it("rejects a password passed as an extra argument without echoing it", async () => {
    const supplied = "do-not-echo-this-password";
    const result = await runCli(["--setup-admin-password", supplied]);

    expect(result.code).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("Unknown arguments");
    expect(`${result.stdout}${result.stderr}`).not.toContain(supplied);
  });
});

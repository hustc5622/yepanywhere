import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HarnessUpdateService } from "../../src/services/HarnessUpdateService.js";
import {
  type HarnessInstallation,
  type RunHarnessCommand,
  harnessInstallCommand,
  inspectHarnessInstallation,
  isNewerHarnessVersion,
  runHarnessCommand,
} from "../../src/services/harness-installation.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  let version = "0.1.0";
  const inspect = vi.fn(
    async (): Promise<HarnessInstallation> => ({
      path: "/node/bin/codex",
      currentVersion: version,
      manager: "npm",
      command: { file: "/node/bin/npm", args: ["--prefix", "/node"] },
    }),
  );
  const run = vi.fn<RunHarnessCommand>(async (command) => {
    if (command.args.includes("view")) return '"0.2.0"';
    version = "0.2.0";
    return "installed";
  });
  const isBusy = vi.fn(async () => false);
  const service = new HarnessUpdateService({ inspect, run, isBusy });
  return {
    service,
    inspect,
    run,
    isBusy,
    setVersion: (next: string) => {
      version = next;
    },
  };
}

async function finished(service: HarnessUpdateService) {
  await vi.waitFor(async () => {
    expect((await service.getInfo("codex")).job?.status).not.toBe("running");
  });
  return service.getInfo("codex");
}

describe("HarnessUpdateService", () => {
  it("only contacts the registry on demand and coalesces concurrent checks", async () => {
    const { service, run } = fixture();
    await service.getInfo("codex");
    expect(run).not.toHaveBeenCalled();
    const [first, second] = await Promise.all([
      service.check("codex"),
      service.check("codex"),
    ]);
    expect(first).toMatchObject({
      currentVersion: "0.1.0",
      latestVersion: "0.2.0",
      updateAvailable: true,
    });
    expect(second.checkedAt).toBe(first.checkedAt);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("holds a global lock until installation and version verification finish", async () => {
    const { service, run, setVersion } = fixture();
    const gate = deferred();
    run.mockImplementation(async (command, options) => {
      if (command.args.includes("view")) return '"0.2.0"';
      options?.onOutput?.("x".repeat(20_000));
      await gate.promise;
      setVersion("0.2.0");
      return "done";
    });
    expect(service.start("codex")?.status).toBe("running");
    expect(service.start("codex")).toBeNull();
    expect(service.start("pi")).toBeNull();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    // A second client reads the same background job and bounded live log.
    const during = await service.getInfo("codex");
    expect(during.job?.status).toBe("running");
    expect(during.job?.log).toHaveLength(16_000);
    gate.resolve();
    const after = await finished(service);
    expect(after).toMatchObject({
      currentVersion: "0.2.0",
      updateAvailable: false,
      job: { status: "completed", fromVersion: "0.1.0", toVersion: "0.2.0" },
    });
    expect(run.mock.calls[1]?.[0]).toMatchObject({
      file: "/node/bin/npm",
      args: [
        "--prefix",
        "/node",
        "install",
        "--global",
        "@openai/codex@0.2.0",
        "--no-audit",
        "--no-fund",
      ],
    });
  });

  it("refuses active work, including work appearing during the registry lookup", async () => {
    const { service, run, isBusy } = fixture();
    isBusy.mockResolvedValueOnce(false).mockResolvedValue(true);
    service.start("codex");
    const after = await finished(service);
    expect(after.job).toMatchObject({
      status: "failed",
      error: expect.stringContaining("active work"),
    });
    expect(
      run.mock.calls.every(([command]) => command.args.includes("view")),
    ).toBe(true);
    expect(after.blockedReason).toBe("busy");
  });

  it("releases the lock after failure and allows a retry", async () => {
    const { service, run } = fixture();
    run.mockRejectedValueOnce(new Error("registry offline"));
    service.start("codex");
    expect((await finished(service)).job).toMatchObject({
      status: "failed",
      error: "registry offline",
    });
    expect(service.start("codex")?.status).toBe("running");
    expect((await finished(service)).job?.status).toBe("completed");
  });

  it("reports a failed verification when the original executable remains old", async () => {
    const { service, run } = fixture();
    run.mockResolvedValue('"0.2.0"');
    service.start("codex");
    expect((await finished(service)).job).toMatchObject({
      status: "failed",
      error: expect.stringContaining("original path"),
    });
  });

  it("does not downgrade a newer local CLI", async () => {
    const { service, run, setVersion } = fixture();
    setVersion("0.10.0");
    service.start("codex");
    expect((await finished(service)).job).toMatchObject({
      status: "completed",
      toVersion: "0.10.0",
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("blocks unsupported installations without launching a package manager", async () => {
    const { service, inspect, run } = fixture();
    inspect.mockResolvedValue({
      path: "/custom/codex",
      currentVersion: "0.1.0",
      blockedReason: "unsupported_install",
    });
    service.start("codex");
    expect((await finished(service)).job?.status).toBe("failed");
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects malformed registry versions before installation and exposes check failures", async () => {
    const { service, run } = fixture();
    run.mockResolvedValue('"latest; echo unsafe"');
    expect(await service.check("codex")).toMatchObject({
      updateAvailable: false,
      error: expect.stringContaining("stable CLI version"),
    });
    service.start("codex");
    expect((await finished(service)).job?.status).toBe("failed");
    expect(
      run.mock.calls.some(([command]) => command.args.includes("install")),
    ).toBe(false);
  });
});

describe("harness installation discovery", () => {
  const temporary: string[] = [];
  afterEach(async () => {
    await Promise.all(
      temporary
        .splice(0)
        .map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  async function npmInstall() {
    const prefix = await realpath(
      await mkdtemp(join(tmpdir(), "yep-harness-")),
    );
    temporary.push(prefix);
    const root = join(prefix, "lib/node_modules/@openai/codex");
    await mkdir(join(root, "bin"), { recursive: true });
    await mkdir(join(prefix, "bin"), { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "@openai/codex" }),
    );
    await writeFile(join(root, "bin/codex.js"), "", { mode: 0o755 });
    await symlink(join(root, "bin/codex.js"), join(prefix, "bin/codex"));
    for (const bin of ["npm", "node"])
      await writeFile(join(prefix, "bin", bin), "", { mode: 0o755 });
    return { prefix, root, path: join(prefix, "bin/codex") };
  }

  it("targets an NVM-style npm prefix even when PATH points elsewhere", async () => {
    const { prefix, path } = await npmInstall();
    const info = await inspectHarnessInstallation("codex", {
      path,
      run: async () => "codex-cli 0.155.1",
    });
    expect(info).toMatchObject({
      path,
      currentVersion: "0.155.1",
      manager: "npm",
      command: { file: join(prefix, "bin/npm"), args: ["--prefix", prefix] },
    });
    expect(info.command?.env?.PATH?.startsWith(`${prefix}/bin:`)).toBe(true);
  });

  it("refuses a similarly named package tree that does not own the CLI bin", async () => {
    const { prefix, root, path } = await npmInstall();
    await rm(path);
    await writeFile(path, "custom wrapper", { mode: 0o755 });
    const info = await inspectHarnessInstallation("codex", {
      path: join(root, "bin/codex.js"),
      run: async () => "0.1.0",
    });
    expect(info.blockedReason).toBe("unsupported_install");
    expect(info.command).toBeUndefined();
    await rm(join(prefix, "bin/npm"));
  });

  it("does not fall back to a different npm when the matching package manager is missing", async () => {
    const { prefix, path } = await npmInstall();
    await rm(join(prefix, "bin/npm"));
    expect(
      await inspectHarnessInstallation("codex", {
        path,
        run: async () => "0.1.0",
      }),
    ).toMatchObject({ blockedReason: "package_manager_missing" });
  });

  it("does not invoke a CLI on an unsupported platform", async () => {
    const run = vi.fn<RunHarnessCommand>();
    expect(
      await inspectHarnessInstallation("codex", {
        path: "C:\\bin\\codex.cmd",
        platform: "win32",
        run,
      }),
    ).toMatchObject({ blockedReason: "unsupported_platform" });
    expect(run).not.toHaveBeenCalled();
  });

  it("recognizes a Homebrew cask but rejects a version-pinned binary", async () => {
    const prefix = await realpath(await mkdtemp(join(tmpdir(), "yep-brew-")));
    temporary.push(prefix);
    const binary = join(prefix, "Caskroom/codex/0.1.0/codex");
    await mkdir(join(prefix, "Caskroom/codex/0.1.0"), { recursive: true });
    await mkdir(join(prefix, "bin"));
    await writeFile(binary, "", { mode: 0o755 });
    await writeFile(join(prefix, "bin/brew"), "", { mode: 0o755 });
    await symlink(binary, join(prefix, "bin/codex"));
    const run = async () => "codex-cli 0.1.0";
    const info = await inspectHarnessInstallation("codex", {
      path: join(prefix, "bin/codex"),
      run,
    });
    expect(info.manager).toBe("brew");
    expect(harnessInstallCommand("codex", info, "0.2.0")).toMatchObject({
      file: join(prefix, "bin/brew"),
      args: ["upgrade", "--cask", "codex"],
    });
    expect(
      (await inspectHarnessInstallation("codex", { path: binary, run }))
        .blockedReason,
    ).toBe("unsupported_install");
  });

  it("reports an unreadable version instead of enabling an unverified update", async () => {
    const { path } = await npmInstall();
    expect(
      await inspectHarnessInstallation("codex", {
        path,
        run: async () => "unknown",
      }),
    ).toMatchObject({ error: expect.stringContaining("Could not read") });
  });

  it("uses the Pi package and disables install scripts", () => {
    const command = harnessInstallCommand(
      "pi",
      {
        manager: "npm",
        command: {
          file: "/bin/npm",
          args: ["--prefix", "/prefix with spaces"],
        },
      },
      "1.2.3",
    );
    expect(command.args).toContain("@earendil-works/pi-coding-agent@1.2.3");
    expect(command.args).toContain("--ignore-scripts");
    expect(command.args[1]).toBe("/prefix with spaces");
    expect(isNewerHarnessVersion("1.2.3", "1.2.3-beta.1")).toBe(true);
    expect(isNewerHarnessVersion("1.2.3", "1.2.4-beta.1")).toBe(false);
  });

  it("captures output, closes stdin, and reports command failures", async () => {
    const onOutput = vi.fn();
    const result = await runHarnessCommand(
      {
        file: process.execPath,
        args: [
          "-e",
          "process.stdin.resume(); process.stdin.on('end', () => console.log('done')); console.error('progress');",
        ],
      },
      { onOutput },
    );
    expect(result).toBe("done");
    expect(onOutput.mock.calls.flat().join("")).toContain("progress");
    await expect(
      runHarnessCommand({
        file: process.execPath,
        args: ["-e", "console.error('no permission'); process.exit(1)"],
      }),
    ).rejects.toThrow("no permission");
    await expect(
      runHarnessCommand(
        { file: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] },
        { timeoutMs: 100 },
      ),
    ).rejects.toThrow("timed out");
  });
});

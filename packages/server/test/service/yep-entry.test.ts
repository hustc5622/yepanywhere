import { EventEmitter } from "node:events";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const readlineState = vi.hoisted(() => ({ prompts: [] as string[] }));

vi.mock("node:readline", () => ({
  default: {
    createInterface: () => ({
      close: () => undefined,
      question: (prompt: string, answer: (value: string) => void) => {
        readlineState.prompts.push(prompt);
        answer("q");
      },
    }),
  },
}));

type EntryModule = {
  backendForPlatform?: (platform: string) => unknown;
  dispatch?: (options: {
    platform: string;
    args: string[];
    spawnImpl: (...args: unknown[]) => EventEmitter;
  }) => Promise<number>;
};

const entry = (await import("../../../../yep.mjs")) as EntryModule;
const repoRoot = path.resolve(import.meta.dirname, "../../../..");

function closingChild(code: number | null, signal: string | null = null) {
  const child = new EventEmitter();
  queueMicrotask(() => child.emit("close", code, signal));
  return child;
}

function requireDispatch() {
  expect(entry.dispatch).toBeTypeOf("function");
  return entry.dispatch as NonNullable<EntryModule["dispatch"]>;
}

describe("yep 跨平台入口", () => {
  it("作为模块导入时不显示系统选择菜单", async () => {
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(readlineState.prompts).toEqual([]);
  });

  it("在 Windows 原样转发参数并继承标准流", async () => {
    const spawnImpl = vi.fn(() => closingChild(23));

    const result = await requireDispatch()({
      platform: "win32",
      args: ["restart-dev", "--fg"],
      spawnImpl,
    });

    expect(result).toBe(23);
    expect(spawnImpl).toHaveBeenCalledWith(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(repoRoot, "scripts", "yep.ps1"),
        "restart-dev",
        "--fg",
      ],
      expect.objectContaining({ stdio: "inherit" }),
    );
  });

  it("在 macOS 无参数时直接交给 yep.sh", async () => {
    const spawnImpl = vi.fn(() => closingChild(0));

    const result = await requireDispatch()({
      platform: "darwin",
      args: [],
      spawnImpl,
    });

    expect(result).toBe(0);
    expect(spawnImpl).toHaveBeenCalledWith(
      "bash",
      [path.join(repoRoot, "yep.sh")],
      expect.objectContaining({ stdio: "inherit" }),
    );
  });

  it("子进程被信号终止时返回非零结果", async () => {
    const result = await requireDispatch()({
      platform: "darwin",
      args: ["status"],
      spawnImpl: () => closingChild(null, "SIGTERM"),
    });

    expect(result).toBe(1);
  });

  it("子进程启动失败时返回非零结果", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await requireDispatch()({
      platform: "win32",
      args: ["status"],
      spawnImpl: () => {
        throw new Error("spawn failed");
      },
    });

    expect(result).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("无法启动 Yep Anywhere 服务脚本"),
    );
    errorSpy.mockRestore();
  });

  it("不支持的平台输出中文错误且不启动后端", async () => {
    const spawnImpl = vi.fn(() => closingChild(0));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await requireDispatch()({
      platform: "linux",
      args: ["status"],
      spawnImpl,
    });

    expect(result).toBe(1);
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("不支持的操作系统"),
    );
    errorSpy.mockRestore();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { ACPClient } from "../../../src/sdk/providers/acp/client.js";
import {
  KimiProvider,
  toKimiAcpMode,
} from "../../../src/sdk/providers/kimi.js";

describe("KimiProvider permission modes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("advertises Kimi's four native modes in their UI order", () => {
    expect(new KimiProvider().permissionModes).toEqual([
      "default",
      "plan",
      "auto",
      "bypassPermissions",
    ]);
  });

  it.each([
    ["default", "default"],
    ["plan", "plan"],
    ["auto", "auto"],
    ["bypassPermissions", "yolo"],
    ["acceptEdits", "default"],
  ] as const)("maps Yep %s to Kimi ACP %s", (mode, expected) => {
    expect(toKimiAcpMode(mode)).toBe(expected);
  });

  it("applies the native mode on startup and supports live switching", async () => {
    vi.spyOn(ACPClient.prototype, "connect").mockResolvedValue();
    vi.spyOn(ACPClient.prototype, "initialize").mockResolvedValue(
      {} as Awaited<ReturnType<ACPClient["initialize"]>>,
    );
    vi.spyOn(ACPClient.prototype, "newSession").mockResolvedValue("session-1");
    const setSessionMode = vi
      .spyOn(ACPClient.prototype, "setSessionMode")
      .mockResolvedValue();
    vi.spyOn(ACPClient.prototype, "close").mockImplementation(() => {});

    const session = await new KimiProvider({
      kimiPath: process.execPath,
    }).startSession({
      cwd: process.cwd(),
      permissionMode: "bypassPermissions",
    });

    await expect(session.iterator.next()).resolves.toMatchObject({
      done: false,
      value: {
        type: "system",
        subtype: "init",
        session_id: "session-1",
      },
    });
    expect(setSessionMode).toHaveBeenCalledWith("session-1", "yolo");

    await session.setPermissionMode?.("auto");
    expect(setSessionMode).toHaveBeenLastCalledWith("session-1", "auto");

    session.abort();
  });
});

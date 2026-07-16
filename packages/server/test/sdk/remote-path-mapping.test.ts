import { describe, expect, it } from "vitest";
import {
  mapLocalPathToRemote,
  mapRemotePathToLocal,
  tryMapRemotePathToLocal,
} from "../../src/sdk/remote-path-mapping.js";

const executor = {
  localRoot: "/Users/yueyuan/Desktop/file/UTM",
  remoteRoot: "/mnt/utm",
};

describe("remote path mapping", () => {
  it("maps roots and nested Unicode paths in both directions", () => {
    expect(mapLocalPathToRemote(executor.localRoot, executor)).toBe(
      executor.remoteRoot,
    );
    expect(
      mapLocalPathToRemote(
        "/Users/yueyuan/Desktop/file/UTM/projects/中文 demo",
        executor,
      ),
    ).toBe("/mnt/utm/projects/中文 demo");
    expect(mapRemotePathToLocal("/mnt/utm/projects/中文 demo", executor)).toBe(
      "/Users/yueyuan/Desktop/file/UTM/projects/中文 demo",
    );
  });

  it("uses path-component boundaries and rejects parent traversal", () => {
    expect(() =>
      mapLocalPathToRemote(
        "/Users/yueyuan/Desktop/file/UTM-other/project",
        executor,
      ),
    ).toThrow("outside the configured shared root");
    expect(() =>
      mapRemotePathToLocal("/mnt/utm-other/project", executor),
    ).toThrow("outside the configured shared root");
    expect(() =>
      mapRemotePathToLocal("/mnt/utm/projects/../secret", executor),
    ).toThrow("cannot contain '..'");
    expect(tryMapRemotePathToLocal("/opt/project", executor)).toBeNull();
  });

  it("supports a Windows local root with a POSIX remote root", () => {
    const windowsExecutor = {
      localRoot: "C:\\Users\\me\\UTM",
      remoteRoot: "/mnt/utm",
    };
    expect(
      mapLocalPathToRemote(
        "C:\\Users\\me\\UTM\\projects\\demo",
        windowsExecutor,
      ),
    ).toBe("/mnt/utm/projects/demo");
    expect(
      mapRemotePathToLocal("/mnt/utm/projects/demo", windowsExecutor),
    ).toBe("C:\\Users\\me\\UTM\\projects\\demo");
  });
});

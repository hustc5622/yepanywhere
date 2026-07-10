import { describe, expect, it } from "vitest";
import {
  classifyBackendFile,
  classifyBackendFiles,
  getBackendReloadPlan,
} from "../../../../scripts/runtime-reload-classifier.js";

describe("runtime reload classifier", () => {
  it.each([
    ["packages/server/src/routes/sessions.ts", "shell"],
    ["packages/server/src/auth/AuthService.ts", "shell"],
    ["packages/server/src/runtime/standalone.ts", "runtime"],
    ["packages/server/src/supervisor/Process.ts", "runtime"],
    ["packages/server/src/sdk/providers/codex.ts", "shared"],
    ["packages/server/src/augments/index.ts", "shared"],
    ["packages/server/src/sdk/messageQueue.ts", "runtime"],
    ["packages/server/src/codex/normalization.ts", "shared"],
    ["packages/server/src/config.ts", "shared"],
    ["packages/server/src/sdk/real.ts", "shared"],
    ["packages/server/src/watcher/EventBus.ts", "shared"],
    ["packages/shared/src/types.ts", "shared"],
  ] as const)("classifies %s as %s", (file, expected) => {
    expect(classifyBackendFile(file)).toBe(expected);
  });

  it("classifies control-protocol changes as shared by shell and runtime", () => {
    expect(
      classifyBackendFiles([
        "packages/server/src/routes/ws.ts",
        "packages/server/src/runtime/types.ts",
        "packages/shared/src/types.ts",
      ]),
    ).toEqual({
      shellFiles: ["packages/server/src/routes/ws.ts"],
      runtimeFiles: [],
      sharedFiles: [
        "packages/server/src/runtime/types.ts",
        "packages/shared/src/types.ts",
      ],
    });
  });

  it("reloads the shell and marks the runtime dirty for shared changes", () => {
    expect(
      getBackendReloadPlan(["packages/shared/src/types.ts"]),
    ).toMatchObject({
      runtimeImpactingFiles: ["packages/shared/src/types.ts"],
      shouldReloadShell: true,
    });
  });

  it("does not reload the shell for runtime-only changes", () => {
    expect(
      getBackendReloadPlan(["packages/server/src/supervisor/Process.ts"]),
    ).toMatchObject({
      shouldReloadShell: false,
    });
  });

  it("reloads the shell and marks transitive runtime dependencies dirty", () => {
    expect(
      getBackendReloadPlan([
        "packages/server/src/codex/normalization.ts",
        "packages/server/src/config.ts",
      ]),
    ).toMatchObject({
      runtimeImpactingFiles: [
        "packages/server/src/codex/normalization.ts",
        "packages/server/src/config.ts",
      ],
      shouldReloadShell: true,
    });
  });
});

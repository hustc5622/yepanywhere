import { describe, expect, it } from "vitest";
import {
  classifyBackendFile,
  classifyBackendFiles,
  classifyChangedFile,
  getBackendReloadPlan,
  getHotApplyPlan,
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

describe("hot-apply classifier", () => {
  it.each([
    ["packages/client/src/components/MessageList.tsx", "client"],
    ["packages/client/public/icon-192.png", "client"],
    ["packages/server/src/routes/sessions.ts", "shell"],
    ["packages/server/src/supervisor/Process.ts", "runtime"],
    ["packages/server/resources/pi-yep-extension.mjs", "runtime"],
    ["packages/shared/src/types.ts", "shared"],
    ["docs/project/versioning.md", "ignored"],
    ["scripts/deploy.sh", "ignored"],
    [
      "packages/client/src/components/__tests__/MessageInput.test.tsx",
      "ignored",
    ],
    ["packages/server/src/display/display.test.ts", "ignored"],
    ["packages/mobile/src-tauri/tauri.conf.json", "ignored"],
  ] as const)("classifies %s as %s", (file, expected) => {
    expect(classifyChangedFile(file)).toBe(expected);
  });

  it("keeps a client-only diff at the zero-downtime tier", () => {
    expect(
      getHotApplyPlan([
        "packages/client/src/components/MessageList.tsx",
        "docs/project/versioning.md",
      ]),
    ).toMatchObject({
      level: "client",
      needsClientBuild: true,
      needsShellRestart: false,
      needsRuntimeRestart: false,
    });
  });

  it("requires a shell restart for web/API changes but spares the runtime", () => {
    expect(
      getHotApplyPlan([
        "packages/client/src/api/client.ts",
        "packages/server/src/routes/sessions.ts",
      ]),
    ).toMatchObject({
      level: "shell",
      needsClientBuild: true,
      needsShellRestart: true,
      needsRuntimeRestart: false,
    });
  });

  it("treats shared package changes as client + shell + runtime", () => {
    expect(getHotApplyPlan(["packages/shared/src/types.ts"])).toMatchObject({
      level: "runtime",
      needsClientBuild: true,
      needsShellRestart: true,
      needsRuntimeRestart: true,
    });
  });

  it("reports nothing to do when only ignored files changed", () => {
    expect(
      getHotApplyPlan(["AGENTS.md", "scripts/hot-apply.mjs"]),
    ).toMatchObject({
      level: "none",
      needsClientBuild: false,
      needsShellRestart: false,
      needsRuntimeRestart: false,
    });
  });
});

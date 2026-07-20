import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DevelopmentSettings } from "./DevelopmentSettings";

const mocks = vi.hoisted(() => ({
  clearIgnoredTools: vi.fn(),
  isMobileShellDocument: vi.fn(() => true),
  refetchVersionFresh: vi.fn(),
  reloadBackend: vi.fn(),
  setHoldModeEnabled: vi.fn(),
  setValidationEnabled: vi.fn(),
  updateServerSetting: vi.fn(),
  uploadNativeLogs: vi.fn(),
}));

vi.mock("../../api/client", () => ({ api: {} }));
vi.mock("../../contexts/SchemaValidationContext", () => ({
  useSchemaValidationContext: () => ({
    ignoredTools: [],
    clearIgnoredTools: mocks.clearIgnoredTools,
  }),
}));
vi.mock("../../hooks/useDeveloperMode", () => ({
  useDeveloperMode: () => ({
    holdModeEnabled: false,
    setHoldModeEnabled: mocks.setHoldModeEnabled,
  }),
}));
vi.mock("../../hooks/useGlobalActiveAgents", () => ({
  useGlobalActiveAgents: () => 0,
}));
vi.mock("../../hooks/useReloadNotifications", () => ({
  useReloadNotifications: () => ({
    isManualReloadMode: false,
    pendingReloads: { backend: false },
    connected: true,
    reloadBackend: mocks.reloadBackend,
    unsafeToRestart: false,
    workerActivity: { activeWorkers: 0 },
  }),
}));
vi.mock("../../hooks/useSchemaValidation", () => ({
  useSchemaValidation: () => ({
    settings: { enabled: false },
    setEnabled: mocks.setValidationEnabled,
  }),
}));
vi.mock("../../hooks/useServerSettings", () => ({
  useServerSettings: () => ({
    settings: null,
    updateSetting: mocks.updateServerSetting,
  }),
}));
vi.mock("../../hooks/useVersion", () => ({
  useVersion: () => ({
    version: null,
    loading: false,
    refetchFresh: mocks.refetchVersionFresh,
  }),
}));
vi.mock("../../i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock("../../lib/nativePushBridge", () => ({
  isMobileShellDocument: mocks.isMobileShellDocument,
  uploadNativeLogs: mocks.uploadNativeLogs,
}));

describe("DevelopmentSettings", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shows native log upload in the APK when manual reload mode is disabled", () => {
    render(
      <MemoryRouter>
        <DevelopmentSettings />
      </MemoryRouter>,
    );

    expect(screen.getByText("developmentNativeLogsTitle")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "developmentNativeLogsUpload" }),
    ).toBeTruthy();
    expect(screen.queryByText("developmentSchemaTitle")).toBeNull();
  });
});

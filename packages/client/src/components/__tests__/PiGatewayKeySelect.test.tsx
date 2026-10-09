import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type LlmGatewayKeysResponse, api } from "../../api/client";
import { useLlmGatewayKeys } from "../../hooks/useLlmGatewayKeys";
import { I18nProvider } from "../../i18n";
import { updateNewSessionLayout } from "../../lib/newSessionLayout";
import { setCurrentInstallId } from "../../lib/storageKeys";
import { NewSessionSetupSkeleton } from "../NewSessionSkeleton";
import { PiGatewayKeySelect } from "../PiGatewayKeySelect";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function response(counts: number[]): LlmGatewayKeysResponse {
  return {
    error: null,
    channels: counts.map((count, channelIndex) => ({
      id: `channel-${channelIndex}`,
      label: `Gateway ${channelIndex}`,
      apiBase: "https://example.com/v1",
      isDefault: channelIndex === 0,
      keys: Array.from({ length: count }, (_, index) => ({
        id: `key-${channelIndex}-${index}`,
        channelId: `channel-${channelIndex}`,
        label: `Key ${channelIndex}-${index}`,
        preview: "sk-…demo",
        isEnvKey: false,
        createdAt: "2026-10-01T00:00:00Z",
        status: null,
      })),
    })),
  };
}

function Picker() {
  const state = useLlmGatewayKeys();
  return (
    <PiGatewayKeySelect
      value={null}
      onChange={() => {}}
      {...state}
      onAdd={state.addKey}
      onRemove={state.removeKey}
      onRefresh={state.refresh}
    />
  );
}

describe("Pi gateway loading", () => {
  beforeEach(() => {
    sessionStorage.clear();
    setCurrentInstallId("pi-gateway-loading");
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("keeps the remembered gateway layout from form setup through key loading", async () => {
    updateNewSessionLayout({ provider: "pi", piGatewayKeyCounts: [2, 1] });
    const pending = deferred<LlmGatewayKeysResponse>();
    vi.spyOn(api, "getLlmGatewayKeys").mockReturnValue(pending.promise);
    const view = render(
      <I18nProvider>
        <NewSessionSetupSkeleton provider="pi" />
      </I18nProvider>,
    );
    expect(view.container.querySelectorAll(".gateway-key-group")).toHaveLength(
      2,
    );
    expect(view.container.querySelectorAll(".gateway-key-row")).toHaveLength(3);
    view.rerender(
      <I18nProvider>
        <Picker />
      </I18nProvider>,
    );
    expect(
      screen.getByRole("status", { name: "Loading session options…" }),
    ).toBeTruthy();
    expect(view.container.querySelectorAll(".gateway-key-row")).toHaveLength(3);
    await act(async () => {
      pending.resolve(response([2, 1]));
    });
    expect(view.container.querySelectorAll(".gateway-key-row")).toHaveLength(3);
    expect(screen.getByRole("button", { name: /Key 1-0/ })).toBeTruthy();
    expect(
      screen.queryByRole("status", { name: "Loading session options…" }),
    ).toBeNull();
  });

  it("keeps existing keys available when a manual refresh fails", async () => {
    vi.spyOn(api, "getLlmGatewayKeys").mockResolvedValue(response([1]));
    render(
      <I18nProvider>
        <Picker />
      </I18nProvider>,
    );
    const key = await screen.findByRole("button", { name: /Key 0-0/ });
    vi.mocked(api.getLlmGatewayKeys).mockRejectedValue(
      new Error("Gateway unavailable"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByText("Gateway unavailable");
    expect(screen.getByRole("button", { name: /Key 0-0/ })).toBe(key);
    expect(key.hasAttribute("disabled")).toBe(false);
  });

  it("ignores the initial response if a fresh read has already completed", async () => {
    const pending = deferred<LlmGatewayKeysResponse>();
    vi.spyOn(api, "getLlmGatewayKeys")
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(response([2]));
    const hook = renderHook(() => useLlmGatewayKeys());
    await act(async () => {
      await hook.result.current.refresh(true);
    });
    expect(hook.result.current.keys).toHaveLength(2);
    await act(async () => {
      pending.resolve(response([1]));
    });
    expect(hook.result.current.keys).toHaveLength(2);
    expect(hook.result.current.loading).toBe(false);
  });
});

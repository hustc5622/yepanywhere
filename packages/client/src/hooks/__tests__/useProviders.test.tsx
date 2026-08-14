import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ProviderInfo } from "@yep-anywhere/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useProviders } from "../useProviders";

const { mockGetProviders } = vi.hoisted(() => ({
  mockGetProviders: vi.fn(),
}));

vi.mock("../../api/client", () => ({
  api: { getProviders: mockGetProviders },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const codexProvider = {
  name: "codex",
  displayName: "Codex",
  installed: true,
  authenticated: true,
  enabled: true,
  models: [],
  supportsPermissionMode: true,
  supportsThinkingToggle: true,
  supportsSlashCommands: true,
} satisfies ProviderInfo;

describe("useProviders", () => {
  afterEach(() => {
    cleanup();
    mockGetProviders.mockReset();
  });

  it("shares provider probes and keeps the last snapshot during revalidation", async () => {
    const initial = deferred<{ providers: ProviderInfo[] }>();
    mockGetProviders.mockReturnValueOnce(initial.promise);

    const first = renderHook(() => useProviders());
    const second = renderHook(() => useProviders());

    expect(first.result.current.loading).toBe(true);
    expect(second.result.current.loading).toBe(true);
    expect(mockGetProviders).toHaveBeenCalledTimes(1);

    await act(async () => {
      initial.resolve({ providers: [codexProvider] });
      await initial.promise;
    });
    await waitFor(() => {
      expect(first.result.current.providers).toEqual([codexProvider]);
      expect(second.result.current.providers).toEqual([codexProvider]);
    });

    first.unmount();
    second.unmount();
    const revalidation = deferred<{ providers: ProviderInfo[] }>();
    mockGetProviders.mockReturnValueOnce(revalidation.promise);

    const remounted = renderHook(() => useProviders());

    expect(remounted.result.current.providers).toEqual([codexProvider]);
    expect(remounted.result.current.loading).toBe(false);
    expect(mockGetProviders).toHaveBeenCalledTimes(2);

    await act(async () => {
      revalidation.resolve({ providers: [codexProvider] });
      await revalidation.promise;
    });
  });
});

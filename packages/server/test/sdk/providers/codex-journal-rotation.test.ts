import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  JsonlCodexEventStore,
  type JsonlCodexEventStoreOptions,
} from "../../../src/codex-events/index.js";
import { CodexProvider } from "../../../src/sdk/providers/codex.js";

vi.mock("../../../src/codex-events/index.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/codex-events/index.js")>();
  return {
    ...actual,
    JsonlCodexEventStore: vi.fn((options: JsonlCodexEventStoreOptions) => {
      // Construction does no I/O. Observe the provider/store configuration
      // boundary without starting a CLI or touching an existing journal.
      return new actual.JsonlCodexEventStore(options);
    }),
  };
});

describe("CodexProvider journal rotation configuration", () => {
  beforeEach(() => {
    vi.mocked(JsonlCodexEventStore).mockClear();
  });

  it.each([
    {
      name: "no rotation overrides",
      rotation: undefined,
      expected: { maxBytes: 64 * 1024 * 1024, keepSegments: 2 },
    },
    {
      name: "an empty override object",
      rotation: {},
      expected: { maxBytes: 64 * 1024 * 1024, keepSegments: 2 },
    },
    {
      name: "unset production environment overrides",
      rotation: { maxBytes: undefined, keepSegments: undefined },
      expected: { maxBytes: 64 * 1024 * 1024, keepSegments: 2 },
    },
    {
      name: "only a size override",
      rotation: { maxBytes: 8 * 1024 * 1024, keepSegments: undefined },
      expected: { maxBytes: 8 * 1024 * 1024, keepSegments: 2 },
    },
    {
      name: "only a segment-count override",
      rotation: { maxBytes: undefined, keepSegments: 1 },
      expected: { maxBytes: 64 * 1024 * 1024, keepSegments: 1 },
    },
    {
      name: "explicit overrides",
      rotation: { maxBytes: 16 * 1024 * 1024, keepSegments: 4 },
      expected: { maxBytes: 16 * 1024 * 1024, keepSegments: 4 },
    },
    {
      name: "explicit zero values from an embedder",
      rotation: { maxBytes: 0, keepSegments: 0 },
      expected: { maxBytes: 0, keepSegments: 0 },
    },
  ])("resolves each field for $name", ({ rotation, expected }) => {
    new CodexProvider({
      eventSpine: {
        durableStorePath: "/unused/provider-events.jsonl",
        storeRotation: rotation,
      },
    });

    expect(JsonlCodexEventStore).toHaveBeenLastCalledWith(
      expect.objectContaining({ appendOnly: true, rotation: expected }),
    );
  });
});

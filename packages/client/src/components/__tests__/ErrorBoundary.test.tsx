import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "../ErrorBoundary";

vi.mock("../../lib/buildRecovery", () => ({
  CLIENT_BUILD_ID: "client-build-a",
}));

function ThrowingChild(): never {
  throw new Error("render exploded");
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ErrorBoundary", () => {
  it("shows client build, server build, and server version after a render error", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        current: "0.9.7",
        build: { buildId: "server-build-b" },
      }),
    );
    vi.stubGlobal("fetch", fetchImpl);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    render(
      <ErrorBoundary>
        <ThrowingChild />
      </ErrorBoundary>,
    );

    expect(await screen.findByText("server-build-b")).toBeTruthy();
    expect(screen.getByText("Client build:")).toBeTruthy();
    expect(screen.getByText("client-build-a")).toBeTruthy();
    expect(screen.getByText("Server build:")).toBeTruthy();
    expect(screen.getByText("Server version:")).toBeTruthy();
    expect(screen.getByText("0.9.7")).toBeTruthy();
    expect(fetchImpl).toHaveBeenCalledWith("/api/version");
  });
});

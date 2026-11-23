import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAgyUpstreamFailureForTests } from "../../../src/sdk/providers/agy-network.js";
import { AgyProvider } from "../../../src/sdk/providers/agy.js";

/** `agy models` as printed when agy cannot use its saved sign-in. */
const SIGNED_OUT_AGY = `#!/bin/sh
echo "Fetching available models..."
echo "Please sign in to use Antigravity CLI." >&2
exit 1
`;

describe("agy auth status probe", () => {
  let dir: string;
  let agyPath: string;

  beforeEach(async () => {
    // The probe must not route through a real proxy in tests.
    vi.stubEnv("YEP_AGY_PROXY", "");
    dir = await mkdtemp(join(tmpdir(), "agy-auth-"));
    agyPath = join(dir, "agy");
    await writeFile(agyPath, SIGNED_OUT_AGY);
    await chmod(agyPath, 0o755);
  });

  afterEach(async () => {
    setAgyUpstreamFailureForTests(null);
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  });

  it("treats 'Please sign in' as signed out when the network is fine", async () => {
    const provider = new AgyProvider({ agyPath });
    await expect(provider.getAuthStatus()).resolves.toEqual({
      installed: true,
      authenticated: false,
      enabled: false,
    });
  });

  it("keeps agy available while YEP_AGY_PROXY is failing", async () => {
    // agy prints the same sign-in hint when its token refresh cannot reach
    // Google through a broken exit; that is not a sign-out.
    setAgyUpstreamFailureForTests("upstream proxy closed");
    const provider = new AgyProvider({ agyPath });
    await expect(provider.getAuthStatus()).resolves.toEqual({
      installed: true,
      authenticated: true,
      enabled: true,
    });
  });
});

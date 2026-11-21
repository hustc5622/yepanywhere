import { describe, expect, it, vi } from "vitest";
import {
  AgyUsageService,
  parseAgyCommandOutput,
  parseAgyCredits,
  parseAgyUsageGroups,
} from "../../../src/sdk/providers/agy-usage.js";

// Captured from `agy -p /usage --output-format json` (agy 1.5.14).
const USAGE = JSON.stringify({
  conversation_id: "",
  status: "SUCCESS",
  response: "Gemini Models\tWeekly Limit Remaining\t90%\t…",
  duration_seconds: 0,
  num_turns: 0,
  command: {
    name: "usage",
    data: {
      description: "Within each group, models share a weekly limit…",
      groups: [
        {
          name: "Gemini Models",
          description:
            "Models within this group: Gemini 4 Neon, Gemini 4 Hydrogen, Orchestrator (Neon), Gemini 3.8 Flash",
          buckets: [
            {
              id: "gemini-weekly",
              name: "Weekly Limit Remaining",
              window: "weekly",
              remaining_fraction: 0.899398684501648,
              reset_time: "2026-11-28T08:57:53Z",
            },
            {
              id: "gemini-5h",
              name: "Five Hour Limit Remaining",
              window: "5h",
              remaining_fraction: 0.661708652973175,
              reset_time: "2026-11-21T13:57:53Z",
            },
          ],
        },
        {
          name: "Gemini 4 Argon",
          description: "For paid Pro plans, Argon quota is separate.",
          buckets: [
            {
              id: "gemini-argon-wtu-weekly",
              name: "Gemini 4 Argon Weekly Limit",
              window: "weekly",
              remaining_fraction: 1,
              reset_time: "2026-11-28T12:30:56Z",
            },
            { id: "broken", name: "No fraction", window: "5h" },
          ],
        },
      ],
    },
  },
});

const CREDITS = JSON.stringify({
  conversation_id: "",
  status: "SUCCESS",
  num_turns: 0,
  command: {
    name: "credits",
    data: {
      remaining_credits: 0,
      upgrade_uri: "https://antigravity.google/g1-upgrade",
    },
  },
});

const ok = (stdout: string) => ({ stdout, stderr: "" });

describe("agy usage parsing", () => {
  it("reads groups, models and buckets from a real answer", () => {
    const parsed = parseAgyCommandOutput(ok(USAGE), ["usage", "quota"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const groups = parseAgyUsageGroups(parsed.data);
    expect(groups).toEqual([
      {
        name: "Gemini Models",
        models: [
          "Gemini 4 Neon",
          "Gemini 4 Hydrogen",
          "Orchestrator (Neon)",
          "Gemini 3.8 Flash",
        ],
        buckets: [
          {
            id: "gemini-weekly",
            name: "Weekly Limit Remaining",
            window: "weekly",
            remainingFraction: 0.899398684501648,
            resetTime: "2026-11-28T08:57:53Z",
          },
          {
            id: "gemini-5h",
            name: "Five Hour Limit Remaining",
            window: "5h",
            remainingFraction: 0.661708652973175,
            resetTime: "2026-11-21T13:57:53Z",
          },
        ],
      },
      {
        name: "Gemini 4 Argon",
        models: [],
        buckets: [
          {
            id: "gemini-argon-wtu-weekly",
            name: "Gemini 4 Argon Weekly Limit",
            window: "weekly",
            remainingFraction: 1,
            resetTime: "2026-11-28T12:30:56Z",
          },
        ],
      },
    ]);
  });

  it("reads credits", () => {
    const parsed = parseAgyCommandOutput(ok(CREDITS), ["credits"]);
    expect(parsed.ok && parseAgyCredits(parsed.data)).toEqual({
      remaining: 0,
      upgradeUrl: "https://antigravity.google/g1-upgrade",
    });
  });

  it("refuses an answer that ran a real turn or another command", () => {
    const turn = JSON.parse(USAGE);
    turn.num_turns = 1;
    expect(
      parseAgyCommandOutput(ok(JSON.stringify(turn)), ["usage"]),
    ).toMatchObject({ ok: false, state: "error" });
    expect(parseAgyCommandOutput(ok(CREDITS), ["usage"])).toMatchObject({
      ok: false,
      state: "error",
    });
  });

  it("maps signed-out, agy errors and non-JSON output", () => {
    expect(
      parseAgyCommandOutput(
        { stdout: "", stderr: "Please sign in to continue" },
        ["usage"],
      ),
    ).toMatchObject({ ok: false, state: "signed-out" });
    expect(
      parseAgyCommandOutput(
        ok(
          JSON.stringify({
            status: "ERROR",
            error: "no quota summary is available for this account",
          }),
        ),
        ["usage"],
      ),
    ).toEqual({
      ok: false,
      state: "unavailable",
      message: "no quota summary is available for this account",
    });
    expect(parseAgyCommandOutput(ok("banner\n"), ["usage"])).toMatchObject({
      ok: false,
      state: "error",
    });
    // A banner line before the JSON answer is tolerated.
    expect(
      parseAgyCommandOutput(ok(`Updating…\n${USAGE}\n`), ["usage"]).ok,
    ).toBe(true);
  });
});

describe("AgyUsageService", () => {
  const runner = () =>
    vi.fn(async (_path: string, command: "/usage" | "/credits") =>
      ok(command === "/usage" ? USAGE : CREDITS),
    );

  it("combines usage and credits, caches success and shares one read", async () => {
    const run = runner();
    let now = 1_000_000;
    const service = new AgyUsageService(
      async () => "/h/agy",
      run,
      () => now,
    );
    const [first, second] = await Promise.all([
      service.getUsage(),
      service.getUsage(),
    ]);
    expect(first).toBe(second);
    expect(first.state).toBe("ok");
    expect(first.groups).toHaveLength(2);
    expect(first.credits).toEqual({
      remaining: 0,
      upgradeUrl: "https://antigravity.google/g1-upgrade",
    });
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenCalledWith("/h/agy", "/usage");

    await service.getUsage();
    expect(run).toHaveBeenCalledTimes(2);
    await service.getUsage({ fresh: true });
    expect(run).toHaveBeenCalledTimes(4);
    now += 5 * 60_000 + 1;
    await service.getUsage();
    expect(run).toHaveBeenCalledTimes(6);
  });

  it("keeps usage when /credits fails and does not cache failures", async () => {
    const run = vi.fn(async (_path: string, command: "/usage" | "/credits") => {
      if (command === "/credits") throw new Error("boom");
      return ok(USAGE);
    });
    const service = new AgyUsageService(async () => "/h/agy", run);
    const result = await service.getUsage();
    expect(result.state).toBe("ok");
    expect(result.credits).toBeNull();

    const signedOut = new AgyUsageService(
      async () => "/h/agy",
      vi.fn(async () => {
        throw Object.assign(new Error("exit 1"), {
          stdout: "",
          stderr: "Please sign in",
        });
      }),
    );
    expect((await signedOut.getUsage()).state).toBe("signed-out");
    expect((await signedOut.getUsage()).state).toBe("signed-out");
  });

  it("reports a missing CLI without spawning", async () => {
    const run = runner();
    const service = new AgyUsageService(async () => null, run);
    expect(await service.getUsage()).toEqual({
      state: "not-installed",
      groups: [],
      credits: null,
      message: null,
      fetchedAt: null,
    });
    expect(run).not.toHaveBeenCalled();
  });
});

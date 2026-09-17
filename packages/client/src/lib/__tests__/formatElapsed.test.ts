import { describe, expect, it } from "vitest";
import { formatElapsed, parseStartedAt } from "../formatElapsed";

describe("formatElapsed", () => {
  it("formats sub-minute, minute, hour and day ranges", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(999)).toBe("0s");
    expect(formatElapsed(45_000)).toBe("45s");
    expect(formatElapsed(72_000)).toBe("1m12s");
    expect(formatElapsed(240_000)).toBe("4m00s");
    expect(formatElapsed(3_600_000)).toBe("1h00m");
    expect(formatElapsed(3_900_000)).toBe("1h05m");
    expect(formatElapsed(97_200_000)).toBe("1d03h");
  });

  it("clamps skewed clocks and invalid input to zero", () => {
    expect(formatElapsed(-5_000)).toBe("0s");
    expect(formatElapsed(Number.NaN)).toBe("0s");
  });
});

describe("parseStartedAt", () => {
  const now = Date.parse("2026-01-02T10:00:00.000Z");

  it("returns epoch milliseconds for a valid timestamp", () => {
    expect(parseStartedAt("2026-01-02T09:58:00.000Z", now)).toBe(
      Date.parse("2026-01-02T09:58:00.000Z"),
    );
  });

  it("rejects missing, malformed and implausibly old timestamps", () => {
    expect(parseStartedAt(undefined, now)).toBeNull();
    expect(parseStartedAt("not a date", now)).toBeNull();
    expect(parseStartedAt("2000-01-01T00:00:00.000Z", now)).toBeNull();
  });
});

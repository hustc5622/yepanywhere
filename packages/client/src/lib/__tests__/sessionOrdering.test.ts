import { describe, expect, it } from "vitest";
import {
  compareSessionsByPinAndUpdatedAt,
  isSessionVisibleInAgeWindow,
} from "../sessionOrdering";

describe("compareSessionsByPinAndUpdatedAt", () => {
  it("keeps pins first and sorts both groups by recency", () => {
    const sessions = [
      {
        id: "newest-ordinary",
        updatedAt: "2026-08-27T12:00:00.000Z",
        isStarred: false,
      },
      {
        id: "older-pin",
        updatedAt: "2026-08-25T12:00:00.000Z",
        isStarred: true,
      },
      {
        id: "newer-pin",
        updatedAt: "2026-08-26T12:00:00.000Z",
        isStarred: true,
      },
      {
        id: "older-ordinary",
        updatedAt: "2026-08-24T12:00:00.000Z",
      },
    ];

    expect(
      [...sessions]
        .sort(compareSessionsByPinAndUpdatedAt)
        .map((session) => session.id),
    ).toEqual(["newer-pin", "older-pin", "newest-ordinary", "older-ordinary"]);
  });

  it("uses the session id as a deterministic timestamp tiebreaker", () => {
    const updatedAt = "2026-08-27T12:00:00.000Z";
    const sessions = [
      { id: "session-b", updatedAt },
      { id: "session-a", updatedAt },
    ];

    expect(
      [...sessions]
        .sort(compareSessionsByPinAndUpdatedAt)
        .map((session) => session.id),
    ).toEqual(["session-a", "session-b"]);
  });

  it("keeps old pins visible while applying the age window to ordinary sessions", () => {
    const now = new Date("2026-09-07T01:03:00.000Z").getTime();
    const oldUpdatedAt = "2026-08-30T03:59:29.000Z";

    expect(
      isSessionVisibleInAgeWindow(
        { updatedAt: oldUpdatedAt, isStarred: true },
        7,
        now,
      ),
    ).toBe(true);
    expect(
      isSessionVisibleInAgeWindow(
        { updatedAt: oldUpdatedAt, isStarred: false },
        7,
        now,
      ),
    ).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { isSlashCommandSessionTitle } from "../src/session-kind.js";

describe("isSlashCommandSessionTitle", () => {
  it.each([
    "<command-message>review</command-message>",
    "/commit",
    "/review src/auth.ts",
    "$imagegen",
    "$some-skill with arguments",
  ])("classifies %s as a slash or skill command session", (title) => {
    expect(isSlashCommandSessionTitle(title)).toBe(true);
  });

  it.each([
    "$git-commit-push",
    "$git-commit-push review the release branch",
    "$git commit push",
    "$GIT-COMMIT-PUSH",
  ])("keeps %s in the regular session library", (title) => {
    expect(isSlashCommandSessionTitle(title)).toBe(false);
  });

  it.each([undefined, null, "", "Normal session", "Discuss $git-commit-push"])(
    "does not classify %s as a command session",
    (title) => {
      expect(isSlashCommandSessionTitle(title)).toBe(false);
    },
  );
});

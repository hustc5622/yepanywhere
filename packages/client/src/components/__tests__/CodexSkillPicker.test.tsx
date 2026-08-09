import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { I18nProvider } from "../../i18n";
import {
  type CodexSkillOption,
  CodexSkillPicker,
  parseCodexSkillsList,
} from "../CodexSkillPicker";

function PickerHarness() {
  const [selected, setSelected] = useState<CodexSkillOption | null>(null);
  return (
    <CodexSkillPicker
      sessionId="session-1"
      selected={selected}
      onSelect={setSelected}
    />
  );
}

describe("CodexSkillPicker", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("loads bounded skills, renders names only, and keeps path in memory", async () => {
    const privatePath = "/test-fixtures/codex/skills/release-check/SKILL.md";
    vi.spyOn(api, "executeCodexControl").mockResolvedValue({
      control: "skills/list",
      data: {
        data: [
          {
            cwd: "/test-fixtures/project",
            skills: [
              {
                name: "release-check",
                description: `Read ${privatePath} before release`,
                path: privatePath,
                enabled: true,
              },
              {
                name: "disabled-skill",
                path: "/test-fixtures/codex/skills/disabled/SKILL.md",
                enabled: false,
              },
            ],
          },
        ],
      },
    });

    render(
      <I18nProvider>
        <PickerHarness />
      </I18nProvider>,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Choose a Codex skill" }),
    );

    const list = await screen.findByRole("listbox", {
      name: "Codex Skills",
    });
    expect(api.executeCodexControl).toHaveBeenCalledWith("session-1", {
      control: "skills/list",
    });
    expect(
      within(list).getByRole("option", { name: "release-check" }),
    ).toBeDefined();
    expect(
      within(list).queryByRole("option", { name: "disabled-skill" }),
    ).toBeNull();
    expect(document.body.textContent).not.toContain(privatePath);
    expect(document.body.textContent).not.toContain("/test-fixtures");

    fireEvent.click(
      within(list).getByRole("option", { name: "release-check" }),
    );
    expect(screen.getByText("release-check")).toBeDefined();
    expect(document.body.textContent).not.toContain(privatePath);
    expect(JSON.stringify({ ...localStorage })).not.toContain(privatePath);
  });

  it("uses a generic unsupported fallback without exposing provider errors", async () => {
    const privatePath = "/test-fixtures/private/SKILL.md";
    vi.spyOn(api, "executeCodexControl").mockRejectedValue(
      new Error(`unsupported: ${privatePath}`),
    );

    render(
      <I18nProvider>
        <PickerHarness />
      </I18nProvider>,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Choose a Codex skill" }),
    );

    await waitFor(() =>
      expect(
        screen.getByText("Skills are unavailable for this Codex session."),
      ).toBeDefined(),
    );
    expect(document.body.textContent).not.toContain(privatePath);
  });

  it("rejects unsafe values and caps the parsed list", () => {
    const skills = Array.from({ length: 80 }, (_, index) => ({
      name: index === 0 ? "/private/path" : `skill-${index}`,
      path:
        index === 1
          ? "/test-fixtures/skills/unsafe\npath/SKILL.md"
          : `/test-fixtures/skills/skill-${index}/SKILL.md`,
      enabled: true,
    }));

    const parsed = parseCodexSkillsList({ data: [{ skills }] });

    expect(parsed).toHaveLength(40);
    expect(parsed.some((skill) => skill.name === "/private/path")).toBe(false);
    expect(parsed.some((skill) => skill.name === "skill-1")).toBe(false);
  });
});

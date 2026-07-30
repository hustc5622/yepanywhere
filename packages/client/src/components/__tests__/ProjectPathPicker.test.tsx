import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectDirectoryBrowseResponse } from "../../api/client";
import { I18nProvider } from "../../i18n";
import { ProjectPathPicker } from "../ProjectPathPicker";

const { browseProjectDirectories } = vi.hoisted(() => ({
  browseProjectDirectories: vi.fn(),
}));

vi.mock("../../api/client", () => ({
  api: {
    browseProjectDirectories,
  },
}));

function browseResponse(
  overrides: Partial<ProjectDirectoryBrowseResponse> = {},
): ProjectDirectoryBrowseResponse {
  return {
    path: "/Users/test",
    parent: "/Users",
    home: "/Users/test",
    directories: [
      {
        name: "code",
        path: "/Users/test/code",
        hidden: false,
      },
    ],
    exact: true,
    truncated: false,
    ...overrides,
  };
}

function PickerHarness({ initialValue = "" }: { initialValue?: string }) {
  const [value, setValue] = useState(initialValue);
  return (
    <I18nProvider>
      <ProjectPathPicker value={value} onChange={setValue} />
    </I18nProvider>
  );
}

describe("ProjectPathPicker", () => {
  beforeEach(() => {
    browseProjectDirectories.mockReset();
    browseProjectDirectories.mockResolvedValue(browseResponse());
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("lists the home directory and lets the user browse into a folder", async () => {
    render(<PickerHarness />);

    await waitFor(() => {
      expect(browseProjectDirectories).toHaveBeenCalledWith("", false);
    });
    fireEvent.click(await screen.findByRole("option", { name: "code" }));

    expect(
      (screen.getByLabelText("Project folder") as HTMLInputElement).value,
    ).toBe("/Users/test/code");
  });

  it("completes a single matching directory with Tab", async () => {
    browseProjectDirectories.mockResolvedValue(
      browseResponse({
        path: "/Users/test",
        exact: false,
      }),
    );
    render(<PickerHarness initialValue="/Users/test/co" />);

    const input = screen.getByLabelText("Project folder");
    await screen.findByRole("option", { name: "code" });
    fireEvent.keyDown(input, { key: "Tab" });

    expect((input as HTMLInputElement).value).toBe("/Users/test/code");
  });

  it("keeps Enter available for submitting an exact directory", async () => {
    render(<PickerHarness initialValue="/Users/test" />);

    const input = screen.getByLabelText("Project folder");
    await screen.findByRole("option", { name: "code" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect((input as HTMLInputElement).value).toBe("/Users/test");
  });

  it("reloads the listing when hidden folders are enabled", async () => {
    render(<PickerHarness />);
    await screen.findByRole("option", { name: "code" });

    fireEvent.click(screen.getByLabelText("Show hidden folders"));

    await waitFor(() => {
      expect(browseProjectDirectories).toHaveBeenLastCalledWith("", true);
    });
  });
});

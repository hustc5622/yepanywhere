import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { ProjectGitStatusSummary } from "@yep-anywhere/shared";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { I18nProvider } from "../../i18n";
import { UI_KEYS } from "../../lib/storageKeys";
import { ProjectGitStatusButton } from "../ProjectGitStatusButton";

const STATUS: ProjectGitStatusSummary = {
  isGitRepo: true,
  branch: "feature/sidebar-git-details",
  head: "abc1234",
  upstream: "origin/feature/sidebar-git-details",
  ahead: 2,
  behind: 1,
  isClean: false,
  stagedCount: 2,
  unstagedCount: 14,
  deletedCount: 1,
  untrackedCount: 3,
  conflictedCount: 0,
  stashCount: 1,
};

const originalPointerEvent = window.PointerEvent;

class MockPointerEvent extends MouseEvent {
  readonly pointerType: string;

  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerType = init.pointerType ?? "";
  }
}

function renderButton() {
  window.localStorage.setItem(UI_KEYS.locale, "en");
  return render(
    <I18nProvider>
      <ProjectGitStatusButton status={STATUS} projectName="Yep Anywhere" />
    </I18nProvider>,
  );
}

describe("ProjectGitStatusButton", () => {
  beforeAll(() => {
    Object.defineProperty(window, "PointerEvent", {
      configurable: true,
      value: MockPointerEvent,
    });
  });

  afterAll(() => {
    Object.defineProperty(window, "PointerEvent", {
      configurable: true,
      value: originalPointerEvent,
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    window.localStorage.removeItem(UI_KEYS.locale);
  });

  it("shows the complete Git summary on mouse hover", () => {
    renderButton();
    const button = screen.getByRole("button", {
      name: "Show Git details for Yep Anywhere",
    });

    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.pointerEnter(button, { pointerType: "mouse" });

    const popover = screen.getByRole("tooltip");
    expect(popover.textContent).toContain("feature/sidebar-git-details");
    expect(popover.textContent).toContain("Ahead 2");
    expect(popover.textContent).toContain("Behind 1");
    expect(popover.textContent).toContain("Changes14");
    expect(popover.textContent).toContain("Untracked3");

    fireEvent.pointerLeave(button, { pointerType: "mouse" });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("pins the summary after a touch long-press without closing on its click", () => {
    vi.useFakeTimers();
    renderButton();
    const button = screen.getByRole("button", {
      name: "Show Git details for Yep Anywhere",
    });

    fireEvent.pointerDown(button, {
      pointerType: "touch",
      clientX: 20,
      clientY: 20,
    });
    act(() => vi.advanceTimersByTime(500));

    expect(screen.getByRole("tooltip")).not.toBeNull();
    fireEvent.pointerUp(button, { pointerType: "touch" });
    fireEvent.click(button);
    expect(screen.getByRole("tooltip")).not.toBeNull();
  });

  it("opens on tap/click and closes when clicking outside", () => {
    renderButton();
    const button = screen.getByRole("button", {
      name: "Show Git details for Yep Anywhere",
    });

    fireEvent.click(button);
    expect(screen.getByRole("tooltip")).not.toBeNull();

    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});

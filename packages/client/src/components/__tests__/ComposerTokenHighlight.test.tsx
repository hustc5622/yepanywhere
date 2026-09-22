import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposerTokenHighlight } from "../ComposerTokenHighlight";

function Composer({
  onTokenClick,
  disabled = false,
}: {
  onTokenClick: (name: string, occurrence: number) => void;
  disabled?: boolean;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const text = "before @[image.png] between @[image.png] after";
  return (
    <div>
      <ComposerTokenHighlight
        textareaRef={textareaRef}
        text={text}
        names={["image.png"]}
        onTokenClick={onTokenClick}
      />
      <textarea ref={textareaRef} defaultValue={text} disabled={disabled} />
    </div>
  );
}

function setup(disabled = false) {
  const onTokenClick = vi.fn();
  const result = render(
    <Composer onTokenClick={onTokenClick} disabled={disabled} />,
  );
  const chips = result.container.querySelectorAll(".composer-token-chip");
  const [firstChip, secondChip] = chips;
  if (!firstChip || !secondChip) throw new Error("Expected two attachments");
  // The second attachment wraps, leaving plain text beside each fragment.
  vi.spyOn(firstChip, "getClientRects").mockReturnValue([
    new DOMRect(60, 10, 100, 20),
  ] as unknown as DOMRectList);
  vi.spyOn(secondChip, "getClientRects").mockReturnValue([
    new DOMRect(220, 10, 80, 20),
    new DOMRect(10, 30, 50, 20),
  ] as unknown as DOMRectList);
  return {
    ...result,
    onTokenClick,
    textarea: screen.getByRole("textbox") as HTMLTextAreaElement,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ComposerTokenHighlight input layer", () => {
  it("opens the correct occurrence from either fragment of a wrapped token", () => {
    const { textarea, onTokenClick } = setup();
    fireEvent.click(textarea, { clientX: 80, clientY: 20 });
    fireEvent.click(textarea, { clientX: 240, clientY: 20 });
    fireEvent.click(textarea, { clientX: 30, clientY: 40 });
    expect(onTokenClick.mock.calls).toEqual([
      ["image.png", 0],
      ["image.png", 1],
      ["image.png", 1],
    ]);
  });

  it("keeps the insertion point when opening a preview, while plain text remains editable", () => {
    const { textarea, onTokenClick } = setup();
    textarea.focus();
    textarea.setSelectionRange(4, 4);
    expect(
      fireEvent.mouseDown(textarea, { clientX: 80, clientY: 20, button: 0 }),
    ).toBe(false);
    fireEvent.click(textarea, { clientX: 80, clientY: 20 });
    expect(textarea.selectionStart).toBe(4);
    expect(document.activeElement).toBe(textarea);

    onTokenClick.mockClear();
    // Inside the wrapped token's bounding box, but outside its fragments.
    expect(
      fireEvent.mouseDown(textarea, { clientX: 180, clientY: 40, button: 0 }),
    ).toBe(true);
    fireEvent.click(textarea, { clientX: 180, clientY: 40 });
    expect(onTokenClick).not.toHaveBeenCalled();
  });

  it("does not open previews from a disabled input", () => {
    const { textarea, onTokenClick } = setup(true);
    fireEvent.click(textarea, { clientX: 80, clientY: 20 });
    expect(onTokenClick).not.toHaveBeenCalled();
  });
});

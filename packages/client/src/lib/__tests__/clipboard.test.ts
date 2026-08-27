import { afterEach, describe, expect, it, vi } from "vitest";
import { readClipboardUserInput, writeClipboardUserInput } from "../clipboard";

const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(
  navigator,
  "clipboard",
);
const originalSecureContextDescriptor = Object.getOwnPropertyDescriptor(
  window,
  "isSecureContext",
);

interface ClipboardItemMockValue {
  representations: Record<string, string | Blob | PromiseLike<string | Blob>>;
}

function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result ?? "")));
    reader.addEventListener("error", () => reject(reader.error));
    reader.readAsText(blob);
  });
}

function installRichClipboardMock(): ClipboardItemMockValue[] {
  const writtenItems: ClipboardItemMockValue[] = [];
  class ClipboardItemMock {
    representations: ClipboardItemMockValue["representations"];

    constructor(representations: ClipboardItemMockValue["representations"]) {
      this.representations = representations;
    }

    static supports(type: string) {
      return type === "text/html";
    }
  }
  vi.stubGlobal("ClipboardItem", ClipboardItemMock);
  Object.defineProperty(window, "isSecureContext", {
    configurable: true,
    value: true,
  });
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      write: vi.fn(async (items: ClipboardItemMockValue[]) => {
        writtenItems.push(...items);
        await items[0]?.representations["text/html"];
      }),
      writeText: vi.fn(),
    },
  });
  return writtenItems;
}

afterEach(() => {
  if (originalClipboardDescriptor) {
    Object.defineProperty(navigator, "clipboard", originalClipboardDescriptor);
  } else {
    Reflect.deleteProperty(navigator, "clipboard");
  }
  if (originalSecureContextDescriptor) {
    Object.defineProperty(
      window,
      "isSecureContext",
      originalSecureContextDescriptor,
    );
  } else {
    Reflect.deleteProperty(window, "isSecureContext");
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("user input clipboard payload", () => {
  it("writes plain text and every image into one rich clipboard item", async () => {
    const writtenItems = installRichClipboardMock();

    const result = await writeClipboardUserInput("review both", [
      {
        name: "first.png",
        mimeType: "image/png",
        sourceUrl: "data:image/png;base64,Zmlyc3Q=",
      },
      {
        name: "second.png",
        mimeType: "image/png",
        sourceUrl: "data:image/png;base64,c2Vjb25k",
      },
    ]);

    expect(result).toEqual({ requestedImageCount: 2, copiedImageCount: 2 });
    expect(writtenItems).toHaveLength(1);

    const htmlBlob = await writtenItems[0]?.representations["text/html"];
    expect(htmlBlob).toBeInstanceOf(Blob);
    const html = await readBlob(htmlBlob as Blob);
    expect(html).toContain('data-yep-anywhere-user-input="1"');
    expect(html).toContain('data-yep-anywhere-attachment-name="first.png"');
    expect(html).toContain('data-yep-anywhere-attachment-name="second.png"');
    expect(html).toContain("review both");
  });

  it("uses declared image metadata when a managed download is octet-stream", async () => {
    const writtenItems = installRichClipboardMock();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        blob: async () =>
          new Blob([new Uint8Array([1, 2, 3])], {
            type: "application/octet-stream",
          }),
      }),
    );

    const result = await writeClipboardUserInput("managed image", [
      {
        name: "feishu-1.image",
        mimeType: "image/png",
        sourceUrl: "/api/projects/project/sessions/session/upload/image",
      },
    ]);

    expect(result).toEqual({ requestedImageCount: 1, copiedImageCount: 1 });
    const htmlBlob = await writtenItems[0]?.representations["text/html"];
    const html = await readBlob(htmlBlob as Blob);
    expect(html).toContain("data:image/png;base64,AQID");
  });

  it("restores copied text and all embedded images as named files", () => {
    const payload = readClipboardUserInput({
      getData: (type) => {
        if (type === "text/plain") return "review both";
        if (type === "text/html") {
          return `<div data-yep-anywhere-user-input="1">
            <img src="data:image/png;base64,Zmlyc3Q=" data-yep-anywhere-attachment-name="first.png">
            <img src="data:image/jpeg;base64,c2Vjb25k" data-yep-anywhere-attachment-name="folder/second.jpg">
          </div>`;
        }
        return "";
      },
    });

    expect(payload?.text).toBe("review both");
    expect(payload?.images.map((file) => file.name)).toEqual([
      "first.png",
      "second.jpg",
    ]);
    expect(payload?.images.map((file) => file.type)).toEqual([
      "image/png",
      "image/jpeg",
    ]);
    expect(payload?.images.map((file) => file.size)).toEqual([5, 6]);
  });

  it("ignores ordinary rich clipboard HTML without the Yep marker", () => {
    expect(
      readClipboardUserInput({
        getData: (type) =>
          type === "text/html"
            ? '<p>hello<img src="data:image/png;base64,Zm9v"></p>'
            : "hello",
      }),
    ).toBeNull();
  });
});

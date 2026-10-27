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

    expect(result).toEqual({
      requestedAttachmentCount: 2,
      copiedAttachmentCount: 2,
      failedNames: [],
    });
    expect(writtenItems).toHaveLength(1);

    const htmlBlob = await writtenItems[0]?.representations["text/html"];
    expect(htmlBlob).toBeInstanceOf(Blob);
    const html = await readBlob(htmlBlob as Blob);
    expect(html).toContain('data-yep-anywhere-user-input="2"');
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

    expect(result).toEqual({
      requestedAttachmentCount: 1,
      copiedAttachmentCount: 1,
      failedNames: [],
    });
    const htmlBlob = await writtenItems[0]?.representations["text/html"];
    const html = await readBlob(htmlBlob as Blob);
    expect(html).toContain("data:image/png;base64,AQID");
  });

  it("restores a v1 copy's text and images as named files", () => {
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
    const files = (payload?.attachments ?? []).flatMap((entry) =>
      entry.kind === "file" ? [entry.file] : [],
    );
    expect(files.map((file) => file.name)).toEqual(["first.png", "second.jpg"]);
    expect(files.map((file) => file.type)).toEqual(["image/png", "image/jpeg"]);
    expect(files.map((file) => file.size)).toEqual([5, 6]);
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

  it("round-trips images, files, references and misses in order", async () => {
    const writtenItems = installRichClipboardMock();
    const big = new Blob([new Uint8Array(6 * 1024 * 1024)], {
      type: "application/zip",
    });
    const reference =
      "/api/projects/cHJvamVjdA/sessions/session-1/upload/123e4567-e89b-12d3-a456-426614174000_big.zip";
    const result = await writeClipboardUserInput(
      "see @[a.png] and @[notes.pdf] @[big.zip] @[gone.txt]",
      [
        {
          name: "a.png",
          mimeType: "image/png",
          read: async () => new Blob(["png"], { type: "image/png" }),
        },
        {
          name: "notes.pdf",
          mimeType: "application/pdf",
          read: async () => new Blob(["%PDF"], { type: "" }),
        },
        {
          name: "big.zip",
          mimeType: "application/zip",
          read: async () => big,
          reference,
        },
        { name: "gone.txt", mimeType: "text/plain" },
      ],
    );
    expect(result).toEqual({
      requestedAttachmentCount: 4,
      copiedAttachmentCount: 3,
      failedNames: ["gone.txt"],
    });

    const html = await readBlob(
      (await writtenItems[0]?.representations["text/html"]) as Blob,
    );
    expect(html).not.toContain("AAAAAAAA".repeat(1000));
    const payload = readClipboardUserInput({
      getData: (type) =>
        type === "text/html"
          ? html
          : "see @[a.png] and @[notes.pdf] @[big.zip] @[gone.txt]",
    });
    expect(payload?.missingNames).toEqual(["gone.txt"]);
    const entries = payload?.attachments ?? [];
    expect(entries.map((entry) => entry.kind)).toEqual([
      "file",
      "file",
      "reference",
    ]);
    const [image, pdf, ref] = entries;
    expect(image?.kind === "file" && image.file.name).toBe("a.png");
    expect(pdf?.kind === "file" && [pdf.file.name, pdf.file.type]).toEqual([
      "notes.pdf",
      "application/pdf",
    ]);
    expect(pdf?.kind === "file" && (await readBlob(pdf.file))).toBe("%PDF");
    expect(ref).toEqual({
      kind: "reference",
      name: "big.zip",
      mimeType: "application/zip",
      path: reference,
    });
  });

  it("ignores references that are not managed upload routes", () => {
    const payload = readClipboardUserInput({
      getData: (type) =>
        type === "text/html"
          ? `<div data-yep-anywhere-user-input="2"><span data-yep-anywhere-attachment-name="x" data-yep-anywhere-attachment-ref="/api/settings"></span></div>`
          : "@[x]",
    });
    expect(payload?.attachments).toEqual([]);
    expect(payload?.missingNames).toEqual(["x"]);
  });
});

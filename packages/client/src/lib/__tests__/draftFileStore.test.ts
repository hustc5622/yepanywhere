import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import {
  DRAFT_FILES_TTL_MS,
  DRAFT_FILE_MAX_BYTES,
  createDraftFileStore,
} from "../draftFileStore";

function readText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsText(file);
  });
}

describe("draft file store", () => {
  it("round-trips files in order and saves incrementally", async () => {
    const store = createDraftFileStore(new IDBFactory());
    const a = new File(["alpha"], "a.png", {
      type: "image/png",
      lastModified: 5,
    });
    const b = new File(["beta"], "b.pdf", { type: "application/pdf" });
    await store.save("draft", [
      { id: "1", file: a },
      { id: "2", file: b },
    ]);
    let loaded = await store.load("draft");
    expect(
      loaded.map((entry) => [entry.id, entry.file.name, entry.file.type]),
    ).toEqual([
      ["1", "a.png", "image/png"],
      ["2", "b.pdf", "application/pdf"],
    ]);
    expect(loaded[0]?.file.lastModified).toBe(5);
    expect(await readText(loaded[1]?.file as File)).toBe("beta");

    // Re-saving keeps stored bytes; removal deletes the record.
    const replaced = new File(["changed"], "a.png", { type: "image/png" });
    await store.save("draft", [{ id: "1", file: replaced }]);
    loaded = await store.load("draft");
    expect(loaded.map((entry) => entry.id)).toEqual(["1"]);
    expect(await readText(loaded[0]?.file as File)).toBe("alpha");
    expect(await store.load("other")).toEqual([]);

    await store.save("draft", []);
    expect(await store.load("draft")).toEqual([]);
  });

  it("keeps oversized files out and expires old drafts", async () => {
    let now = 1_000;
    const store = createDraftFileStore(new IDBFactory(), () => now);
    const big = new File(["x"], "big.zip");
    Object.defineProperty(big, "size", { value: DRAFT_FILE_MAX_BYTES + 1 });
    const small = new File(["ok"], "ok.txt", { type: "text/plain" });
    const result = await store.save("draft", [
      { id: "big", file: big },
      { id: "ok", file: small },
    ]);
    expect(result.skippedNames).toEqual(["big.zip"]);
    expect((await store.load("draft")).map((entry) => entry.id)).toEqual([
      "ok",
    ]);

    now += DRAFT_FILES_TTL_MS + 1;
    expect(await store.load("draft")).toEqual([]);
  });

  it("degrades to a no-op without IndexedDB", async () => {
    const store = createDraftFileStore(undefined);
    expect(
      await store.save("draft", [{ id: "1", file: new File(["a"], "a.txt") }]),
    ).toEqual({ skippedNames: [] });
    expect(await store.load("draft")).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { protobufDigestChildren } from "../../src/sessions/cursor-store.js";

const hex = (value: string) => Buffer.from(value.replace(/\s/g, ""), "hex");

describe("Cursor blob protobuf walker", () => {
  // These lengths overflowed a 32-bit shift into a negative value, which moved
  // the read offset backwards and spun the event loop forever.
  it("stops on a length varint that does not fit the blob", () => {
    expect(protobufDigestChildren(hex("0a fa ff ff ff 0f"))).toEqual([]);
    expect(protobufDigestChildren(hex("08 01 0a f8 ff ff ff 0f"))).toEqual([]);
  });

  it("stops on a varint wider than a safe integer", () => {
    expect(
      protobufDigestChildren(hex("0a ff ff ff ff ff ff ff ff 7f")),
    ).toEqual([]);
  });

  it("still reads digest children around other field types", () => {
    const digest = "ab".repeat(32);
    const blob = Buffer.concat([
      hex("08 96 01"), // field 1 varint 150
      hex("12 20"), // field 2, 32 bytes
      Buffer.from(digest, "hex"),
      hex("1d 01 02 03 04"), // field 3 fixed32
      hex("6a 20"), // field 13, 32 bytes
      Buffer.from(digest.replace(/ab/g, "cd"), "hex"),
    ]);
    expect(protobufDigestChildren(blob)).toEqual([
      digest,
      digest.replace(/ab/g, "cd"),
    ]);
  });

  it("terminates on arbitrary input", () => {
    for (let seed = 1; seed <= 2_000; seed++) {
      let state = seed;
      const bytes = Buffer.alloc(48);
      for (let i = 0; i < bytes.length; i++) {
        state = (state * 1103515245 + 12345) % 2 ** 31;
        bytes[i] = state & 0xff;
      }
      expect(Array.isArray(protobufDigestChildren(bytes))).toBe(true);
    }
  });
});

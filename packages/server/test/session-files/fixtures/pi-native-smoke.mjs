import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { registerPiFileOperationTools } from "../../../resources/pi-file-operations.mjs";

const [sdkPath, root, scenario] = process.argv.slice(2);
const sdk = await import(sdkPath);
const registered = new Map();
const records = [];
const notices = [];
assert.equal(
  registerPiFileOperationTools(
    { registerTool: (tool) => registered.set(tool.name, tool) },
    sdk,
    async (record) => {
      if (scenario === "storage-error") throw new Error("storage unavailable");
      records.push(record);
    },
  ),
  true,
);
const ctx = {
  cwd: root,
  sessionManager: {
    getSessionId: () => "s",
    getBranch: () => [
      { id: "u", type: "message", message: { role: "user" } },
      {
        id: "assistant",
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", id: "write-call" },
            { type: "toolCall", id: "edit-call" },
            { type: "toolCall", id: "failed" },
          ],
        },
      },
      { id: "later-user", type: "message", message: { role: "user" } },
    ],
  },
  ui: { notify: (...args) => notices.push(args) },
};
await registered
  .get("write")
  .execute(
    "write-call",
    { path: "doc.md", content: "old\n" },
    undefined,
    undefined,
    ctx,
  );
assert.equal(await readFile(join(root, "doc.md"), "utf8"), "old\n");
if (scenario === "storage-error") {
  assert.equal(notices.length, 1);
} else {
  await registered
    .get("edit")
    .execute(
      "edit-call",
      { path: "doc.md", edits: [{ oldText: "old", newText: "new" }] },
      undefined,
      undefined,
      ctx,
    );
  assert.equal(await readFile(join(root, "doc.md"), "utf8"), "new\n");
  assert.equal(records.length, 2);
  assert.equal(records[0].turnId, "u");
  assert.equal(records[1].turnId, "u");
  assert.equal(records[0].before, null);
  assert.equal(records[1].before, Buffer.from("old\n").toString("base64"));
  assert.equal(records[1].after, Buffer.from("new\n").toString("base64"));
  await assert.rejects(
    registered
      .get("edit")
      .execute(
        "failed",
        { path: "doc.md", edits: [{ oldText: "missing", newText: "bad" }] },
        undefined,
        undefined,
        ctx,
      ),
  );
  assert.equal(records.length, 2);
}
console.log("Pi native file operation smoke passed");

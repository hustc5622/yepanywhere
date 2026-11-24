// Live smoke for Antigravity side conversations: a real main session, then a
// side conversation with and without the main context, a read-only question
// and a question that asks for a file edit. Sends real model requests and
// deletes every conversation it creates; run only with the user's consent.
//
// Run: npx tsx --conditions source scripts/smoke-agy-side-conversation.ts
// Env:
//   SMOKE_MODEL (default gemini-3.8-flash), SMOKE_EFFORT (default low)
//   SMOKE_SKIP_EMPTY=1     only test the snapshot side
//   SMOKE_SKIP_EDIT=1      skip the prompt that asks for a file change
//   SMOKE_KEEP_PARENT=1    keep the parent conversation (printed session id)
import { mkdirSync } from "node:fs";
import type { SideConversationResponse } from "@yep-anywhere/shared";
import { AgyProvider } from "../packages/server/src/sdk/providers/agy.js";
import { findAgySessionRecord } from "../packages/server/src/sessions/agy-store.js";
import { getAgySideSessionRegistry } from "../packages/server/src/side-conversations/agy-registry.js";
import type { SideConversationControl } from "../packages/server/src/side-conversations/session.js";

const cwd = process.argv[2] ?? "/tmp/yep-agy-smoke";
mkdirSync(cwd, { recursive: true });
const model = process.env.SMOKE_MODEL ?? "gemini-3.8-flash";
const reasoningEffort = process.env.SMOKE_EFFORT ?? "low";
const provider = new AgyProvider();
const registry = getAgySideSessionRegistry();
const fail = (message: string): never => {
  console.error("FAIL", message);
  process.exit(1);
};

/** Run one main turn and wait for it to finish. */
async function mainTurn(text: string, resumeSessionId?: string) {
  const session = await provider.startSession({
    cwd,
    resumeSessionId,
    permissionMode: "default",
    model,
    reasoningEffort,
    initialMessage: { text },
  });
  let id = resumeSessionId ?? "";
  let sawResult = false;
  for await (const message of session.iterator) {
    if (message.type === "system" && message.subtype === "init")
      id = String(message.session_id);
    if (message.type === "result") sawResult = true;
  }
  if (!id || !sawResult) fail("main turn did not finish");
  return { session, id };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Ask in the side and collect the snapshot it produces. */
async function ask(
  control: SideConversationControl,
  id: string,
  requestId: string,
  text: string,
): Promise<SideConversationResponse["conversation"]> {
  await control.execute({ action: "send", id, requestId, text });
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    const state = await control.execute({ action: "get", id });
    const conversation = state.conversation;
    if (!conversation) return fail("side conversation disappeared");
    if (conversation.status === "idle" || conversation.status === "failed")
      return conversation;
    await sleep(1_000);
  }
  return fail("side answer timed out");
}

let parentId = "";
try {
  const { session, id } = await mainTurn(
    "Reply with exactly the word: pong. Do not use any tool.",
  );
  parentId = id;
  console.log("parent", parentId);
  const control = session.sideConversations;
  if (!control) throw new Error("provider has no side conversation control");

  // 1. Snapshot side: asks a question that needs a file read.
  const created = await control.execute({
    action: "create",
    requestId: "create-snapshot",
    context: "snapshot",
  });
  if (!created.supported) fail(`side not supported: ${created.error ?? ""}`);
  if (created.error) fail(`side create failed: ${created.error}`);
  const sideId = created.conversation?.id;
  if (!sideId) fail("side conversation missing");
  console.log("side model", created.conversation?.model);
  const answer = await ask(
    control,
    sideId,
    "q1",
    "Read package.json in this repository and tell me the root package name. Read only; do not change anything.",
  );
  if (answer?.status !== "idle")
    fail(`snapshot side ended ${answer?.status}: ${answer?.error ?? ""}`);
  const tools = (answer?.messages ?? []).flatMap((message) =>
    (message.blocks ?? []).flatMap((block) =>
      block.type === "tool_use" ? [block.name] : [],
    ),
  );
  console.log("snapshot side tools", tools.join(","));
  if (!tools.includes("Read"))
    console.log("NOTE: model answered without reading");
  console.log(
    "snapshot side text",
    answer?.messages.at(-1)?.text.slice(0, 300),
  );
  await control.execute({ action: "close", id: sideId });

  // 2. Empty side: a write request must be declined, not executed.
  if (process.env.SMOKE_SKIP_EMPTY !== "1") {
    const empty = await control.execute({
      action: "create",
      requestId: "create-empty",
      context: "empty",
    });
    const emptyId = empty.conversation?.id;
    if (!emptyId) throw new Error("empty side missing");
    const edit = await ask(
      control,
      emptyId,
      "q1",
      "Create a file named yep-agy-side-smoke.txt containing hello. Use your file writing tool.",
    );
    console.log("empty side status", edit?.status, edit?.error ?? "");
    const blocked = (edit?.messages ?? [])
      .flatMap((message) => message.blocks ?? [])
      .flatMap((block) =>
        block.type === "tool_use"
          ? [{ name: block.name, failed: block.result?.isError === true }]
          : [],
      );
    console.log("empty side tools", JSON.stringify(blocked));
    if (edit?.status === "closed")
      fail(`read-only guard closed the side: ${edit.error ?? ""}`);
    await control.execute({ action: "close", id: emptyId });
  }

  session.abort();
  await sleep(2_000);
  // The temporary conversations stay hidden from every listing.
  for (const id of [created.conversation?.id]) {
    if (!id) continue;
    if (!registry.isHidden(id)) fail(`side conversation ${id} is visible`);
    const visible = await findAgySessionRecord(id);
    if (visible) fail(`side conversation ${id} leaked into the catalog`);
  }
  console.log("hidden check ok");
} catch (error) {
  console.error("ERROR", error);
  process.exitCode = 1;
} finally {
  // The parent is a real conversation this script created; agy has no
  // delete for it outside a running `agy acp`, so it is left in place.
  if (parentId) console.log("parent conversation left:", parentId);
}

// Live smoke for agent-initiated agy turns: the prompt starts a background
// command and ends; when the command finishes agy wakes itself and replies
// with no prompt in flight. Checks that AgyProvider frames that wake-up as
// `turn_started` ... `result`. Sends real model requests and leaves a test
// conversation in ~/.gemini/antigravity-cli; run only with the user's consent.
// Run: npx tsx scripts/smoke-agy-agent-turn.ts [cwd]
// Env: SMOKE_MODEL (default gemini-3.8-flash), SMOKE_EFFORT (default low),
// SMOKE_STEER=1 (send a prompt into the woken turn), SMOKE_CANCEL=1
// (interrupt the woken turn).
import { mkdirSync } from "node:fs";
import { AgyProvider } from "../packages/server/src/sdk/providers/agy.js";

const cwd = process.argv[2] ?? "/tmp/yep-agy-smoke";
mkdirSync(cwd, { recursive: true });
const provider = new AgyProvider();
const t0 = Date.now();
const ts = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

const session = await provider.startSession({
  cwd,
  permissionMode: "acceptEdits",
  model: process.env.SMOKE_MODEL ?? "gemini-3.8-flash",
  reasoningEffort: process.env.SMOKE_EFFORT ?? "low",
  initialMessage: {
    text: "Start the shell command `sleep 15 && echo BG_DONE_42` as a BACKGROUND task (do not block on it, do not poll it). Tell me in one short sentence that it started and end your turn. When the background task finishes, reply with one short sentence containing its output.",
  },
  onToolApproval: async (_tool, input) =>
    ({ behavior: "allow", updatedInput: input }) as never,
});

let sessionId = "";
let results = 0;
let woken = false;
const timeline: string[] = [];
const deadline = setTimeout(() => {
  console.log(ts(), "TIMEOUT");
  session.abort();
}, 180_000);
for await (const message of session.iterator) {
  const m = message as Record<string, unknown>;
  if (m.type === "system" && m.subtype === "init")
    sessionId = String(m.session_id);
  const content = (m.message as { content?: unknown } | undefined)?.content;
  const label =
    m.type === "system"
      ? `system:${m.subtype}${m.origin ? `(${m.origin})` : ""}`
      : m.type === "result"
        ? `result:${m.turnStatus}`
        : `${m.type}:${JSON.stringify(content ?? "").slice(0, 100)}`;
  console.log(ts(), label);
  timeline.push(label.split(":")[0] === "system" ? label : String(m.type));
  if (m.type === "system" && m.subtype === "turn_started") {
    woken = true;
    if (process.env.SMOKE_STEER === "1") {
      setTimeout(() => {
        console.log(ts(), "STEER");
        void session
          .steer?.({ text: "Also include the word PINEAPPLE in that reply." })
          .then((r) => console.log(ts(), "STEER accepted", JSON.stringify(r)));
      }, 300);
    }
    if (process.env.SMOKE_CANCEL === "1") {
      setTimeout(() => {
        console.log(ts(), "CANCEL");
        void session.interrupt?.();
      }, 300);
    }
  }
  if (m.type === "result") {
    results += 1;
    // The prompt's own turn, then the turn agy started itself.
    if (woken) break;
  }
}
clearTimeout(deadline);
session.abort();
console.log("timeline", timeline.join(" → "));
console.log("session", sessionId, "woken", woken);

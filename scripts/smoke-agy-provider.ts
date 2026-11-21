// Live smoke for AgyProvider: new session -> prompt -> resume -> tool prompt
// -> question -> reader projection. Sends real model requests and leaves test
// conversations in ~/.gemini/antigravity-cli; run only with the user's consent.
// Run: npx tsx scripts/smoke-agy-provider.ts [cwd]
// Env: SMOKE_RESUME=<id>, SMOKE_PROMPT, SMOKE_DENY=1, SMOKE_MODEL (default
// gemini-3.8-flash), SMOKE_EFFORT (default low), SMOKE_MODE (default default),
// SMOKE_MODELS=1 (print catalog), SMOKE_QUESTION=0 (skip the question turn).
import { mkdirSync } from "node:fs";
import type { PermissionMode } from "@yep-anywhere/shared";
import { AgyProvider } from "../packages/server/src/sdk/providers/agy.js";
import { AgySessionReader } from "../packages/server/src/sessions/agy-reader.js";
import { normalizeSession } from "../packages/server/src/sessions/normalization.js";

const cwd = process.argv[2] ?? "/tmp/yep-agy-smoke";
mkdirSync(cwd, { recursive: true });
const provider = new AgyProvider();
console.log("installed", await provider.isInstalled());
console.log("auth", await provider.getAuthStatus());
if (process.env.SMOKE_MODELS === "1") {
  const models = await provider.getAvailableModels();
  console.log("models", JSON.stringify(models).slice(0, 1200));
}

const model = process.env.SMOKE_MODEL ?? "gemini-3.8-flash";
const reasoningEffort = process.env.SMOKE_EFFORT ?? "low";
const permissionMode = (process.env.SMOKE_MODE ?? "default") as PermissionMode;
const denyApprovals = process.env.SMOKE_DENY === "1";
const approvals: string[] = [];

async function runTurn(text: string, resumeSessionId?: string) {
  const session = await provider.startSession({
    cwd,
    resumeSessionId,
    permissionMode,
    model,
    reasoningEffort,
    initialMessage: { text },
    onToolApproval: async (toolName, input) => {
      approvals.push(toolName);
      if (toolName === "AskUserQuestion") {
        const questions = (
          input as { questions: Array<Record<string, unknown>> }
        ).questions;
        console.log("  [question]", JSON.stringify(questions).slice(0, 400));
        const answers = Object.fromEntries(
          questions.map((q) => {
            const options = q.options as Array<{ value: string }>;
            return [q.id as string, options.at(-1)?.value ?? "free text"];
          }),
        );
        return {
          behavior: "allow",
          updatedInput: { ...input, answers },
        } as never;
      }
      console.log(
        "  [approval]",
        toolName,
        JSON.stringify(input).slice(0, 200),
      );
      return (
        denyApprovals
          ? { behavior: "deny", message: "denied by smoke test" }
          : { behavior: "allow", updatedInput: input }
      ) as never;
    },
  });
  let sessionId = "";
  for await (const message of session.iterator) {
    const m = message as Record<string, unknown>;
    if (m.type === "system" && m.subtype === "init") {
      sessionId = String(m.session_id);
      console.log(
        "  init",
        sessionId,
        "model",
        m.model,
        "effort",
        m.reasoningEffort,
      );
    } else if (m.type === "result") {
      console.log("  result", m.turnStatus);
      break;
    } else if (m.type === "error") {
      console.log("  ERROR", m.error);
      break;
    } else {
      const content = (m.message as { content?: unknown })?.content;
      const summary =
        typeof content === "string"
          ? `text(${content.length}): ${content.slice(0, 80)}`
          : String(JSON.stringify(content ?? m)).slice(0, 200);
      console.log(" ", m.type, summary);
    }
  }
  session.abort();
  return sessionId;
}

let sessionId = process.env.SMOKE_RESUME ?? "";
if (!sessionId) {
  console.log("== turn 1 (new)");
  sessionId = await runTurn("Reply with exactly the word: pong");
}
console.log("== turn 2 (resume + tool)");
await runTurn(
  process.env.SMOKE_PROMPT ??
    "Create a file named yep-agy.txt containing exactly: yep-agy-ok. Then run the shell command `cat yep-agy.txt` and reply with its output.",
  sessionId,
);
if (process.env.SMOKE_QUESTION !== "0") {
  console.log("== turn 3 (question)");
  await runTurn(
    "Use your ask_question tool to ask me which color I prefer (options: red, blue), then reply with one sentence stating my answer.",
    sessionId,
  );
}

await new Promise((resolve) => setTimeout(resolve, 1500));
const reader = new AgySessionReader({ projectPath: cwd });
const loaded = await reader.getSession(sessionId, "p" as never);
console.log("== reader summary", JSON.stringify(loaded?.summary).slice(0, 500));
if (loaded) {
  const normalized = normalizeSession(loaded);
  for (const msg of normalized.messages) {
    console.log(
      "  ",
      msg.type,
      JSON.stringify(msg.message?.content ?? msg.content ?? null).slice(0, 160),
    );
  }
}
console.log("approvals", approvals);
process.exit(0);

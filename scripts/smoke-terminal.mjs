/**
 * Smoke test for the remote terminal WebSocket flow.
 *
 * - Connects to /api/ws using the server's configured authentication state.
 * - Sends terminal_open with a fresh terminalId.
 * - Sends a couple of stdin lines, prints echoed output.
 * - Sends terminal_close (no kill).
 * - Reconnects with the SAME terminalId, expects scrollback replay
 *   plus terminal_opened with attached:true.
 */

import { randomUUID } from "node:crypto";
import WebSocket from "ws";

const URL = process.env.WS_URL || "ws://localhost:4500/api/ws";
const TERM_ID = process.env.TERM_ID || randomUUID();

function decodeOutput(b64) {
  return Buffer.from(b64, "base64").toString("utf8");
}

function attach(label, { kill = false, sendInputs = [] } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const events = [];
    let openedSeen = false;

    const finish = (err) => {
      try {
        ws.close();
      } catch {}
      err ? reject(err) : resolve(events);
    };

    ws.on("open", () => {
      console.log(`[${label}] WS open`);
      ws.send(
        JSON.stringify({
          type: "terminal_open",
          terminalId: TERM_ID,
          cols: 80,
          rows: 24,
        }),
      );
    });

    ws.on("message", async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        console.log(`[${label}] non-json ${raw.length}b`);
        return;
      }
      if (msg.type === "terminal_opened") {
        events.push({ type: "opened", attached: msg.attached, pid: msg.pid });
        console.log(
          `[${label}] terminal_opened attached=${msg.attached} pid=${msg.pid} cwd=${msg.cwd}`,
        );
        openedSeen = true;
        // Send any test inputs after opened
        for (let i = 0; i < sendInputs.length; i++) {
          const text = sendInputs[i];
          await new Promise((r) => setTimeout(r, 200));
          console.log(`[${label}] sendInput ${JSON.stringify(text)}`);
          ws.send(
            JSON.stringify({
              type: "terminal_input",
              terminalId: TERM_ID,
              data: Buffer.from(text, "utf8").toString("base64"),
            }),
          );
        }
        // Wait a bit for output, then close
        setTimeout(() => {
          console.log(`[${label}] sending terminal_close kill=${kill}`);
          ws.send(
            JSON.stringify({
              type: "terminal_close",
              terminalId: TERM_ID,
              kill,
            }),
          );
          setTimeout(finish, 200);
        }, 800);
      } else if (msg.type === "terminal_output") {
        const out = decodeOutput(msg.data);
        events.push({ type: "output", bytes: out.length });
        process.stdout.write(`[${label}] out: ${JSON.stringify(out)}\n`);
      } else if (msg.type === "terminal_exit") {
        events.push({ type: "exit", exitCode: msg.exitCode });
        console.log(`[${label}] terminal_exit code=${msg.exitCode}`);
      } else if (msg.type === "terminal_error") {
        events.push({ type: "error", message: msg.message });
        console.log(`[${label}] terminal_error ${msg.message}`);
        finish(new Error(msg.message));
      } else {
        // Ignore other messages (pong, etc.)
      }
    });

    ws.on("close", (code, reason) => {
      console.log(
        `[${label}] WS close code=${code} reason=${reason?.toString() || "-"}`,
      );
      if (!openedSeen) finish(new Error("never received terminal_opened"));
    });

    ws.on("error", (err) => {
      console.error(`[${label}] WS error:`, err.message);
      finish(err);
    });
  });
}

(async () => {
  console.log(`Smoke test terminalId=${TERM_ID}`);
  const ev1 = await attach("first", {
    sendInputs: ["echo hello-from-yepa\n"],
  });
  console.log("---first attach summary---", JSON.stringify(ev1));

  console.log("Reconnecting with same terminalId...");
  await new Promise((r) => setTimeout(r, 300));
  const ev2 = await attach("reattach", {
    sendInputs: ["echo round-two\n"],
    kill: true,
  });
  console.log("---reattach summary---", JSON.stringify(ev2));

  const reattached = ev2.find((e) => e.type === "opened")?.attached === true;
  const sawScrollback = ev2.some((e) => e.type === "output");
  console.log(
    `\nVERDICT: reattached=${reattached} sawOutputOnReattach=${sawScrollback}`,
  );
  if (!reattached || !sawScrollback) process.exit(2);
})().catch((err) => {
  console.error("Smoke test failed:", err);
  process.exit(1);
});

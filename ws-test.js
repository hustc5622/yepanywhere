const WebSocket = require("ws");
const ws = new WebSocket("ws://127.0.0.1:8022/api/ws", {
  origin: "http://127.0.0.1:8022",
  headers: { "X-Yep-Anywhere": "true" },
});
ws.on("open", () => {
  console.log("open");
  ws.close();
});
ws.on("error", (e) => console.log("error", e.message));
ws.on("close", (c, r) => console.log("close", c, r.toString()));
ws.on("unexpected-response", (req, res) =>
  console.log("unexpected", res.statusCode, res.statusMessage),
);
setTimeout(() => {
  console.log("timeout");
  ws.terminate();
}, 15000);

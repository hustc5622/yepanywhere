const http = require("node:http");
const crypto = require("node:crypto");
const key = crypto.randomBytes(16).toString("base64");
const req = http.request({
  hostname: "127.0.0.1",
  port: 8022,
  path: "/api/ws",
  method: "GET",
  headers: {
    Host: "127.0.0.1:8022",
    Connection: "Upgrade",
    Upgrade: "websocket",
    "Sec-WebSocket-Key": key,
    "Sec-WebSocket-Version": "13",
    Origin: "http://127.0.0.1:8022",
  },
  timeout: 10000,
});
req.on("upgrade", (res, socket, head) => {
  console.log(
    "upgrade",
    res.statusCode,
    res.headers["sec-websocket-accept"] ? "accept" : "no-accept",
  );
  socket.end();
});
req.on("response", (res) => {
  console.log("response", res.statusCode, res.statusMessage);
  let data = "";
  res.on("data", (c) => {
    data += c;
  });
  res.on("end", () => console.log("body:", data));
});
req.on("error", (e) => console.log("error", e.message));
req.on("timeout", () => {
  console.log("timeout");
  req.destroy();
});
req.end();

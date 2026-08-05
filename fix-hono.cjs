const fs = require("node:fs");
const path = require("node:path");

const ROOT = "D:/PythonProjects/Python_projects_anaconda_zpb/Yepanywhere";
const SRC = path.join(
  ROOT,
  "node_modules/.pnpm/hono@4.12.32/node_modules/hono",
);
const DST = path.join(ROOT, "dist/npm-package/node_modules/hono");

function rmrf(p) {
  if (fs.existsSync(p)) {
    fs.rmSync(p, { recursive: true, force: true });
  }
}

// Clean any nested/old mess first
rmrf(DST);

// Copy pnpm's complete hono into the bundle
fs.cpSync(SRC, DST, { recursive: true, force: true });

const ok = fs.existsSync(path.join(DST, "dist/helper/websocket/index.js"));
console.log("bundle hono replaced");
console.log("websocket file present:", ok);

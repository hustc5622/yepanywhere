const fs = require("node:fs");
const path = require("node:path");
const ROOT = "D:/PythonProjects/Python_projects_anaconda_zpb/Yepanywhere";
const STAGING = path.join(ROOT, "dist/npm-package");

const entries = [
  "client-dist",
  "dist",
  "bundled",
  "build-info.json",
  "package.json",
  "README.md",
  "npm-shrinkwrap.json",
  "node_modules",
];

for (const e of entries) {
  const p = path.join(STAGING, e);
  if (!fs.existsSync(p)) {
    console.log(`SKIP (absent): ${e}`);
    continue;
  }
  const t = Date.now();
  try {
    fs.rmSync(p, { recursive: true, force: true });
    console.log(`OK (${Date.now() - t}ms): ${e}`);
  } catch (err) {
    console.log(`ERR (${Date.now() - t}ms): ${e} -> ${err.message}`);
  }
}
console.log("diag done");

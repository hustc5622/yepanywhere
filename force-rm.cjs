// Cycle-safe recursive delete. Native fs.rmSync({recursive:true}) can hang on
// Windows junction/symlink cycles left by `npm ci` inside node_modules.
// This walks with lstat + realpath cycle detection and removes links without
// following them, so it never recurses infinitely.
const fs = require("node:fs");
const path = require("node:path");

function rmDir(dir, seen) {
  let rp;
  try {
    rp = fs.realpathSync(dir);
  } catch {
    rp = dir;
  }
  // Cycle / junction pointing back into an already-visited subtree:
  // remove the link itself, do not recurse.
  if (seen.has(rp)) {
    try {
      fs.rmSync(dir, { force: true });
    } catch {}
    return;
  }
  seen.add(rp);

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    try {
      fs.rmSync(dir, { force: true });
    } catch {}
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    let st;
    try {
      st = fs.lstatSync(p);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) {
      try {
        fs.rmSync(p, { force: true });
      } catch {}
    } else if (st.isDirectory()) {
      rmDir(p, seen);
    } else {
      try {
        fs.rmSync(p, { force: true });
      } catch {}
    }
  }
  try {
    fs.rmdirSync(dir);
  } catch {}
}

const target = process.argv[2];
if (!target) {
  console.error("usage: node force-rm.cjs <dir>");
  process.exit(2);
}
console.log("force-removing:", target);
rmDir(target, new Set());
// Final pass in case something was missed
try {
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 3 });
} catch {}
console.log("done:", target, "exists:", fs.existsSync(target));

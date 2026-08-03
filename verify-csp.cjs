const fs = require("node:fs");
const crypto = require("node:crypto");

const path =
  "D:/PythonProjects/Python_projects_anaconda_zpb/Yepanywhere/dist/npm-package/client-dist/index.html";
const html = fs.readFileSync(path, "utf8");

// Extract CSP script-src hashes
const cspMatch = html.match(/content=["']([^"']*script-src[^"']*)["']/i);
let cspHashes = [];
if (cspMatch) {
  const m = cspMatch[1].match(/sha256-([A-Za-z0-9+/=]+)/g);
  cspHashes = m ? m : [];
}
console.log("CSP sha256 hashes in meta:", cspHashes);

// Extract inline non-module scripts without src
const scriptRegex =
  /<script(?![^>]*\btype\s*=\s*["']module["'])(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi;
const scripts = [];
for (const match of html.matchAll(scriptRegex)) {
  const content = match[1];
  if (content.trim()) scripts.push(content);
}
console.log("Inline script count:", scripts.length);

for (const [i, content] of scripts.entries()) {
  const crlfHash = crypto.createHash("sha256").update(content).digest("base64");
  const lfContent = content.replace(/\r\n/g, "\n");
  const lfHash = crypto.createHash("sha256").update(lfContent).digest("base64");
  const hasCrlf = content.includes("\r\n");
  console.log(
    `\nInline script #${i}: length=${content.length}, hasCRLF=${hasCrlf}`,
  );
  console.log(`  CRLF hash: sha256-${crlfHash}`);
  console.log(`  LF   hash: sha256-${lfHash}`);
  const matchCrlf = cspHashes.includes(`sha256-${crlfHash}`);
  const matchLf = cspHashes.includes(`sha256-${lfHash}`);
  console.log(`  Matches CSP (CRLF)? ${matchCrlf}`);
  console.log(`  Matches CSP (LF)  ? ${matchLf}`);
  if (matchLf && !matchCrlf) {
    console.log(
      "  => FIX CONFIRMED: CSP hash uses LF-normalized content (browser will accept).",
    );
  } else if (matchCrlf && !matchLf) {
    console.log(
      "  => STILL BROKEN: CSP hash uses raw CRLF (browser will reject).",
    );
  } else if (matchLf && matchCrlf) {
    console.log("  => Both match (content has no CRLF line endings).");
  } else {
    console.log("  => WARNING: neither hash matches CSP meta.");
  }
}

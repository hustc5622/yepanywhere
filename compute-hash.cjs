const crypto = require("node:crypto");
const fs = require("node:fs");
const html = fs.readFileSync(
  "D://PythonProjects//Python_projects_anaconda_zpb//Yepanywhere//dist//npm-package//client-dist//index.html",
  "utf8",
);
const regex =
  /<script(?![^>]*\btype\s*=\s*["']module["'])(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi;
for (const match of html.matchAll(regex)) {
  const content = match[1];
  if (content.trim()) {
    const hash = crypto
      .createHash("sha256")
      .update(content, "utf8")
      .digest("base64");
    console.log("Found inline script, hash:", `'sha256-${hash}'`);
    console.log("Content length:", content.length);
    console.log(
      "Content first 100 chars:",
      JSON.stringify(content.slice(0, 100)),
    );
  }
}

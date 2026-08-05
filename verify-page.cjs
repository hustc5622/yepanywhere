const path = require("node:path");
// Resolve playwright from the pnpm store (not hoisted at workspace root)
const pwPath = path.join(
  "D:/PythonProjects/Python_projects_anaconda_zpb/Yepanywhere/node_modules/.pnpm/playwright@1.58.2/node_modules/playwright",
);
const { chromium } = require(pwPath);

(async () => {
  const consoleErrors = [];
  const pageErrors = [];
  const cspViolations = [];

  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();

  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
    const t = msg.text();
    if (/content security policy/i.test(t) || /violates/i.test(t))
      cspViolations.push(t);
  });
  page.on("pageerror", (err) => pageErrors.push(err.message));

  const url = "http://127.0.0.1:8022/";
  await page
    .goto(url, { waitUntil: "networkidle" })
    .catch((e) => consoleErrors.push(`goto: ${e.message}`));

  // Give React time to mount and splash to clear
  await page.waitForTimeout(4000);

  const result = await page.evaluate(() => {
    const splash = document.getElementById("splash");
    const root = document.getElementById("root");
    const splashVisible = splash
      ? getComputedStyle(splash).display !== "none" &&
        splash.offsetParent !== null
      : null;
    return {
      hasSplash: !!splash,
      splashVisible,
      rootChildCount: root ? root.children.length : -1,
      rootHasText: root ? (root.innerText || "").trim().length : 0,
      title: document.title,
      bodyChildCount: document.body.children.length,
    };
  });

  console.log("=== PAGE LOAD RESULT ===");
  console.log(JSON.stringify(result, null, 2));
  console.log(`\n=== CONSOLE ERRORS (${consoleErrors.length}) ===`);
  for (const e of consoleErrors) {
    console.log(`  - ${e}`);
  }
  console.log(`\n=== CSP VIOLATIONS (${cspViolations.length}) ===`);
  for (const e of cspViolations) {
    console.log(`  - ${e}`);
  }
  console.log(`\n=== PAGE ERRORS (${pageErrors.length}) ===`);
  for (const e of pageErrors) {
    console.log(`  - ${e}`);
  }

  const fixed =
    cspViolations.length === 0 &&
    pageErrors.length === 0 &&
    result.rootChildCount > 0 &&
    result.splashVisible !== true;
  console.log("\n=== VERDICT ===");
  console.log(
    fixed
      ? "PASS: page loads, React rendered, no CSP/page errors."
      : "FAIL: issues remain.",
  );

  await browser.close();
  process.exit(fixed ? 0 : 1);
})().catch((e) => {
  console.error("SCRIPT ERROR:", e);
  process.exit(2);
});

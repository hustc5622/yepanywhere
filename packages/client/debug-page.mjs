import { chromium } from "@playwright/test";

const browser = await chromium.launch({
  channel: "msedge",
  headless: false,
});
const context = await browser.newContext();
const page = await context.newPage();

page.on("console", (msg) => console.log("CONSOLE", msg.type(), msg.text()));
page.on("pageerror", (err) => console.log("PAGEERROR", err.message, err.stack));
page.on("response", (resp) =>
  console.log("RESPONSE", resp.status(), resp.url()),
);
page.on("requestfailed", (req) =>
  console.log("REQUESTFAILED", req.url(), req.failure()?.errorText),
);

console.log("Opening page...");
await page.goto("http://127.0.0.1:8022/", {
  timeout: 30000,
  waitUntil: "domcontentloaded",
});
console.log("Page loaded, waiting 8s...");
await page.waitForTimeout(8000);

const html = await page.content();
console.log("BODY:", html.slice(0, 500));

await browser.close();

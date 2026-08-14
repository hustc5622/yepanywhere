import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it } from "vitest";

const indexHtml = readFileSync(
  resolve(process.cwd(), "../mobile/static-shim/index.html"),
  "utf8",
).replace('<script src="./loader.js" defer></script>', "");
const loaderSource = readFileSync(
  resolve(process.cwd(), "../mobile/static-shim/loader.js"),
  "utf8",
);

const openDoms: JSDOM[] = [];

function mountShell(options?: {
  appReadyTimeoutMs?: number;
  language?: string;
  storedChannel?: string;
  storedNode?: string;
}) {
  const dom = new JSDOM(indexHtml, {
    runScripts: "outside-only",
    url: "https://tauri.localhost/",
  });
  openDoms.push(dom);

  Object.defineProperty(dom.window.navigator, "language", {
    configurable: true,
    value: options?.language ?? "en-US",
  });

  if (options?.storedChannel) {
    dom.window.localStorage.setItem(
      "yep-anywhere-mobile-channel",
      options.storedChannel,
    );
  }
  if (options?.storedNode) {
    dom.window.localStorage.setItem(
      "yep-anywhere-mobile-active-node",
      options.storedNode,
    );
  }

  const source = loaderSource.replace(
    "var APP_READY_TIMEOUT_MS = 12000;",
    `var APP_READY_TIMEOUT_MS = ${options?.appReadyTimeoutMs ?? 12000};`,
  );
  dom.window.eval(source);
  dom.window.document.dispatchEvent(
    new dom.window.Event("DOMContentLoaded", { bubbles: true }),
  );

  const frame =
    dom.window.document.querySelector<HTMLIFrameElement>("#app-frame");
  if (!frame) throw new Error("mobile shell frame was not created");
  return { dom, frame };
}

function postAppReady(dom: JSDOM, frame: HTMLIFrameElement, origin: string) {
  dom.window.dispatchEvent(
    new dom.window.MessageEvent("message", {
      data: { type: "yep-anywhere:app-ready" },
      origin,
      source: frame.contentWindow,
    }),
  );
}

function clickSavedNode(dom: JSDOM, origin: string) {
  const button = Array.from(
    dom.window.document.querySelectorAll<HTMLButtonElement>(
      "[data-node-origin]",
    ),
  ).find((candidate) => candidate.dataset.nodeOrigin === origin);
  if (!button) throw new Error(`saved node button not found: ${origin}`);
  button.click();
}

afterEach(() => {
  for (const dom of openDoms.splice(0)) dom.window.close();
});

describe("APK mobile shell recovery", () => {
  it("migrates the retired persisted endpoint to the current default", () => {
    const { dom, frame } = mountShell({
      storedChannel: "tcp",
      storedNode: "http://43.226.60.75:61874",
    });

    expect(frame.src).toBe("http://43.226.60.75:46789/yep/?yep-mobile-shell=1");
    expect(
      dom.window.localStorage.getItem("yep-anywhere-mobile-active-node"),
    ).toBeNull();
    expect(
      dom.window.document.querySelector<HTMLInputElement>("[data-node-input]")
        ?.value,
    ).toBe("43.226.60.75:46789");
    expect(dom.window.document.body.classList.contains("is-loaded")).toBe(
      false,
    );
  });

  it("does not treat an iframe load event as an app-ready handshake", async () => {
    const { dom, frame } = mountShell({ appReadyTimeoutMs: 20 });

    frame.onload?.(new dom.window.Event("load"));
    expect(dom.window.document.body.classList.contains("is-loaded")).toBe(
      false,
    );

    await new Promise((resolve) => setTimeout(resolve, 35));

    expect(dom.window.document.body.classList.contains("is-loaded")).toBe(
      false,
    );
    expect(
      dom.window.document.body.classList.contains("has-connection-error"),
    ).toBe(true);
    expect(
      dom.window.document.querySelector("[data-diagnostic-state]")?.textContent,
    ).toBe("Timed out");
  });

  it("only reveals the remote page after a ready message from the active origin", () => {
    const { dom, frame } = mountShell();

    postAppReady(dom, frame, "http://unexpected.example:1234");
    expect(dom.window.document.body.classList.contains("is-loaded")).toBe(
      false,
    );

    postAppReady(dom, frame, "http://43.226.60.75:46789");
    expect(dom.window.document.body.classList.contains("is-loaded")).toBe(true);
    expect(
      dom.window.document.querySelector("[data-diagnostic-state]")?.textContent,
    ).toBe("Ready");

    dom.window.document
      .querySelector<HTMLButtonElement>("[data-open-settings]")
      ?.click();
    expect(dom.window.document.body.classList.contains("is-panel-open")).toBe(
      true,
    );
    dom.window.document
      .querySelector<HTMLButtonElement>("[data-close-settings]")
      ?.click();
    expect(dom.window.document.body.classList.contains("is-panel-open")).toBe(
      false,
    );
  });

  it("keeps a newly entered endpoint recoverable and persists it", () => {
    const { dom, frame } = mountShell({ language: "zh-CN" });
    const input =
      dom.window.document.querySelector<HTMLInputElement>("[data-node-input]");
    const form =
      dom.window.document.querySelector<HTMLFormElement>("[data-node-form]");
    if (!input || !form) throw new Error("connection form was not created");

    input.value = "10.0.0.2:9000";
    form.dispatchEvent(
      new dom.window.Event("submit", { bubbles: true, cancelable: true }),
    );

    expect(frame.src).toBe(
      "http://10.0.0.2:9000/yep/projects?yep-mobile-shell=1",
    );
    expect(
      dom.window.localStorage.getItem("yep-anywhere-mobile-active-node"),
    ).toBe("http://10.0.0.2:9000");
    expect(dom.window.document.documentElement.lang).toBe("zh-CN");
    expect(
      dom.window.document.querySelector("[data-loader-status]")?.textContent,
    ).toContain("正在连接");
    expect(dom.window.document.body.classList.contains("is-panel-open")).toBe(
      true,
    );
  });

  it("opens the new endpoint at its project list instead of reusing an old session route", () => {
    const { dom, frame } = mountShell();
    frame.src =
      "http://43.226.60.75:46789/yep/projects/old-project/sessions/old-session?branch=old-branch";

    clickSavedNode(dom, "http://39.106.200.1:18022");

    expect(frame.src).toBe(
      "http://39.106.200.1:18022/yep/projects?yep-mobile-shell=1",
    );
  });

  it("drops a project path sent by the embedded client when it changes endpoints", () => {
    const { dom, frame } = mountShell();

    dom.window.dispatchEvent(
      new dom.window.MessageEvent("message", {
        data: {
          type: "yep-anywhere:mobile-shell-set-channel",
          channel: "tcp",
          node: "http://39.106.200.1:18022",
          path: "/yep/new-session?projectId=old-project",
        },
        source: frame.contentWindow,
      }),
    );

    expect(frame.src).toBe(
      "http://39.106.200.1:18022/yep/projects?yep-mobile-shell=1",
    );
  });

  it("preserves the current route when retrying the same endpoint", () => {
    const { dom, frame } = mountShell();
    frame.src =
      "http://43.226.60.75:46789/yep/projects/current-project/sessions/current-session?branch=current-branch";

    dom.window.document
      .querySelector<HTMLButtonElement>("[data-retry-connection]")
      ?.click();

    expect(frame.src).toBe(
      "http://43.226.60.75:46789/yep/projects/current-project/sessions/current-session?branch=current-branch&yep-mobile-shell=1",
    );
  });
});

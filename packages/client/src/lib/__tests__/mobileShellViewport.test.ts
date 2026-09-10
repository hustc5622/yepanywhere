import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(
  resolve(process.cwd(), "../mobile/static-shim/viewport.js"),
  "utf8",
);

describe("APK shell viewport", () => {
  it("resizes the iframe container and clears outer panning independently of the iframe", () => {
    const dom = new JSDOM(
      "<!doctype html><html><body><iframe></iframe></body></html>",
      { runScripts: "outside-only" },
    );
    try {
      const { window } = dom;
      const viewport = Object.assign(new window.EventTarget(), {
        height: 800,
        offsetTop: 0,
        scale: 1,
      });
      Object.defineProperty(window, "visualViewport", { value: viewport });
      window.scrollTo = vi.fn();
      window.eval(source);
      const root = window.document.documentElement;
      expect(root.style.getPropertyValue("--shell-viewport-height")).toBe(
        "800px",
      );
      viewport.height = 420;
      viewport.dispatchEvent(new window.Event("resize"));
      expect(root.style.getPropertyValue("--shell-viewport-height")).toBe(
        "420px",
      );
      Object.defineProperty(window, "scrollY", { value: 18 });
      window.dispatchEvent(new window.Event("scroll"));
      expect(window.scrollTo).toHaveBeenCalledWith(0, 0);
      viewport.height = 800;
      viewport.dispatchEvent(new window.Event("resize"));
      expect(root.style.getPropertyValue("--shell-viewport-height")).toBe(
        "800px",
      );
    } finally {
      dom.window.close();
    }
  });
});

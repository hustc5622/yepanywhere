import { useLayoutEffect } from "react";

/** Lock only the navigation document; nested message lists and inputs still scroll. */
export function useMobileViewport(enabled: boolean) {
  useLayoutEffect(() => {
    if (!enabled) return;
    const root = document.documentElement;
    const viewport = window.visualViewport;
    root.classList.add("mobile-navigation-viewport");

    const sync = () => {
      // Ignore pinch zoom: resizing the app while magnifying would reflow content.
      if (viewport && Math.abs(viewport.scale - 1) > 0.01) return;
      const height = viewport?.height ?? window.innerHeight;
      if (height <= 0) return;
      root.style.setProperty("--app-viewport-height", `${height}px`);
      root.style.setProperty(
        "--app-viewport-top",
        `${viewport?.offsetTop ?? 0}px`,
      );
      // WebView focus reveal can scroll the outer document even with hidden
      // overflow. Reset the document only, never a nested transcript or textarea.
      if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
    };

    sync();
    window.addEventListener("resize", sync);
    window.addEventListener("scroll", sync);
    viewport?.addEventListener("resize", sync);
    viewport?.addEventListener("scroll", sync);
    return () => {
      window.removeEventListener("resize", sync);
      window.removeEventListener("scroll", sync);
      viewport?.removeEventListener("resize", sync);
      viewport?.removeEventListener("scroll", sync);
      root.classList.remove("mobile-navigation-viewport");
      root.style.removeProperty("--app-viewport-height");
      root.style.removeProperty("--app-viewport-top");
    };
  }, [enabled]);
}

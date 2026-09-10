// Own the top-level viewport here: the cross-origin app cannot constrain its parent.
(function () {
  var root = document.documentElement;
  var viewport = window.visualViewport;
  function syncViewport() {
    if (viewport && Math.abs(viewport.scale - 1) > 0.01) return;
    var height = viewport ? viewport.height : window.innerHeight;
    if (height <= 0) return;
    root.style.setProperty("--shell-viewport-height", height + "px");
    root.style.setProperty("--shell-viewport-top", (viewport ? viewport.offsetTop : 0) + "px");
    // Reset only the shell document, never the app iframe's nested scroll areas.
    if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
  }
  syncViewport();
  window.addEventListener("resize", syncViewport);
  window.addEventListener("scroll", syncViewport);
  if (viewport) {
    viewport.addEventListener("resize", syncViewport);
    viewport.addEventListener("scroll", syncViewport);
  }
})();

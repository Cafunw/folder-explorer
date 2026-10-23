// TEMPORARY diagnostics: writes timestamped lines to fe-debug.log (via Rust) to find out what
// happens around a visible flicker. Remove together with src-tauri/src/diag.rs.
import { api, on } from "../api";

export function startDiag() {
  const log = (s: string) => api.debugLog(s).catch(() => {});
  log("--- diag started");
  document.addEventListener("visibilitychange", () => log(`visibility=${document.visibilityState}`));
  window.addEventListener("blur", () => log("window blur"));
  window.addEventListener("focus", () => log("window focus"));
  for (const t of ["pointerdown", "pointerup", "contextmenu"] as const) {
    window.addEventListener(t, (e) => log(`${t} ${(e as PointerEvent).clientX},${(e as PointerEvent).clientY}`), true);
  }
  void on("desktop-changed", () => log("event desktop-changed"));
  void on("desktop-raised", () => log("event desktop-raised"));
  void on("empty-press", () => log("event empty-press"));
  void on("empty-release", () => log("event empty-release"));

  // render stalls: requestAnimationFrame stops while the page is hidden / occluded / starved
  let last = performance.now();
  const tick = (t: number) => {
    if (t - last > 45) log(`rAF gap ${Math.round(t - last)} ms`);
    last = t;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  // what is on screen: tile count, images not loaded, tiles with opacity 0
  let lastState = "";
  window.setInterval(() => {
    const tiles = document.querySelectorAll<HTMLElement>(".tile");
    let unloaded = 0;
    let faded = 0;
    tiles.forEach((el) => {
      const img = el.querySelector("img");
      if (img && !img.complete) unloaded++;
      if (parseFloat(getComputedStyle(el).opacity) < 0.5) faded++;
    });
    const s = `tiles=${tiles.length} unloadedImgs=${unloaded} fadedTiles=${faded}`;
    if (s !== lastState) {
      lastState = s;
      log(s);
    }
  }, 50);
}

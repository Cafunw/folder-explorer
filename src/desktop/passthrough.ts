// Tells Rust where this app's own objects are on screen. The desktop window takes the mouse only
// there (and while a panel, dialog, drag or name box is open); everywhere else the mouse passes
// straight through to Windows' real desktop, which handles it natively (right-click menu, New,
// Refresh, selection, drops…). See docs/ARCHITECTURE.md, "Core rule".
import { useEffect } from "react";
import { api } from "../api";
import { useDrag } from "./dnd";
import { useDesk } from "./store";

const PAD = 2;

/** Window rectangles of everything marked `data-hit` (a tile counts as its icon plus its label). */
function collect(): number[][] {
  const out: number[][] = [];
  const W = window.innerWidth;
  const H = window.innerHeight;
  document.querySelectorAll<HTMLElement>("[data-hit]").forEach((el) => {
    let l = Infinity;
    let t = Infinity;
    let r = -Infinity;
    let b = -Infinity;
    const take = (q: DOMRect) => {
      l = Math.min(l, q.left);
      t = Math.min(t, q.top);
      r = Math.max(r, q.right);
      b = Math.max(b, q.bottom);
    };
    if (el.dataset.hit === "tile") {
      el.querySelectorAll<HTMLElement>(".tile-icon, .tile-label").forEach((c) => take(c.getBoundingClientRect()));
    }
    if (l === Infinity) take(el.getBoundingClientRect());
    if (r - l <= 0 || b - t <= 0 || r <= 0 || b <= 0 || l >= W || t >= H) return;
    out.push([Math.floor(l) - PAD, Math.floor(t) - PAD, Math.ceil(r - l) + 2 * PAD, Math.ceil(b - t) + 2 * PAD]);
  });
  return out;
}

export function useInputRegions() {
  useEffect(() => {
    let timer: number | undefined;
    let last = "";
    let sentAt = 0;

    const push = () => {
      timer = undefined;
      const st = useDesk.getState();
      const dr = useDrag.getState();
      const all = !!(st.panel || st.dialog || st.rename || dr.drag);
      const rects = all ? [] : collect();
      const key = (all ? "A" : "") + rects.join(";");
      if (key === last) return;
      last = key;
      sentAt = performance.now();
      api.setInputRegions(all, rects).catch(() => {});
    };
    // at most ~30 updates a second while things animate, always one trailing update when they settle
    const schedule = () => {
      if (timer === undefined) timer = window.setTimeout(push, Math.max(0, 33 - (performance.now() - sentAt)));
    };

    const offDesk = useDesk.subscribe(schedule);
    const offDrag = useDrag.subscribe(schedule);
    const mo = new MutationObserver(schedule);
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "class"] });
    window.addEventListener("resize", schedule);
    schedule();
    return () => {
      offDesk();
      offDrag();
      mo.disconnect();
      window.removeEventListener("resize", schedule);
      window.clearTimeout(timer);
    };
  }, []);
}

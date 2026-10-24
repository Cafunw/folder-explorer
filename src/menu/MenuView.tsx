import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { create } from "zustand";
import { api, emitToWindow, on } from "../api";
import { applyTheme, normalizeSettings } from "../settings";
import { MenuIcon } from "./icons";
import {
  dynamicNodes,
  menuKey,
  visibleNodes,
  type BarButton,
  type MenuExtra,
  type MenuNode,
  type MenuPick,
  type MenuRequest,
  type ShellNewItem,
} from "./model";
import "./menu.css";

// Two windows: "menu" (the menu, it has the keyboard) and "menusub" (a submenu beside it, never
// focused). The menu window drives both; the submenu only draws and reports the mouse.

type Item = Extract<MenuNode, { kind: "item" }>;
const isItem = (n: MenuNode | undefined): n is Item => !!n && n.kind === "item";
const hasSub = (n: MenuNode | undefined) => isItem(n) && !!(n.items || n.dynamic);
const SUB_DELAY = 250;
/** .cm-list padding-top: a submenu's first entry lines up with its parent entry */
const LIST_PAD = 3;

type Anchor = { top: number; bottom: number; left: number; right: number };
type SubOpen = {
  seq: number;
  nodes: MenuNode[];
  hover: number;
  anchor: Anchor;
  work: [number, number, number, number];
  scale: number;
  accent: string;
  /** a newly opened submenu (fades in), not an update of the open one */
  fresh: boolean;
};

function useThemeSync(accent: string | null) {
  useEffect(() => {
    document.body.style.background = "transparent";
    api.loadState().then((st) => applyTheme(normalizeSettings(st.settings))).catch(() => {});
    const off = on<{ settings: unknown }>("settings-changed", (p) => applyTheme(normalizeSettings(p.settings)));
    return () => {
      off.then((u) => u()).catch(() => {});
    };
  }, []);
  useEffect(() => {
    if (accent) document.documentElement.style.setProperty("--cm-accent", accent);
  }, [accent]);
}

const accentFor = (a: { dark: string; light: string }) => (document.documentElement.dataset.theme === "light" ? a.light : a.dark);

function step(nodes: MenuNode[], from: number, dir: 1 | -1) {
  const n = nodes.length;
  for (let k = 1; k <= n; k++) {
    const i = (((from < 0 && dir < 0 ? 0 : from) + dir * k) % n + n) % n;
    const x = nodes[i];
    if (isItem(x) && !x.disabled) return i;
  }
  return from;
}

/** Entries of one menu panel. */
function Rows(props: {
  nodes: MenuNode[];
  hover: number;
  open: number;
  scale: number;
  onHover: (i: number) => void;
  onPick: (i: number) => void;
  itemRef?: (i: number, el: HTMLDivElement | null) => void;
}) {
  const { nodes, hover, open, scale } = props;
  const marks = nodes.some((n) => isItem(n) && (n.check || n.radio));
  const hints = nodes.some((n) => isItem(n) && n.hint);
  return (
    <div className="cm-list" data-hints={hints}>
      {nodes.map((n, i) =>
        n.kind === "sep" ? (
          <div key={i} className="cm-sep" />
        ) : (
          <div
            key={i}
            ref={(el) => props.itemRef?.(i, el)}
            className="cm-item"
            data-hover={i === hover || i === open}
            data-disabled={!!n.disabled}
            onMouseEnter={() => props.onHover(i)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => props.onPick(i)}
          >
            {marks ? (
              <span className="ico cm-mark">{n.checked ? n.radio ? <span className="cm-dot" /> : "" : null}</span>
            ) : (
              <MenuIcon icon={n.icon} scale={scale} />
            )}
            <span className="cm-label">{n.label}</span>
            {n.hint ? (
              <span className="cm-hint">{n.hint}</span>
            ) : (
              hasSub(n) && <span className="cm-chevron">{""}</span>
            )}
          </div>
        ),
      )}
    </div>
  );
}

// ---------------------------------------------------------------- the menu

type MenuState = {
  req: MenuRequest | null;
  seq: number;
  extra: MenuExtra | null;
  hover: number;
  sub: { index: number; nodes: MenuNode[]; hover: number } | null;
  keyboardInSub: boolean;
  place: { x: number; y: number; w: number; h: number } | null;
  closing: boolean;
};

const useMenu = create<MenuState>(() => ({
  req: null,
  seq: 0,
  extra: null,
  hover: -1,
  sub: null,
  keyboardInSub: false,
  place: null,
  closing: false,
}));
const get = useMenu.getState;
const set = useMenu.setState;

/** Windows' New ▸ list from the last time, so the submenu is complete even before the shell answers. */
let newCache: ShellNewItem[] | null = (() => {
  try {
    return JSON.parse(localStorage.getItem("fe.menu.new") ?? "null");
  } catch {
    return null;
  }
})();

function have(req: MenuRequest) {
  return { paste: req.canPaste, terminal: req.hasTerminal };
}

/** Entries whose icon is only known on this machine (Windows Terminal's app icon). */
function withIcons(nodes: MenuNode[], req: MenuRequest): MenuNode[] {
  const term = req.terminalIcon;
  return term ? nodes.map((n) => (isItem(n) && n.icon === "terminal" ? { ...n, icon: { file: term } } : n)) : nodes;
}

function rootNodes(req: MenuRequest | null) {
  return req ? withIcons(visibleNodes(req.spec.items, have(req)), req) : [];
}

function barButtons(req: MenuRequest | null): BarButton[] {
  return req ? req.spec.bar.filter((b) => !b.needs || req.canPaste) : [];
}

const itemEls = new Map<number, HTMLDivElement>();
let subTimer: number | undefined;
let focused = false;
const BLUR_GRACE = 80;

function subNodesFor(n: Item, req: MenuRequest) {
  const nodes = n.dynamic ? dynamicNodes(n.dynamic, get().extra, newCache) : (n.items ?? []);
  return withIcons(visibleNodes(nodes, have(req)), req);
}

function sendSub(index: number, nodes: MenuNode[], hover: number, fresh = false) {
  const { req, place, seq } = get();
  const el = itemEls.get(index);
  if (!req || !place || !el) return;
  const r = el.getBoundingClientRect();
  const s = req.scale;
  const payload: SubOpen = {
    seq,
    nodes,
    hover,
    anchor: { top: place.y + r.top * s, bottom: place.y + r.bottom * s, left: place.x, right: place.x + place.w },
    work: req.work,
    scale: s,
    accent: accentFor(req.accent),
    fresh,
  };
  void emitToWindow("menusub", "menu-sub-open", payload);
}

function openSub(index: number, keyboard: boolean) {
  window.clearTimeout(subTimer);
  const { req } = get();
  const n = rootNodes(req)[index];
  if (!req || !isItem(n) || !hasSub(n) || n.disabled) return;
  const nodes = subNodesFor(n, req);
  const hover = keyboard ? step(nodes, -1, 1) : -1;
  set({ sub: { index, nodes, hover }, keyboardInSub: keyboard, hover: index });
  sendSub(index, nodes, hover, true);
}

function closeSub() {
  window.clearTimeout(subTimer);
  if (!get().sub) return;
  set({ sub: null, keyboardInSub: false });
  void emitToWindow("menusub", "menu-sub-close", {});
  api.hideMenu("menusub").catch(() => {});
}

function closeMenu() {
  window.clearTimeout(subTimer);
  if (!get().req || get().closing) return;
  closeSub();
  // one transparent frame first, so the next opening never flashes this menu's old content
  flushSync(() => set({ closing: true }));
  const seq = get().seq;
  requestAnimationFrame(() => {
    // a new menu opened meanwhile (right-click elsewhere): it keeps the window
    if (get().seq !== seq) return;
    api.hideMenu("menu").catch(() => {});
    set({ req: null, closing: false, place: null });
  });
}

function act(id: string) {
  const { req } = get();
  if (!req) return;
  const pick: MenuPick = { id, target: req.target, ids: req.ids, paths: req.paths, at: req.at, cell: req.cell, canPaste: req.canPaste };
  void emitToWindow("desktop", "menu-action", pick);
  closeMenu();
}

function pickRoot(i: number) {
  const n = rootNodes(get().req)[i];
  if (!isItem(n) || n.disabled) return;
  if (hasSub(n)) {
    if (get().sub?.index !== i) openSub(i, false);
    return;
  }
  act(n.id);
}

function pickSub(i: number) {
  const n = get().sub?.nodes[i];
  if (isItem(n) && !n.disabled && !hasSub(n)) act(n.id);
}

function hoverRoot(i: number) {
  const { sub, req } = get();
  set({ hover: i, keyboardInSub: false });
  window.clearTimeout(subTimer);
  if (sub?.index === i) return;
  const n = rootNodes(req)[i];
  subTimer = window.setTimeout(() => {
    if (hasSub(n) && isItem(n) && !n.disabled) openSub(i, false);
    else closeSub();
  }, SUB_DELAY);
}

function onKey(e: KeyboardEvent) {
  const { req, sub, keyboardInSub, hover } = get();
  if (!req) return;
  const nodes = rootNodes(req);
  const key = e.key;
  if (["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Enter", " ", "Escape", "Home", "End"].includes(key)) e.preventDefault();
  if (key === "Escape" || key === "ContextMenu" || (key === "F10" && e.shiftKey)) {
    if (sub && key === "Escape") closeSub();
    else closeMenu();
    return;
  }
  if (keyboardInSub && sub) {
    if (key === "ArrowDown" || key === "ArrowUp") {
      const h = step(sub.nodes, sub.hover, key === "ArrowDown" ? 1 : -1);
      set({ sub: { ...sub, hover: h } });
      void emitToWindow("menusub", "menu-sub-hover-set", { index: h });
    } else if (key === "ArrowLeft") closeSub();
    else if (key === "Enter" || key === " ") pickSub(sub.hover);
    return;
  }
  if (key === "ArrowDown" || key === "ArrowUp") {
    window.clearTimeout(subTimer);
    if (sub) closeSub();
    set({ hover: step(nodes, hover, key === "ArrowDown" ? 1 : -1) });
  } else if (key === "Home" || key === "End") {
    set({ hover: key === "Home" ? step(nodes, -1, 1) : step(nodes, 0, -1) });
  } else if (key === "ArrowRight" && hasSub(nodes[hover])) openSub(hover, true);
  else if (key === "Enter" || key === " ") {
    if (hasSub(nodes[hover])) openSub(hover, true);
    else if (hover >= 0) pickRoot(hover);
  }
}

function RootMenu() {
  const req = useMenu((s) => s.req);
  const seq = useMenu((s) => s.seq);
  const hover = useMenu((s) => s.hover);
  const sub = useMenu((s) => s.sub);
  const closing = useMenu((s) => s.closing);
  const panel = useRef<HTMLDivElement>(null);
  useThemeSync(req ? accentFor(req.accent) : null);

  useEffect(() => {
    const open = (r: MenuRequest) => {
      if (!r?.spec) return;
      window.clearTimeout(subTimer);
      if (get().sub) closeSub();
      const prev = get().extra;
      flushSync(() =>
        set({
          req: r,
          seq: get().seq + 1,
          extra: prev && prev.key === menuKey(r.paths) ? prev : null,
          hover: -1,
          sub: null,
          keyboardInSub: false,
          closing: false,
        }),
      );
    };
    api
      .takeMenuRequest()
      .then((r) => r && open(r as MenuRequest))
      .catch(() => {});
    const subs: Promise<() => void>[] = [
      on<MenuRequest>("menu-open", open),
      on<MenuExtra>("menu-extra", (x) => {
        const { req: r, extra, sub: s } = get();
        if (!r || x.key !== menuKey(r.paths)) return;
        const merged: MenuExtra = {
          key: x.key,
          verbs: x.verbs ?? extra?.verbs,
          newItems: x.newItems ?? extra?.newItems,
          openWith: x.openWith ?? extra?.openWith,
        };
        if (x.newItems) {
          newCache = x.newItems;
          try {
            localStorage.setItem("fe.menu.new", JSON.stringify(x.newItems));
          } catch {
            /* the cache is only a convenience */
          }
        }
        set({ extra: merged });
        const parent = s ? rootNodes(r)[s.index] : undefined;
        if (s && isItem(parent) && parent.dynamic && (x.newItems || x.openWith)) {
          const nodes = subNodesFor(parent, r);
          set({ sub: { ...s, nodes } });
          sendSub(s.index, nodes, s.hover);
        }
      }),
      on<{ index: number }>("menu-sub-hover", ({ index }) => {
        window.clearTimeout(subTimer);
        const s = get().sub;
        if (s) set({ sub: { ...s, hover: index }, hover: s.index, keyboardInSub: false });
      }),
      on<{ index: number }>("menu-sub-pick", ({ index }) => pickSub(index)),
      getCurrentWindow().onFocusChanged(({ payload }) => {
        focused = payload;
        // a click into the submenu can take the focus for a moment (Rust gives it back): only a
        // focus that stays away closes the menu
        if (!payload) window.setTimeout(() => !focused && closeMenu(), BLUR_GRACE);
      }),
    ];
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      subs.forEach((p) => p.then((u) => u()).catch(() => {}));
    };
  }, []);

  // measure, then show the window at the cursor: flipped left / up where the screen ends
  useLayoutEffect(() => {
    const el = panel.current;
    if (!req || !el) return;
    const r = el.getBoundingClientRect();
    const s = req.scale || 1;
    const w = Math.ceil(r.width * s);
    const h = Math.ceil(r.height * s);
    let [x, y] = req.at;
    const [wx, wy, ww, wh] = req.work;
    if (x + w > wx + ww) x = Math.max(wx, x - w);
    if (y + h > wy + wh) y = Math.max(wy, y - h);
    set({ place: { x, y, w, h } });
    api.placeMenu("menu", x, y, w, h).catch(() => {});
  }, [seq, req]);

  if (!req) return null;
  const nodes = rootNodes(req);
  const bar = barButtons(req);
  return (
    <div
      ref={panel}
      className="cm"
      data-target={req.target}
      data-closing={closing}
      onContextMenu={(e) => e.preventDefault()}
      onMouseLeave={() => {
        window.clearTimeout(subTimer);
        if (!get().sub) set({ hover: -1 });
      }}
    >
      {bar.length > 0 && (
        <div className="cm-bar">
          {bar.map((b) => (
            <button key={b.id} className="cm-btn" title={b.label} onMouseDown={(e) => e.preventDefault()} onClick={() => act(b.id)}>
              <MenuIcon icon={b.icon} scale={req.scale} />
              <span className="cm-btn-label">{b.label}</span>
            </button>
          ))}
        </div>
      )}
      <Rows
        nodes={nodes}
        hover={hover}
        open={sub?.index ?? -1}
        scale={req.scale}
        onHover={hoverRoot}
        onPick={pickRoot}
        itemRef={(i, el) => {
          if (el) itemEls.set(i, el);
          else itemEls.delete(i);
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------- a submenu (its own window)

function SubMenu() {
  const [p, setP] = useState<SubOpen | null>(null);
  const [hover, setHover] = useState(-1);
  const [entrance, setEntrance] = useState<"pending" | "playing" | null>(null);
  const [opening, setOpening] = useState(0);
  const panel = useRef<HTMLDivElement>(null);
  const open = useRef(p);
  open.current = p;
  useThemeSync(p?.accent ?? null);

  useEffect(() => {
    let latest: SubOpen | null = null;
    const show = (x: SubOpen) =>
      flushSync(() => {
        if (x.fresh) {
          setEntrance("pending");
          setOpening((value) => value + 1);
        }
        setP(x);
        setHover(x.hover);
      });
    const subs = [
      on<SubOpen>("menu-sub-open", (x) => {
        latest = x;
        // another submenu is open: hide it first, or its window would show the new entries
        if (x.fresh && open.current)
          api
            .hideMenu("menusub")
            .catch(() => {})
            .finally(() => latest === x && show(x));
        else show(x);
      }),
      on("menu-sub-close", () => {
        latest = null;
        setP(null);
        setEntrance(null);
      }),
      on<{ index: number }>("menu-sub-hover-set", ({ index }) => setHover(index)),
    ];
    return () => subs.forEach((s) => s.then((u) => u()).catch(() => {}));
  }, []);

  useLayoutEffect(() => {
    const el = panel.current;
    if (!p || !el) return;
    const r = el.getBoundingClientRect();
    const s = p.scale || 1;
    const w = Math.ceil(r.width * s);
    const h = Math.ceil(r.height * s);
    const [wx, wy, ww, wh] = p.work;
    let x = p.anchor.right;
    if (x + w > wx + ww) x = Math.max(wx, p.anchor.left - w);
    let y = Math.round(p.anchor.top - LIST_PAD * s);
    if (y + h > wy + wh) y = wy + wh - h;
    y = Math.max(wy, y);
    // Start the content reveal only after the native window is placed. Starting it on
    // mount can consume the animation while the reused submenu window is still hidden.
    let cancelled = false;
    api.placeMenu("menusub", x, y, w, h, p.fresh)
      .then(() => {
        if (!cancelled) setEntrance((value) => value === "pending" ? "playing" : value);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [p]);

  if (!p) return null;
  return (
    <div
      key={opening}
      ref={panel}
      className="cm cm-sub"
      data-entrance={entrance ?? undefined}
      onAnimationEnd={(e) => {
        if (e.target === e.currentTarget) setEntrance(null);
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <Rows
        nodes={p.nodes}
        hover={hover}
        open={-1}
        scale={p.scale}
        onHover={(i) => {
          setHover(i);
          void emitToWindow("menu", "menu-sub-hover", { index: i });
        }}
        onPick={(i) => void emitToWindow("menu", "menu-sub-pick", { index: i })}
      />
    </div>
  );
}

export function MenuView() {
  return document.documentElement.dataset.view === "menusub" ? <SubMenu /> : <RootMenu />;
}

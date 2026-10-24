// Menu icons drawn the way Windows 11's menus draw them: a Segoe Fluent Icons glyph in the text
// colour with one part in the system accent colour (the same glyph again, clipped to that part).

import { iconUrl } from "../api";
import type { Icon, IconName } from "./model";

type Glyph = {
  g: string;
  /** clip-path of the accent coloured part; "all" = the whole glyph */
  accent?: string;
  /** a small accent glyph on top (the gear of "display settings", the arrow of "new tab") */
  badge?: { g: string; size: number; x: number; y: number; hole?: boolean };
};

const GLYPHS: Partial<Record<IconName, Glyph>> = {
  cut: { g: "", accent: "inset(52% 0 0 0)" },
  copy: { g: "", accent: "inset(0 0 30% 30%)" },
  rename: { g: "", accent: "polygon(18% 24%, 58% 24%, 58% 0, 82% 0, 82% 100%, 58% 100%, 58% 76%, 18% 76%)" },
  share: { g: "", accent: "polygon(36% 0, 100% 0, 100% 62%, 36% 62%)" },
  delete: { g: "" },
  paste: { g: "" },
  openwith: { g: "", accent: "inset(42% 0 0 42%)" },
  star: { g: "", accent: "all" },
  pin: { g: "", accent: "polygon(26% 0, 100% 0, 100% 74%, 26% 74%)" },
  properties: { g: "" },
  more: { g: "", accent: "inset(0 0 46% 46%)" },
  newwindow: { g: "", accent: "inset(0 0 46% 46%)" },
  newtab: { g: "", badge: { g: "", size: 8, x: 7, y: 1 } },
  admin: { g: "", accent: "inset(38% 0 0 38%)" },
  folderopen: { g: "" },
  view: { g: "" },
  sort: { g: "", accent: "inset(0 0 0 50%)" },
  refresh: { g: "" },
  new: { g: "", accent: "inset(27%)" },
  display: { g: "", badge: { g: "", size: 9, x: 8, y: 7, hole: true } },
  personalize: { g: "", accent: "polygon(0 50%, 50% 50%, 50% 100%, 0 100%)" },
  terminal: { g: "" },
  group: { g: "", accent: "inset(45% 0 0 45%)" },
  fence: { g: "", accent: "inset(0 0 50% 50%)" },
  heading: { g: "" },
  divider: { g: "", accent: "all" },
  // group kinds: Filter, SyncFolder, History
  smart: { g: "", accent: "inset(0 0 55% 0)" },
  live: { g: "", accent: "inset(45% 0 0 45%)" },
  frequent: { g: "", accent: "inset(0 0 0 50%)" },
  // Edit (pencil): the icon edit mode
  editicons: { g: "", accent: "polygon(0 52%, 48% 52%, 48% 100%, 0 100%)" },
};

function Svg({ name }: { name: "zip" | "copypath" }) {
  if (name === "zip") {
    return (
      <svg className="ico-svg" viewBox="0 0 16 16" fill="none">
        <path d="M1.5 4.5v8a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1H8L6.5 3.5h-4a1 1 0 0 0-1 1z" stroke="currentColor" />
        <path d="M11 5v8.5" stroke="var(--cm-accent)" strokeDasharray="1.2 1" />
        <path d="M10.2 9.2h1.6v1.8h-1.6z" fill="var(--cm-accent)" />
      </svg>
    );
  }
  return (
    <svg className="ico-svg" viewBox="0 0 16 16" fill="none">
      <rect x="1.5" y="3.5" width="13" height="9" rx="1.6" stroke="currentColor" />
      <path d="M4.2 5.6l1.6 4.8M6.9 5.6l1.6 4.8" stroke="var(--cm-accent)" strokeLinecap="round" />
      <circle cx="10.6" cy="10" r="0.8" fill="currentColor" />
      <circle cx="12.6" cy="10" r="0.8" fill="currentColor" />
    </svg>
  );
}

export function MenuIcon({ icon, scale }: { icon?: Icon; scale: number }) {
  if (!icon) return <span className="ico" />;
  if (typeof icon === "object") {
    const src = "img" in icon ? icon.img : iconUrl(icon.file, 16 * scale, "1");
    return (
      <span className="ico">
        <img src={src} alt="" draggable={false} />
      </span>
    );
  }
  if (icon === "zip" || icon === "copypath") {
    return (
      <span className="ico">
        <Svg name={icon} />
      </span>
    );
  }
  const gl = GLYPHS[icon];
  if (!gl) return <span className="ico" />;
  const b = gl.badge;
  const mask = b?.hole
    ? `radial-gradient(circle at ${b.x + b.size / 2}px ${b.y + b.size / 2}px, transparent ${b.size / 2 + 0.5}px, #000 ${b.size / 2 + 1}px)`
    : undefined;
  return (
    <span className="ico ico-glyph">
      <span className={gl.accent === "all" ? "ico-acc" : undefined} style={{ maskImage: mask, WebkitMaskImage: mask }}>
        {gl.g}
      </span>
      {gl.accent && gl.accent !== "all" && (
        <span className="ico-acc ico-layer" style={{ clipPath: gl.accent }}>
          {gl.g}
        </span>
      )}
      {b && (
        <span className="ico-acc ico-badge" style={{ left: b.x, top: b.y, fontSize: b.size, lineHeight: `${b.size}px` }}>
          {b.g}
        </span>
      )}
    </span>
  );
}

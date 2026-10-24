import { AnimatePresence, motion, useTransform, type MotionValue } from "motion/react";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { create } from "zustand";
import { mediaUrl, wallpaperUrl } from "../api";
import { primaryGrid, type GridInfo } from "../layout/grid";
import { pageCount } from "../layout/model";
import { applyTheme, setWallpaperAccent } from "../settings";
import type { Settings, WallpaperInfo, WallpaperSpec } from "../types";
import { accentFromColors, dominantColor, drawsWallpaper, isNight, msToNextSwitch, parallaxStep, wallpaperFor } from "../visual";
import { pagePos } from "./registry";
import { useAnimation, useDesk } from "./store";

/** Draw the Windows wallpaper ourselves (off: the transparent window shows the real one). */
const drawWindowsWallpaper = false;

const SIZE: Record<WallpaperInfo["position"], { size: string; repeat: string }> = {
  fill: { size: "cover", repeat: "no-repeat" },
  fit: { size: "contain", repeat: "no-repeat" },
  stretch: { size: "100% 100%", repeat: "no-repeat" },
  tile: { size: "auto", repeat: "repeat" },
  center: { size: "auto", repeat: "no-repeat" },
  span: { size: "cover", repeat: "no-repeat" },
};

type Span = { left: number; top: number; width: number; height: number };

/** Day / night state (`wallpaper.dayNight`), kept by `WallpaperSync`; null until it first ran. */
const useClock = create<{ night: boolean | null }>(() => ({ night: null }));

/** Before the clock ran the time is read directly, so the start shows no day → night fade. */
const nightOf = (clock: boolean | null, wp: Settings["wallpaper"]) =>
  clock ?? (wp.dayNight.enabled && isNight(new Date(), wp.dayNight.dayStart, wp.dayNight.nightStart));

/**
 * One monitor's wallpaper: the spec of its current page (own > night > main), cross-faded when it
 * changes, drifting with the page (parallax) when we paint it. "windows" = nothing painted (the
 * transparent window shows the real wallpaper), only the dim layer.
 */
export function Wallpaper({ g, span }: { g: GridInfo; span: Span }) {
  const wp = useDesk((s) => s.settings.wallpaper);
  const animation = useAnimation();
  const page = useDesk((s) => s.pages[g.monitorId] ?? 0);
  const pages = useDesk((s) => pageCount(s.layout, g.monitorId));
  const info = useDesk((s) => s.wallpapers.find((w) => w.monitorId === g.monitorId) ?? s.wallpapers[0]);
  const quiet = useDesk((s) => s.quiet.game || s.quiet.battery);
  const clock = useClock((c) => c.night);

  const { key, spec } = wallpaperFor(wp, g.monitorId, page, nightOf(clock, wp));
  const painted = drawsWallpaper(spec) || drawWindowsWallpaper;
  const total = Math.max(pages, page + 1);
  // the same for every spec, so the old and the new picture move together while they cross-fade
  const step = animation.parallax ? parallaxStep(g.width, total) : 0;
  const width = g.width + step * (total - 1);

  // follows the monitor's page position (MonitorSurface animates it for every page transition, or
  // jumps it with reduced motion / in quiet modes), so the picture and the icons always move together
  const pos = pagePos(g.monitorId);
  const x = useTransform(pos, (v) => -v * step);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (!el || !step) return;
    // the moving picture gets a compositor layer only while it drifts (`.wallpaper[data-moving]`)
    const sync = (v: number) => el.toggleAttribute("data-moving", Math.abs(v - Math.round(v)) > 1e-3);
    sync(pos.get());
    const off = pos.on("change", sync);
    return () => {
      off();
      el.removeAttribute("data-moving");
    };
  }, [pos, step]);

  const fade = quiet || animation.reduceMotion ? 0 : 0.45 / animation.speed;
  const shown = painted || spec.dim > 0;
  return (
    <div ref={box} className="wallpaper" style={{ left: g.left, top: g.top, width: g.width, height: g.height }}>
      <AnimatePresence initial={false} custom={painted}>
        {shown && (
          <motion.div
            key={key}
            className="wallpaper-fade"
            custom={painted}
            variants={{
              hidden: { opacity: 0 },
              shown: { opacity: 1, transition: { duration: fade, ease: "easeOut" } },
              // the old picture stays under the new one until that is opaque, or fades out to "windows"
              gone: (next: boolean) => ({ opacity: 0, transition: { duration: fade, delay: next ? fade : 0 } }),
            }}
            initial="hidden"
            animate="shown"
            exit="gone"
          >
            {painted && <Layer spec={spec} info={info} g={g} span={span} width={width} x={x} quiet={quiet} />}
            {spec.dim > 0 && <div className="wallpaper-layer" style={{ background: `rgba(0,0,0,${spec.dim})` }} />}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Layer({
  spec,
  info,
  g,
  span,
  width,
  x,
  quiet,
}: {
  spec: WallpaperSpec;
  info: WallpaperInfo | undefined;
  g: GridInfo;
  span: Span;
  width: number;
  x: MotionValue<number>;
  quiet: boolean;
}) {
  const image = spec.source === "image" && spec.image ? mediaUrl(spec.image) : null;
  const blurred = useBlurredImage(image, spec.blur, width, g.height);
  let layer: CSSProperties;
  if (spec.source === "windows") {
    if (info?.path) {
      const mode = SIZE[info.position] ?? SIZE.fill;
      layer = {
        backgroundColor: info.color,
        backgroundImage: `url("${wallpaperUrl(info.monitorId, info.version)}")`,
        backgroundSize: mode.size,
        backgroundRepeat: mode.repeat,
      };
      if (info.position === "span") {
        // one image across all monitors
        layer.backgroundSize = `${span.width}px ${span.height}px`;
        layer.backgroundPosition = `${span.left - g.left}px ${span.top - g.top}px`;
      }
    } else layer = { backgroundColor: info?.color ?? "#000" };
  } else if (image) {
    if (blurred) layer = { backgroundImage: `url("${blurred}")`, backgroundSize: "100% 100%" };
    else {
      // until the pre-blurred copy is ready (or when it failed): a live filter, never in quiet modes
      const b = quiet ? 0 : spec.blur;
      layer = {
        backgroundImage: `url("${image}")`,
        backgroundSize: "cover",
        filter: b ? `blur(${b}px)` : undefined,
        left: -2 * b,
        top: -2 * b,
        height: g.height + 4 * b,
      };
      return <motion.div className="wallpaper-layer" style={{ ...layer, right: "auto", bottom: "auto", width: width + 4 * b, x }} />;
    }
  } else if (spec.source === "gradient") {
    layer = { backgroundImage: `linear-gradient(${spec.gradient.angle}deg, ${spec.gradient.from}, ${spec.gradient.to})` };
  } else {
    layer = { backgroundColor: spec.color };
  }
  return <motion.div className="wallpaper-layer" style={{ ...layer, right: "auto", width, x }} />;
}

// ---------------------------------------------------------------- pre-blurred images

/**
 * A blurred copy of an image wallpaper, rendered once on a small canvas (the blur hides the lower
 * resolution) and shown as a plain image: no live `filter: blur()` while the desktop is on screen.
 */
const blurred = new Map<string, string | null>(); // key → object URL (null = failed)
const blurring = new Map<string, Promise<string | null>>();
const BLUR_KEEP = 12;

function useBlurredImage(url: string | null, blur: number, w: number, h: number): string | null {
  const key = url && blur > 0 ? `${url}|${blur}|${Math.round(w)}x${Math.round(h)}` : "";
  const [, rerender] = useState(0);
  useEffect(() => {
    if (!key || blurred.has(key)) return;
    let alive = true;
    let job = blurring.get(key);
    if (!job) {
      job = renderBlurred(url!, blur, w, h).then((v) => {
        blurring.delete(key);
        blurred.set(key, v);
        while (blurred.size > BLUR_KEEP) {
          const [old, oldUrl] = blurred.entries().next().value!;
          blurred.delete(old);
          if (oldUrl) URL.revokeObjectURL(oldUrl);
        }
        return v;
      });
      blurring.set(key, job);
    }
    job.then(() => alive && rerender((n) => n + 1));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return key ? (blurred.get(key) ?? null) : null;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.decoding = "async";
  img.src = url;
  return img.decode().then(() => img);
}

async function renderBlurred(url: string, blur: number, w: number, h: number): Promise<string | null> {
  try {
    const img = await loadImage(url);
    const q = Math.min(1, Math.max(0.125, 3 / blur));
    const cw = Math.max(1, Math.round(w * q));
    const ch = Math.max(1, Math.round(h * q));
    const scale = Math.max(cw / img.naturalWidth, ch / img.naturalHeight);
    const sw = cw / scale;
    const sh = ch / scale;
    const canvas = new OffscreenCanvas(cw, ch);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const r = blur * q;
    // drawn a bit larger than the canvas so the blur does not fade out at the edges
    ctx.filter = `blur(${r}px)`;
    ctx.drawImage(img, (img.naturalWidth - sw) / 2, (img.naturalHeight - sh) / 2, sw, sh, -2 * r, -2 * r, cw + 4 * r, ch + 4 * r);
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.9 });
    return URL.createObjectURL(blob);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- day / night + accent

/** Keeps the day / night clock and the accent taken from the wallpaper; render once on the desktop. */
export function WallpaperSync() {
  useDayNightClock();
  useWallpaperAccent();
  return null;
}

/** One timeout to the next switch time; re-checked when it fires, on settings change and wake-ups. */
function useDayNightClock() {
  const enabled = useDesk((s) => s.settings.wallpaper.dayNight.enabled);
  const dayStart = useDesk((s) => s.settings.wallpaper.dayNight.dayStart);
  const nightStart = useDesk((s) => s.settings.wallpaper.dayNight.nightStart);
  useEffect(() => {
    if (!enabled) {
      useClock.setState({ night: false });
      return;
    }
    let timer: number | undefined;
    const check = () => {
      window.clearTimeout(timer);
      const now = new Date();
      const night = isNight(now, dayStart, nightStart);
      if (useClock.getState().night !== night) useClock.setState({ night });
      const ms = msToNextSwitch(now, dayStart, nightStart);
      if (Number.isFinite(ms)) timer = window.setTimeout(check, Math.min(ms + 250, 2 ** 31 - 1));
    };
    check();
    // after sleep / a suspended webview the timeout can be late: these usually come with the wake-up
    const onVisible = () => document.visibilityState === "visible" && check();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", check);
    const unsub = useDesk.subscribe((s, p) => {
      if (s.env !== p.env || s.wallpapers !== p.wallpapers || s.quiet !== p.quiet) check();
    });
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", check);
      unsub();
    };
  }, [enabled, dayStart, nightStart]);
}

/** What the accent is taken from: the primary monitor's current wallpaper ("" = off). */
function accentSource(s: ReturnType<typeof useDesk.getState>, clock: boolean | null): string {
  const wp = s.settings.wallpaper;
  if (!wp.accentFromWallpaper) return "";
  const g = primaryGrid(s.grids);
  if (!g) return "";
  const { spec } = wallpaperFor(wp, g.monitorId, s.pages[g.monitorId] ?? 0, nightOf(clock, wp));
  if (spec.source === "windows") {
    const info = s.wallpapers.find((w) => w.monitorId === g.monitorId) ?? s.wallpapers[0];
    if (!info) return "";
    return info.path ? `img:${wallpaperUrl(info.monitorId, info.version)}` : `col:${info.color}`;
  }
  if (spec.source === "image" && spec.image) return `img:${mediaUrl(spec.image)}`;
  if (spec.source === "gradient") return `col:${spec.gradient.from},${spec.gradient.to}`;
  return `col:${spec.color}`;
}

const accents = new Map<string, Promise<string | null>>();

function accentOf(source: string): Promise<string | null> {
  let job = accents.get(source);
  if (!job) {
    job = source.startsWith("col:")
      ? Promise.resolve(accentFromColors(source.slice(4).split(",")))
      : loadImage(source.slice(4))
          .then((img) => {
            const c = document.createElement("canvas");
            c.width = 64;
            c.height = 64;
            const ctx = c.getContext("2d", { willReadFrequently: true });
            if (!ctx) return null;
            ctx.drawImage(img, 0, 0, 64, 64);
            return dominantColor(ctx.getImageData(0, 0, 64, 64).data);
          })
          .catch(() => {
            accents.delete(source); // a load error is tried again next time
            return null;
          });
    accents.set(source, job);
  }
  return job;
}

/** Computed once per wallpaper change; applied as the effective accent (settings.accent is kept). */
function useWallpaperAccent() {
  const clock = useClock((c) => c.night);
  const source = useDesk((s) => accentSource(s, clock));
  useEffect(() => {
    let alive = true;
    const apply = (c: string | null) => {
      setWallpaperAccent(c);
      applyTheme(useDesk.getState().settings);
    };
    if (!source) apply(null);
    else accentOf(source).then((c) => alive && apply(c));
    return () => {
      alive = false;
    };
  }, [source]);
}

import type { CSSProperties } from "react";
import { mediaUrl, wallpaperUrl } from "../api";
import type { GridInfo } from "../layout/grid";
import type { WallpaperInfo } from "../types";
import { useDesk } from "./store";

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

export function Wallpaper({ g, span }: { g: GridInfo; span: { left: number; top: number; width: number; height: number } }) {
  const wp = useDesk((s) => s.settings.wallpaper);
  const info = useDesk((s) => s.wallpapers.find((w) => w.monitorId === g.monitorId) ?? s.wallpapers[0]);

  let layer: CSSProperties = {};
  if (wp.source === "windows" && !drawWindowsWallpaper) {
    // The window is transparent: the real desktop wallpaper (incl. live wallpapers) shows through.
    return wp.dim > 0 ? (
      <div className="wallpaper" style={{ left: g.left, top: g.top, width: g.width, height: g.height, background: `rgba(0,0,0,${wp.dim})` }} />
    ) : null;
  }
  if (wp.source === "windows") {
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
  } else if (wp.source === "image" && wp.image) {
    layer = { backgroundImage: `url("${mediaUrl(wp.image)}")`, backgroundSize: "cover" };
  } else if (wp.source === "gradient") {
    layer = { backgroundImage: `linear-gradient(${wp.gradient.angle}deg, ${wp.gradient.from}, ${wp.gradient.to})` };
  } else {
    layer = { backgroundColor: wp.color };
  }

  const blur = wp.blur;
  return (
    <div className="wallpaper" style={{ left: g.left, top: g.top, width: g.width, height: g.height }}>
      <div
        className="wallpaper-layer"
        style={{
          ...layer,
          filter: blur ? `blur(${blur}px)` : undefined,
          inset: blur ? -blur * 2 : 0,
        }}
      />
      {wp.dim > 0 && <div className="wallpaper-layer" style={{ background: `rgba(0,0,0,${wp.dim})` }} />}
    </div>
  );
}

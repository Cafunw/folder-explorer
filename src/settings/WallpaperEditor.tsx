import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import { api } from "../api";
import { t } from "../i18n";
import type { WallpaperSpec } from "../types";
import { Colors, pct, px, Row, Seg, Slider } from "./controls";
import { WallpaperThumb } from "./previews";

const COLORS = ["#0f172a", "#1f2937", "#111827", "#3f3f46", "#1e3a8a", "#14532d", "#7c2d12", "#581c87"];

/** Rows that edit one wallpaper (the main one, the night one or a page's own). */
export function WallpaperEditor({ spec, onChange }: { spec: WallpaperSpec; onChange: (patch: Partial<WallpaperSpec>) => void }) {
  const [error, setError] = useState("");
  const pick = async () => {
    const file = await openDialog({ multiple: false, filters: [{ name: t.imageFiles, extensions: ["png", "jpg", "jpeg", "webp", "bmp", "gif"] }] });
    if (typeof file !== "string") return;
    try {
      onChange({ image: await api.importMedia(file, "wallpaper"), source: "image" });
      setError("");
    } catch (e) {
      setError(String(e));
    }
  };
  const g = spec.gradient;
  return (
    <>
      <Row title={t.wpSource}>
        <Seg
          value={spec.source}
          options={[
            { v: "windows", label: t.wpWindows },
            { v: "image", label: t.wpImage },
            { v: "color", label: t.wpColor },
            { v: "gradient", label: t.wpGradient },
          ]}
          onChange={(v) => onChange({ source: v })}
        />
      </Row>
      {spec.source === "image" && (
        <Row title={t.wpImage} desc={error || undefined}>
          {spec.image && <WallpaperThumb spec={spec} />}
          <button className="btn" onClick={pick}>
            {t.chooseImage}
          </button>
        </Row>
      )}
      {spec.source === "color" && (
        <Row title={t.wpColor}>
          <Colors value={spec.color} options={COLORS} onChange={(v) => v && onChange({ color: v })} />
        </Row>
      )}
      {spec.source === "gradient" && (
        <>
          <Row title={t.wpFrom}>
            <input type="color" className="color-input" value={g.from} onChange={(e) => onChange({ gradient: { ...g, from: e.target.value } })} />
          </Row>
          <Row title={t.wpTo}>
            <input type="color" className="color-input" value={g.to} onChange={(e) => onChange({ gradient: { ...g, to: e.target.value } })} />
          </Row>
          <Row title={t.wpAngle}>
            <Slider value={g.angle} min={0} max={360} format={(v) => `${v}°`} onChange={(v) => onChange({ gradient: { ...g, angle: v } })} />
          </Row>
        </>
      )}
      <Row title={t.wpBlur}>
        <Slider value={spec.blur} min={0} max={40} format={px} onChange={(v) => onChange({ blur: v })} />
      </Row>
      <Row title={t.wpDim}>
        <Slider value={spec.dim} min={0} max={0.8} step={0.01} format={pct} onChange={(v) => onChange({ dim: v })} />
      </Row>
    </>
  );
}

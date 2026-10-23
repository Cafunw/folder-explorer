import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  Archive,
  Folder,
  Grid3x3,
  Image,
  Info,
  Layers,
  MousePointerClick,
  Palette,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, emitToWindow, mediaUrl, on } from "../api";
import { t } from "../i18n";
import { ACCENTS, applyTheme, DEFAULT_SETTINGS, FOLDER_COLORS, normalizeSettings, rgba } from "../settings";
import type { BackupInfo, PersistedState, Settings } from "../types";
import "./settings.css";

type Section = "appearance" | "wallpaper" | "icons" | "folders" | "transparency" | "animation" | "behavior" | "backup" | "about";

const SECTIONS: { id: Section; label: string; icon: LucideIcon }[] = [
  { id: "appearance", label: t.secAppearance, icon: Palette },
  { id: "wallpaper", label: t.secWallpaper, icon: Image },
  { id: "icons", label: t.secIcons, icon: Grid3x3 },
  { id: "folders", label: t.secFolders, icon: Folder },
  { id: "transparency", label: t.secTransparency, icon: Layers },
  { id: "animation", label: t.secAnimation, icon: Sparkles },
  { id: "behavior", label: t.secBehavior, icon: MousePointerClick },
  { id: "backup", label: t.secBackup, icon: Archive },
  { id: "about", label: t.secAbout, icon: Info },
];

export function SettingsView() {
  const [s, setS] = useState<Settings>(DEFAULT_SETTINGS);
  const [section, setSection] = useState<Section>("appearance");
  const saveTimer = useRef<number | undefined>(undefined);
  const latest = useRef(s);

  useEffect(() => {
    applyTheme(DEFAULT_SETTINGS);
    api
      .loadState()
      .then((st) => {
        const n = normalizeSettings(st.settings);
        latest.current = n;
        setS(n);
        applyTheme(n);
      })
      .catch(console.error);
    const sub = on<{ settings: unknown }>("settings-changed", (p) => {
      const n = normalizeSettings(p.settings);
      latest.current = n;
      setS(n);
      applyTheme(n);
    });
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onScheme = () => applyTheme(latest.current);
    mq.addEventListener("change", onScheme);
    return () => {
      sub.then((u) => u());
      mq.removeEventListener("change", onScheme);
    };
  }, []);

  const update = (fn: (cur: Settings) => Settings) => {
    const next = normalizeSettings(fn(latest.current));
    latest.current = next;
    setS(next);
    applyTheme(next);
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => api.saveSettings(next).catch(console.error), 120);
  };

  return (
    <div className="settings-root">
      <nav className="settings-nav">
        <div className="settings-brand">
          <div className="logo">
            <i style={{ background: "#FFD25A" }} />
            <i style={{ background: "#4ADE9B" }} />
            <i style={{ background: "#FF6B8B" }} />
            <i style={{ background: "#fff" }} />
          </div>
          {t.appName}
        </div>
        {SECTIONS.map(({ id, label, icon: I }) => (
          <button key={id} className="nav-item" data-active={section === id} onClick={() => setSection(id)}>
            <I size={17} strokeWidth={1.8} />
            {label}
          </button>
        ))}
      </nav>
      <main className="settings-main">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={section}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.16 }}
          >
            <h1>{SECTIONS.find((x) => x.id === section)?.label}</h1>
            {section === "appearance" && <Appearance s={s} update={update} />}
            {section === "wallpaper" && <WallpaperSec s={s} update={update} />}
            {section === "icons" && <IconsSec s={s} update={update} />}
            {section === "folders" && <FoldersSec s={s} update={update} />}
            {section === "transparency" && <TransparencySec s={s} update={update} />}
            {section === "animation" && <AnimationSec s={s} update={update} />}
            {section === "behavior" && <BehaviorSec s={s} update={update} />}
            {section === "backup" && <BackupSec update={update} />}
            {section === "about" && <About />}
          </motion.div>
        </AnimatePresence>
      </main>
    </div>
  );
}

type SecProps = { s: Settings; update: (fn: (cur: Settings) => Settings) => void };

// ---------------------------------------------------------------- controls

function Row({ title, desc, children }: { title: string; desc?: string; children?: ReactNode }) {
  return (
    <div className="row">
      <div className="row-text">
        <div className="row-title">{title}</div>
        {desc && <div className="row-desc">{desc}</div>}
      </div>
      {children}
    </div>
  );
}

function Toggle({ on: value, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return <button className="toggle" data-on={value} onClick={() => onChange(!value)} role="switch" aria-checked={value} />;
}

function Seg<T extends string | number>({ value, options, onChange }: { value: T; options: { v: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button key={String(o.v)} data-active={o.v === value} onClick={() => onChange(o.v)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Slider({
  value,
  min,
  max,
  step = 1,
  format,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  format?: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="slider">
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="val">{format ? format(value) : value}</span>
    </div>
  );
}

const pct = (v: number) => `%${Math.round(v * 100)}`;
const px = (v: number) => `${Math.round(v)} px`;

function Colors({ value, options, onChange, allowNone }: { value: string | null; options: string[]; onChange: (c: string | null) => void; allowNone?: boolean }) {
  return (
    <div className="colors">
      {allowNone && <button className="swatch none" data-active={value === null} onClick={() => onChange(null)} title={t.noColor} />}
      {options.map((c) => (
        <button key={c} className="swatch" style={{ background: c }} data-active={value === c} onClick={() => onChange(c)} />
      ))}
      <input type="color" className="color-input" value={value ?? "#888888"} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

// ---------------------------------------------------------------- sections

function Appearance({ s, update }: SecProps) {
  return (
    <div className="card">
      <Row title={t.theme}>
        <Seg
          value={s.theme}
          options={[
            { v: "system", label: t.themeSystem },
            { v: "light", label: t.themeLight },
            { v: "dark", label: t.themeDark },
          ]}
          onChange={(v) => update((c) => ({ ...c, theme: v }))}
        />
      </Row>
      <Row title={t.accent}>
        <Colors value={s.accent} options={ACCENTS} onChange={(v) => v && update((c) => ({ ...c, accent: v }))} />
      </Row>
    </div>
  );
}

function WallpaperSec({ s, update }: SecProps) {
  const wp = s.wallpaper;
  const set = (patch: Partial<Settings["wallpaper"]>) => update((c) => ({ ...c, wallpaper: { ...c.wallpaper, ...patch } }));
  const pick = async () => {
    const file = await openDialog({ multiple: false, filters: [{ name: "Resim", extensions: ["png", "jpg", "jpeg", "webp", "bmp", "gif"] }] });
    if (typeof file !== "string") return;
    try {
      const stored = await api.importMedia(file, "wallpaper");
      set({ image: stored, source: "image" });
    } catch (e) {
      console.error(e);
    }
  };
  return (
    <>
      <div className="card">
        <Row title={t.wpSource}>
          <Seg
            value={wp.source}
            options={[
              { v: "windows", label: t.wpWindows },
              { v: "image", label: t.wpImage },
              { v: "color", label: t.wpColor },
              { v: "gradient", label: t.wpGradient },
            ]}
            onChange={(v) => set({ source: v })}
          />
        </Row>
        {wp.source === "image" && (
          <Row title={t.wpImage} desc={wp.image ?? undefined}>
            {wp.image && <img src={mediaUrl(wp.image)} alt="" style={{ width: 96, height: 54, objectFit: "cover", borderRadius: 8 }} />}
            <button className="btn" onClick={pick}>
              {t.chooseImage}
            </button>
          </Row>
        )}
        {wp.source === "color" && (
          <Row title={t.wpColor}>
            <Colors value={wp.color} options={["#0f172a", "#1f2937", "#111827", "#3f3f46", "#1e3a8a", "#14532d", "#7c2d12", "#581c87"]} onChange={(v) => v && set({ color: v })} />
          </Row>
        )}
        {wp.source === "gradient" && (
          <>
            <Row title={t.wpFrom}>
              <input type="color" className="color-input" value={wp.gradient.from} onChange={(e) => set({ gradient: { ...wp.gradient, from: e.target.value } })} />
            </Row>
            <Row title={t.wpTo}>
              <input type="color" className="color-input" value={wp.gradient.to} onChange={(e) => set({ gradient: { ...wp.gradient, to: e.target.value } })} />
            </Row>
            <Row title={t.wpAngle}>
              <Slider value={wp.gradient.angle} min={0} max={360} format={(v) => `${v}°`} onChange={(v) => set({ gradient: { ...wp.gradient, angle: v } })} />
            </Row>
          </>
        )}
      </div>
      <div className="card">
        <Row title={t.wpBlur}>
          <Slider value={wp.blur} min={0} max={40} format={px} onChange={(v) => set({ blur: v })} />
        </Row>
        <Row title={t.wpDim}>
          <Slider value={wp.dim} min={0} max={0.8} step={0.01} format={pct} onChange={(v) => set({ dim: v })} />
        </Row>
      </div>
    </>
  );
}

function IconsSec({ s, update }: SecProps) {
  const set = (patch: Partial<Settings["grid"]>) => update((c) => ({ ...c, grid: { ...c.grid, ...patch } }));
  return (
    <div className="card">
      <Row title={t.iconSize}>
        <Slider value={s.grid.iconSize} min={24} max={128} format={px} onChange={(v) => set({ iconSize: v, cellWidth: Math.max(s.grid.cellWidth, v + 24), cellHeight: Math.max(s.grid.cellHeight, v + 40) })} />
      </Row>
      <Row title={t.cellWidth}>
        <Slider value={s.grid.cellWidth} min={56} max={200} format={px} onChange={(v) => set({ cellWidth: v })} />
      </Row>
      <Row title={t.cellHeight}>
        <Slider value={s.grid.cellHeight} min={56} max={220} format={px} onChange={(v) => set({ cellHeight: v })} />
      </Row>
      <Row title={t.showLabels}>
        <Toggle on={s.grid.labels} onChange={(v) => set({ labels: v })} />
      </Row>
      <Row title={t.labelLines}>
        <Seg value={s.grid.labelLines} options={[{ v: 1, label: "1" }, { v: 2, label: "2" }, { v: 3, label: "3" }]} onChange={(v) => set({ labelLines: v })} />
      </Row>
      <Row title={t.autoArrange} desc={t.autoArrangeDesc}>
        <Toggle on={s.grid.autoArrange} onChange={(v) => set({ autoArrange: v })} />
      </Row>
    </div>
  );
}

function MockFolder({ s, size = 76 }: { s: Settings; size?: number }) {
  const n = s.folders.preview;
  const pad = size * (n === 3 ? 0.12 : 0.16);
  const gap = size * (n === 3 ? 0.055 : 0.08);
  const mini = (size - pad * 2 - gap * (n - 1)) / n;
  const colors = ["#ff6b6b", "#ffd25a", "#4ade9b", "#5b8cff", "#c084fc", "#f97316", "#22d3ee", "#f472b6", "#a3e635"];
  const color = s.folders.defaultColor;
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
      <div
        style={{
          width: size,
          height: size,
          borderRadius: size * s.folders.radius,
          padding: pad,
          display: "grid",
          gap,
          gridTemplateColumns: `repeat(${n}, ${mini}px)`,
          gridTemplateRows: `repeat(${n}, ${mini}px)`,
          background: color ? rgba(color, Math.min(1, s.transparency.folderTile * 1.5)) : `rgba(255,255,255,${s.transparency.folderTile})`,
          backdropFilter: s.transparency.folderTile > 0.005 ? `blur(${s.transparency.folderTileBlur}px) saturate(1.6)` : "none",
          border: `1px solid rgba(255,255,255,${0.22 * Math.min(1, s.transparency.folderTile / 0.25)})`,
          boxShadow: s.transparency.folderTile > 0.005 ? "0 3px 10px rgba(0,0,0,.22)" : "none",
        }}
      >
        {colors.slice(0, n * n).map((c) => (
          <div key={c} style={{ borderRadius: mini * 0.26, background: c, opacity: s.transparency.iconOpacity }} />
        ))}
      </div>
      <span style={{ color: "#fff", fontSize: 12, textShadow: "0 1px 3px rgba(0,0,0,.7)", background: `rgba(0,0,0,${s.transparency.labelBg * 0.6})`, borderRadius: 6, padding: "1px 6px" }}>
        {t.newFolderName}
      </span>
    </div>
  );
}

function FoldersSec({ s, update }: SecProps) {
  const set = (patch: Partial<Settings["folders"]>) => update((c) => ({ ...c, folders: { ...c.folders, ...patch } }));
  return (
    <>
      <div className="preview-strip">
        <MockFolder s={s} />
        <MockFolder s={s} size={56} />
      </div>
      <div className="card">
        <Row title={t.folderStyle}>
          <Seg
            value={s.folders.style}
            options={[
              { v: "ios", label: t.styleIos },
              { v: "android", label: t.styleAndroid },
            ]}
            onChange={(v) => set(v === "ios" ? { style: v, preview: 3, radius: 0.26 } : { style: v, preview: 2, radius: 0.5 })}
          />
        </Row>
        <Row title={t.preview}>
          <Seg value={s.folders.preview} options={[{ v: 2, label: "2 × 2" }, { v: 3, label: "3 × 3" }]} onChange={(v) => set({ preview: v })} />
        </Row>
        <Row title={t.shape} desc={`${t.shapeSquare} → ${t.shapeCircle}`}>
          <Slider value={s.folders.radius} min={0} max={0.5} step={0.01} format={pct} onChange={(v) => set({ radius: v })} />
        </Row>
        <Row title={t.panelColumns}>
          <Slider value={s.folders.panelColumns} min={3} max={8} onChange={(v) => set({ panelColumns: v })} />
        </Row>
        <Row title={t.defaultFolderColor}>
          <Colors value={s.folders.defaultColor} options={FOLDER_COLORS} allowNone onChange={(v) => set({ defaultColor: v })} />
        </Row>
      </div>
    </>
  );
}

function TransparencySec({ s, update }: SecProps) {
  const set = (patch: Partial<Settings["transparency"]>) => update((c) => ({ ...c, transparency: { ...c.transparency, ...patch } }));
  const tr = s.transparency;
  return (
    <>
      <div className="preview-strip">
        <MockFolder s={s} />
        <div
          style={{
            flex: 1,
            height: 92,
            borderRadius: 22,
            background: `rgba(var(--glass-rgb), ${tr.panel})`,
            backdropFilter: `blur(${tr.panelBlur}px) saturate(1.7)`,
            border: "1px solid rgba(255,255,255,.16)",
          }}
        />
      </div>
      <div className="card">
        <Row title={t.tFolderTile}>
          <Slider value={tr.folderTile} min={0} max={1} step={0.01} format={pct} onChange={(v) => set({ folderTile: v })} />
        </Row>
        <Row title={t.tFolderTileBlur}>
          <Slider value={tr.folderTileBlur} min={0} max={40} format={px} onChange={(v) => set({ folderTileBlur: v })} />
        </Row>
        <Row title={t.tPanel}>
          <Slider value={tr.panel} min={0} max={1} step={0.01} format={pct} onChange={(v) => set({ panel: v })} />
        </Row>
        <Row title={t.tPanelBlur}>
          <Slider value={tr.panelBlur} min={0} max={80} format={px} onChange={(v) => set({ panelBlur: v })} />
        </Row>
        <Row title={t.tLabelBg}>
          <Slider value={tr.labelBg} min={0} max={1} step={0.01} format={pct} onChange={(v) => set({ labelBg: v })} />
        </Row>
        <Row title={t.tIconOpacity}>
          <Slider value={tr.iconOpacity} min={0.2} max={1} step={0.01} format={pct} onChange={(v) => set({ iconOpacity: v })} />
        </Row>
      </div>
    </>
  );
}

function AnimationSec({ s, update }: SecProps) {
  const set = (patch: Partial<Settings["animation"]>) => update((c) => ({ ...c, animation: { ...c.animation, ...patch } }));
  return (
    <div className="card">
      <Row title={t.animSpeed}>
        <Slider value={s.animation.speed} min={0.25} max={3} step={0.05} format={(v) => `${v.toFixed(2)}×`} onChange={(v) => set({ speed: v })} />
      </Row>
      <Row title={t.reduceMotion} desc={t.reduceMotionDesc}>
        <Toggle on={s.animation.reduceMotion} onChange={(v) => set({ reduceMotion: v })} />
      </Row>
    </div>
  );
}

function HotkeyInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [listening, setListening] = useState(false);
  return (
    <button
      className="hotkey"
      data-listening={listening}
      onClick={() => setListening(true)}
      onBlur={() => setListening(false)}
      onKeyDown={(e) => {
        if (!listening) return;
        e.preventDefault();
        if (e.key === "Escape") return setListening(false);
        const mods: string[] = [];
        if (e.ctrlKey) mods.push("Ctrl");
        if (e.altKey) mods.push("Alt");
        if (e.shiftKey) mods.push("Shift");
        if (e.metaKey) mods.push("Super");
        let key = e.code;
        if (key.startsWith("Key")) key = key.slice(3);
        else if (key.startsWith("Digit")) key = key.slice(5);
        else if (key === "Space") key = "Space";
        else if (!/^F\d{1,2}$/.test(key)) {
          if (["ControlLeft", "ControlRight", "AltLeft", "AltRight", "ShiftLeft", "ShiftRight", "MetaLeft", "MetaRight"].includes(key)) return;
        }
        if (mods.length === 0) return;
        onChange([...mods, key].join("+"));
        setListening(false);
      }}
    >
      {listening ? t.pressKeys : value}
    </button>
  );
}

function BehaviorSec({ s, update }: SecProps) {
  const set = (patch: Partial<Settings["behavior"]>) => update((c) => ({ ...c, behavior: { ...c.behavior, ...patch } }));
  return (
    <div className="card">
      <Row title={t.lockLayout} desc={t.lockLayoutDesc}>
        <Toggle on={s.behavior.lockLayout} onChange={(v) => set({ lockLayout: v })} />
      </Row>
      <Row title={t.searchHotkey} desc={t.searchHotkeyDesc}>
        <HotkeyInput value={s.behavior.searchHotkey} onChange={(v) => set({ searchHotkey: v })} />
      </Row>
      <Row title={t.typeToSearch} desc={t.typeToSearchDesc}>
        <Toggle on={s.behavior.typeToSearch} onChange={(v) => set({ typeToSearch: v })} />
      </Row>
      <Row title={t.showSystemIcons} desc={t.showSystemIconsDesc}>
        <Toggle on={s.behavior.showSystemIcons} onChange={(v) => set({ showSystemIcons: v })} />
      </Row>
      <Row title={t.startWithWindows} desc={t.startWithWindowsDesc}>
        <Toggle on={s.behavior.startWithWindows} onChange={(v) => set({ startWithWindows: v })} />
      </Row>
    </div>
  );
}

function BackupSec({ update }: { update: SecProps["update"] }) {
  const [backups, setBackups] = useState<BackupInfo[] | null>(null);
  const [note, setNote] = useState("");
  const load = () => api.listBackups().then(setBackups).catch(() => setBackups([]));
  useEffect(() => {
    load();
  }, []);

  const apply = async (st: PersistedState, msg: string) => {
    if (st.layout) await emitToWindow("desktop", "layout-replaced", { layout: st.layout });
    if (st.settings) update(() => normalizeSettings(st.settings));
    setNote(msg);
  };

  const fmt = new Intl.DateTimeFormat("tr-TR", { dateStyle: "medium", timeStyle: "short" });
  return (
    <>
      <p className="small-note">{t.backupsDesc}</p>
      <div className="card">
        <Row title={t.exportLayout}>
          <button
            className="btn"
            onClick={async () => {
              const path = await saveDialog({ defaultPath: "folder-explorer-duzen.json", filters: [{ name: "JSON", extensions: ["json"] }] });
              if (!path) return;
              await api.exportState(path);
              setNote(t.exportDone);
            }}
          >
            {t.exportLayout}
          </button>
        </Row>
        <Row title={t.importLayout}>
          <button
            className="btn"
            onClick={async () => {
              const path = await openDialog({ multiple: false, filters: [{ name: "JSON", extensions: ["json"] }] });
              if (typeof path !== "string") return;
              try {
                await apply(await api.importState(path), t.importDone);
              } catch (e) {
                setNote(String(e));
              }
            }}
          >
            {t.importLayout}
          </button>
        </Row>
      </div>
      {note && <p className="small-note">{note}</p>}
      <div className="card backup-list">
        {backups && backups.length === 0 && <Row title={t.noBackups} />}
        {backups?.map((b) => (
          <Row key={b.name} title={fmt.format(new Date(b.createdAt))} desc={`${(b.size / 1024).toFixed(1)} KB`}>
            <button
              className="btn"
              onClick={async () => {
                try {
                  await apply(await api.restoreBackup(b.name), t.backupRestored);
                  load();
                } catch (e) {
                  setNote(String(e));
                }
              }}
            >
              {t.restoreBackup}
            </button>
          </Row>
        ))}
      </div>
    </>
  );
}

function About() {
  return (
    <>
      <div className="card">
        <Row title={t.appName} desc={`${t.version} 0.1.0`} />
        <div style={{ padding: "0 18px 16px", color: "var(--fg-dim)", lineHeight: 1.55 }}>{t.aboutText}</div>
      </div>
      <button className="btn danger" onClick={() => api.quitApp().catch(() => {})}>
        {t.quit}
      </button>
    </>
  );
}

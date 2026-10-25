import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  Archive,
  Check,
  Folder,
  Gauge,
  Grid3x3,
  Image,
  Info,
  Layers,
  MousePointerClick,
  Palette,
  Search,
  Sparkles,
  SwatchBook,
  Type,
  Volume2,
  type LucideIcon,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, emitToWindow, mediaUrl, on } from "../api";
import { t } from "../i18n";
import { cellMetrics } from "../layout/grid";
import { ACCENTS, applyTheme, DEFAULT_SETTINGS, FOLDER_COLORS, normalizeSettings, spring } from "../settings";
import { applyPreset, readThemeFile, applyThemePatch, THEME_PRESETS, themeFile, visualSettings } from "../themes";
import type { BackupInfo, IconShape, MonitorInfo, PersistedState, Settings, WallpaperSpec } from "../types";
import { AutoColor, Colors, pct, px, Row, Seg, Slider, times, Toggle } from "./controls";
import { IconSample, MockFolder, PageIndicator, plateRadius, ThemeThumb, WallpaperThumb } from "./previews";
import { previewSound } from "../desktop/sounds";
import { WallpaperEditor } from "./WallpaperEditor";
import "./settings.css";

type Section =
  | "appearance"
  | "themes"
  | "wallpaper"
  | "icons"
  | "labels"
  | "folders"
  | "transparency"
  | "animation"
  | "behavior"
  | "search"
  | "performance"
  | "backup"
  | "about";

const SECTIONS: { id: Section; label: string; icon: LucideIcon }[] = [
  { id: "appearance", label: t.secAppearance, icon: Palette },
  { id: "themes", label: t.secThemes, icon: SwatchBook },
  { id: "wallpaper", label: t.secWallpaper, icon: Image },
  { id: "icons", label: t.secIcons, icon: Grid3x3 },
  { id: "labels", label: t.secLabels, icon: Type },
  { id: "folders", label: t.secFolders, icon: Folder },
  { id: "transparency", label: t.secTransparency, icon: Layers },
  { id: "animation", label: t.secAnimation, icon: Sparkles },
  { id: "behavior", label: t.secBehavior, icon: MousePointerClick },
  { id: "search", label: t.secSearch, icon: Search },
  { id: "performance", label: t.secPerformance, icon: Gauge },
  { id: "backup", label: t.secBackup, icon: Archive },
  { id: "about", label: t.secAbout, icon: Info },
];

export function SettingsView() {
  const [s, setS] = useState<Settings>(DEFAULT_SETTINGS);
  const [section, setSection] = useState<Section>("appearance");
  const saveTimer = useRef<number | undefined>(undefined);
  const latest = useRef(s);
  const mainRef = useRef<HTMLElement>(null);

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
          <button
            key={id}
            className="nav-item"
            data-active={section === id}
            onClick={() => {
              setSection(id);
              mainRef.current?.scrollTo(0, 0);
            }}
          >
            <I size={17} strokeWidth={1.8} />
            {label}
          </button>
        ))}
      </nav>
      <main className="settings-main" ref={mainRef}>
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
            {section === "themes" && <ThemesSec s={s} update={update} />}
            {section === "wallpaper" && <WallpaperSec s={s} update={update} />}
            {section === "icons" && <IconsSec s={s} update={update} />}
            {section === "labels" && <LabelsSec s={s} update={update} />}
            {section === "folders" && <FoldersSec s={s} update={update} />}
            {section === "transparency" && <TransparencySec s={s} update={update} />}
            {section === "animation" && <AnimationSec s={s} update={update} />}
            {section === "behavior" && <BehaviorSec s={s} update={update} />}
            {section === "search" && <SearchSec s={s} update={update} />}
            {section === "performance" && <PerformanceSec s={s} update={update} />}
            {section === "backup" && <BackupSec update={update} />}
            {section === "about" && <About />}
          </motion.div>
        </AnimatePresence>
      </main>
    </div>
  );
}

type Update = (fn: (cur: Settings) => Settings) => void;
type SecProps = { s: Settings; update: Update };
type GroupKey = { [K in keyof Settings]: Settings[K] extends Record<string, unknown> ? K : never }[keyof Settings];

const groupSetter =
  <K extends GroupKey>(update: Update, key: K) =>
  (patch: Partial<Settings[K]>) =>
    update((c) => ({ ...c, [key]: { ...c[key], ...patch } }) as Settings);

function Title({ children }: { children: string }) {
  return <h2 className="sec-title">{children}</h2>;
}

// ---------------------------------------------------------------- sections

function Appearance({ s, update }: SecProps) {
  const sel = groupSetter(update, "selection");
  const pi = groupSetter(update, "pageIndicator");
  return (
    <>
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
        <Row title={t.accent} desc={s.wallpaper.accentFromWallpaper ? t.accentFromWpOn : undefined}>
          <Colors value={s.accent} options={ACCENTS} onChange={(v) => v && update((c) => ({ ...c, accent: v }))} />
        </Row>
      </div>

      <Title>{t.hSelection}</Title>
      <div className="preview-strip">
        <IconSample s={s} glyph={0} label={t.sampleNames[0]} selected />
        <IconSample s={s} glyph={1} label={t.sampleNames[1]} selected />
        <IconSample s={s} glyph={2} label={t.sampleNames[2]} />
        <div className="marquee-sample" style={marqueeStyle(s)} />
      </div>
      <div className="card">
        <Row title={t.selColor}>
          <AutoColor value={s.selection.color} fallback={s.accent} autoLabel={t.accent} onChange={(v) => sel({ color: v })} />
        </Row>
        <Row title={t.selStyle}>
          <Seg
            value={s.selection.style}
            options={[
              { v: "fill", label: t.selFill },
              { v: "outline", label: t.selOutline },
              { v: "glow", label: t.selGlow },
            ]}
            onChange={(v) => sel({ style: v })}
          />
        </Row>
        <Row title={t.marqueeRadius}>
          <Slider value={s.selection.marqueeRadius} min={0} max={12} format={px} onChange={(v) => sel({ marqueeRadius: v })} />
        </Row>
      </div>

      <Title>{t.hPageIndicator}</Title>
      <div className="preview-strip screen">
        <IconSample s={s} glyph={1} />
        <IconSample s={s} glyph={0} />
        <IconSample s={s} glyph={2} />
        <PageIndicator s={s} />
      </div>
      <div className="card">
        <Row title={t.piStyle}>
          <Seg
            value={s.pageIndicator.style}
            options={[
              { v: "dots", label: t.piDots },
              { v: "line", label: t.piLine },
              { v: "numbers", label: t.piNumbers },
              { v: "hidden", label: t.piHidden },
            ]}
            onChange={(v) => pi({ style: v })}
          />
        </Row>
        <Row title={t.piPosition}>
          <Seg
            value={s.pageIndicator.position}
            options={[
              { v: "bottom", label: t.posBottom },
              { v: "top", label: t.posTop },
              { v: "left", label: t.posLeft },
              { v: "right", label: t.posRight },
            ]}
            onChange={(v) => pi({ position: v })}
          />
        </Row>
      </div>
    </>
  );
}

function marqueeStyle(s: Settings) {
  const c = s.selection.color ?? s.accent;
  return { borderRadius: s.selection.marqueeRadius, borderColor: c, background: `color-mix(in srgb, ${c} 18%, transparent)` };
}

function ThemesSec({ s, update }: SecProps) {
  const [note, setNote] = useState("");
  const presets = useMemo(() => {
    const cur = JSON.stringify(visualSettings(s));
    return THEME_PRESETS.map((p) => {
      const ps = applyPreset(s, p);
      return { p, ps, active: JSON.stringify(visualSettings(ps)) === cur };
    });
  }, [s]);

  const exportFile = async () => {
    const path = await saveDialog({ defaultPath: "folder-explorer-tema.json", filters: [{ name: "JSON", extensions: ["json"] }] });
    if (!path) return;
    try {
      await api.exportTheme(path, themeFile(s));
      setNote(t.themeExported);
    } catch (e) {
      setNote(String(e));
    }
  };
  const importFile = async () => {
    const path = await openDialog({ multiple: false, filters: [{ name: "JSON", extensions: ["json"] }] });
    if (typeof path !== "string") return;
    try {
      const patch = readThemeFile(await api.importTheme(path));
      if (!patch) return setNote(t.themeInvalid);
      update((c) => applyThemePatch(c, patch));
      setNote(t.themeImported);
    } catch (e) {
      setNote(String(e));
    }
  };

  return (
    <>
      <p className="small-note">{t.themesDesc}</p>
      <div className="theme-grid">
        {presets.map(({ p, ps, active }) => (
          <button key={p.id} className="theme-card" data-active={active} onClick={() => update((c) => applyPreset(c, p))}>
            <ThemeThumb s={ps} />
            <div className="theme-name">
              {p.name}
              {active && (
                <span className="theme-badge">
                  <Check size={12} strokeWidth={2.4} />
                  {t.themeActive}
                </span>
              )}
            </div>
          </button>
        ))}
      </div>
      <Title>{t.hThemeFile}</Title>
      <div className="card">
        <Row title={t.exportThemeTitle} desc={t.exportThemeDesc}>
          <button className="btn" onClick={exportFile}>
            {t.exportTheme}
          </button>
        </Row>
        <Row title={t.importThemeTitle} desc={t.importThemeDesc}>
          <button className="btn" onClick={importFile}>
            {t.importTheme}
          </button>
        </Row>
      </div>
      {note && <p className="small-note">{note}</p>}
    </>
  );
}

function WallpaperSec({ s, update }: SecProps) {
  const wp = s.wallpaper;
  const set = (patch: Partial<Settings["wallpaper"]>) => update((c) => ({ ...c, wallpaper: { ...c.wallpaper, ...patch } }));
  const setDayNight = (patch: Partial<Settings["wallpaper"]["dayNight"]>) =>
    update((c) => ({ ...c, wallpaper: { ...c.wallpaper, dayNight: { ...c.wallpaper.dayNight, ...patch } } }));
  const setNight = (patch: Partial<WallpaperSpec>) =>
    update((c) => {
      const dn = c.wallpaper.dayNight;
      return { ...c, wallpaper: { ...c.wallpaper, dayNight: { ...dn, night: { ...dn.night, ...patch } } } };
    });
  const dn = wp.dayNight;
  return (
    <>
      <div className="card">
        <WallpaperEditor spec={wp} onChange={set} />
      </div>
      <div className="card">
        <Row title={t.accentFromWp} desc={t.accentFromWpDesc}>
          <Toggle on={wp.accentFromWallpaper} onChange={(v) => set({ accentFromWallpaper: v })} />
        </Row>
      </div>

      <Title>{t.hDayNight}</Title>
      <div className="card">
        <Row title={t.dayNight} desc={t.dayNightDesc}>
          <Toggle on={dn.enabled} onChange={(v) => setDayNight({ enabled: v })} />
        </Row>
        {dn.enabled && (
          <>
            <Row title={t.dayStart}>
              <input type="time" className="input time-input" value={dn.dayStart} onChange={(e) => e.target.value && setDayNight({ dayStart: e.target.value })} />
            </Row>
            <Row title={t.nightStart}>
              <input type="time" className="input time-input" value={dn.nightStart} onChange={(e) => e.target.value && setDayNight({ nightStart: e.target.value })} />
            </Row>
            <div className="sub">
              <div className="sub-title">{t.nightWallpaper}</div>
              <WallpaperEditor spec={dn.night} onChange={setNight} />
            </div>
          </>
        )}
      </div>

      <Title>{t.hPerPage}</Title>
      <PerPageWallpapers s={s} update={update} />
    </>
  );
}

const pageKey = (monitorId: string, page: number) => `${monitorId}|${page}`;

function PerPageWallpapers({ s, update }: SecProps) {
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  const [pageCounts, setPageCounts] = useState<Record<string, number>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [mon, setMon] = useState("");
  const [page, setPage] = useState(0);

  useEffect(() => {
    api
      .getEnvironment()
      .then((env) => {
        const ms = [...env.monitors].sort((a, b) => Number(b.primary) - Number(a.primary) || a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y);
        setMonitors(ms);
        setMon((m) => m || ms[0]?.id || "");
      })
      .catch(() => {});
    api
      .loadState()
      .then((st) => {
        const counts: Record<string, number> = {};
        const placements = (st.layout as { placements?: Record<string, { m?: unknown; p?: unknown }> } | null)?.placements ?? {};
        for (const pl of Object.values(placements)) {
          if (typeof pl?.m === "string" && typeof pl.p === "number") counts[pl.m] = Math.max(counts[pl.m] ?? 1, pl.p + 1);
        }
        setPageCounts(counts);
      })
      .catch(() => {});
  }, []);

  const label = (key: string) => {
    const i = key.lastIndexOf("|");
    const id = key.slice(0, i);
    const p = Number(key.slice(i + 1));
    const mi = monitors.findIndex((m) => m.id === id);
    const m = monitors[mi];
    return { monitor: m ? t.monitorLabel(mi + 1, m.primary) : t.unknownMonitor, page: t.pageLabel(p + 1), order: (mi < 0 ? 99 : mi) * 1000 + p };
  };
  const entries = Object.entries(s.wallpaper.perPage)
    .map(([key, spec]) => ({ key, spec, ...label(key) }))
    .sort((a, b) => a.order - b.order);

  const setEntry = (key: string, patch: Partial<WallpaperSpec>) =>
    update((c) => {
      const perPage = { ...c.wallpaper.perPage, [key]: { ...c.wallpaper.perPage[key], ...patch } };
      return { ...c, wallpaper: { ...c.wallpaper, perPage } };
    });
  const remove = (key: string) => {
    update((c) => {
      const perPage = { ...c.wallpaper.perPage };
      delete perPage[key];
      return { ...c, wallpaper: { ...c.wallpaper, perPage } };
    });
    if (editing === key) setEditing(null);
  };
  const add = () => {
    if (!mon) return;
    const key = pageKey(mon, page);
    if (!s.wallpaper.perPage[key]) {
      update((c) => {
        const { source, image, color, gradient, blur, dim } = c.wallpaper;
        const spec: WallpaperSpec = { source, image, color, gradient: { ...gradient }, blur, dim };
        return { ...c, wallpaper: { ...c.wallpaper, perPage: { ...c.wallpaper.perPage, [key]: spec } } };
      });
    }
    setEditing(key);
  };
  const pages = (pageCounts[mon] ?? 1) + 1;

  return (
    <div className="card">
      {entries.length === 0 && <Row title={t.perPageEmpty} desc={t.perPageDesc} />}
      {entries.map((e) => (
        <PerPageEntry
          key={e.key}
          title={e.monitor}
          desc={e.page}
          spec={e.spec}
          open={editing === e.key}
          onToggle={() => setEditing(editing === e.key ? null : e.key)}
          onRemove={() => remove(e.key)}
          onChange={(patch) => setEntry(e.key, patch)}
        />
      ))}
      <Row title={t.perPageAdd} desc={entries.length ? t.perPageDesc : undefined}>
        <select className="input select" value={mon} onChange={(e) => setMon(e.target.value)}>
          {monitors.map((m, i) => (
            <option key={m.id} value={m.id}>
              {`${t.monitorLabel(i + 1, m.primary)} · ${m.bounds.width}×${m.bounds.height}`}
            </option>
          ))}
        </select>
        <select className="input select narrow" value={Math.min(page, pages - 1)} onChange={(e) => setPage(Number(e.target.value))}>
          {Array.from({ length: pages }, (_, p) => (
            <option key={p} value={p}>
              {t.pageLabel(p + 1)}
            </option>
          ))}
        </select>
        <button className="btn" disabled={!mon} onClick={add}>
          {t.addEntry}
        </button>
      </Row>
    </div>
  );
}

function PerPageEntry({
  title,
  desc,
  spec,
  open,
  onToggle,
  onRemove,
  onChange,
}: {
  title: string;
  desc: string;
  spec: WallpaperSpec;
  open: boolean;
  onToggle: () => void;
  onRemove: () => void;
  onChange: (patch: Partial<WallpaperSpec>) => void;
}) {
  return (
    <>
      <Row title={title} desc={desc}>
        <WallpaperThumb spec={spec} />
        <button className="btn" onClick={onToggle}>
          {open ? t.doneEntry : t.editEntry}
        </button>
        <button className="btn" onClick={onRemove}>
          {t.removeEntry}
        </button>
      </Row>
      {open && (
        <div className="sub">
          <WallpaperEditor spec={spec} onChange={onChange} />
        </div>
      )}
    </>
  );
}

const SHAPES: { v: IconShape; label: string }[] = [
  { v: "none", label: t.shapeNone },
  { v: "circle", label: t.shapeCircle },
  { v: "squircle", label: t.shapeSquircle },
  { v: "square", label: t.shapeSquare },
  { v: "teardrop", label: t.shapeTeardrop },
];

function IconsSec({ s, update }: SecProps) {
  const set = groupSetter(update, "grid");
  const ic = groupSetter(update, "icons");
  // switching to manual starts from what the primary monitor shows now, so nothing jumps
  const toManual = () =>
    api
      .getEnvironment()
      .then((env) => {
        const m = env.monitors.find((x) => x.primary) ?? env.monitors[0];
        const cur = cellMetrics(m, env.scaleFactor || 1, s);
        set({ autoSize: false, iconSize: cur.iconSize, cellWidth: cur.cellW, cellHeight: cur.cellH });
      })
      .catch(() => set({ autoSize: false }));
  const size = Math.round(Math.min(96, Math.max(24, (s.grid.autoSize ? 44 : s.grid.iconSize) * s.grid.iconScale)));
  return (
    <>
      <div className="preview-strip">
        {[0, 1, 2].map((g) => (
          <IconSample key={g} s={s} glyph={g} label={t.sampleNames[g]} size={size} />
        ))}
      </div>

      <Title>{t.hPlate}</Title>
      <div className="card">
        <Row title={t.iconShape}>
          <Seg
            value={s.icons.shape}
            options={SHAPES.map((o) => ({ ...o, icon: <i className="shape-ico" data-none={o.v === "none" || undefined} style={{ borderRadius: plateRadius(o.v) }} /> }))}
            onChange={(v) => ic({ shape: v })}
          />
        </Row>
        {s.icons.shape !== "none" && (
          <>
            <Row title={t.plateColor} desc={t.plateColorDesc}>
              <AutoColor value={s.icons.plateColor} fallback="#ffffff" onChange={(v) => ic({ plateColor: v })} />
            </Row>
            <Row title={t.plateOpacity}>
              <Slider value={s.icons.plateOpacity} min={0} max={1} step={0.01} format={pct} onChange={(v) => ic({ plateOpacity: v })} />
            </Row>
            <Row title={t.iconInset} desc={t.iconInsetDesc}>
              <Slider value={s.icons.inset} min={0} max={0.35} step={0.01} format={pct} onChange={(v) => ic({ inset: v })} />
            </Row>
          </>
        )}
      </div>

      <Title>{t.hIconPack}</Title>
      <IconPackCard s={s} update={update} />

      <Title>{t.hSizeGrid}</Title>
      <div className="card">
        <Row title={t.iconScale} desc={t.iconScaleDesc}>
          <Slider value={s.grid.iconScale} min={0.5} max={3} step={0.05} format={pct} onChange={(v) => set({ iconScale: v })} />
        </Row>
        <Row title={t.autoSize} desc={t.autoSizeDesc}>
          <Toggle on={s.grid.autoSize} onChange={(v) => (v ? set({ autoSize: true }) : toManual())} />
        </Row>
        {!s.grid.autoSize && (
          <>
            <Row title={t.iconSize}>
              <Slider
                value={s.grid.iconSize}
                min={24}
                max={128}
                format={px}
                onChange={(v) => set({ iconSize: v, cellWidth: Math.max(s.grid.cellWidth, v + 24), cellHeight: Math.max(s.grid.cellHeight, v + 40) })}
              />
            </Row>
            <Row title={t.cellWidth}>
              <Slider value={s.grid.cellWidth} min={56} max={200} format={px} onChange={(v) => set({ cellWidth: v })} />
            </Row>
            <Row title={t.cellHeight}>
              <Slider value={s.grid.cellHeight} min={56} max={220} format={px} onChange={(v) => set({ cellHeight: v })} />
            </Row>
          </>
        )}
        <Row title={t.autoArrange} desc={t.autoArrangeDesc}>
          <Toggle on={s.grid.autoArrange} onChange={(v) => set({ autoArrange: v })} />
        </Row>
      </div>
    </>
  );
}

function IconPackCard({ s, update }: SecProps) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const pack = s.icons.pack;
  const files = pack ? Object.values(pack.map) : [];
  const pick = async () => {
    const dir = await openDialog({ directory: true, multiple: false });
    if (typeof dir !== "string") return;
    setBusy(true);
    setNote("");
    try {
      const p = await api.importIconPack(dir);
      const n = p ? Object.keys(p.map).length : 0;
      if (p && n) {
        update((c) => ({ ...c, icons: { ...c.icons, pack: p } }));
        setNote(t.iconPackDone(n));
      }
    } catch (e) {
      setNote(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="card">
        <Row title={pack ? pack.name : t.iconPackNone} desc={pack ? t.iconPackCount(files.length) : undefined}>
          {pack && (
            <div className="pack-preview">
              {files.slice(0, 6).map((f) => (
                <img key={f} src={mediaUrl(f)} alt="" />
              ))}
            </div>
          )}
          {pack && (
            <button className="btn" onClick={() => update((c) => ({ ...c, icons: { ...c.icons, pack: null } }))}>
              {t.removeEntry}
            </button>
          )}
          <button className="btn" disabled={busy} onClick={pick}>
            {busy ? t.importingPack : pack ? t.changeFolder : t.chooseFolder}
          </button>
        </Row>
      </div>
      <p className="small-note">{note || t.iconPackDesc}</p>
    </>
  );
}

const FONTS = ["Segoe UI", "Segoe UI Variable", "Bahnschrift", "Consolas", "Georgia", "Trebuchet MS", "Verdana"];
const OTHER_FONT = "__other__";

function LabelsSec({ s, update }: SecProps) {
  const lb = groupSetter(update, "labels");
  const grid = groupSetter(update, "grid");
  const [other, setOther] = useState(() => s.labels.font !== "" && !FONTS.includes(s.labels.font));
  return (
    <>
      <div className="preview-strip">
        {[0, 1, 2].map((g) => (
          <IconSample key={g} s={s} glyph={g} label={t.sampleNames[g]} />
        ))}
        {s.labels.hoverOnly && <span className="strip-hint">{t.hoverToSee}</span>}
      </div>
      <div className="card">
        <Row title={t.showLabels}>
          <Toggle on={s.grid.labels} onChange={(v) => grid({ labels: v })} />
        </Row>
        <Row title={t.labelLines}>
          <Seg
            value={s.grid.labelLines}
            options={[
              { v: 1, label: "1" },
              { v: 2, label: "2" },
              { v: 3, label: "3" },
            ]}
            onChange={(v) => grid({ labelLines: v })}
          />
        </Row>
      </div>
      <div className="card">
        <Row title={t.labelFont}>
          {other && <input className="input font-input" value={s.labels.font} placeholder={t.fontPlaceholder} onChange={(e) => lb({ font: e.target.value })} />}
          <select
            className="input select"
            value={other ? OTHER_FONT : s.labels.font}
            onChange={(e) => {
              const v = e.target.value;
              setOther(v === OTHER_FONT);
              if (v !== OTHER_FONT) lb({ font: v });
            }}
          >
            <option value="">{t.fontSystem}</option>
            {FONTS.map((f) => (
              <option key={f} value={f} style={{ fontFamily: f }}>
                {f}
              </option>
            ))}
            <option value={OTHER_FONT}>{t.fontOther}</option>
          </select>
        </Row>
        <Row title={t.labelSize}>
          <Slider value={s.labels.size} min={10} max={18} format={px} onChange={(v) => lb({ size: v })} />
        </Row>
        <Row title={t.labelWeight}>
          <Seg
            value={s.labels.weight}
            options={[
              { v: 400, label: t.weightRegular },
              { v: 500, label: t.weightMedium },
              { v: 600, label: t.weightSemibold },
              { v: 700, label: t.weightBold },
            ]}
            onChange={(v) => lb({ weight: v })}
          />
        </Row>
        <Row title={t.labelColor} desc={t.labelColorDesc}>
          <AutoColor value={s.labels.color} fallback="#ffffff" onChange={(v) => lb({ color: v })} />
        </Row>
        <Row title={t.labelShadow}>
          <Slider value={s.labels.shadow} min={0} max={1} step={0.01} format={pct} onChange={(v) => lb({ shadow: v })} />
        </Row>
        <Row title={t.labelHoverOnly} desc={t.labelHoverOnlyDesc}>
          <Toggle on={s.labels.hoverOnly} onChange={(v) => lb({ hoverOnly: v })} />
        </Row>
      </div>
    </>
  );
}

function FoldersSec({ s, update }: SecProps) {
  const set = groupSetter(update, "folders");
  const gb = groupSetter(update, "groupBox");
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
          <Seg
            value={s.folders.preview}
            options={[
              { v: 2, label: "2 × 2" },
              { v: 3, label: "3 × 3" },
            ]}
            onChange={(v) => set({ preview: v })}
          />
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

      <Title>{t.hGroupBox}</Title>
      <div className="card">
        <Row title={t.gbBorderWidth}>
          <Slider value={s.groupBox.borderWidth} min={0} max={4} step={0.5} format={px} onChange={(v) => gb({ borderWidth: v })} />
        </Row>
        {s.groupBox.borderWidth > 0 && (
          <>
            <Row title={t.gbBorderColor} desc={t.gbBorderColorDesc}>
              <AutoColor value={s.groupBox.borderColor} fallback="#ffffff" onChange={(v) => gb({ borderColor: v })} />
            </Row>
            <Row title={t.gbBorderOpacity}>
              <Slider value={s.groupBox.borderOpacity} min={0} max={1} step={0.01} format={pct} onChange={(v) => gb({ borderOpacity: v })} />
            </Row>
          </>
        )}
        <Row title={t.gbShadow}>
          <Slider value={s.groupBox.shadow} min={0} max={1} step={0.01} format={pct} onChange={(v) => gb({ shadow: v })} />
        </Row>
        <Row title={t.gbGradient} desc={t.gbGradientDesc}>
          <Toggle on={s.groupBox.gradient} onChange={(v) => gb({ gradient: v })} />
        </Row>
        <Row title={t.gbGlow}>
          <Slider value={s.groupBox.glow} min={0} max={1} step={0.01} format={pct} onChange={(v) => gb({ glow: v })} />
        </Row>
      </div>
    </>
  );
}

function TransparencySec({ s, update }: SecProps) {
  const set = groupSetter(update, "transparency");
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

const HOVERS: { v: Settings["animation"]["hover"]; label: string }[] = [
  { v: "none", label: t.hoverNone },
  { v: "lift", label: t.hoverLift },
  { v: "grow", label: t.hoverGrow },
  { v: "tilt", label: t.hoverTilt },
  { v: "glow", label: t.hoverGlow },
  { v: "bounce", label: t.hoverBounce },
  { v: "magnify", label: t.hoverMagnify },
];

function SpringDemo({ s }: { s: Settings }) {
  const [right, setRight] = useState(false);
  return (
    <button className="spring-demo" onClick={() => setRight((r) => !r)} title={t.tryIt}>
      <motion.i animate={{ x: right ? 64 : 0 }} transition={spring(s, 0.5, 0.3)} />
      <span>{t.tryIt}</span>
    </button>
  );
}

function AnimationSec({ s, update }: SecProps) {
  const set = groupSetter(update, "animation");
  const an = s.animation;
  return (
    <>
      <div className="card">
        <Row title={t.animSpeed}>
          <Slider value={an.speed} min={0.25} max={3} step={0.05} format={times} onChange={(v) => set({ speed: v })} />
        </Row>
        <Row title={t.reduceMotion} desc={t.reduceMotionDesc}>
          <Toggle on={an.reduceMotion} onChange={(v) => set({ reduceMotion: v })} />
        </Row>
      </div>

      <Title>{t.hStyles}</Title>
      <div className="card">
        <Row title={t.openStyle}>
          <Seg
            value={an.openStyle}
            options={[
              { v: "zoom", label: t.openZoom },
              { v: "spring", label: t.openSpring },
              { v: "flip", label: t.openFlip },
              { v: "blur", label: t.openBlur },
              { v: "fade", label: t.openFade },
            ]}
            onChange={(v) => set({ openStyle: v })}
          />
        </Row>
        <Row title={t.pageTransition}>
          <Seg
            value={an.pageTransition}
            options={[
              { v: "slide", label: t.ptSlide },
              { v: "cube", label: t.ptCube },
              { v: "cards", label: t.ptCards },
              { v: "fade", label: t.ptFade },
            ]}
            onChange={(v) => set({ pageTransition: v })}
          />
        </Row>
        <Row title={t.hoverEffect} desc={an.hover !== "none" ? t.hoverToSee : undefined} stack>
          <div className="hover-demo">
            <Seg value={an.hover} options={HOVERS} onChange={(v) => set({ hover: v })} />
            <div className="hover-samples">
              {[1, 0, 2].map((g) => (
                <IconSample key={g} s={s} glyph={g} size={40} hover={an.hover} />
              ))}
            </div>
          </div>
        </Row>
        <Row title={t.parallax} desc={t.parallaxDesc}>
          <Toggle on={an.parallax} onChange={(v) => set({ parallax: v })} />
        </Row>
      </div>

      <Title>{t.hMotion}</Title>
      <div className="card">
        <Row title={t.stiffness} desc={t.stiffnessDesc}>
          <Slider value={an.stiffness} min={0.5} max={2} step={0.05} format={times} onChange={(v) => set({ stiffness: v })} />
        </Row>
        <Row title={t.bounce} desc={t.bounceDesc}>
          <Slider value={an.bounce} min={0} max={2} step={0.05} format={times} onChange={(v) => set({ bounce: v })} />
        </Row>
        <Row title={t.preview}>
          <SpringDemo s={s} />
        </Row>
      </div>

      <Title>{t.hSounds}</Title>
      <div className="card">
        <Row title={t.soundsSetting} desc={t.soundsSettingDesc}>
          <Toggle on={an.sounds} onChange={(v) => set({ sounds: v })} />
        </Row>
        <Row title={t.soundVolume}>
          <Slider value={an.soundVolume} min={0} max={1} step={0.01} format={pct} disabled={!an.sounds} onChange={(v) => set({ soundVolume: v })} />
          <button className="btn icon-btn" disabled={an.soundVolume <= 0} onClick={() => previewSound("open", an.soundVolume)}>
            <Volume2 size={15} strokeWidth={1.8} />
            {t.listen}
          </button>
        </Row>
      </div>
    </>
  );
}

function BehaviorSec({ s, update }: SecProps) {
  const set = groupSetter(update, "behavior");
  const be = s.behavior;
  return (
    <>
      <Title>{t.hDesktopBehavior}</Title>
      <div className="card">
        <Row title={t.lockLayout} desc={t.lockLayoutDesc}>
          <Toggle on={be.lockLayout} onChange={(v) => set({ lockLayout: v })} />
        </Row>
        <Row title={t.doubleClickHide} desc={t.doubleClickHideDesc}>
          <Toggle on={be.doubleClickHide} onChange={(v) => set({ doubleClickHide: v })} />
        </Row>
        <Row title={t.ctrlWheelZoom} desc={t.ctrlWheelZoomDesc}>
          <Toggle on={be.ctrlWheelZoom} onChange={(v) => set({ ctrlWheelZoom: v })} />
        </Row>
        <Row title={t.quickLookSetting} desc={t.quickLookSettingDesc}>
          <Toggle on={be.quickLook} onChange={(v) => set({ quickLook: v })} />
        </Row>
        <Row title={t.dropOnApp} desc={t.dropOnAppDesc}>
          <Toggle on={be.dropOnApp} onChange={(v) => set({ dropOnApp: v })} />
        </Row>
        <Row title={t.showSystemIcons} desc={t.showSystemIconsDesc}>
          <Toggle on={be.showSystemIcons} onChange={(v) => set({ showSystemIcons: v })} />
        </Row>
      </div>
      <Title>{t.hGeneral}</Title>
      <div className="card">
        <Row title={t.startWithWindows} desc={t.startWithWindowsDesc}>
          <Toggle on={be.startWithWindows} onChange={(v) => set({ startWithWindows: v })} />
        </Row>
        <Row title={t.newMenuEntry} desc={t.newMenuEntryDesc}>
          <Toggle on={be.newMenuEntry} onChange={(v) => set({ newMenuEntry: v })} />
        </Row>
      </div>
    </>
  );
}

function SearchSec({ s, update }: SecProps) {
  const be = groupSetter(update, "behavior");
  const sr = groupSetter(update, "search");
  const rows: { key: keyof Settings["search"]; title: string; desc: string }[] = [
    { key: "calculator", title: t.srcCalculator, desc: t.srcCalculatorDesc },
    { key: "recentFiles", title: t.srcRecent, desc: t.srcRecentDesc },
    { key: "files", title: t.srcFiles, desc: t.srcFilesDesc },
    { key: "settingsPages", title: t.srcSettings, desc: t.srcSettingsDesc },
    { key: "web", title: t.srcWeb, desc: t.srcWebDesc },
  ];
  return (
    <>
      <div className="card">
        <Row title={t.typeToSearch} desc={t.typeToSearchDesc}>
          <Toggle on={s.behavior.typeToSearch} onChange={(v) => be({ typeToSearch: v })} />
        </Row>
      </div>
      <Title>{t.hSearchSources}</Title>
      <div className="card">
        {rows.map((r) => (
          <Row key={r.key} title={r.title} desc={r.desc}>
            <Toggle on={s.search[r.key]} onChange={(v) => sr({ [r.key]: v })} />
          </Row>
        ))}
      </div>
      <p className="small-note">{t.paletteNote}</p>
    </>
  );
}

function PerformanceSec({ s, update }: SecProps) {
  const set = groupSetter(update, "performance");
  return (
    <div className="card">
      <Row title={t.gameModeSetting} desc={t.gameModeSettingDesc}>
        <Toggle on={s.performance.gameMode} onChange={(v) => set({ gameMode: v })} />
      </Row>
      <Row title={t.batteryModeSetting} desc={t.batteryModeSettingDesc}>
        <Seg
          value={s.performance.batteryMode}
          options={[
            { v: "auto", label: t.batteryAuto },
            { v: "always", label: t.batteryAlways },
            { v: "off", label: t.batteryOff },
          ]}
          onChange={(v) => set({ batteryMode: v })}
        />
      </Row>
    </div>
  );
}

function BackupSec({ update }: { update: Update }) {
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

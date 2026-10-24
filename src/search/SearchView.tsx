import { getCurrentWindow } from "@tauri-apps/api/window";
import { Calculator, Check, ChevronsRight, Folder, Globe, Search, Settings as SettingsIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { api, emitToWindow, iconUrl, mediaUrl, on } from "../api";
import { t } from "../i18n";
import { isFolderId, normalizeLayout } from "../layout/model";
import type { MenuPick } from "../menu/model";
import { applyTheme, DEFAULT_SETTINGS, normalizeSettings, rgba } from "../settings";
import type { DesktopItem, FoundFile, Layout, RecentFile, Settings, StartApp } from "../types";
import { calculate } from "./calc";
import { SETTINGS_PAGES } from "./settingsPages";
import "./search.css";

type Group = "calc" | "commands" | "desktop" | "apps" | "settings" | "recent" | "files" | "web";

type Entry = {
  key: string;
  group: Group;
  kind: "item" | "folder" | "app" | "calc" | "recent" | "file" | "setting" | "web" | "command";
  name: string;
  sub: string;
  id?: string;
  path?: string;
  parsingName?: string;
  icon?: string;
  color?: string | null;
  /** calc: the result text; setting: its ms-settings: URI; command: its id */
  value?: string;
};

const GROUP_LABEL: Record<Group, string> = {
  calc: t.groupCalc,
  commands: t.groupCommands,
  desktop: t.groupDesktop,
  apps: t.groupApps,
  settings: t.groupSettings,
  recent: t.groupRecent,
  files: t.groupFiles,
  web: t.groupWeb,
};

// ---------------------------------------------------------------- command palette (">")

/** Runs in the desktop window: the same `menu-action` its right-click menu sends. */
const menuAction = (id: string) => () => {
  const pick: MenuPick = { id, target: "desktop", ids: [], paths: [], at: [0, 0], cell: null, canPaste: false };
  return emitToWindow("desktop", "menu-action", pick);
};
/** Desktop actions that are not menu entries (DesktopView handles `palette-action`). */
const paletteAction = (id: string) => () => emitToWindow("desktop", "palette-action", { id });

const COMMANDS: { id: string; name: string; run: () => Promise<unknown> }[] = [
  { id: "refresh", name: t.palette.refresh, run: menuAction("refresh") },
  { id: "autoarrange", name: t.palette.autoArrange, run: menuAction("autoarrange") },
  { id: "sort:name", name: t.palette.sortName, run: menuAction("sort:name") },
  { id: "sort:size", name: t.palette.sortSize, run: menuAction("sort:size") },
  { id: "sort:type", name: t.palette.sortType, run: menuAction("sort:type") },
  { id: "sort:date", name: t.palette.sortDate, run: menuAction("sort:date") },
  { id: "view:large", name: t.palette.large, run: menuAction("view:large") },
  { id: "view:medium", name: t.palette.medium, run: menuAction("view:medium") },
  { id: "view:small", name: t.palette.small, run: menuAction("view:small") },
  { id: "showicons", name: t.palette.showIcons, run: menuAction("showicons") },
  { id: "new-group", name: t.palette.newGroup, run: paletteAction("new-group") },
  { id: "newfence", name: t.palette.newFence, run: menuAction("newfence") },
  { id: "newheading", name: t.palette.newHeading, run: menuAction("newheading") },
  { id: "newdivider", name: t.palette.newDivider, run: menuAction("newdivider") },
  { id: "editicons", name: t.palette.editIcons, run: menuAction("editicons") },
  { id: "add-app", name: t.palette.addApp, run: paletteAction("add-app") },
  { id: "settings", name: t.palette.settings, run: () => api.openSettingsWindow() },
  { id: "toggle-lock", name: t.palette.lock, run: paletteAction("toggle-lock") },
  { id: "undo", name: t.palette.undo, run: paletteAction("undo") },
  { id: "redo", name: t.palette.redo, run: paletteAction("redo") },
  { id: "display", name: t.palette.display, run: menuAction("display") },
  { id: "personalize", name: t.palette.personalize, run: menuAction("personalize") },
  { id: "terminal", name: t.palette.terminal, run: menuAction("terminal") },
  { id: "windows-icons", name: t.palette.windowsIcons, run: () => api.setWindowsIconsMode(true) },
];

// ---------------------------------------------------------------- matching

const fold = (s: string) =>
  s
    .toLocaleLowerCase("tr")
    .replace(/ı/g, "i")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");

function score(name: string, q: string): number {
  const n = fold(name);
  if (!q) return 1;
  if (n === q) return 1000;
  if (n.startsWith(q)) return 800 - n.length;
  const words = n.split(/[\s\-_.()]+/);
  if (words.some((w) => w.startsWith(q))) return 600 - n.length;
  const i = n.indexOf(q);
  if (i >= 0) return 400 - i;
  // initials: "vsc" -> "Visual Studio Code"
  const initials = words.filter(Boolean).map((w) => w[0]).join("");
  if (q.length >= 2 && initials.startsWith(q)) return 300 - n.length;
  return -1;
}

/** Several words ("visual code"): each must match, the weakest counts. */
function scoreWords(name: string, q: string): number {
  const s = score(name, q);
  if (s >= 0 || !q.includes(" ")) return s;
  let min = Infinity;
  for (const w of q.split(/\s+/).filter(Boolean)) {
    const v = score(name, w);
    if (v < 0) return -1;
    min = Math.min(min, v);
  }
  return min - 100;
}

/** The `max` best matches; `keepAll` keeps non-matching ones last (the index already matched them). */
function best<T>(list: T[], q: string, nameOf: (x: T) => string, max: number, keepAll = false): T[] {
  return list
    .map((x) => ({ x, s: scoreWords(nameOf(x), q) }))
    .filter((r) => keepAll || r.s >= 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, max)
    .map((r) => r.x);
}

const parentOf = (p: string) => p.replace(/[\\/][^\\/]*$/, "");

function buildEntries(layout: Layout, items: DesktopItem[]): Entry[] {
  const map = new Map(items.map((i) => [i.id, i]));
  const out: Entry[] = [];
  const visit = (id: string, path: string[]) => {
    if (isFolderId(id)) {
      const f = layout.folders[id];
      if (!f) return;
      out.push({ key: id, group: "desktop", kind: "folder", name: f.name, sub: path.join(" › ") || t.groupDesktop, id, color: f.color });
      // a locked group's content stays hidden, also from search
      if (!f.lock) for (const c of f.children) visit(c, [...path, f.name]);
      return;
    }
    const it = map.get(id);
    if (!it) return;
    out.push({
      key: id,
      group: "desktop",
      kind: "item",
      name: layout.custom[id]?.name || it.name,
      sub: path.join(" › ") || t.groupDesktop,
      id,
      path: it.path,
      parsingName: it.parsingName,
      icon: layout.custom[id]?.icon ? mediaUrl(layout.custom[id]!.icon!) : iconUrl(it.parsingName, 64, it.iconVersion),
    });
  };
  for (const id of Object.keys(layout.placements)) visit(id, []);
  return out;
}

const recentEntry = (r: RecentFile): Entry => ({
  key: `recent:${r.path}`,
  group: "recent",
  kind: "recent",
  name: r.name,
  sub: parentOf(r.path),
  path: r.path,
  icon: iconUrl(r.path, 64, String(r.modified)),
});

const fileEntry = (f: FoundFile): Entry => ({
  key: `file:${f.path}`,
  group: "files",
  kind: "file",
  name: f.name,
  sub: parentOf(f.path),
  path: f.path,
  icon: iconUrl(f.parsingName, 64, "found"),
});

// ---------------------------------------------------------------- view

/**
 * Rust shows the window only when the page asks (`reveal_search`, with a fallback): once the new
 * query is painted, so a webview just resumed from suspension never flashes an empty / stale frame.
 */
function revealAfterPaint() {
  let done = false;
  const go = () => {
    if (done) return;
    done = true;
    api.revealSearch().catch(() => {});
  };
  requestAnimationFrame(() => window.setTimeout(go, 0));
  window.setTimeout(go, 120);
}

export function SearchView() {
  const [q, setQ] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [apps, setApps] = useState<StartApp[]>([]);
  const [recent, setRecent] = useState<RecentFile[]>([]);
  const [files, setFiles] = useState<FoundFile[]>([]);
  const [prefs, setPrefs] = useState<Settings["search"]>(DEFAULT_SETTINGS.search);
  const [selKey, setSelKey] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const fileSeq = useRef(0);
  const [accent, setAccent] = useState("#3b82f6");

  const applySettings = (s: Settings) => {
    applyTheme(s);
    setAccent(s.accent);
    setPrefs(s.search);
    return s;
  };

  const load = async () => {
    try {
      const [state, items] = await Promise.all([api.loadState(), api.listDesktopItems()]);
      const s = applySettings(normalizeSettings(state.settings));
      setEntries(buildEntries(normalizeLayout(state.layout), items));
      // kept for the session, refreshed every time the window opens
      if (s.search.recentFiles) api.listRecent(40).then(setRecent).catch(() => {});
    } catch (e) {
      console.error(e);
    }
    if (apps.length === 0) api.listStartApps().then(setApps).catch(() => {});
  };

  useEffect(() => {
    document.body.style.background = "transparent";
    load();
    const win = getCurrentWindow();
    const subs: Promise<() => void>[] = [
      on<{ initial: string }>("search-open", (p) => {
        flushSync(() => {
          setQ(p?.initial ?? "");
          setSelKey(null);
          setCopied(null);
        });
        revealAfterPaint();
        load();
        requestAnimationFrame(() => {
          inputRef.current?.focus();
          const len = inputRef.current?.value.length ?? 0;
          inputRef.current?.setSelectionRange(len, len);
        });
      }),
      on<{ settings: unknown }>("settings-changed", (p) => applySettings(normalizeSettings(p.settings))),
      win.onFocusChanged(({ payload }) => {
        if (!payload) api.hideSearch().catch(() => {});
      }),
    ];
    api
      .takeSearchInitial()
      .then((initial) => {
        if (initial) flushSync(() => setQ(initial));
      })
      .catch(() => {})
      .finally(revealAfterPaint);
    inputRef.current?.focus();
    return () => {
      subs.forEach((p) => p.then((u) => u()).catch(() => {}));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Windows Search index: debounced, only the newest answer counts
  useEffect(() => {
    const query = q.trim();
    if (!prefs.files || query.startsWith(">") || [...query].length < 3 || calculate(query)) {
      fileSeq.current++;
      setFiles([]);
      return;
    }
    const seq = ++fileSeq.current;
    const timer = window.setTimeout(() => {
      api
        .searchFiles(query, 20)
        .then((list) => {
          if (seq === fileSeq.current) setFiles(list);
        })
        .catch(() => {});
    }, 250);
    return () => window.clearTimeout(timer);
  }, [q, prefs.files]);

  const results = useMemo<Entry[]>(() => {
    const raw = q.trim();
    if (raw.startsWith(">")) {
      const cq = fold(raw.slice(1).trim());
      return best(COMMANDS, cq, (c) => c.name, COMMANDS.length).map((c) => ({
        key: `cmd:${c.id}`,
        group: "commands",
        kind: "command",
        name: c.name,
        sub: "",
        value: c.id,
      }));
    }
    const qq = fold(raw);
    if (!qq) {
      return [
        ...entries.filter((e) => e.kind === "folder").slice(0, 8),
        ...(prefs.recentFiles ? recent.slice(0, 5).map(recentEntry) : []),
      ];
    }
    const out: Entry[] = [];
    if (prefs.calculator) {
      const c = calculate(raw);
      if (c) {
        out.push({
          key: "calc",
          group: "calc",
          kind: "calc",
          name: `= ${c.text}`,
          sub: copied === "calc" ? t.calcCopied : `${raw} · ${t.calcCopyHint}`,
          value: c.text,
        });
      }
    }
    const desk = best(entries, qq, (e) => e.name, 9);
    out.push(...desk);
    const names = new Set(entries.map((e) => fold(e.name)));
    out.push(
      ...best(
        apps.filter((a) => !names.has(fold(a.name))),
        qq,
        (a) => a.name,
        6,
      ).map<Entry>((a) => ({
        key: `app:${a.parsingName}`,
        group: "apps",
        kind: "app",
        name: a.name,
        sub: t.groupApps,
        parsingName: a.parsingName,
        icon: iconUrl(a.parsingName, 64, "app"),
      })),
    );
    if (prefs.settingsPages) {
      out.push(
        ...SETTINGS_PAGES.map((p) => ({ p, s: Math.max(scoreWords(p.name, qq), ...p.keywords.map((k) => scoreWords(k, qq) - 50)) }))
          .filter((r) => r.s >= 0)
          .sort((a, b) => b.s - a.s)
          .slice(0, 4)
          .map<Entry>(({ p }) => ({ key: `set:${p.uri}`, group: "settings", kind: "setting", name: p.name, sub: t.settingsPageSub, value: p.uri })),
      );
    }
    const seen = new Set(entries.filter((e) => e.path).map((e) => e.path!.toLowerCase()));
    if (prefs.recentFiles) {
      const rows = best(recent, qq, (r) => r.name, 5).filter((r) => !seen.has(r.path.toLowerCase()));
      rows.forEach((r) => seen.add(r.path.toLowerCase()));
      out.push(...rows.map(recentEntry));
    }
    if (prefs.files && files.length) {
      out.push(
        ...best(
          files.filter((f) => !seen.has(f.path.toLowerCase())),
          qq,
          (f) => f.name,
          8,
          true,
        ).map(fileEntry),
      );
    }
    if (prefs.web) {
      out.push({ key: "web", group: "web", kind: "web", name: t.webSearch(raw), sub: t.webSearchSub });
    }
    return out;
  }, [q, entries, apps, recent, files, prefs, copied]);

  const sel = Math.max(0, results.findIndex((r) => r.key === selKey));

  useEffect(() => {
    setSelKey(null);
    setCopied(null);
  }, [q]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const activate = async (e: Entry) => {
    try {
      switch (e.kind) {
        case "calc":
          await api.copyText(e.value ?? "");
          setCopied("calc");
          return;
        case "folder":
          if (!e.id) break;
          await emitToWindow("desktop", "open-virtual-folder", { folderId: e.id });
          await api.raiseDesktop(true);
          break;
        case "item":
          if (!e.path) break;
          await api.openItem(e.path);
          if (e.id) await emitToWindow("desktop", "item-opened", { id: e.id });
          break;
        case "app":
          if (e.parsingName) await api.openItem(e.parsingName);
          break;
        case "recent":
        case "file":
          if (e.path) await api.openItem(e.path);
          break;
        case "setting":
          if (e.value) await api.openItem(e.value);
          break;
        case "web":
          await api.openItem(`https://www.google.com/search?q=${encodeURIComponent(q.trim())}`);
          break;
        case "command":
          await COMMANDS.find((c) => c.id === e.value)?.run();
          break;
      }
    } catch (err) {
      console.error(err);
    }
    api.hideSearch().catch(() => {});
  };

  const move = (d: number) => {
    const next = results[Math.min(results.length - 1, Math.max(0, sel + d))];
    if (next) setSelKey(next.key);
  };

  const onKey = (ev: React.KeyboardEvent) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      api.hideSearch().catch(() => {});
    } else if (ev.key === "ArrowDown") {
      ev.preventDefault();
      move(1);
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      move(-1);
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      const r = results[sel];
      if (r) activate(r);
    }
  };

  let lastGroup = "";
  return (
    <div className="search-root" style={{ ["--accent" as string]: accent, ["--accent-soft" as string]: rgba(accent, 0.22) }}>
      <div className="search-bar">
        {q.trimStart().startsWith(">") ? (
          <ChevronsRight size={22} strokeWidth={2} style={{ opacity: 0.7 }} />
        ) : (
          <Search size={22} strokeWidth={2} style={{ opacity: 0.6 }} />
        )}
        <input
          ref={inputRef}
          value={q}
          placeholder={t.searchPlaceholder}
          spellCheck={false}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKey}
          autoFocus
        />
      </div>
      <div className="search-list" ref={listRef}>
        {results.length === 0 && q.trim() && <div className="search-empty">{t.noResults}</div>}
        {results.map((r, i) => {
          const header = r.group !== lastGroup ? GROUP_LABEL[r.group] : null;
          lastGroup = r.group;
          return (
            <div key={r.key}>
              {header && <div className="search-group">{header}</div>}
              <button
                className="search-row"
                data-index={i}
                data-active={i === sel}
                data-kind={r.kind}
                onMouseMove={() => r.key !== selKey && setSelKey(r.key)}
                onClick={() => activate(r)}
              >
                <span className="search-icon">
                  <RowIcon r={r} copied={copied === r.key} />
                </span>
                <span className="search-text">
                  <span className="search-name">{r.name}</span>
                  {r.sub && <span className="search-sub">{r.kind === "folder" ? `${t.folderKind} · ${r.sub}` : r.sub}</span>}
                </span>
                {i === sel && <span className="search-enter">↵</span>}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RowIcon({ r, copied }: { r: Entry; copied: boolean }) {
  switch (r.kind) {
    case "folder":
      return (
        <span className="search-folder" style={{ background: r.color ? rgba(r.color, 0.85) : undefined }}>
          <Folder size={18} strokeWidth={2} />
        </span>
      );
    case "calc":
      return <span className="search-glyph">{copied ? <Check size={18} strokeWidth={2.2} /> : <Calculator size={18} strokeWidth={2} />}</span>;
    case "setting":
      return (
        <span className="search-glyph">
          <SettingsIcon size={18} strokeWidth={2} />
        </span>
      );
    case "web":
      return (
        <span className="search-glyph">
          <Globe size={18} strokeWidth={2} />
        </span>
      );
    case "command":
      return (
        <span className="search-glyph">
          <ChevronsRight size={18} strokeWidth={2} />
        </span>
      );
    default:
      return <img src={r.icon} alt="" draggable={false} loading="lazy" />;
  }
}

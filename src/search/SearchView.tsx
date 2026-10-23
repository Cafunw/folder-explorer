import { getCurrentWindow } from "@tauri-apps/api/window";
import { Folder, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, emitToWindow, iconUrl, mediaUrl, on } from "../api";
import { t } from "../i18n";
import { isFolderId, normalizeLayout } from "../layout/model";
import { applyTheme, normalizeSettings, rgba } from "../settings";
import type { DesktopItem, Layout, StartApp } from "../types";
import "./search.css";

type Entry = {
  key: string;
  group: "desktop" | "apps";
  kind: "item" | "folder" | "app";
  name: string;
  sub: string;
  id?: string;
  path?: string;
  parsingName?: string;
  icon?: string;
  color?: string | null;
};

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

function buildEntries(layout: Layout, items: DesktopItem[]): Entry[] {
  const map = new Map(items.map((i) => [i.id, i]));
  const out: Entry[] = [];
  const visit = (id: string, path: string[]) => {
    if (isFolderId(id)) {
      const f = layout.folders[id];
      if (!f) return;
      out.push({ key: id, group: "desktop", kind: "folder", name: f.name, sub: path.join(" › ") || t.groupDesktop, id, color: f.color });
      for (const c of f.children) visit(c, [...path, f.name]);
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

export function SearchView() {
  const [q, setQ] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [apps, setApps] = useState<StartApp[]>([]);
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [accent, setAccent] = useState("#3b82f6");

  const load = async () => {
    try {
      const [state, items] = await Promise.all([api.loadState(), api.listDesktopItems()]);
      const s = normalizeSettings(state.settings);
      applyTheme(s);
      setAccent(s.accent);
      setEntries(buildEntries(normalizeLayout(state.layout), items));
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
        setQ(p?.initial ?? "");
        setSel(0);
        load();
        requestAnimationFrame(() => {
          inputRef.current?.focus();
          const len = inputRef.current?.value.length ?? 0;
          inputRef.current?.setSelectionRange(len, len);
        });
      }),
      on<{ settings: unknown }>("settings-changed", (p) => {
        const s = normalizeSettings(p.settings);
        applyTheme(s);
        setAccent(s.accent);
      }),
      win.onFocusChanged(({ payload }) => {
        if (!payload) api.hideSearch().catch(() => {});
      }),
    ];
    api
      .takeSearchInitial()
      .then((initial) => {
        if (initial) setQ(initial);
      })
      .catch(() => {});
    inputRef.current?.focus();
    return () => {
      subs.forEach((p) => p.then((u) => u()).catch(() => {}));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const results = useMemo(() => {
    const qq = fold(q.trim());
    if (!qq) {
      return entries.filter((e) => e.kind === "folder").slice(0, 8);
    }
    const desk = entries
      .map((e) => ({ e, s: score(e.name, qq) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 9)
      .map((x) => x.e);
    const names = new Set(entries.map((e) => fold(e.name)));
    const appRes = apps
      .map((a) => ({ a, s: score(a.name, qq) }))
      .filter((x) => x.s >= 0 && !names.has(fold(x.a.name)))
      .sort((a, b) => b.s - a.s)
      .slice(0, 6)
      .map<Entry>(({ a }) => ({
        key: `app:${a.parsingName}`,
        group: "apps",
        kind: "app",
        name: a.name,
        sub: t.groupApps,
        parsingName: a.parsingName,
        icon: iconUrl(a.parsingName, 64, "app"),
      }));
    return [...desk, ...appRes];
  }, [q, entries, apps]);

  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const activate = async (e: Entry) => {
    try {
      if (e.kind === "folder" && e.id) {
        await emitToWindow("desktop", "open-virtual-folder", { folderId: e.id });
        await api.raiseDesktop(true);
      } else if (e.kind === "item" && e.path) {
        await api.openItem(e.path);
      } else if (e.kind === "app" && e.parsingName) {
        await api.openItem(e.parsingName);
      }
    } catch (err) {
      console.error(err);
    }
    api.hideSearch().catch(() => {});
  };

  const onKey = (ev: React.KeyboardEvent) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      api.hideSearch().catch(() => {});
    } else if (ev.key === "ArrowDown") {
      ev.preventDefault();
      setSel((s) => Math.min(results.length - 1, s + 1));
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      setSel((s) => Math.max(0, s - 1));
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
        <Search size={22} strokeWidth={2} style={{ opacity: 0.6 }} />
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
          const header = r.group !== lastGroup ? (r.group === "desktop" ? t.groupDesktop : t.groupApps) : null;
          lastGroup = r.group;
          return (
            <div key={r.key}>
              {header && <div className="search-group">{header}</div>}
              <button
                className="search-row"
                data-index={i}
                data-active={i === sel}
                onMouseMove={() => setSel(i)}
                onClick={() => activate(r)}
              >
                <span className="search-icon">
                  {r.kind === "folder" ? (
                    <span className="search-folder" style={{ background: r.color ? rgba(r.color, 0.85) : undefined }}>
                      <Folder size={18} strokeWidth={2} />
                    </span>
                  ) : (
                    <img src={r.icon} alt="" draggable={false} />
                  )}
                </span>
                <span className="search-text">
                  <span className="search-name">{r.name}</span>
                  <span className="search-sub">
                    {r.kind === "folder" ? `${t.folderKind} · ${r.sub}` : r.sub}
                  </span>
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

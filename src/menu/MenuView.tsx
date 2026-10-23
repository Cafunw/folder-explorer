import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Copy,
  Ellipsis,
  ExternalLink,
  Info,
  Link2,
  PencilLine,
  Scissors,
  ShieldCheck,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, emitToWindow, on } from "../api";
import { t } from "../i18n";
import { applyTheme, normalizeSettings } from "../settings";
import { menuRows, type MenuAction, type MenuRequest } from "./layout";
import "./menu.css";

const ICON: Record<MenuAction, LucideIcon> = {
  cut: Scissors,
  copy: Copy,
  rename: PencilLine,
  delete: Trash2,
  open: ExternalLink,
  runas: ShieldCheck,
  copypath: Link2,
  properties: Info,
  more: Ellipsis,
};

const LABEL: Record<MenuAction, string> = {
  cut: t.menuCut,
  copy: t.menuCopy,
  rename: t.rename,
  delete: t.delete,
  open: t.open,
  runas: t.menuRunAs,
  copypath: t.menuCopyPath,
  properties: t.menuProperties,
  more: t.menuMore,
};

/** The popup for a right-click on one of our icons. It lives in its own small always-on-top window. */
export function MenuView() {
  const [req, setReq] = useState<MenuRequest | null>(null);

  useEffect(() => {
    document.body.style.background = "transparent";
    api.loadState().then((st) => applyTheme(normalizeSettings(st.settings))).catch(() => {});
    api
      .takeMenuRequest()
      .then((r) => r && setReq(r as MenuRequest))
      .catch(() => {});
    const hide = () => api.hideMenu().catch(() => {});
    const subs: Promise<() => void>[] = [
      on<MenuRequest>("menu-open", (r) => setReq(r)),
      on<{ settings: unknown }>("settings-changed", (p) => applyTheme(normalizeSettings(p.settings))),
      getCurrentWindow().onFocusChanged(({ payload }) => {
        if (!payload) hide();
      }),
    ];
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") hide();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      subs.forEach((p) => p.then((u) => u()).catch(() => {}));
    };
  }, []);

  const rows = useMemo(() => (req ? menuRows(req) : []), [req]);

  const pick = (action: MenuAction) => {
    if (!req) return;
    void emitToWindow("desktop", "menu-action", { action, ids: req.ids, at: [req.x ?? 0, req.y ?? 0] });
    api.hideMenu().catch(() => {});
  };

  return (
    <div className="mw-root" onContextMenu={(e) => e.preventDefault()}>
      {rows.map((r, i) =>
        r.k === "sep" ? (
          <div key={i} className="menu-sep" />
        ) : r.k === "icons" ? (
          <div key={i} className="mw-icons">
            {r.actions.map((a) => {
              const I = ICON[a];
              return (
                <button key={a} className="mw-icon-btn" onClick={() => pick(a)}>
                  <I size={18} strokeWidth={1.75} />
                  <span>{LABEL[a]}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <button key={i} className="menu-item" onClick={() => pick(r.action)}>
            <span className="mi-icon">{(() => {
              const I = ICON[r.action];
              return <I size={16} strokeWidth={1.75} />;
            })()}</span>
            <span className="mi-label">{LABEL[r.action]}</span>
            {r.hint && <span className="mi-hint">{r.hint}</span>}
          </button>
        ),
      )}
    </div>
  );
}

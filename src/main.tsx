import type { ComponentType } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { api, on } from "./api";
import { language, setLanguage } from "./i18n";
import type { Language } from "./types";

const view =
  new URLSearchParams(window.location.search).get("view") ??
  (window as unknown as { __FE_VIEW__?: string }).__FE_VIEW__ ??
  "desktop";
document.documentElement.dataset.view = view;

// The webview's own context menu / text selection never fits a desktop shell.
window.addEventListener("contextmenu", (e) => {
  const t = e.target as HTMLElement | null;
  if (!t || (t.tagName !== "INPUT" && t.tagName !== "TEXTAREA")) e.preventDefault();
});

// Every window loads this page; each one only fetches, parses and keeps its own view's code.
const load: () => Promise<ComponentType> =
  view === "search"
    ? () => import("./search/SearchView").then((m) => m.SearchView)
    : view === "settings"
      ? () => import("./settings/SettingsView").then((m) => m.SettingsView)
      : () => import("./desktop/DesktopView").then((m) => m.DesktopView);

// same rule as normalizeSettings: anything but "tr" is English
const langOf = (s: unknown): Language => ((s as { language?: unknown } | null)?.language === "tr" ? "tr" : "en");

// the language is set before a view module loads (some read strings at load); a change reloads every window
api
  .loadState()
  .then((st) => setLanguage(langOf(st.settings)))
  .catch(() => {})
  .then(() => {
    document.documentElement.lang = language();
    on<{ settings: unknown }>("settings-changed", (p) => {
      if (langOf(p.settings) !== language()) location.reload();
    });
    return load();
  })
  .then((View) => createRoot(document.getElementById("root")!).render(<View />));

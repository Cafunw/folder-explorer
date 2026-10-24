import type { ComponentType } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { isTauri } from "./api";

const view =
  new URLSearchParams(window.location.search).get("view") ??
  (window as unknown as { __FE_VIEW__?: string }).__FE_VIEW__ ??
  "desktop";
document.documentElement.dataset.view = view;
// Browser preview only: the real desktop window is transparent over the Windows wallpaper.
if (!isTauri && view === "desktop") document.body.style.background = "linear-gradient(135deg, #1e293b, #4c1d95)";

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

load().then((View) => createRoot(document.getElementById("root")!).render(<View />));

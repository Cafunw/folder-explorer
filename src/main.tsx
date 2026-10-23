import { createRoot } from "react-dom/client";
import "./styles.css";
import { isTauri } from "./api";
import { DesktopView } from "./desktop/DesktopView";
import { MenuView } from "./menu/MenuView";
import { SearchView } from "./search/SearchView";
import { SettingsView } from "./settings/SettingsView";

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

createRoot(document.getElementById("root")!).render(
  view === "search" ? <SearchView /> : view === "settings" ? <SettingsView /> : view === "menu" ? <MenuView /> : <DesktopView />,
);

// The popup shown when one of OUR icons is right-clicked (a Windows 11 style menu drawn by the app:
// it opens instantly). "Daha fazla seçenek göster" builds the shell's full classic menu, which loads
// every shell extension and takes a moment, only when asked for, like Windows 11's own menu does.

export type MenuAction = "cut" | "copy" | "rename" | "delete" | "open" | "runas" | "copypath" | "properties" | "more";

export type MenuRequest = {
  ids: string[];
  paths: string[];
  /** a system icon (Recycle Bin, This PC…): only "open" and "more options" make sense */
  system: boolean;
  canRunAs: boolean;
  /** screen position of the right-click (physical px), filled in by the backend */
  x?: number;
  y?: number;
};

export type MenuRow =
  | { k: "icons"; actions: MenuAction[] }
  | { k: "item"; action: MenuAction; hint?: string }
  | { k: "sep" };

export function menuRows(r: MenuRequest): MenuRow[] {
  if (r.system) return [{ k: "item", action: "open", hint: "Enter" }, { k: "sep" }, { k: "item", action: "more" }];
  const one = r.ids.length === 1;
  const rows: MenuRow[] = [
    { k: "icons", actions: one ? ["cut", "copy", "rename", "delete"] : ["cut", "copy", "delete"] },
    { k: "sep" },
    { k: "item", action: "open", hint: "Enter" },
  ];
  if (one && r.canRunAs) rows.push({ k: "item", action: "runas" });
  rows.push({ k: "item", action: "copypath", hint: "Ctrl+Shift+C" });
  if (one) rows.push({ k: "item", action: "properties", hint: "Alt+Enter" });
  rows.push({ k: "sep" }, { k: "item", action: "more", hint: "Shift+F10" });
  return rows;
}

// Row heights in CSS px; menu.css uses the same numbers.
export const MENU_W = 272;
const PAD = 6;
const H_ICONS = 62;
const H_ITEM = 36;
const H_SEP = 9;

export function menuHeight(rows: MenuRow[]): number {
  return 2 * PAD + rows.reduce((h, r) => h + (r.k === "icons" ? H_ICONS : r.k === "sep" ? H_SEP : H_ITEM), 0);
}

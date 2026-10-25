// Shared desktop action payloads and OS-rendered menus for virtual headings and groups.
import { t } from "../i18n";
import type { Placement } from "../types";

export type MenuPick = {
  id: string;
  target: "items" | "desktop";
  ids: string[];
  paths: string[];
  at: [number, number];
  cell: Placement | null;
  canPaste: boolean;
};

export const ICON_SCALES = { large: 2, medium: 1, small: 0.67 } as const;

/** Win32 popup entries for app objects that have no Windows Shell item. */
export type OwnItem = {
  id: string;
  text: string;
  sep?: boolean;
  checked?: boolean;
  radio?: boolean;
  disabled?: boolean;
  items?: OwnItem[];
};

export function headingMenu(h: { style: "title" | "divider"; align: "left" | "center"; underline?: boolean }): OwnItem[] {
  return [
    { id: "heading:edit", text: `${t.cm.editHeading}\tF2` },
    { id: "heading:align", text: t.cm.align, items: [
      { id: "heading:align:left", text: t.cm.alignLeft, radio: true, checked: h.align === "left" },
      { id: "heading:align:center", text: t.cm.alignCenter, radio: true, checked: h.align === "center" },
    ] },
    { id: "heading:style", text: t.cm.headingStyle, items: [
      { id: "heading:style:title", text: t.cm.styleTitle, radio: true, checked: h.style === "title" },
      { id: "heading:style:divider", text: t.cm.styleDivider, radio: true, checked: h.style === "divider" },
    ] },
    ...(h.style === "title" ? [{ id: "heading:underline", text: t.cm.underline, checked: !!h.underline }] : []),
    { id: "", text: "", sep: true },
    { id: "heading:delete", text: t.cm.delete },
  ];
}

/** A group tile's or a fence's popup ("group:<action>"); a fence is always open, so it folds instead. */
export function groupMenu(fence: boolean, collapsed = false): OwnItem[] {
  return [
    fence
      ? { id: "group:collapse", text: collapsed ? t.fence.expand : t.fence.collapse }
      : { id: "group:open", text: `${t.cm.open}\t${t.cm.hintOpen}` },
    { id: "group:rename", text: `${t.cm.rename}\t${t.cm.hintRename}` },
    { id: "group:settings", text: `${t.cm.groupSettings}\t${t.cm.hintSettings}` },
    { id: "", text: "", sep: true },
    { id: "group:dissolve", text: t.ungroup },
    { id: "group:delete", text: t.deleteFolderWithContents },
  ];
}

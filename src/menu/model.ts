// Our right-click menus, entry for entry like Windows 11's own (same order, words and shortcuts).
// The desktop builds a MenuSpec, the menu window (MenuView) only draws it and reports the chosen
// entry's id back to the desktop (actions.ts → runMenuAction).

import { t } from "../i18n";
import type { Placement } from "../types";

export type IconName =
  | "cut"
  | "copy"
  | "rename"
  | "share"
  | "delete"
  | "paste"
  | "openwith"
  | "star"
  | "pin"
  | "zip"
  | "copypath"
  | "properties"
  | "more"
  | "newtab"
  | "newwindow"
  | "admin"
  | "folderopen"
  | "view"
  | "sort"
  | "refresh"
  | "new"
  | "display"
  | "personalize"
  | "terminal"
  | "group"
  | "fence"
  | "heading"
  | "divider"
  | "smart"
  | "live"
  | "frequent"
  | "editicons";

/** A Fluent glyph by name, or an image (data:/fe:// URL, or a file whose shell icon is wanted). */
export type Icon = IconName | { img: string } | { file: string };

export type MenuNode =
  | { kind: "sep" }
  | {
      kind: "item";
      id: string;
      label: string;
      icon?: Icon;
      hint?: string;
      /** a submenu */
      items?: MenuNode[];
      /** a submenu the shell fills in (Open with ▸, New ▸) */
      dynamic?: "openwith" | "new";
      check?: boolean;
      radio?: boolean;
      checked?: boolean;
      disabled?: boolean;
      /** shown only when the clipboard has files / Windows Terminal is installed */
      needs?: "paste" | "terminal";
    };

export type BarButton = { id: string; label: string; icon: IconName; needs?: "paste" };

export type MenuSpec = { bar: BarButton[]; items: MenuNode[] };

/** What the desktop asks for; Rust adds where and on which monitor (see windows_mgr::open_menu). */
export type MenuRequest = {
  target: "items" | "desktop";
  ids: string[];
  paths: string[];
  /** the desktop cell under the right-click (new items land there) */
  cell: Placement | null;
  spec: MenuSpec;
  at: [number, number];
  work: [number, number, number, number];
  scale: number;
  accent: { dark: string; light: string };
  canPaste: boolean;
  hasTerminal: boolean;
  /** Windows Terminal's app item, whose icon "Terminalde Aç" shows */
  terminalIcon: string | null;
};

/** The chosen entry, sent to the desktop window. */
export type MenuPick = {
  id: string;
  target: "items" | "desktop";
  ids: string[];
  paths: string[];
  at: [number, number];
  cell: Placement | null;
  canPaste: boolean;
};

export type ShellNewItem = { id: number; text: string; icon: string | null };
export type ShellHandler = { index: number; name: string; icon: string | null };

/** What the shell reports while the menu is open (ctxmenu::MenuExtra). */
export type MenuExtra = {
  key: string;
  verbs?: string[] | null;
  newItems?: ShellNewItem[] | null;
  openWith?: ShellHandler[] | null;
};

export const RECYCLE_PATH = "::{645ff040-5081-101b-9f08-00aa002f954e}";

/** ctxmenu::key_of */
export function menuKey(paths: string[]) {
  return paths.length ? paths.map((p) => p.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase()).join("\n") : "desktop";
}

const sep = (): MenuNode => ({ kind: "sep" });
const item = (id: string, label: string, icon?: Icon, more: Partial<Extract<MenuNode, { kind: "item" }>> = {}): MenuNode => ({
  kind: "item",
  id,
  label,
  icon,
  ...more,
});

export type ItemInfo = {
  kind: "file" | "folder" | "system";
  path: string;
  isShortcut: boolean;
  /** the icon "Aç" shows: the item's own */
  icon: Icon;
};

const RUNNABLE = /\.(exe|bat|cmd|com|msi)$/i;
const NO_OPEN_WITH = /\.(exe|lnk|url|bat|cmd|com|msi|scr|pif)$/i;

export function itemMenu(items: ItemInfo[]): MenuSpec {
  const one = items.length === 1;
  const it = items[0];
  const system = items.some((i) => i.kind === "system");
  const folder = one && it.kind === "folder";
  const allFiles = items.every((i) => i.kind === "file");
  const lnk = one && it.isShortcut;
  const exe = one && it.kind === "file" && RUNNABLE.test(it.path);
  const open = item("open", t.cm.open, it.icon, { hint: t.cm.hintOpen });
  const more = item("more", t.cm.more, "more");

  if (system) {
    const recycle = one && it.path.toLowerCase() === RECYCLE_PATH;
    return {
      bar: one ? [{ id: "rename", label: t.cm.rename, icon: "rename" }] : [],
      items: [
        open,
        ...(recycle ? [item("emptybin", t.cm.emptyBin, "delete")] : []),
        ...(one ? [item("pinhome", t.cm.pinHome, "pin"), item("pinstart", t.cm.pinStart, "pin")] : []),
        item("properties", t.cm.properties, "properties", { hint: t.cm.hintProperties }),
        sep(),
        more,
      ],
    };
  }

  const bar: BarButton[] = [
    { id: "cut", label: t.cm.cut, icon: "cut" },
    { id: "copy", label: t.cm.copy, icon: "copy" },
    ...(one ? [{ id: "rename", label: t.cm.rename, icon: "rename" as const }] : []),
    ...(allFiles ? [{ id: "share", label: t.cm.share, icon: "share" as const }] : []),
    { id: "delete", label: t.cm.delete, icon: "delete" },
  ];
  const list: MenuNode[] = [open];
  if (one && it.kind === "file" && !NO_OPEN_WITH.test(it.path) && /\.[^\\.]+$/.test(it.path)) {
    list.push(item("openwith", t.cm.openWith, "openwith", { dynamic: "openwith" }));
  }
  if (folder) {
    list.push(
      item("newtab", t.cm.newTab, "newtab"),
      item("newwindow", t.cm.newWindow, "newwindow"),
      item("pinhome", t.cm.pinHome, "pin"),
      item("pinstart", t.cm.pinStart, "pin"),
    );
  }
  if (lnk || exe) list.push(item("runas", t.cm.runAs, "admin"));
  if (lnk) list.push(item("opencontaining", t.cm.openLocation, "folderopen"));
  if (lnk || exe) list.push(item("pinstart", t.cm.pinStart, "pin"));
  if (!folder) list.push(item("favorite", t.cm.favorite, "star"));
  list.push(
    item("compress", t.cm.compress, "zip", {
      items: [item("compress:zip", t.cm.zip), item("compress:7z", t.cm.sevenZip), item("compress:tar", t.cm.tar)],
    }),
    item("copypath", t.cm.copyPath, "copypath", { hint: t.cm.hintCopyPath }),
    item("properties", t.cm.properties, "properties", { hint: t.cm.hintProperties }),
  );
  if (folder) list.push(sep(), item("terminal", t.cm.terminal, "terminal", { needs: "terminal" }));
  list.push(sep(), more);
  return { bar, items: list };
}

export type DesktopState = { iconScale: number; autoArrange: boolean; showIcons: boolean };

export const ICON_SCALES = { large: 2, medium: 1, small: 0.67 } as const;

function viewItems(s: DesktopState): MenuNode[] {
  const size = (id: keyof typeof ICON_SCALES, label: string) =>
    item(`view:${id}`, label, undefined, { radio: true, checked: Math.abs(s.iconScale - ICON_SCALES[id]) < 0.01 });
  return [
    size("large", t.cm.large),
    size("medium", t.cm.medium),
    size("small", t.cm.small),
    sep(),
    item("autoarrange", t.cm.autoArrange, undefined, { check: true, checked: s.autoArrange }),
    // our icons always sit on the grid
    item("aligngrid", t.cm.alignGrid, undefined, { check: true, checked: true, disabled: true }),
    sep(),
    item("showicons", t.cm.showIcons, undefined, { check: true, checked: s.showIcons }),
  ];
}

const sortItems = (): MenuNode[] => [
  item("sort:name", t.cm.sortName),
  item("sort:size", t.cm.sortSize),
  item("sort:type", t.cm.sortType),
  item("sort:date", t.cm.sortDate),
];

export function desktopMenu(s: DesktopState): MenuSpec {
  return {
    bar: [{ id: "paste", label: t.cm.paste, icon: "paste", needs: "paste" }],
    items: [
      item("view", t.cm.view, "view", { items: viewItems(s) }),
      item("sortby", t.cm.sortBy, "sort", { items: sortItems() }),
      item("refresh", t.cm.refresh, "refresh"),
      // our icon edit mode (wiggle, remove badges), not a Windows entry
      item("editicons", t.cm.editIcons, "editicons"),
      sep(),
      item("new", t.cm.new, "new", { dynamic: "new" }),
      sep(),
      item("display", t.cm.display, "display"),
      item("personalize", t.cm.personalize, "personalize"),
      sep(),
      item("terminal", t.cm.terminal, "terminal", { needs: "terminal" }),
      sep(),
      item("more", t.cm.more, "more"),
    ],
  };
}

/** ctxmenu::OwnItem: what Explorer's desktop view adds on top of the classic menu. */
export type OwnItem = { id: string; text: string; sep?: boolean; checked?: boolean; radio?: boolean; disabled?: boolean; items?: OwnItem[] };

const toOwn = (nodes: MenuNode[]): OwnItem[] =>
  nodes.map((n) =>
    n.kind === "sep"
      ? { id: "", text: "", sep: true }
      : { id: n.id, text: n.label, checked: n.checked, radio: n.radio, disabled: n.disabled, items: n.items ? toOwn(n.items) : undefined },
  );

/** View ▸, Sort by ▸, Refresh, Paste, Paste shortcut: the top of Windows' classic desktop menu. */
export function desktopClassicOwn(s: DesktopState, canPaste: boolean): OwnItem[] {
  return [
    ...toOwn([item("view", t.cm.view, undefined, { items: viewItems(s) }), item("sortby", t.cm.sortBy, undefined, { items: sortItems() })]),
    { id: "refresh", text: t.cm.refresh },
    { id: "", text: "", sep: true },
    { id: "paste", text: t.cm.paste, disabled: !canPaste },
    { id: "pasteshortcut", text: t.cm.pasteShortcut, disabled: !canPaste },
    { id: "", text: "", sep: true },
  ];
}

/** Entries whose condition does not hold are left out; separators never double up or dangle. */
export function visibleNodes(nodes: MenuNode[], have: { paste: boolean; terminal: boolean }): MenuNode[] {
  const out: MenuNode[] = [];
  for (const n of nodes) {
    if (n.kind === "item" && n.needs && !have[n.needs]) continue;
    if (n.kind === "sep" && (out.length === 0 || out[out.length - 1].kind === "sep")) continue;
    out.push(n);
  }
  while (out.length && out[out.length - 1].kind === "sep") out.pop();
  return out;
}

/** The entries of a shell-filled submenu. */
export function dynamicNodes(kind: "openwith" | "new", extra: MenuExtra | null, newCache: ShellNewItem[] | null): MenuNode[] {
  if (kind === "openwith") {
    const apps = extra?.openWith ?? [];
    return [
      ...apps.map((h) => item(`openwith:${h.index}`, h.name, h.icon ? (h.icon.startsWith("data:") ? { img: h.icon } : { file: h.icon }) : undefined)),
      ...(apps.length ? [sep()] : []),
      item("openwith:other", t.cm.chooseApp),
    ];
  }
  const list = extra?.newItems ?? newCache ?? [];
  const nodes: MenuNode[] = list.map((n) => (n.id === 0 ? sep() : item(`new:${n.id}`, n.text, n.icon ? { img: n.icon } : undefined)));
  // our group, fence, heading and divider sit with Folder and Shortcut, before Windows' file types
  const firstSep = nodes.findIndex((n) => n.kind === "sep");
  const ours = [
    item("newgroup", t.cm.newGroup, "group"),
    item("newsmart", t.grp.newSmart, "smart"),
    item("newlive", t.grp.newLive, "live"),
    item("newfrequent", t.grp.newFrequent, "frequent"),
    item("newfence", t.cm.newFence, "fence"),
    item("newheading", t.cm.newHeading, "heading"),
    item("newdivider", t.cm.newDivider, "divider"),
  ];
  if (firstSep < 0) nodes.push(...ours);
  else nodes.splice(firstSep, 0, ...ours);
  return nodes;
}

/** Right-click on a heading / divider of the desktop. Entry ids start with "heading:". */
export function headingMenu(h: { style: "title" | "divider"; align: "left" | "center"; underline?: boolean }): MenuSpec {
  const radio = (id: string, label: string, checked: boolean) => item(id, label, undefined, { radio: true, checked });
  return {
    bar: [
      { id: "heading:edit", label: t.cm.editHeading, icon: "rename" },
      { id: "heading:delete", label: t.cm.delete, icon: "delete" },
    ],
    items: [
      item("heading:edit", t.cm.editHeading, "rename", { hint: t.cm.hintRename }),
      item("heading:align", t.cm.align, undefined, {
        items: [radio("heading:align:left", t.cm.alignLeft, h.align === "left"), radio("heading:align:center", t.cm.alignCenter, h.align === "center")],
      }),
      item("heading:style", t.cm.headingStyle, undefined, {
        items: [
          radio("heading:style:title", t.cm.styleTitle, h.style === "title"),
          radio("heading:style:divider", t.cm.styleDivider, h.style === "divider"),
        ],
      }),
      ...(h.style === "title" ? [item("heading:underline", t.cm.underline, undefined, { check: true, checked: !!h.underline })] : []),
      sep(),
      item("heading:delete", t.cm.delete, "delete"),
    ],
  };
}

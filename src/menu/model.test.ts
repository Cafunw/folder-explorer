import { describe, expect, it } from "vitest";
import { desktopClassicOwn, desktopMenu, dynamicNodes, headingMenu, itemMenu, menuKey, RECYCLE_PATH, visibleNodes, type ItemInfo, type MenuNode } from "./model";

const file = (path: string, more: Partial<ItemInfo> = {}): ItemInfo => ({ kind: "file", path, isShortcut: false, icon: "copy", ...more });
const ids = (nodes: MenuNode[]) => nodes.map((n) => (n.kind === "sep" ? "-" : n.id));
const all = { paste: true, terminal: true };

describe("item menus (same entries as Windows 11)", () => {
  it("a text file", () => {
    const m = itemMenu([file("C:\\d\\a.txt")]);
    expect(m.bar.map((b) => b.id)).toEqual(["cut", "copy", "rename", "share", "delete"]);
    expect(ids(m.items)).toEqual(["open", "openwith", "favorite", "compress", "copypath", "properties", "-", "more"]);
  });

  it("a folder", () => {
    const m = itemMenu([{ kind: "folder", path: "C:\\d\\x", isShortcut: false, icon: "folderopen" }]);
    expect(m.bar.map((b) => b.id)).toEqual(["cut", "copy", "rename", "delete"]);
    expect(ids(visibleNodes(m.items, all))).toEqual([
      "open", "newtab", "newwindow", "pinhome", "pinstart", "compress", "copypath", "properties", "-", "terminal", "-", "more",
    ]);
    expect(ids(visibleNodes(m.items, { paste: false, terminal: false }))).not.toContain("terminal");
  });

  it("a shortcut", () => {
    const m = itemMenu([file("C:\\d\\n.lnk", { isShortcut: true })]);
    expect(ids(m.items)).toEqual(["open", "runas", "opencontaining", "pinstart", "favorite", "compress", "copypath", "properties", "-", "more"]);
  });

  it("several items: no rename, share only for files", () => {
    const m = itemMenu([file("C:\\d\\a.txt"), { kind: "folder", path: "C:\\d\\x", isShortcut: false, icon: "copy" }]);
    expect(m.bar.map((b) => b.id)).toEqual(["cut", "copy", "delete"]);
    expect(ids(m.items)).toEqual(["open", "favorite", "compress", "copypath", "properties", "-", "more"]);
  });

  it("the Recycle Bin", () => {
    const m = itemMenu([{ kind: "system", path: RECYCLE_PATH.toUpperCase(), isShortcut: false, icon: "copy" }]);
    expect(m.bar.map((b) => b.id)).toEqual(["rename"]);
    expect(ids(m.items)).toEqual(["open", "emptybin", "pinhome", "pinstart", "properties", "-", "more"]);
  });
});

describe("desktop menu", () => {
  const s = { iconScale: 1, autoArrange: false, showIcons: true };

  it("drops what is unavailable without doubled separators", () => {
    const m = desktopMenu(s);
    expect(ids(visibleNodes(m.items, { paste: false, terminal: false }))).toEqual([
      "view", "sortby", "refresh", "editicons", "-", "new", "-", "display", "personalize", "-", "more",
    ]);
    expect(m.bar.map((b) => b.id)).toEqual(["paste"]);
  });

  it("offers the icon edit mode (Simgeleri düzenle) after Refresh", () => {
    const e = desktopMenu(s).items.find((n) => n.kind === "item" && n.id === "editicons");
    expect(e).toMatchObject({ kind: "item", label: "Simgeleri düzenle", icon: "editicons" });
    expect(e && e.kind === "item" && (e.items || e.dynamic || e.needs)).toBeFalsy();
  });

  it("marks the current icon size and toggles", () => {
    const view = desktopMenu({ iconScale: 2, autoArrange: true, showIcons: false }).items[0];
    if (view.kind !== "item") throw new Error();
    const checked = (view.items ?? []).filter((n) => n.kind === "item" && n.checked).map((n) => (n.kind === "item" ? n.id : ""));
    expect(checked).toEqual(["view:large", "autoarrange", "aligngrid"]);
  });

  it("puts View / Sort / Refresh / Paste on top of the classic menu", () => {
    const own = desktopClassicOwn(s, false);
    expect(own.map((o) => (o.sep ? "-" : o.id))).toEqual(["view", "sortby", "refresh", "-", "paste", "pasteshortcut", "-"]);
    expect(own.find((o) => o.id === "paste")?.disabled).toBe(true);
    expect(own[0].items?.length).toBeGreaterThan(3);
  });
});

describe("shell-filled submenus", () => {
  it("New ▸: our group kinds, fence, heading and divider join Folder and Shortcut, before the file types", () => {
    const list = [
      { id: 1, text: "Klasör", icon: null },
      { id: 2, text: "Kısayol", icon: null },
      { id: 0, text: "", icon: null },
      { id: 3, text: "Metin Belgesi", icon: null },
    ];
    const ours = ["newgroup", "newsmart", "newlive", "newfrequent", "newfence", "newheading", "newdivider"];
    expect(ids(dynamicNodes("new", { key: "desktop", newItems: list }, null))).toEqual(["new:1", "new:2", ...ours, "-", "new:3"]);
    expect(ids(dynamicNodes("new", null, list))).toEqual(["new:1", "new:2", ...ours, "-", "new:3"]);
    expect(ids(dynamicNodes("new", null, null))).toEqual(ours);
  });

  it("Open with ▸: the apps, then Choose another app", () => {
    const extra = { key: "k", openWith: [{ index: 0, name: "Not Defteri", icon: null }] };
    expect(ids(dynamicNodes("openwith", extra, null))).toEqual(["openwith:0", "-", "openwith:other"]);
    expect(ids(dynamicNodes("openwith", null, null))).toEqual(["openwith:other"]);
  });

  it("a heading: edit, align ▸, style ▸, underline (titles only), delete", () => {
    const m = headingMenu({ style: "title", align: "center", underline: true });
    expect(m.bar.map((b) => b.id)).toEqual(["heading:edit", "heading:delete"]);
    expect(ids(m.items)).toEqual(["heading:edit", "heading:align", "heading:style", "heading:underline", "-", "heading:delete"]);
    const align = m.items[1];
    if (align.kind !== "item") throw new Error();
    expect((align.items ?? []).map((n) => (n.kind === "item" ? [n.id, n.checked] : "-"))).toEqual([
      ["heading:align:left", false],
      ["heading:align:center", true],
    ]);
    const u = m.items[3];
    expect(u.kind === "item" && u.checked).toBe(true);
    expect(ids(headingMenu({ style: "divider", align: "left" }).items)).not.toContain("heading:underline");
  });

  it("keys menus like the Rust side", () => {
    expect(menuKey([])).toBe("desktop");
    expect(menuKey(["C:/Users/A/Desktop/", "C:\\X\\b.TXT"])).toBe("c:\\users\\a\\desktop\nc:\\x\\b.txt");
  });
});

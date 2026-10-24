import { describe, expect, it } from "vitest";
import type { DesktopItem, Environment, Layout, SmartRule, VirtualFolder } from "../types";
import { DEFAULT_SETTINGS } from "../settings";
import { computeGrids } from "./grid";
import { emptyLayout, moveToCell, moveToDesktop, reconcile, USAGE_MAX } from "./model";
import {
  activeTabOf,
  collectSmart,
  DEFAULT_TEMP_DAYS,
  frequentItems,
  GENERAL_TAB,
  isGame,
  itemHasType,
  matchesRule,
  newItemIds,
  recordOpen,
  setActiveTab,
  smartChanged,
  staleItems,
  tabsOf,
} from "./smart";

const env: Environment = {
  monitors: [
    {
      id: "M1",
      primary: true,
      bounds: { x: 0, y: 0, width: 1000, height: 640 },
      work: { x: 0, y: 0, width: 1000, height: 600 },
      scale: 1,
    },
  ],
  windowOrigin: { x: 0, y: 0 },
  scaleFactor: 1,
  desktopDir: "C:\\Users\\u\\Desktop",
  publicDesktopDir: "C:\\Users\\Public\\Desktop",
  isDev: true,
};
const grids = computeGrids(env, DEFAULT_SETTINGS);
const DAY = 24 * 3600 * 1000;
const NOW = Date.UTC(2026, 9, 24);

function item(file: string, over: Partial<DesktopItem> = {}): DesktopItem {
  const dot = file.lastIndexOf(".");
  const ext = dot > 0 ? file.slice(dot).toLowerCase() : "";
  const isShortcut = ext === ".lnk" || ext === ".url";
  return {
    id: `c:\\users\\u\\desktop\\${file.toLowerCase()}`,
    kind: "file",
    path: `C:\\Users\\u\\Desktop\\${file}`,
    parsingName: `C:\\Users\\u\\Desktop\\${file}`,
    name: isShortcut ? file.slice(0, dot) : file,
    ext,
    isShortcut,
    isPublic: false,
    modified: NOW - DAY,
    size: 1,
    iconVersion: "1",
    ...over,
  };
}

const rule = (conditions: SmartRule["conditions"], all = true): SmartRule => ({ all, conditions });

describe("classification", () => {
  it("knows types by extension, kind and shortcut", () => {
    expect(itemHasType(item("rapor.PDF"), "document")).toBe(true);
    expect(itemHasType(item("foto.jpeg"), "image")).toBe(true);
    expect(itemHasType(item("film.mkv"), "video")).toBe(true);
    expect(itemHasType(item("şarkı.mp3"), "audio")).toBe(true);
    expect(itemHasType(item("yedek.7z"), "archive")).toBe(true);
    expect(itemHasType(item("Chrome.lnk"), "shortcut")).toBe(true);
    expect(itemHasType(item("Chrome.lnk"), "file")).toBe(false);
    expect(itemHasType(item("notlar.txt"), "file")).toBe(true);
    expect(itemHasType(item("Projeler", { kind: "folder", ext: "" }), "folder")).toBe(true);
    expect(itemHasType(item("Projeler", { kind: "folder", ext: "" }), "file")).toBe(false);
    expect(itemHasType(item("Bu Bilgisayar", { kind: "system", ext: "" }), "document")).toBe(false);
  });

  it("recognizes game launchers and games by shortcut name only", () => {
    for (const name of [
      "Steam.lnk",
      "VALORANT.lnk",
      "League of Legends.lnk",
      "Riot Client.lnk",
      "Battle.net.lnk",
      "Epic Games Launcher.lnk",
      "TLauncher.lnk",
      "Lunar Client.lnk",
      "Counter-Strike 2.url",
      "osu!.lnk",
      "Grand Theft Auto V.url",
      "Minecraft Launcher.lnk",
      "Roblox Player.lnk",
      "EA.lnk",
      "Ubisoft Connect.lnk",
      "GOG GALAXY.lnk",
    ]) {
      expect(isGame(item(name)), name).toBe(true);
    }
    for (const name of ["Visual Studio Code.lnk", "RustRover.lnk", "Discord.lnk", "Google Chrome.lnk", "OriginLab.lnk", "Idea.lnk"]) {
      expect(isGame(item(name)), name).toBe(false);
    }
    expect(isGame(item("steam.txt"))).toBe(false);
    expect(itemHasType(item("Steam.lnk"), "game")).toBe(true);
  });
});

describe("matchesRule", () => {
  it("combines conditions with all / any", () => {
    const png = item("Ekran Görüntüsü.png");
    const r = rule([
      { field: "ext", value: [".png"] },
      { field: "name", op: "startsWith", value: "ekran" },
    ]);
    expect(matchesRule(png, r, NOW)).toBe(true);
    expect(matchesRule(item("Ekran.jpg"), r, NOW)).toBe(false);
    expect(matchesRule(item("Ekran.jpg"), { ...r, all: false }, NOW)).toBe(true);
    expect(matchesRule(png, rule([]), NOW)).toBe(false);
  });

  it("matches names regardless of case, Turkish dotted / dotless i included", () => {
    const r = rule([{ field: "name", op: "contains", value: "IŞIK" }]);
    expect(matchesRule(item("ışık ayarları.txt"), r, NOW)).toBe(true);
    expect(matchesRule(item("Işık.txt"), rule([{ field: "name", op: "startsWith", value: "isik" }]), NOW)).toBe(true);
    expect(matchesRule(item("İndirilenler.txt"), rule([{ field: "name", op: "startsWith", value: "indir" }]), NOW)).toBe(true);
  });

  it("checks the age from the modification time", () => {
    const fresh = item("yeni.txt", { modified: NOW - 2 * DAY });
    const old = item("eski.txt", { modified: NOW - 40 * DAY });
    const newer = rule([{ field: "age", op: "newerThan", days: 7 }]);
    const older = rule([{ field: "age", op: "olderThan", days: 30 }]);
    expect(matchesRule(fresh, newer, NOW)).toBe(true);
    expect(matchesRule(old, newer, NOW)).toBe(false);
    expect(matchesRule(old, older, NOW)).toBe(true);
    expect(matchesRule(item("x.txt", { modified: 0 }), older, NOW)).toBe(false);
  });

  it("only files match an extension condition", () => {
    const r = rule([{ field: "ext", value: [".png"] }]);
    expect(matchesRule(item("klasör.png", { kind: "folder" }), r, NOW)).toBe(false);
  });
});

describe("smart groups", () => {
  const png = item("a.png");
  const jpg = item("b.jpg");
  const txt = item("c.txt");
  const steam = item("Steam.lnk");
  const sys = item("Bu Bilgisayar", { id: "::{pc}", kind: "system", ext: "", name: "Bu Bilgisayar.png" });
  const all = [png, jpg, txt, steam, sys];

  const smart = (id: string, r: SmartRule, extra: Partial<VirtualFolder> = {}): VirtualFolder => ({
    id,
    name: id,
    color: null,
    children: [],
    kind: "smart",
    rule: r,
    ...extra,
  });

  const setup = () => {
    const l = reconcile(emptyLayout(), all, grids, undefined, NOW);
    l.folders["v:img"] = smart("v:img", rule([{ field: "type", value: "image" }]));
    l.placements["v:img"] = { m: "M1", p: 0, c: 5, r: 0 };
    l.folders["v:games"] = smart("v:games", rule([{ field: "type", value: "game" }]));
    l.placements["v:games"] = { m: "M1", p: 0, c: 6, r: 0 };
    return l;
  };

  it("collect the loose matching items, nothing else", () => {
    const l0 = setup();
    l0.folders["v:mine"] = { id: "v:mine", name: "mine", color: null, children: [jpg.id] };
    delete l0.placements[jpg.id];
    l0.placements["v:mine"] = { m: "M1", p: 0, c: 7, r: 0 };
    l0.home[png.id] = { at: 1, placement: { m: "M1", p: 0, c: 20, r: 0 } };
    const l = collectSmart(l0, all, NOW);
    expect(l.folders["v:img"].children).toEqual([png.id]);
    expect(l.folders["v:games"].children).toEqual([steam.id]);
    expect(l.folders["v:mine"].children).toEqual([jpg.id]);
    expect(l.placements[png.id]).toBeUndefined();
    expect(l.home[png.id]).toBeUndefined();
    expect(l.placements[txt.id]).toBeDefined();
    expect(l.placements[sys.id]).toBeDefined();
    expect(l0.placements[png.id]).toBeDefined();
  });

  it("respect exclusions, candidates and the chosen groups; same layout when nothing moves", () => {
    const l0 = setup();
    l0.folders["v:img"].exclude = [png.id];
    const l = collectSmart(l0, all, NOW);
    expect(l.folders["v:img"].children).toEqual([jpg.id]);
    expect(collectSmart(setup(), all, NOW, { only: new Set([jpg.id]) }).placements[png.id]).toBeDefined();
    const games = collectSmart(setup(), all, NOW, { groups: ["v:games"] });
    expect(games.folders["v:img"].children).toEqual([]);
    expect(games.folders["v:games"].children).toEqual([steam.id]);
    const none = emptyLayout();
    expect(collectSmart(none, all, NOW)).toBe(none);
    const collected = collectSmart(setup(), all, NOW);
    expect(collectSmart(collected, all, NOW)).toBe(collected);
  });

  it("the first matching group wins", () => {
    const l0 = setup();
    l0.folders["v:png"] = smart("v:png", rule([{ field: "ext", value: [".png"] }]));
    l0.placements["v:png"] = { m: "M1", p: 0, c: 8, r: 0 };
    const l = collectSmart(l0, all, NOW);
    expect(l.folders["v:img"].children).toContain(png.id);
    expect(l.folders["v:png"].children).toEqual([]);
  });

  it("an item dragged out stays out", () => {
    let l = collectSmart(setup(), all, NOW);
    l = moveToCell(l, grids, [png.id], png.id, { m: "M1", p: 0, c: 9, r: 3 });
    expect(l.folders["v:img"].exclude).toEqual([png.id]);
    l = collectSmart(l, all, NOW);
    expect(l.placements[png.id]).toEqual({ m: "M1", p: 0, c: 9, r: 3 });
    l = moveToDesktop(l, grids, [steam.id]);
    expect(collectSmart(l, all, NOW).placements[steam.id]).toBeDefined();
  });

  it("new or changed rules are detected for collection", () => {
    const before = setup();
    const after = structuredClone(before);
    expect(smartChanged(before, after)).toEqual([]);
    after.folders["v:img"].rule = rule([{ field: "ext", value: [".png"] }]);
    after.folders["v:new"] = smart("v:new", rule([{ field: "type", value: "document" }]));
    after.folders["v:empty"] = smart("v:empty", rule([]));
    expect(smartChanged(before, after).sort()).toEqual(["v:img", "v:new"]);
    const turned = structuredClone(before);
    turned.folders["v:plain"] = { id: "v:plain", name: "p", color: null, children: [] };
    const toSmart = structuredClone(turned);
    toSmart.folders["v:plain"] = smart("v:plain", rule([{ field: "type", value: "image" }]));
    expect(smartChanged(turned, toSmart)).toEqual(["v:plain"]);
  });

  it("newItemIds lists the items the layout doesn't know yet", () => {
    const l = setup();
    const extra = item("yeni.png");
    l.folders["v:img"].children = [png.id];
    delete l.placements[png.id];
    expect([...newItemIds(l, [...all, extra])]).toEqual([extra.id]);
  });
});

describe("frequent", () => {
  const a = item("a.txt");
  const b = item("b.txt");
  const c = item("c.txt");

  it("counts opens, bounded to the most recent entries", () => {
    const l0 = emptyLayout();
    const l1 = recordOpen(l0, a.id, 10);
    const l2 = recordOpen(l1, a.id, 20);
    expect(l2.usage[a.id]).toEqual({ n: 2, last: 20 });
    expect(l0.usage).toEqual({});
    expect(recordOpen(l2, "v:group", 30)).toBe(l2);
    expect(recordOpen(l2, "h:heading", 30)).toBe(l2);
    let big: Layout = { ...emptyLayout(), usage: {} };
    for (let i = 0; i < USAGE_MAX; i++) big.usage[`x${i}`] = { n: 5, last: i };
    big = recordOpen(big, a.id, USAGE_MAX + 1);
    expect(Object.keys(big.usage)).toHaveLength(USAGE_MAX);
    expect(big.usage.x0).toBeUndefined();
    expect(big.usage[a.id]).toEqual({ n: 1, last: USAGE_MAX + 1 });
  });

  it("ranks by count fading with time, only existing items, never from locked groups", () => {
    const l = emptyLayout();
    l.usage = {
      [a.id]: { n: 10, last: NOW - 120 * DAY }, // much used long ago
      [b.id]: { n: 3, last: NOW - DAY },
      [c.id]: { n: 4, last: NOW - 2 * DAY },
      "c:\\gone.txt": { n: 99, last: NOW },
    };
    expect(frequentItems(l, [a, b, c], 10, NOW)).toEqual([c.id, b.id, a.id]);
    expect(frequentItems(l, new Map([[b.id, b]]), 10, NOW)).toEqual([b.id]);
    expect(frequentItems(l, [a, b, c], 1, NOW)).toEqual([c.id]);
    l.folders["v:secret"] = { id: "v:secret", name: "s", color: null, children: ["v:inner"], lock: { method: "hello", hash: null, salt: null } };
    l.folders["v:inner"] = { id: "v:inner", name: "i", color: null, children: [c.id] };
    expect(frequentItems(l, [a, b, c], 10, NOW)).toEqual([b.id, a.id]);
  });
});

describe("temp", () => {
  it("finds the items older than the group's days", () => {
    const f: VirtualFolder = {
      id: "v:t",
      name: "t",
      color: null,
      kind: "temp",
      tempDays: 3,
      children: ["old", "new", "unknown"],
      added: { old: NOW - 4 * DAY, new: NOW - DAY },
    };
    expect(staleItems(f, NOW)).toEqual(["old"]);
    expect(staleItems({ ...f, tempDays: undefined }, NOW)).toEqual([]);
    expect(staleItems({ ...f, tempDays: undefined }, NOW + DEFAULT_TEMP_DAYS * DAY)).toEqual(["old", "new"]);
    expect(staleItems({ ...f, kind: undefined }, NOW)).toEqual([]);
  });
});

describe("tabs", () => {
  const l = emptyLayout();
  l.folders["v:tabs"] = { id: "v:tabs", name: "t", color: null, display: "tabs", children: ["x", "v:a", "y", "v:b"] };
  l.folders["v:a"] = { id: "v:a", name: "a", color: null, children: ["a1"] };
  l.folders["v:b"] = { id: "v:b", name: "b", color: null, children: [] };
  l.folders["v:only"] = { id: "v:only", name: "o", color: null, children: ["v:a"] };
  l.folders["v:empty"] = { id: "v:empty", name: "e", color: null, children: [] };

  it("are the loose children (Genel) then one per child group", () => {
    expect(tabsOf(l, "v:tabs")).toEqual([
      { id: GENERAL_TAB, folderId: null, items: ["x", "y"] },
      { id: "v:a", folderId: "v:a", items: ["a1"] },
      { id: "v:b", folderId: "v:b", items: [] },
    ]);
    expect(tabsOf(l, "v:only").map((t) => t.id)).toEqual(["v:a"]);
    expect(tabsOf(l, "v:empty")).toEqual([{ id: GENERAL_TAB, folderId: null, items: [] }]);
    expect(tabsOf(l, "v:missing")).toEqual([]);
  });

  it("remember the open tab while it exists", () => {
    expect(activeTabOf(l, "v:tabs")).toBe(GENERAL_TAB);
    const opened = setActiveTab(l, "v:tabs", "v:b");
    expect(activeTabOf(opened, "v:tabs")).toBe("v:b");
    expect(l.folders["v:tabs"].activeTab).toBeUndefined();
    expect(setActiveTab(opened, "v:tabs", "v:b")).toBe(opened);
    expect(activeTabOf(setActiveTab(l, "v:tabs", "v:gone"), "v:tabs")).toBe(GENERAL_TAB);
    expect(activeTabOf(l, "v:only")).toBe("v:a");
  });
});

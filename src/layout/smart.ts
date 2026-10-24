// Group kinds: smart rules (auto collection), frequent (usage), temp (arrival times), tabs.
// Pure like model.ts: operations return a new layout.

import type { DesktopItem, Layout, SmartCondition, SmartRule, SmartType, VirtualFolder } from "../types";
import { boundUsage, clone, isFolderId, isHeadingId, parentMap } from "./model";

const DAY = 24 * 3600 * 1000;
export const DEFAULT_FREQUENT_LIMIT = 12;
export const DEFAULT_TEMP_DAYS = 7;
/** id of the tabs view's tab for the loose (non-group) children */
export const GENERAL_TAB = "general";
/** an open counts half as much after three weeks */
const USAGE_HALF_LIFE = 21 * DAY;

// ---------------------------------------------------------------- classification

const EXTS: Record<"document" | "image" | "video" | "audio" | "archive", string[]> = {
  document: [
    ".pdf", ".doc", ".docx", ".docm", ".odt", ".rtf", ".txt", ".md", ".xls", ".xlsx", ".xlsm", ".ods", ".csv",
    ".ppt", ".pptx", ".odp", ".epub", ".xps", ".oxps", ".pages", ".numbers", ".key", ".one", ".tex",
  ],
  image: [
    ".png", ".jpg", ".jpeg", ".jfif", ".gif", ".bmp", ".webp", ".tif", ".tiff", ".svg", ".ico", ".heic", ".heif",
    ".avif", ".psd", ".raw", ".cr2", ".nef", ".arw", ".dng",
  ],
  video: [".mp4", ".mkv", ".avi", ".mov", ".wmv", ".webm", ".flv", ".m4v", ".mpg", ".mpeg", ".3gp", ".ts", ".m2ts"],
  audio: [".mp3", ".wav", ".flac", ".aac", ".ogg", ".oga", ".m4a", ".wma", ".opus", ".aiff", ".mid", ".midi"],
  archive: [".zip", ".rar", ".7z", ".tar", ".gz", ".tgz", ".bz2", ".xz", ".zst", ".iso", ".cab", ".img"],
};
const EXT_TYPE = new Map<string, SmartType>(
  Object.entries(EXTS).flatMap(([type, exts]) => exts.map((e) => [e, type as SmartType] as const)),
);

/**
 * Game launchers, stores and well-known games. A shortcut whose name contains one of these as
 * whole words (any case) is a "game".
 */
export const GAME_KEYWORDS = [
  "steam", "epic games", "epic games launcher", "riot client", "valorant", "league of legends", "legends of runeterra",
  "teamfight tactics", "rockstar games", "rockstar games launcher", "battle.net", "blizzard", "ubisoft connect", "uplay",
  "ea", "ea app", "ea desktop", "origin", "gog galaxy", "gog", "xbox", "minecraft", "minecraft launcher", "tlauncher",
  "lunar client", "badlion client", "feather client", "modrinth", "curseforge", "prism launcher", "multimc", "roblox",
  "roblox player", "counter-strike", "counter-strike 2", "cs2", "cs:go", "dota 2", "team fortress 2", "fortnite",
  "genshin impact", "honkai", "honkai star rail", "zenless zone zero", "hoyoplay", "wuthering waves", "overwatch",
  "call of duty", "warzone", "apex legends", "rocket league", "pubg", "battlegrounds", "gta", "grand theft auto",
  "red dead redemption", "the sims", "sims 4", "world of warcraft", "hearthstone", "diablo", "starcraft",
  "ea sports fc", "fifa", "efootball", "pes", "euro truck simulator", "american truck simulator", "rainbow six",
  "destiny 2", "warframe", "osu!", "elden ring", "cyberpunk 2077", "the witcher", "terraria", "stardew valley",
  "among us", "fall guys", "palworld", "lethal company", "battlefield", "assassin's creed", "far cry", "forza",
  "halo", "sea of thieves", "marvel rivals", "the finals", "path of exile", "lost ark", "new world", "metin2",
  "knight online", "wolfteam", "zula", "point blank", "playnite", "heroic games launcher", "amazon games",
  "itch", "geforce now", "ubisoft", "riot games", "hytale", "brawlhalla", "paladins", "smite", "dead by daylight",
  "dayz", "arma 3", "escape from tarkov", "war thunder", "world of tanks", "world of warships",
];

/** Case- and accent-insensitive form (Turkish aware: I / İ / ı / i, ş → s, ğ → g …). */
const fold = (s: string) =>
  s.toLocaleLowerCase("tr").normalize("NFD").replace(/\p{M}/gu, "").replace(/ı/g, "i");
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const GAME_RE = new RegExp(
  `(?:^|[^\\p{L}\\p{N}])(?:${[...GAME_KEYWORDS]
    .sort((a, b) => b.length - a.length)
    .map((k) => escapeRe(fold(k)))
    .join("|")})(?=$|[^\\p{L}\\p{N}])`,
  "u",
);

export function isGame(item: DesktopItem): boolean {
  if (!item.isShortcut && item.ext !== ".lnk" && item.ext !== ".url") return false;
  return GAME_RE.test(fold(item.name.replace(/\.(lnk|url)$/i, "")));
}

export function itemHasType(item: DesktopItem, type: SmartType): boolean {
  switch (type) {
    case "shortcut":
      return item.isShortcut;
    case "folder":
      return item.kind === "folder";
    case "file":
      return item.kind === "file" && !item.isShortcut;
    case "game":
      return isGame(item);
    default:
      return item.kind === "file" && EXT_TYPE.get(item.ext.toLowerCase()) === type;
  }
}

function matchesCondition(item: DesktopItem, c: SmartCondition, now: number): boolean {
  switch (c.field) {
    case "ext":
      return item.kind === "file" && c.value.includes(item.ext.toLowerCase());
    case "name": {
      const name = fold(item.name);
      const v = fold(c.value);
      return c.op === "startsWith" ? name.startsWith(v) : name.includes(v);
    }
    case "type":
      return itemHasType(item, c.value);
    case "age": {
      if (!item.modified) return false;
      const age = now - item.modified;
      return c.op === "newerThan" ? age <= c.days * DAY : age > c.days * DAY;
    }
  }
}

/** All (rule.all) or any of the conditions hold; a rule without conditions matches nothing. */
export function matchesRule(item: DesktopItem, rule: SmartRule, now = Date.now()): boolean {
  if (!rule.conditions.length) return false;
  return rule.all
    ? rule.conditions.every((c) => matchesCondition(item, c, now))
    : rule.conditions.some((c) => matchesCondition(item, c, now));
}

// ---------------------------------------------------------------- smart collection

const activeSmart = (f: VirtualFolder) => f.kind === "smart" && !!f.rule?.conditions.length;

/**
 * Move loose top-level desktop items (in `placements`) that match a smart group's rule into that
 * group (the first matching group wins). Never touches items inside groups, groups, headings,
 * system items or a group's `exclude`. `only` limits the candidates (e.g. the items that just
 * appeared), `groups` the collecting groups. Returns the same layout when nothing moved.
 */
export function collectSmart(
  l0: Layout,
  items: Iterable<DesktopItem>,
  now = Date.now(),
  opts: { only?: Set<string>; groups?: string[] } = {},
): Layout {
  const smart = Object.values(l0.folders).filter(
    (f) => activeSmart(f) && (!opts.groups || opts.groups.includes(f.id)),
  );
  if (!smart.length) return l0;
  const excluded = new Map(smart.map((f) => [f.id, new Set(f.exclude ?? [])]));
  let l: Layout | null = null;
  for (const it of items) {
    if (opts.only && !opts.only.has(it.id)) continue;
    if (it.kind === "system" || isFolderId(it.id) || isHeadingId(it.id) || !l0.placements[it.id]) continue;
    const f = smart.find((g) => !excluded.get(g.id)!.has(it.id) && matchesRule(it, g.rule!, now));
    if (!f) continue;
    l ??= clone(l0);
    delete l.placements[it.id];
    delete l.home[it.id];
    l.folders[f.id].children.push(it.id);
  }
  return l ?? l0;
}

/** Smart groups of `after` that are new or whose rule changed since `before` (they collect anew). */
export function smartChanged(before: Layout, after: Layout): string[] {
  const out: string[] = [];
  for (const f of Object.values(after.folders)) {
    if (!activeSmart(f)) continue;
    const b = before.folders[f.id];
    if (!b || b.kind !== "smart" || JSON.stringify(b.rule) !== JSON.stringify(f.rule)) out.push(f.id);
  }
  return out;
}

/** Items that are nowhere in the layout yet (neither on the desktop nor in a group). */
export function newItemIds(l: Layout, items: Iterable<DesktopItem>): Set<string> {
  const known = parentMap(l);
  const out = new Set<string>();
  for (const it of items) if (!l.placements[it.id] && !known.has(it.id)) out.add(it.id);
  return out;
}

// ---------------------------------------------------------------- frequent

/** Count an open of an item (groups / headings are not counted). Bounded to `USAGE_MAX` entries. */
export function recordOpen(l: Layout, id: string, now = Date.now()): Layout {
  if (isFolderId(id) || isHeadingId(id)) return l;
  const prev = l.usage[id];
  return { ...l, usage: boundUsage({ ...l.usage, [id]: { n: (prev?.n ?? 0) + 1, last: now } }) };
}

export const usageScore = (u: { n: number; last: number }, now: number) =>
  u.n * 0.5 ** (Math.max(0, now - u.last) / USAGE_HALF_LIFE);

/**
 * The most used existing items, best first (open count fading with time since the last open).
 * Items inside a locked group are left out.
 */
export function frequentItems(
  l: Layout,
  items: DesktopItem[] | ReadonlyMap<string, DesktopItem>,
  limit = DEFAULT_FREQUENT_LIMIT,
  now = Date.now(),
): string[] {
  const ids = Array.isArray(items) ? new Set(items.map((i) => i.id)) : null;
  const exists = (id: string) => (ids ? ids.has(id) : (items as ReadonlyMap<string, DesktopItem>).has(id));
  const parents = parentMap(l);
  const locked = (id: string) => {
    const guard = new Set<string>();
    for (let p = parents.get(id); p && !guard.has(p); p = parents.get(p)) {
      if (l.folders[p]?.lock) return true;
      guard.add(p);
    }
    return false;
  };
  return Object.entries(l.usage)
    .filter(([id]) => exists(id) && !locked(id))
    .map(([id, u]) => ({ id, score: usageScore(u, now), last: u.last }))
    .sort((a, b) => b.score - a.score || b.last - a.last)
    .slice(0, Math.max(0, limit))
    .map((x) => x.id);
}

// ---------------------------------------------------------------- temp

/** Children of a temp group that have been in it longer than its `tempDays`. */
export function staleItems(f: VirtualFolder, now = Date.now()): string[] {
  if (f.kind !== "temp") return [];
  const ms = (f.tempDays ?? DEFAULT_TEMP_DAYS) * DAY;
  return f.children.filter((id) => {
    const at = f.added?.[id];
    return at !== undefined && now - at > ms;
  });
}

// ---------------------------------------------------------------- tabs

export type Tab = { id: string; folderId: string | null; items: string[] };

/**
 * A tabs group's tabs: "Genel" (`GENERAL_TAB`, folderId null) with the loose children first when
 * there are any (or no child groups at all), then one tab per child group with its children.
 */
export function tabsOf(l: Layout, folderId: string): Tab[] {
  const f = l.folders[folderId];
  if (!f) return [];
  const groups = f.children.filter((c) => isFolderId(c) && l.folders[c]);
  const loose = f.children.filter((c) => !(isFolderId(c) && l.folders[c]));
  const tabs: Tab[] = [];
  if (loose.length || !groups.length) tabs.push({ id: GENERAL_TAB, folderId: null, items: loose });
  for (const g of groups) tabs.push({ id: g, folderId: g, items: [...l.folders[g].children] });
  return tabs;
}

/** The open tab: the stored one while it still exists, else the first. */
export function activeTabOf(l: Layout, folderId: string): string {
  const tabs = tabsOf(l, folderId);
  const want = l.folders[folderId]?.activeTab;
  return tabs.find((t) => t.id === want)?.id ?? tabs[0]?.id ?? GENERAL_TAB;
}

export function setActiveTab(l: Layout, folderId: string, tabId: string): Layout {
  const f = l.folders[folderId];
  if (!f || f.activeTab === tabId) return l;
  return { ...l, folders: { ...l.folders, [folderId]: { ...f, activeTab: tabId } } };
}

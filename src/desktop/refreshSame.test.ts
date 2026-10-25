// The file watcher refreshes the desktop every second while a download runs: an unchanged item list
// must not re-render the tiles, save layout.json or re-send the selection to Explorer.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  // the bits of `window` store.ts touches, in a node test run (late-bound, for fake timers)
  (globalThis as { window?: unknown }).window = {
    setTimeout: (...a: Parameters<typeof setTimeout>) => setTimeout(...a),
    clearTimeout: (id?: Parameters<typeof clearTimeout>[0]) => clearTimeout(id),
    matchMedia: () => ({ matches: false, addEventListener: () => {} }),
  };
  const ok = () => Promise.resolve(undefined);
  return { api: { listDesktopItems: vi.fn(), saveLayout: vi.fn(ok), saveSettings: vi.fn(ok), mirrorSelection: vi.fn(ok), raiseDesktop: vi.fn(ok) } };
});
vi.mock("../api", () => ({ api: mocks.api }));
vi.mock("./sounds", () => ({ playSound: vi.fn() }));

import { computeGrids } from "../layout/grid";
import { emptyLayout } from "../layout/model";
import { DEFAULT_SETTINGS } from "../settings";
import type { DesktopItem, Environment } from "../types";
import { refreshItems, useDesk } from "./store";

const env: Environment = {
  monitors: [{ id: "M1", primary: true, bounds: { x: 0, y: 0, width: 1000, height: 800 }, work: { x: 0, y: 0, width: 1000, height: 760 }, scale: 1 }],
  windowOrigin: { x: 0, y: 0 },
  scaleFactor: 1,
  desktopDir: "C:\\Users\\u\\Desktop",
  publicDesktopDir: "C:\\Users\\Public\\Desktop",
  isDev: true,
} as Environment;

const item = (name: string): DesktopItem => ({
  id: `c:\\users\\u\\desktop\\${name.toLowerCase()}`,
  kind: "file",
  path: `C:\\Users\\u\\Desktop\\${name}`,
  parsingName: `C:\\Users\\u\\Desktop\\${name}`,
  name,
  ext: ".txt",
  isShortcut: false,
  isPublic: false,
  modified: 0,
  size: 0,
  iconVersion: "1",
});
const a = item("a.txt");
const b = item("b.txt");

async function showUp(items: DesktopItem[]) {
  mocks.api.listDesktopItems.mockResolvedValue(items);
  await refreshItems();
  vi.advanceTimersByTime(1000); // the debounced save and selection mirror
}

describe("refreshing the desktop", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    useDesk.setState({ settings: DEFAULT_SETTINGS, grids: computeGrids(env, DEFAULT_SETTINGS), layout: emptyLayout(), items: [], itemMap: new Map(), selection: new Set([a.id]) });
    await showUp([a, b]);
    vi.clearAllMocks();
  });
  afterEach(() => vi.useRealTimers());

  it("keeps everything as it was when nothing changed", async () => {
    const before = useDesk.getState();
    await showUp([{ ...a }, { ...b }]); // new objects from the IPC call, same data
    const s = useDesk.getState();
    expect(s.items).toBe(before.items);
    expect(s.itemMap).toBe(before.itemMap);
    expect(s.layout).toBe(before.layout);
    expect(s.selection).toBe(before.selection);
    expect(mocks.api.saveLayout).not.toHaveBeenCalled();
    expect(mocks.api.mirrorSelection).not.toHaveBeenCalled();
  });

  it("gives only a changed item a new object", async () => {
    const before = useDesk.getState();
    const grown = { ...b, modified: 5, size: 10, iconVersion: "2" };
    await showUp([{ ...a }, grown]);
    const s = useDesk.getState();
    expect(s.itemMap.get(a.id)).toBe(before.itemMap.get(a.id));
    expect(s.itemMap.get(b.id)).toBe(grown);
    expect(s.items).toEqual([before.itemMap.get(a.id), grown]);
    expect(s.layout).toBe(before.layout); // nothing moved
    expect(mocks.api.saveLayout).not.toHaveBeenCalled();
    expect(mocks.api.mirrorSelection).not.toHaveBeenCalled(); // same ids, same selection
  });

  it("places and saves a new file", async () => {
    const c = item("c.txt");
    await showUp([a, b, c]);
    const s = useDesk.getState();
    expect(s.layout.placements[c.id]).toBeDefined();
    expect(mocks.api.saveLayout).toHaveBeenCalledTimes(1);
    expect(mocks.api.saveLayout).toHaveBeenCalledWith(s.layout);
    expect(mocks.api.mirrorSelection).toHaveBeenCalledTimes(1);
  });
});

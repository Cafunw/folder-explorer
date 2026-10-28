// New ▸ on the native desktop menu: Explorer starts renaming the new item in its hidden view, the
// app cancels that and sends "renameNew"; the item must end up being renamed here, whichever comes first.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  // the bits of `window` store.ts touches, in a node test run
  (globalThis as { window?: unknown }).window = {
    setTimeout, clearTimeout, matchMedia: () => ({ matches: false, addEventListener: () => {} }),
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
import { expectNewItem, refreshItems, renameNewItem, useDesk } from "./store";

const env: Environment = {
  monitors: [{ id: "M1", primary: true, bounds: { x: 0, y: 0, width: 1000, height: 800 }, work: { x: 0, y: 0, width: 1000, height: 760 }, scale: 1 }],
  windowOrigin: { x: 0, y: 0 },
  scaleFactor: 1,
  windowsIconSize: 48,
  desktopDir: "C:\\Users\\u\\Desktop",
  publicDesktopDir: "C:\\Users\\Public\\Desktop",
} as Environment;

const item = (name: string): DesktopItem => ({
  id: `c:\\users\\u\\desktop\\${name.toLowerCase()}`,
  kind: "folder",
  path: `C:\\Users\\u\\Desktop\\${name}`,
  parsingName: `C:\\Users\\u\\Desktop\\${name}`,
  name,
  ext: "",
  isShortcut: false,
  isPublic: false,
  modified: 0,
  size: 0,
  iconVersion: "1",
});
const old = item("Eski");
let made: DesktopItem;
let n = 0;

async function showUp(items: DesktopItem[]) {
  mocks.api.listDesktopItems.mockResolvedValue(items);
  await refreshItems();
}

describe("renaming what New ▸ made", () => {
  beforeEach(async () => {
    made = item(`Yeni klasör (${++n})`); // a new name per test: placements wait for an id for 20 s
    useDesk.setState({ settings: DEFAULT_SETTINGS, grids: computeGrids(env, DEFAULT_SETTINGS), layout: emptyLayout(), rename: null, panel: null });
    await showUp([old]);
    expectNewItem({ m: "M1", p: 0, c: 3, r: 2 }); // right-click on the empty desktop
  });

  it("renames the new item when Explorer's rename comes after it showed up", async () => {
    await showUp([old, made]);
    expect(useDesk.getState().rename).toBeNull();
    renameNewItem();
    expect(useDesk.getState().rename).toEqual({ id: made.id, where: "desktop" });
  });

  it("renames it as soon as it shows up when Explorer's rename comes first", async () => {
    renameNewItem();
    expect(useDesk.getState().rename).toBeNull();
    await showUp([old, made]);
    expect(useDesk.getState().rename).toEqual({ id: made.id, where: "desktop" });
    expect(useDesk.getState().layout.placements[made.id]).toMatchObject({ c: 3, r: 2 });
  });

  it("leaves pasted items alone (no rename from Explorer)", async () => {
    await showUp([old, made]);
    expect(useDesk.getState().rename).toBeNull();
  });
});

// Ctrl+wheel up and back down again: every icon is back where it was, however many steps the
// gesture took on the way.
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  // the bits of `window` store.ts touches, in a node test run
  (globalThis as { window?: unknown }).window = {
    setTimeout: () => 0,
    clearTimeout: () => {},
    matchMedia: () => ({ matches: false, addEventListener: () => {} }),
  };
});
vi.mock("../api", () => {
  const ok = () => Promise.resolve(undefined);
  return { api: { listDesktopItems: vi.fn(), saveLayout: vi.fn(ok), saveSettings: vi.fn(ok), mirrorSelection: vi.fn(ok) } };
});
vi.mock("./sounds", () => ({ playSound: vi.fn() }));
vi.mock("../settings", async (orig) => ({ ...(await orig<typeof import("../settings")>()), applyTheme: vi.fn() }));

import { computeGrids } from "../layout/grid";
import { emptyLayout, moveToCell, reconcile } from "../layout/model";
import { DEFAULT_SETTINGS } from "../settings";
import type { DesktopItem, Environment, Placement, Settings } from "../types";
import { api } from "../api";
import { applySettings, refreshItems, useDesk } from "./store";

const env: Environment = {
  monitors: [{ id: "M1", primary: true, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, work: { x: 0, y: 0, width: 1920, height: 1040 }, scale: 1 }],
  windowOrigin: { x: 0, y: 0 },
  scaleFactor: 1,
  windowsIconSize: 48,
  desktopDir: "C:\\Users\\u\\Desktop",
  publicDesktopDir: "C:\\Users\\Public\\Desktop",
};

const item = (name: string): DesktopItem => ({
  id: `c:\\users\\u\\desktop\\${name}`,
  kind: "file",
  path: `C:\\Users\\u\\Desktop\\${name}`,
  parsingName: `C:\\Users\\u\\Desktop\\${name}`,
  name,
  ext: ".lnk",
  isShortcut: true,
  isPublic: false,
  modified: 0,
  size: 0,
  iconVersion: "1",
});

const scaled = (iconScale: number): Settings => ({ ...DEFAULT_SETTINGS, grid: { ...DEFAULT_SETTINGS.grid, iconScale } });

/** Ctrl+wheel one notch at a time from 1 up to `peak`, then back down to 1. */
function wheelUpAndBack(peak: number) {
  const up: number[] = [];
  for (let k = 1.1; k < peak; k *= 1.1) up.push(Math.round(k * 100) / 100);
  for (const k of [...up, ...up.slice(0, -1).reverse(), 1]) applySettings(scaled(k));
}

async function desktop() {
  const grids = computeGrids(env, DEFAULT_SETTINGS);
  const { cols, rows } = grids.M1;
  // a busy desktop: three full columns on the left, a column against the right edge, a few loose icons
  const cells: [number, number][] = [];
  for (let c = 0; c < 3; c++) for (let r = 0; r < rows; r++) cells.push([c, r]);
  for (let r = 0; r < rows; r += 2) cells.push([cols - 1, r]);
  cells.push([cols - 2, 0], [cols - 3, 0], [6, 2], [9, 5], [cols - 4, rows - 1], [cols - 2, rows - 2]);
  const items = cells.map(([c, r]) => item(`i${c}_${r}.lnk`));
  const placements: Record<string, Placement> = {};
  cells.forEach(([c, r], i) => (placements[items[i].id] = { m: "M1", p: 0, c, r }));
  const layout = reconcile({ ...emptyLayout(), placements }, items, grids);
  useDesk.setState({ env, ready: true, settings: DEFAULT_SETTINGS, grids, layout, items: [], itemMap: new Map() });
  vi.mocked(api.listDesktopItems).mockResolvedValue(items);
  await refreshItems();
  return { items, layout };
}

describe("Ctrl+wheel zoom", () => {
  it.each([1.5, 2, 3])("puts every icon back after zooming up to %s and back", async (peak) => {
    const { layout } = await desktop();
    wheelUpAndBack(peak);
    expect(useDesk.getState().layout.placements).toEqual(layout.placements);
  });

  it("keeps an icon the user moved while zoomed in", async () => {
    const { items } = await desktop();
    applySettings(scaled(1.5));
    const s = useDesk.getState();
    const id = items[0].id;
    const to = { m: "M1", p: 0, c: 5, r: 3 };
    useDesk.setState({ layout: moveToCell(s.layout, s.grids, [id], id, to) });
    applySettings(DEFAULT_SETTINGS);
    expect(useDesk.getState().layout.placements[id]).toEqual(to);
  });
});

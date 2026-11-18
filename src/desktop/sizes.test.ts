// The size line under icons (settings.labels.showSize): what a tile adds up, the text, the folder
// size queue and the taller cells.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  (globalThis as { window?: unknown }).window = {
    setTimeout: (...a: Parameters<typeof setTimeout>) => setTimeout(...a),
    clearTimeout: (id?: Parameters<typeof clearTimeout>[0]) => clearTimeout(id),
    matchMedia: () => ({ matches: false, addEventListener: () => {} }),
  };
  return { api: { dirSize: vi.fn() } };
});
vi.mock("../api", () => ({ api: mocks.api }));
vi.mock("./sounds", () => ({ playSound: vi.fn() }));

import { cellMetrics } from "../layout/grid";
import { DEFAULT_SETTINGS } from "../settings";
import type { DesktopItem, MonitorInfo, VirtualFolder } from "../types";
import { formatBytes } from "./bytes";
import { sizeParts, sizeText, useDirSizes, wantDirSize } from "./sizes";

const item = (id: string, kind: DesktopItem["kind"], size = 0, modified = 1): DesktopItem => ({
  id,
  kind,
  path: id,
  parsingName: id,
  name: id,
  ext: "",
  isShortcut: false,
  isPublic: false,
  modified,
  size,
  iconVersion: "1",
});
const group = (id: string, children: string[], extra: Partial<VirtualFolder> = {}): VirtualFolder => ({ id, name: id, color: null, children, ...extra });
const BIN = "::{645ff040-5081-101b-9f08-00aa002f954e}";

const items = new Map<string, DesktopItem>(
  [
    item("c:\\d\\a.txt", "file", 1000),
    item("c:\\d\\b.png", "file", 24),
    item("c:\\d\\proj", "folder", 0, 77),
    item(BIN, "system", 5000),
    item("::{20d04fe0-3aea-1069-a2d8-08002b30309d}", "system"),
  ].map((i) => [i.id, i]),
);

describe("sizeParts", () => {
  const folders: Record<string, VirtualFolder> = {
    "v:outer": group("v:outer", ["c:\\d\\a.txt", "v:inner", "c:\\d\\proj"]),
    "v:inner": group("v:inner", ["c:\\d\\b.png", "c:\\d\\a.txt"]),
    "v:live": group("v:live", [], { kind: "live", source: "D:\\Media" }),
    "v:freq": group("v:freq", [], { kind: "frequent" }),
    "v:locked": group("v:locked", ["c:\\d\\a.txt"], { lock: { method: "pin", hash: "x", salt: "y" } }),
    "v:loop": group("v:loop", ["v:loop", "c:\\d\\b.png"]),
  };
  const parts = (id: string) => sizeParts(id, { folders }, items);

  it("gives files their size, folders a walk and the Recycle Bin its content", () => {
    expect(parts("c:\\d\\a.txt")).toEqual([{ bytes: 1000 }]);
    expect(parts("c:\\d\\proj")).toEqual([{ dir: "c:\\d\\proj", stamp: 77 }]);
    expect(parts(BIN)).toEqual([{ bytes: 5000 }]);
  });

  it("shows nothing for system items without a size or unknown ids", () => {
    expect(parts("::{20d04fe0-3aea-1069-a2d8-08002b30309d}")).toBeNull();
    expect(parts("c:\\gone")).toBeNull();
  });

  it("adds a group's children, nested groups included, each item once", () => {
    expect(parts("v:outer")).toEqual([{ bytes: 1000 }, { bytes: 24 }, { dir: "c:\\d\\proj", stamp: 77 }]);
    expect(parts("v:loop")).toEqual([{ bytes: 24 }]);
  });

  it("walks a live group's folder; frequent and locked groups show nothing", () => {
    expect(parts("v:live")).toEqual([{ dir: "D:\\Media", stamp: 0 }]);
    expect(parts("v:freq")).toBeNull();
    expect(parts("v:locked")).toBeNull();
  });
});

describe("sizeText", () => {
  it("adds known sizes, waits for folders still being summed", () => {
    const at = Date.now();
    expect(sizeText([{ bytes: 1000 }, { bytes: 24 }], {})).toBe(formatBytes(1024));
    expect(sizeText([{ bytes: 1 }, { dir: "C:\\X", stamp: 0 }], {})).toBe("…");
    expect(sizeText([{ bytes: 1024 }, { dir: "C:\\X", stamp: 0 }], { "c:\\x": { bytes: 1024, at, stamp: 0 } })).toBe(formatBytes(2048));
  });

  it("leaves out folders that can't be read, and shows nothing when no part is known", () => {
    expect(sizeText([{ dir: "C:\\X", stamp: 0 }], { "c:\\x": { bytes: -1, at: 0, stamp: 0 } })).toBeNull();
    expect(sizeText([{ bytes: 2048 }, { dir: "C:\\X", stamp: 0 }], { "c:\\x": { bytes: -1, at: 0, stamp: 0 } })).toBe(formatBytes(2048));
    expect(sizeText(null, {})).toBeNull();
    expect(sizeText([], {})).toBe(formatBytes(0)); // an empty group
  });
});

describe("formatBytes", () => {
  it("uses bytes, then 1024-based units", () => {
    expect(formatBytes(512)).toMatch(/^512 /);
    expect(formatBytes(1536)).toMatch(/^1[.,]5 KB$/);
    expect(formatBytes(5 * 1024 ** 3)).toBe("5 GB");
  });
});

describe("wantDirSize", () => {
  beforeEach(() => {
    useDirSizes.setState({ map: {} });
    mocks.api.dirSize.mockReset();
  });

  it("walks two folders at a time, each once, and keeps the result", async () => {
    const waiting: ((n: number) => void)[] = [];
    mocks.api.dirSize.mockImplementation(() => new Promise<number>((r) => waiting.push(r)));
    wantDirSize("C:\\A", 1);
    wantDirSize("c:\\a", 1); // same folder, other case
    wantDirSize("C:\\B", 1);
    wantDirSize("C:\\C", 1);
    expect(mocks.api.dirSize).toHaveBeenCalledTimes(2);
    waiting.shift()!(100);
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.api.dirSize).toHaveBeenCalledTimes(3);
    expect(useDirSizes.getState().map["c:\\a"]).toMatchObject({ bytes: 100, stamp: 1 });
    waiting.forEach((r) => r(1));
    await Promise.resolve();
    await Promise.resolve();
    wantDirSize("C:\\A", 1); // fresh: not asked again
    expect(mocks.api.dirSize).toHaveBeenCalledTimes(3);
    wantDirSize("C:\\A", 2); // the folder changed
    expect(mocks.api.dirSize).toHaveBeenCalledTimes(4);
  });

  it("remembers a folder that can't be read", async () => {
    mocks.api.dirSize.mockRejectedValue("denied");
    wantDirSize("C:\\Locked", 0);
    await Promise.resolve();
    await Promise.resolve();
    expect(useDirSizes.getState().map["c:\\locked"]?.bytes).toBe(-1);
  });
});

describe("cell height", () => {
  const m: MonitorInfo = { id: "M", primary: true, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, work: { x: 0, y: 0, width: 1920, height: 1040 }, scale: 1 };
  it("grows by the size line only while sizes are shown", () => {
    const off = cellMetrics(m, 1, DEFAULT_SETTINGS, 48);
    const on = cellMetrics(m, 1, { ...DEFAULT_SETTINGS, labels: { ...DEFAULT_SETTINGS.labels, showSize: true } }, 48);
    expect(on.cellH - off.cellH).toBeGreaterThanOrEqual(14);
    expect(on.cellH - off.cellH).toBeLessThanOrEqual(18);
    expect(on.cellW).toBe(off.cellW);
  });
  it("is added to the user's own spacing too", () => {
    const manual = { ...DEFAULT_SETTINGS, grid: { ...DEFAULT_SETTINGS.grid, autoSize: false } };
    const off = cellMetrics(m, 1, manual, 48);
    const on = cellMetrics(m, 1, { ...manual, labels: { ...manual.labels, showSize: true } }, 48);
    expect(off.cellH).toBe(manual.grid.cellHeight);
    expect(on.cellH).toBeGreaterThan(off.cellH);
  });
});

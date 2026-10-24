import { describe, expect, it } from "vitest";
import { computeGrids } from "../layout/grid";
import { emptyLayout, locate } from "../layout/model";
import { DEFAULT_SETTINGS } from "../settings";
import type { DesktopItem, Environment, Layout, VirtualFolder } from "../types";
import {
  archiveStale,
  bubbleCols,
  checkPin,
  displayToChildIndex,
  draftOf,
  fanLayout,
  hashPin,
  makeLock,
  newRow,
  patchOf,
  ruleDraft,
  ruleOf,
  smartMatchCount,
  validPin,
} from "./kinds";

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
  return {
    id: file.toLowerCase(),
    kind: "file",
    path: `C:\\Users\\u\\Desktop\\${file}`,
    parsingName: `C:\\Users\\u\\Desktop\\${file}`,
    name: file,
    ext: dot > 0 ? file.slice(dot).toLowerCase() : "",
    isShortcut: false,
    isPublic: false,
    modified: NOW - DAY,
    size: 1,
    iconVersion: "1",
    ...over,
  };
}

const folder = (id: string, over: Partial<VirtualFolder> = {}): VirtualFolder => ({ id, name: id, color: null, children: [], ...over });

describe("PIN", () => {
  it("accepts 4 to 12 digits only", () => {
    expect(validPin("1234")).toBe(true);
    expect(validPin("123456789012")).toBe(true);
    expect(validPin("123")).toBe(false);
    expect(validPin("1234567890123")).toBe(false);
    expect(validPin("12a4")).toBe(false);
    expect(validPin(" 1234")).toBe(false);
  });

  it("hashes salt + pin with SHA-256 as hex", async () => {
    // sha256("00112233445566778899aabbccddeeff2468")
    const want = "accbc08e9277700880cd444acb5e0ba92279bd9d2696120b1b5ee8913c13a3f5";
    expect(await hashPin("2468", "00112233445566778899aabbccddeeff")).toBe(want);
  });

  it("checks a PIN against a lock", async () => {
    const lock = await makeLock("9090", false, "abcd");
    expect(lock).toMatchObject({ method: "pin", salt: "abcd" });
    expect(await checkPin(lock, "9090")).toBe(true);
    expect(await checkPin(lock, "9091")).toBe(false);
    expect(await checkPin(lock, "90")).toBe(false);
    expect(await checkPin(null, "9090")).toBe(false);
    expect((await makeLock("9090", true)).method).toBe("hello");
  });

  it("uses a fresh salt per lock", async () => {
    const a = await makeLock("1111", false);
    const b = await makeLock("1111", false);
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
  });
});

describe("rule editor", () => {
  it("round-trips a rule through the draft", () => {
    const rule = {
      all: false,
      conditions: [
        { field: "ext" as const, value: [".png", ".jpg"] },
        { field: "name" as const, op: "startsWith" as const, value: "Ekran" },
        { field: "type" as const, value: "game" as const },
        { field: "age" as const, op: "olderThan" as const, days: 30 },
      ],
    };
    expect(ruleOf(ruleDraft(rule))).toEqual(rule);
  });

  it("starts with one empty row and drops incomplete rows", () => {
    const d = ruleDraft(undefined);
    expect(d.all).toBe(true);
    expect(d.rows).toHaveLength(1);
    expect(ruleOf(d).conditions).toEqual([]);
    const ext = { ...newRow("ext"), text: "png, .JPG;  gif" };
    const r = ruleOf({ all: true, rows: [ext, newRow("name")] });
    expect(r.conditions).toEqual([{ field: "ext", value: [".png", ".jpg", ".gif"] }]);
  });

  it("counts the loose desktop items a rule would collect", () => {
    const l: Layout = emptyLayout();
    const items = [item("a.png"), item("b.png"), item("c.txt"), item("d.png"), item("e.png", { kind: "system" })];
    l.placements["a.png"] = { m: "M1", p: 0, c: 0, r: 0 };
    l.placements["b.png"] = { m: "M1", p: 0, c: 0, r: 1 };
    l.placements["c.txt"] = { m: "M1", p: 0, c: 0, r: 2 };
    l.placements["e.png"] = { m: "M1", p: 0, c: 0, r: 3 };
    l.folders["v:s"] = folder("v:s", { kind: "smart", children: ["d.png"], exclude: ["b.png"] });
    const rule = { all: true, conditions: [{ field: "ext" as const, value: [".png"] }] };
    expect(smartMatchCount(l, items, "v:s", rule, NOW)).toBe(1);
    expect(smartMatchCount(l, items, "v:s", { all: true, conditions: [] }, NOW)).toBe(0);
  });
});

describe("customize draft", () => {
  it("only patches the options of the chosen kind", () => {
    const f = folder("v:f", { kind: "live", source: "C:\\Data", limit: 20 });
    const d = draftOf(f);
    expect(d).toMatchObject({ kind: "live", display: "panel", source: "C:\\Data", limit: 20, lock: null });
    expect(patchOf(d)).toEqual({ kind: "live", display: null, lock: null, source: "C:\\Data" });
    expect(patchOf({ ...d, kind: "frequent", display: "stack" })).toEqual({ kind: "frequent", display: "stack", lock: null, limit: 20 });
    expect(patchOf({ ...d, kind: "group" })).toEqual({ kind: null, display: null, lock: null });
    expect(patchOf({ ...d, kind: "temp", tempDays: 14 })).toMatchObject({ kind: "temp", tempDays: 14 });
  });
});

describe("displayToChildIndex", () => {
  const children = ["v:t1", "a", "v:t2", "b", "c"];
  const shown = ["a", "b", "c"];

  it("maps a slot of the shown items to the full child list", () => {
    expect(displayToChildIndex(children, shown, [], 0)).toBe(1);
    expect(displayToChildIndex(children, shown, [], 1)).toBe(3);
    expect(displayToChildIndex(children, shown, [], 3)).toBe(5);
  });

  it("leaves the dragged items out", () => {
    expect(displayToChildIndex(children, shown, ["a"], 0)).toBe(2);
    expect(displayToChildIndex(children, shown, ["a"], 2)).toBe(4);
  });

  it("appends when nothing is shown", () => {
    expect(displayToChildIndex(["v:t1"], [], [], 0)).toBe(1);
  });
});

describe("stack fan", () => {
  it("rises from the tile, bending towards the side", () => {
    const step = 80;
    const right = fanLayout(5, step, 1, true);
    expect(right).toHaveLength(5);
    right.forEach((s, i) => {
      expect(s.y).toBeCloseTo(-(i + 1) * step);
      expect(s.x).toBeGreaterThanOrEqual(0);
      expect(s.rot).toBeGreaterThanOrEqual(0);
      if (i) expect(s.x).toBeGreaterThan(right[i - 1].x);
    });
    const down = fanLayout(3, step, -1, false);
    down.forEach((s) => {
      expect(s.y).toBeGreaterThan(0);
      expect(s.x).toBeLessThanOrEqual(0);
    });
    // a gentle arc: the farthest icon stays within a fraction of a step sideways
    expect(Math.abs(fanLayout(9, step, 1, true)[8].x)).toBeLessThan(step * 3.5);
    expect(fanLayout(0, step, 1, true)).toEqual([]);
  });

  it("sizes the grid bubble", () => {
    expect(bubbleCols(10)).toBe(4);
    expect(bubbleCols(2)).toBe(3);
    expect(bubbleCols(100)).toBe(6);
  });
});

describe("archiveStale", () => {
  function setup() {
    const l = emptyLayout();
    l.folders["v:t"] = folder("v:t", {
      kind: "temp",
      tempDays: 3,
      children: ["old", "new"],
      added: { old: NOW - 5 * DAY, new: NOW - DAY },
    });
    l.placements["v:t"] = { m: "M1", p: 0, c: 0, r: 0 };
    return l;
  }

  it("creates the archive group next to the temp group", () => {
    const r = archiveStale(setup(), grids, "v:t", "Arşiv", null, NOW);
    expect(r.moved).toBe(1);
    expect(r.archiveId).not.toBeNull();
    const archive = r.layout.folders[r.archiveId!];
    expect(archive.name).toBe("Arşiv");
    expect(archive.children).toEqual(["old"]);
    expect(r.layout.folders["v:t"].children).toEqual(["new"]);
    expect(locate(r.layout, r.archiveId!)?.type).toBe("desktop");
  });

  it("reuses an existing archive group and does nothing without stale items", () => {
    const l = setup();
    l.folders["v:a"] = folder("v:a", { name: "Arşiv", children: ["x"] });
    l.placements["v:a"] = { m: "M1", p: 0, c: 1, r: 0 };
    const r = archiveStale(l, grids, "v:t", "Arşiv", null, NOW);
    expect(r.archiveId).toBe("v:a");
    expect(r.layout.folders["v:a"].children).toEqual(["x", "old"]);
    const none = archiveStale(r.layout, grids, "v:t", "Arşiv", null, NOW);
    expect(none.moved).toBe(0);
    expect(none.layout).toBe(r.layout);
  });

  it("archives inside the parent group when the temp group is nested", () => {
    const l = setup();
    delete l.placements["v:t"];
    l.folders["v:p"] = folder("v:p", { children: ["v:t"] });
    l.placements["v:p"] = { m: "M1", p: 0, c: 0, r: 0 };
    const r = archiveStale(l, grids, "v:t", "Arşiv", null, NOW);
    expect(r.layout.folders["v:p"].children).toEqual(["v:t", r.archiveId]);
  });
});

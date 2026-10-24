import { describe, expect, it } from "vitest";
import {
  arrowDir,
  dropEffect,
  fileUrlPath,
  firstLast,
  gridStep,
  isDoubleClick,
  isExecutablePath,
  listRange,
  neighbour,
  rangeIds,
  roundScale,
  shortcutDropKind,
  volumeOf,
  wheelPixels,
  zoomBy,
  type CellRect,
} from "./input";

const cell = (id: string, c: number, r: number, w = 1, h = 1): CellRect => ({ id, c, r, w, h });

describe("neighbour", () => {
  const grid = [cell("a", 0, 0), cell("b", 1, 0), cell("c", 0, 1), cell("d", 1, 1), cell("e", 4, 0)];

  it("moves to the adjacent cell in each direction", () => {
    expect(neighbour(grid, grid[0], "right")?.id).toBe("b");
    expect(neighbour(grid, grid[0], "down")?.id).toBe("c");
    expect(neighbour(grid, grid[3], "left")?.id).toBe("c");
    expect(neighbour(grid, grid[3], "up")?.id).toBe("b");
  });

  it("returns null at the edge", () => {
    expect(neighbour(grid, grid[0], "left")).toBeNull();
    expect(neighbour(grid, grid[0], "up")).toBeNull();
    expect(neighbour(grid, grid[4], "right")).toBeNull();
  });

  it("prefers the same row at any distance over a nearer diagonal", () => {
    const g = [cell("from", 0, 0), cell("diag", 1, 1), cell("far", 9, 0)];
    expect(neighbour(g, g[0], "right")?.id).toBe("far");
  });

  it("falls back to the nearest by gap and row offset", () => {
    const g = [cell("from", 0, 5), cell("near", 1, 3), cell("other", 1, 2), cell("far", 9, 4)];
    expect(neighbour(g, g[0], "right")?.id).toBe("near");
  });

  it("treats a spanned block as one target and moves past it", () => {
    // fence over cols 1..3, rows 0..1; a heading over cols 0..2 on row 3
    const g = [cell("x", 0, 0), cell("fence", 1, 0, 3, 2), cell("y", 4, 1), cell("head", 0, 3, 3, 1), cell("z", 2, 4)];
    expect(neighbour(g, g[0], "right")?.id).toBe("fence");
    expect(neighbour(g, g[1], "right")?.id).toBe("y");
    expect(neighbour(g, g[1], "left")?.id).toBe("x");
    expect(neighbour(g, g[1], "down")?.id).toBe("head");
    expect(neighbour(g, g[3], "down")?.id).toBe("z");
    expect(neighbour(g, g[4], "up")?.id).toBe("head");
  });

  it("leaves a fence from a child's row: the band of `from` decides", () => {
    const g = [cell("fence", 0, 0, 2, 3), cell("top", 3, 0), cell("bottom", 3, 2)];
    expect(neighbour(g, { id: "fence", c: 0, w: 2, r: 2, h: 1 }, "right")?.id).toBe("bottom");
    expect(neighbour(g, { id: "fence", c: 0, w: 2, r: 0, h: 1 }, "right")?.id).toBe("top");
  });

  it("enters a page from its edge (a virtual cell outside the grid)", () => {
    const page = [cell("p", 0, 2), cell("q", 3, 0), cell("r", 5, 2)];
    expect(neighbour(page, { c: -1, w: 1, r: 2, h: 1 }, "right")?.id).toBe("p");
    expect(neighbour(page, { c: 8, w: 1, r: 2, h: 1 }, "left")?.id).toBe("r");
    expect(neighbour(page, { c: -1, w: 1, r: 0, h: 1 }, "right")?.id).toBe("q");
  });
});

describe("firstLast / rangeIds", () => {
  const g = [cell("b", 1, 0), cell("a", 0, 3), cell("c", 1, 4), cell("d", 0, 0)];
  it("orders column by column like Windows", () => {
    expect(firstLast(g, "first")?.id).toBe("d");
    expect(firstLast(g, "last")?.id).toBe("c");
    expect(firstLast([], "first")).toBeNull();
  });
  it("selects the box between two entries, spans included", () => {
    const grid = [cell("a", 0, 0), cell("b", 1, 0), cell("c", 0, 1), cell("d", 1, 1), cell("fence", 2, 0, 2, 2), cell("e", 3, 3)];
    expect(rangeIds(grid, grid[0], grid[3]).sort()).toEqual(["a", "b", "c", "d"]);
    expect(rangeIds(grid, grid[1], grid[4]).sort()).toEqual(["b", "d", "fence"]);
    expect(rangeIds(grid, grid[0], grid[0])).toEqual(["a"]);
  });
});

describe("gridStep / listRange", () => {
  // 7 items, 3 per row:  0 1 2 / 3 4 5 / 6
  it("moves inside the grid and stops at the edges", () => {
    expect(gridStep(0, 7, 3, "right")).toBe(1);
    expect(gridStep(2, 7, 3, "right")).toBeNull();
    expect(gridStep(3, 7, 3, "left")).toBeNull();
    expect(gridStep(4, 7, 3, "up")).toBe(1);
    expect(gridStep(1, 7, 3, "up")).toBeNull();
    expect(gridStep(6, 7, 3, "right")).toBeNull();
  });
  it("goes down to the last item when the last row is shorter", () => {
    expect(gridStep(1, 7, 3, "down")).toBe(4);
    expect(gridStep(4, 7, 3, "down")).toBe(6);
    expect(gridStep(6, 7, 3, "down")).toBeNull();
    expect(gridStep(0, 0, 3, "down")).toBeNull();
  });
  it("ranges in either direction", () => {
    expect(listRange(["a", "b", "c", "d"], 3, 1)).toEqual(["b", "c", "d"]);
    expect(listRange(["a", "b"], 0, 0)).toEqual(["a"]);
  });
  it("maps arrow keys", () => {
    expect(arrowDir("ArrowUp")).toBe("up");
    expect(arrowDir("Home")).toBeNull();
  });
});

describe("isDoubleClick", () => {
  const a = { t: 1000, x: 100, y: 100 };
  it("needs a second click soon and close by", () => {
    expect(isDoubleClick(a, { t: 1300, x: 102, y: 101 })).toBe(true);
    expect(isDoubleClick(a, { t: 1500, x: 100, y: 100 })).toBe(true);
    expect(isDoubleClick(a, { t: 1501, x: 100, y: 100 })).toBe(false);
    expect(isDoubleClick(a, { t: 1100, x: 105, y: 100 })).toBe(false);
    expect(isDoubleClick(null, a)).toBe(false);
    expect(isDoubleClick(a, { t: 900, x: 100, y: 100 })).toBe(false);
  });
});

describe("zoom", () => {
  it("scales by 1.1 per notch and back again exactly", () => {
    const up = zoomBy(1, -100);
    expect(up).toBeCloseTo(1.1, 10);
    expect(zoomBy(up, 100)).toBeCloseTo(1, 10);
    expect(roundScale(zoomBy(1, -200))).toBe(1.21);
  });
  it("adds up small pinch steps before rounding", () => {
    let s = 1;
    for (let i = 0; i < 10; i++) s = zoomBy(s, -10);
    expect(roundScale(s)).toBe(1.1);
  });
  it("clamps to 0.5 … 3", () => {
    expect(zoomBy(2.9, -1000)).toBe(3);
    expect(zoomBy(0.55, 1000)).toBe(0.5);
  });
  it("converts wheel modes and caps bursts", () => {
    expect(wheelPixels(3, 1)).toBe(99);
    expect(wheelPixels(-100, 0)).toBe(-100);
    expect(wheelPixels(1, 2)).toBe(300);
    expect(wheelPixels(-900, 0)).toBe(-300);
  });
});

describe("drops", () => {
  it("knows volumes", () => {
    expect(volumeOf("C:\\a\\b.txt")).toBe("c:");
    expect(volumeOf("\\\\Srv\\Share\\x")).toBe("\\\\srv\\share");
    expect(volumeOf("d:/x")).toBe("d:");
  });
  it("follows Explorer's copy / move rule", () => {
    const none = { ctrl: false, shift: false };
    expect(dropEffect("C:\\x.txt", "C:\\Users\\a\\Belgeler", none)).toBe("move");
    expect(dropEffect("D:\\x.txt", "C:\\Users\\a\\Belgeler", none)).toBe("copy");
    expect(dropEffect("C:\\x.txt", "C:\\dir", { ctrl: true, shift: false })).toBe("copy");
    expect(dropEffect("D:\\x.txt", "C:\\dir", { ctrl: false, shift: true })).toBe("move");
    expect(dropEffect("D:\\x.txt", "C:\\dir", { ctrl: true, shift: true })).toBe("copy");
  });
  it("recognises apps and shortcut targets", () => {
    expect(isExecutablePath("C:\\Apps\\code.EXE")).toBe(true);
    expect(isExecutablePath('"C:\\x\\run.bat"')).toBe(true);
    expect(isExecutablePath("C:\\x\\notes.txt")).toBe(false);
    expect(shortcutDropKind({ target: "C:\\Program Files\\App\\app.exe" })).toEqual({ kind: "app", target: "C:\\Program Files\\App\\app.exe" });
    expect(shortcutDropKind({ target: "C:\\Projeler", isDir: true })).toEqual({ kind: "dir", target: "C:\\Projeler" });
    expect(shortcutDropKind({ target: "C:\\x\\doc.pdf" })).toBeNull();
    expect(shortcutDropKind({ target: "steam://rungameid/1" })).toBeNull();
    expect(shortcutDropKind({ target: "" })).toBeNull();
    expect(shortcutDropKind(null)).toBeNull();
    expect(shortcutDropKind({ target: "file:///C:/Oyun%20lar/oyun.exe" })).toEqual({ kind: "app", target: "C:\\Oyun lar\\oyun.exe" });
  });
  it("turns file URLs into paths", () => {
    expect(fileUrlPath("file:///C:/a/b.exe")).toBe("C:\\a\\b.exe");
    expect(fileUrlPath("file://server/share/x.exe")).toBe("\\\\server\\share\\x.exe");
  });
});

import { describe, expect, it } from "vitest";
import { nextFocusIndex } from "./dialog";

describe("dialog Tab order", () => {
  it("steps forward and back, wrapping at both ends", () => {
    expect(nextFocusIndex(3, 0, false)).toBe(1);
    expect(nextFocusIndex(3, 2, false)).toBe(0);
    expect(nextFocusIndex(3, 1, true)).toBe(0);
    expect(nextFocusIndex(3, 0, true)).toBe(2);
  });

  it("brings focus that is outside the dialog back to its first or last element", () => {
    expect(nextFocusIndex(4, -1, false)).toBe(0);
    expect(nextFocusIndex(4, -1, true)).toBe(3);
  });

  it("stays on a single element and has nowhere to go in an empty dialog", () => {
    expect(nextFocusIndex(1, 0, false)).toBe(0);
    expect(nextFocusIndex(1, 0, true)).toBe(0);
    expect(nextFocusIndex(0, -1, false)).toBe(-1);
  });
});
